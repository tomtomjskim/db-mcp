import { DatabaseConnection } from './connection.js';
import { QueryValidator, ValidationResult, QueryAnalysis } from '../security/query-validator.js';
import { QueryResult, AuditLog } from '../types/index.js';
import { securityConfig } from '../config/index.js';
import { logger, logQuery, logSecurityEvent } from '../utils/logger.js';

export interface QueryOptions {
  timeout?: number;
  maxRows?: number;
  enableAudit?: boolean;
  dryRun?: boolean;
}

export interface ExecutionMetrics {
  executionTime: number;
  rowsAffected: number;
  memoryUsage: number;
  cpuTime: number;
}

export interface QueryCacheEntry {
  key: string;
  result: QueryResult;
  timestamp: number;
  ttl: number;
}

export class QueryExecutor {
  private validator: QueryValidator;
  private auditLogs: AuditLog[] = [];
  private queryCache = new Map<string, QueryCacheEntry>();
  private readonly cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor(private database: DatabaseConnection) {
    this.validator = new QueryValidator();
  }

  async executeQuery(
    query: string,
    parameters: any[] = [],
    options: QueryOptions = {}
  ): Promise<QueryResult> {
    const startTime = Date.now();
    const timeout = options.timeout || securityConfig.maxExecutionTime;
    const maxRows = options.maxRows || securityConfig.maxResultRows;

    try {
      // Input validation
      const validation = this.validator.validate(query);
      if (!validation.isValid) {
        throw new Error(`Query validation failed: ${validation.errors.join(', ')}`);
      }

      // Log warnings
      if (validation.warnings.length > 0) {
        logger.warn('Query validation warnings', {
          query: query.substring(0, 100),
          warnings: validation.warnings,
        });
      }

      // Check cache first
      const cacheKey = this.generateCacheKey(query, parameters);
      const cached = this.getCachedResult(cacheKey);
      if (cached && !options.dryRun) {
        logger.debug('Returning cached query result', { cacheKey });
        return cached;
      }

      // Dry run mode - just validate and analyze
      if (options.dryRun) {
        const analysis = this.validator.getQueryAnalysis(query);
        return {
          rows: [],
          fields: [],
          rowCount: 0,
          executionTime: Date.now() - startTime,
          analysis,
          cached: false,
          dryRun: true,
        } as QueryResult;
      }

      // Execute with timeout
      const result = await this.executeWithTimeout(
        validation.sanitizedQuery ?? query,
        parameters,
        timeout,
        maxRows
      );

      // Cache the result if appropriate
      if (this.shouldCacheQuery(query)) {
        this.cacheResult(cacheKey, result);
      }

      // Audit logging
      if (options.enableAudit !== false) {
        this.logAudit(query, result.executionTime, result.rowCount, true);
      }

      // Performance logging
      logQuery(query, result.executionTime, result.rowCount, true);

      return result;

    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Audit logging for failures
      if (options.enableAudit !== false) {
        this.logAudit(query, executionTime, 0, false, errorMessage);
      }

      // Performance logging for failures
      logQuery(query, executionTime, 0, false, errorMessage);

      // Security event logging for suspicious failures
      if (this.isSuspiciousError(errorMessage)) {
        logSecurityEvent('suspicious_query_error', {
          query: query.substring(0, 200),
          error: errorMessage,
          parameters: parameters?.length || 0,
        });
      }

      throw new Error(`Query execution failed: ${errorMessage}`);
    }
  }

  private async executeWithTimeout(
    query: string,
    parameters: any[],
    timeout: number,
    maxRows: number
  ): Promise<QueryResult> {
    const startTime = Date.now();

    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Query timeout after ${timeout}ms`));
      }, timeout);
    });

    // Create the actual query execution promise
    const queryPromise = this.executeQueryInternal(query, parameters, maxRows);

    try {
      // Race between query execution and timeout
      const result = await Promise.race([queryPromise, timeoutPromise]);
      result.executionTime = Date.now() - startTime;
      return result;
    } catch (error) {
      // If it's a timeout, we should try to cancel the query if possible
      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warn('Query timed out', {
          query: query.substring(0, 100),
          timeout,
          actualTime: Date.now() - startTime,
        });
      }
      throw error;
    }
  }

  private async executeQueryInternal(
    query: string,
    parameters: any[],
    maxRows: number
  ): Promise<QueryResult> {
    const results = await this.database.query(query, parameters);

    if (Array.isArray(results)) {
      // SELECT query results
      const truncatedRows = results.slice(0, maxRows);
      const fields = this.extractFields(results);

      return {
        rows: truncatedRows,
        fields,
        rowCount: results.length,
        executionTime: 0, // Will be set by caller
        truncated: results.length > maxRows,
        totalRows: results.length,
      };
    } else {
      // Non-SELECT query results (SHOW, DESCRIBE, etc.)
      return {
        rows: [],
        fields: [],
        rowCount: 'affectedRows' in results ? Number(results.affectedRows) : 0,
        executionTime: 0, // Will be set by caller
        metadata: results,
      };
    }
  }

  private extractFields(results: any[]): any[] {
    if (results.length === 0) return [];

    const firstRow = results[0];
    return Object.keys(firstRow).map(key => ({
      name: key,
      type: typeof firstRow[key],
      nullable: firstRow[key] === null,
    }));
  }

  private generateCacheKey(query: string, parameters: any[]): string {
    const normalizedQuery = query.replace(/\\s+/g, ' ').trim().toLowerCase();
    const paramStr = parameters ? JSON.stringify(parameters) : '';
    return `${normalizedQuery}:${paramStr}`;
  }

  private getCachedResult(cacheKey: string): QueryResult | null {
    const entry = this.queryCache.get(cacheKey);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.queryCache.delete(cacheKey);
      return null;
    }

    // Return a copy with cache metadata
    return {
      ...entry.result,
      cached: true,
      cacheAge: now - entry.timestamp,
    };
  }

  private cacheResult(cacheKey: string, result: QueryResult): void {
    // Only cache successful SELECT queries with reasonable result sizes
    if (result.rowCount <= 1000 && !result.metadata) {
      this.queryCache.set(cacheKey, {
        key: cacheKey,
        result: { ...result },
        timestamp: Date.now(),
        ttl: this.cacheTTL,
      });

      // Clean old cache entries periodically
      if (this.queryCache.size > 100) {
        this.cleanCache();
      }
    }
  }

  private cleanCache(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, entry] of this.queryCache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        toDelete.push(key);
      }
    }

    toDelete.forEach(key => this.queryCache.delete(key));
    logger.debug(`Cleaned ${toDelete.length} expired cache entries`);
  }

  private shouldCacheQuery(query: string): boolean {
    const queryUpper = query.toUpperCase().trim();

    // Only cache SELECT queries
    if (!queryUpper.startsWith('SELECT')) return false;

    // Don't cache queries with non-deterministic functions
    const nonDeterministicFunctions = ['NOW()', 'RAND()', 'UUID()', 'CONNECTION_ID()'];
    return !nonDeterministicFunctions.some(func =>
      queryUpper.includes(func.toUpperCase())
    );
  }

  private logAudit(
    query: string,
    executionTime: number,
    rowCount: number,
    success: boolean,
    errorMessage?: string
  ): void {
    const auditEntry: AuditLog = {
      timestamp: new Date(),
      query: query.substring(0, 1000), // Truncate very long queries
      executionTime,
      rowCount,
      success,
      // These would typically come from request context
      userAgent: 'mcp-client',
      ipAddress: 'localhost',
    };

    if (errorMessage !== undefined) {
      auditEntry.errorMessage = errorMessage;
    }

    this.auditLogs.push(auditEntry);

    // Keep only last 1000 audit logs in memory
    if (this.auditLogs.length > 1000) {
      this.auditLogs = this.auditLogs.slice(-1000);
    }
  }

  private isSuspiciousError(errorMessage: string): boolean {
    const suspiciousPatterns = [
      /access denied/i,
      /permission denied/i,
      /table.*doesn't exist/i,
      /column.*doesn't exist/i,
      /syntax error/i,
    ];

    return suspiciousPatterns.some(pattern => pattern.test(errorMessage));
  }

  // Public methods for monitoring and management

  getQueryCache(): Map<string, QueryCacheEntry> {
    return new Map(this.queryCache);
  }

  getCacheStats(): { size: number; hitRate: number; totalQueries: number } {
    // This would require tracking hits/misses in a real implementation
    return {
      size: this.queryCache.size,
      hitRate: 0, // Placeholder
      totalQueries: this.auditLogs.length,
    };
  }

  getAuditLogs(limit: number = 100): AuditLog[] {
    return this.auditLogs.slice(-limit);
  }

  clearCache(): void {
    this.queryCache.clear();
    logger.info('Query cache cleared');
  }

  async explainQuery(query: string, parameters: any[] = []): Promise<any> {
    const explainQuery = `EXPLAIN ${query}`;
    return this.executeQuery(explainQuery, parameters, { enableAudit: false });
  }

  async analyzeQuery(query: string): Promise<{
    validation: ValidationResult;
    analysis: QueryAnalysis;
    estimatedRows?: number;
  }> {
    const validation = this.validator.validate(query);
    const analysis = this.validator.getQueryAnalysis(query);

    return {
      validation,
      analysis,
    };
  }
}