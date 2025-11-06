import { securityConfig } from '../config/index.js';
import { logger, logSecurityEvent } from '../utils/logger.js';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedQuery?: string;
}

export interface QueryAnalysis {
  operation: string;
  tables: string[];
  hasSubqueries: boolean;
  hasJoins: boolean;
  hasAggregates: boolean;
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export class QueryValidator {
  private readonly forbiddenKeywords = [
    // DML operations
    'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE',
    // DDL operations
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
    // Transaction control
    'BEGIN', 'COMMIT', 'ROLLBACK', 'START TRANSACTION',
    // User/Session management
    'GRANT', 'REVOKE', 'SET PASSWORD', 'CREATE USER', 'DROP USER',
    // System operations
    'LOAD DATA', 'SELECT ... INTO OUTFILE', 'LOAD_FILE',
    // Stored procedures
    'CALL', 'EXECUTE', 'EXEC',
    // Administrative
    'FLUSH', 'RESET', 'KILL', 'SHUTDOWN',
  ];

  private readonly suspiciousPatterns = [
    // SQL injection patterns
    /('|(\x27)|(\x2D\x2D)|(%27)|(%2D%2D))/i,
    /(\x00|\n|\r|\x1a)/i,
    /(union.*select)/i,
    /(concat.*\()/i,
    /(information_schema)/i,
    /(mysql\.user)/i,
    // File system access
    /(into\s+outfile)/i,
    /(load_file)/i,
    /(@@)/i,
    // Script execution
    /(script)/i,
    /(javascript)/i,
    /(vbscript)/i,
  ];

  private readonly riskyFunctions = [
    'BENCHMARK', 'SLEEP', 'GET_LOCK', 'RELEASE_LOCK',
    'LOAD_FILE', 'UUID', 'RAND', 'CONNECTION_ID',
    'VERSION', 'USER', 'DATABASE', 'SCHEMA',
  ];

  validate(query: string): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    try {
      // Basic input validation
      this.validateBasicInput(query, result);
      if (!result.isValid) return result;

      // Normalize query for analysis
      const normalizedQuery = this.normalizeQuery(query);

      // Check forbidden keywords
      this.checkForbiddenKeywords(normalizedQuery, result);

      // Check suspicious patterns
      this.checkSuspiciousPatterns(normalizedQuery, result);

      // Check risky functions
      this.checkRiskyFunctions(normalizedQuery, result);

      // Analyze query complexity
      const analysis = this.analyzeQuery(normalizedQuery);
      this.checkComplexity(analysis, result);

      // Additional security checks
      this.performAdvancedValidation(normalizedQuery, result);

      // Log security events if needed
      if (result.errors.length > 0 || result.warnings.length > 0) {
        logSecurityEvent('query_validation', {
          query: query.substring(0, 200),
          errors: result.errors,
          warnings: result.warnings,
        });
      }

      result.sanitizedQuery = normalizedQuery;

    } catch (error) {
      result.isValid = false;
      result.errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      logger.error('Query validation failed', { error, query: query.substring(0, 100) });
    }

    return result;
  }

  private validateBasicInput(query: string, result: ValidationResult): void {
    if (!query || typeof query !== 'string') {
      result.isValid = false;
      result.errors.push('Query must be a non-empty string');
      return;
    }

    if (query.length > securityConfig.maxQueryLength) {
      result.isValid = false;
      result.errors.push(`Query exceeds maximum length of ${securityConfig.maxQueryLength} characters`);
      return;
    }

    if (query.trim().length === 0) {
      result.isValid = false;
      result.errors.push('Query cannot be empty or whitespace only');
      return;
    }
  }

  private normalizeQuery(query: string): string {
    return query
      .trim()
      .replace(/\s+/g, ' ')  // Replace multiple whitespace with single space
      .replace(/--.*$/gm, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
      .trim();
  }

  private checkForbiddenKeywords(query: string, result: ValidationResult): void {
    const queryUpper = query.toUpperCase();
    const words = queryUpper.split(/\s+/);

    for (const keyword of this.forbiddenKeywords) {
      if (words.includes(keyword) || queryUpper.includes(keyword)) {
        result.isValid = false;
        result.errors.push(`Forbidden keyword detected: ${keyword}`);
      }
    }

    // Check for allowed operations
    const firstWord = words[0];
    if (firstWord && !securityConfig.allowedKeywords.includes(firstWord)) {
      result.isValid = false;
      result.errors.push(`Operation '${firstWord}' is not allowed. Only read-only operations are permitted.`);
    }
  }

  private checkSuspiciousPatterns(query: string, result: ValidationResult): void {
    for (const pattern of this.suspiciousPatterns) {
      if (pattern.test(query)) {
        result.isValid = false;
        result.errors.push(`Suspicious pattern detected: ${pattern.source}`);
      }
    }
  }

  private checkRiskyFunctions(query: string, result: ValidationResult): void {
    const queryUpper = query.toUpperCase();

    for (const func of this.riskyFunctions) {
      if (queryUpper.includes(func + '(')) {
        result.warnings.push(`Risky function detected: ${func}()`);
      }
    }
  }

  private analyzeQuery(query: string): QueryAnalysis {
    const queryUpper = query.toUpperCase();

    // Extract operation
    const operation = queryUpper.split(/\s+/)[0] || 'UNKNOWN';

    // Extract tables (simplified)
    const fromMatches = query.match(/FROM\s+([\w\.,\s]+)/gi) || [];
    const joinMatches = query.match(/JOIN\s+([\w\.,\s]+)/gi) || [];
    const tables = [...fromMatches, ...joinMatches]
      .map(match => match.replace(/(FROM|JOIN)\s+/gi, '').trim())
      .flatMap(tableList => tableList.split(',').map(t => t.trim()));

    return {
      operation,
      tables: [...new Set(tables)], // Remove duplicates
      hasSubqueries: /\(\s*SELECT/i.test(query),
      hasJoins: /\bJOIN\b/i.test(query),
      hasAggregates: /(COUNT|SUM|AVG|MIN|MAX|GROUP BY)/i.test(query),
      estimatedComplexity: this.estimateComplexity(query),
    };
  }

  private estimateComplexity(query: string): 'low' | 'medium' | 'high' {
    let score = 0;

    // Count various complexity indicators
    score += (query.match(/\bJOIN\b/gi) || []).length * 2;
    score += (query.match(/\bUNION\b/gi) || []).length * 3;
    score += (query.match(/\(\s*SELECT/gi) || []).length * 4;
    score += (query.match(/\bORDER BY\b/gi) || []).length * 1;
    score += (query.match(/\bGROUP BY\b/gi) || []).length * 2;
    score += (query.match(/\bHAVING\b/gi) || []).length * 2;

    if (score <= 3) return 'low';
    if (score <= 8) return 'medium';
    return 'high';
  }

  private checkComplexity(analysis: QueryAnalysis, result: ValidationResult): void {
    if (analysis.estimatedComplexity === 'high') {
      result.warnings.push('High complexity query detected - may impact performance');
    }

    if (analysis.tables.length > 5) {
      result.warnings.push(`Query involves many tables (${analysis.tables.length}) - consider optimization`);
    }

    if (analysis.hasSubqueries) {
      result.warnings.push('Subqueries detected - monitor performance');
    }
  }

  private performAdvancedValidation(query: string, result: ValidationResult): void {
    // Check for potential performance issues
    if (query.match(/SELECT\s+\*\s+FROM/i) && !query.match(/LIMIT/i)) {
      result.warnings.push('SELECT * without LIMIT may return large result sets');
    }

    // Check for missing WHERE clauses on potentially large tables
    if (query.match(/DELETE|UPDATE/i) && !query.match(/WHERE/i)) {
      result.errors.push('DELETE/UPDATE without WHERE clause is not allowed');
    }

    // Check for SQL injection via LIKE patterns
    if (query.match(/LIKE\s*'%.*%'/i)) {
      result.warnings.push('LIKE with leading wildcard may impact performance');
    }

    // Check for potential cartesian products
    const fromCount = (query.match(/FROM/gi) || []).length;
    const joinCount = (query.match(/JOIN/gi) || []).length;
    const whereCount = (query.match(/WHERE/gi) || []).length;

    if (fromCount > 1 && joinCount === 0 && whereCount === 0) {
      result.warnings.push('Potential cartesian product detected - missing JOIN conditions');
    }
  }

  // Utility method to get detailed analysis
  getQueryAnalysis(query: string): QueryAnalysis {
    const normalizedQuery = this.normalizeQuery(query);
    return this.analyzeQuery(normalizedQuery);
  }

  // Method to check if a specific operation is allowed
  isOperationAllowed(operation: string): boolean {
    return securityConfig.allowedKeywords.includes(operation.toUpperCase());
  }

  // Method to get list of forbidden patterns for documentation
  getForbiddenPatterns(): { keywords: string[]; patterns: RegExp[] } {
    return {
      keywords: this.forbiddenKeywords,
      patterns: this.suspiciousPatterns,
    };
  }
}