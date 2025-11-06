import { Pool, PoolConfig, PoolClient } from 'pg';
import { EventEmitter } from 'events';
import {
  DatabaseAdapter,
  DatabaseType,
  ConnectionStatus,
  HealthStatus,
  AdapterMetrics,
  AdapterOptions,
  SchemaAnalyzerBase,
  DataProfilerBase,
  EventEmittingAdapter,
  AdapterEventType,
  AdapterEventListener
} from '../base/database-adapter.js';
import { QueryResult, DatabaseConfig } from '../../../types/index.js';
import { logger, logConnection } from '../../../utils/logger.js';
import { PostgreSQLSchemaAnalyzer } from './postgresql-schema-analyzer.js';
import { PostgreSQLDataProfiler } from './postgresql-data-profiler.js';

/**
 * PostgreSQL 데이터베이스 어댑터
 * PostgreSQL 특화 기능을 제공하는 어댑터 구현
 */
export class PostgreSQLAdapter extends EventEmitter implements EventEmittingAdapter {
  readonly type: DatabaseType = 'postgresql';
  readonly id: string;

  private pool: Pool | null = null;
  private config: DatabaseConfig;
  private options: AdapterOptions;
  private connectionStatus: ConnectionStatus;
  private metrics: AdapterMetrics = {
    queriesExecuted: 0,
    totalExecutionTime: 0,
    averageExecutionTime: 0,
    errorCount: 0,
    successRate: 0,
    lastMetricsReset: new Date()
  };
  private schemaAnalyzer: PostgreSQLSchemaAnalyzer;
  private dataProfiler: PostgreSQLDataProfiler;
  private isShuttingDown = false;

  constructor(options: AdapterOptions) {
    super();
    this.options = options;
    this.config = options.config;
    this.id = `postgresql-${this.config.host}-${this.config.port}-${this.config.database}`;

    // 연결 상태 초기화
    this.connectionStatus = {
      isConnected: false,
      connectionCount: 0,
      activeQueries: 0,
      lastConnectionTime: new Date(),
      uptime: 0,
      databaseType: 'postgresql'
    };

    // 메트릭스 초기화
    this.resetMetrics();

    // 분석기 및 프로파일러 초기화
    this.schemaAnalyzer = new PostgreSQLSchemaAnalyzer(this);
    this.dataProfiler = new PostgreSQLDataProfiler(this);

    logger.info('PostgreSQL adapter initialized', {
      id: this.id,
      host: this.config.host,
      database: this.config.database
    });
  }

  /**
   * 데이터베이스 연결
   */
  async connect(): Promise<void> {
    if (this.pool) {
      logger.warn('PostgreSQL adapter already connected', { id: this.id });
      return;
    }

    try {
      logConnection('connect', {
        host: this.config.host,
        database: this.config.database,
        adapter: 'postgresql'
      });

      const poolConfig: PoolConfig = {
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        max: this.options.poolOptions?.max || 10,
        min: this.options.poolOptions?.min || 2,
        idleTimeoutMillis: this.options.poolOptions?.idleTimeoutMillis || 300000,
        connectionTimeoutMillis: this.config.connectionTimeout || 30000,
        statement_timeout: this.config.timeout || 0,
        query_timeout: this.config.timeout || 0,
        keepAlive: true,
        keepAliveInitialDelayMillis: 0,
      };

      // SSL 설정
      if (this.config.ssl) {
        let sslConfig: any = {};

        if (this.config.ssl.mode === 'REQUIRED') {
          sslConfig.rejectUnauthorized = true;
        } else if (this.config.ssl.mode === 'PREFERRED') {
          sslConfig.rejectUnauthorized = false;
        }

        if (this.config.ssl.ca) {
          sslConfig.ca = this.config.ssl.ca;
        }
        if (this.config.ssl.cert) {
          sslConfig.cert = this.config.ssl.cert;
        }
        if (this.config.ssl.key) {
          sslConfig.key = this.config.ssl.key;
        }

        poolConfig.ssl = sslConfig;
      }

      this.pool = new Pool(poolConfig);

      // 풀 이벤트 리스너 설정
      this.pool.on('error', (err) => {
        logger.error('PostgreSQL pool error', {
          id: this.id,
          error: err.message
        });
        this.emit('query_failed', { adapter: this.id, error: err.message });
      });

      this.pool.on('connect', () => {
        logger.debug('New PostgreSQL client connected', { id: this.id });
      });

      this.pool.on('remove', () => {
        logger.debug('PostgreSQL client removed from pool', { id: this.id });
      });

      // 연결 테스트
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();

      // 연결 상태 업데이트
      this.connectionStatus.isConnected = true;
      this.connectionStatus.lastConnectionTime = new Date();
      this.connectionStatus.connectionCount = this.pool.totalCount;

      this.emit('connected', { adapter: this.id, type: 'postgresql' });

      logger.info('PostgreSQL adapter connected successfully', {
        id: this.id,
        maxConnections: poolConfig.max
      });

    } catch (error) {
      this.connectionStatus.isConnected = false;
      this.emit('disconnected', { adapter: this.id, error });

      logger.error('Failed to connect PostgreSQL adapter', {
        id: this.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw new Error(`PostgreSQL connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 데이터베이스 연결 해제
   */
  async disconnect(): Promise<void> {
    if (!this.pool) {
      logger.warn('PostgreSQL adapter not connected', { id: this.id });
      return;
    }

    try {
      this.isShuttingDown = true;

      logConnection('disconnect', {
        host: this.config.host,
        database: this.config.database,
        adapter: 'postgresql'
      });

      await this.pool.end();
      this.pool = null;

      this.connectionStatus.isConnected = false;
      this.connectionStatus.connectionCount = 0;
      this.connectionStatus.activeQueries = 0;

      this.emit('disconnected', { adapter: this.id });

      logger.info('PostgreSQL adapter disconnected', { id: this.id });

    } catch (error) {
      logger.error('Error disconnecting PostgreSQL adapter', {
        id: this.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 쿼리 실행
   */
  async query(sql: string, params?: any[]): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('PostgreSQL adapter not connected');
    }

    if (this.isShuttingDown) {
      throw new Error('PostgreSQL adapter is shutting down');
    }

    const startTime = Date.now();
    this.connectionStatus.activeQueries++;

    try {
      const result = await this.pool.query(sql, params || []);
      const executionTime = Date.now() - startTime;

      // 메트릭스 업데이트
      this.updateMetrics(true, executionTime);

      const queryResult: QueryResult = {
        rows: result.rows || [],
        fields: result.fields ? result.fields.map(field => ({
          name: field.name,
          type: field.dataTypeID,
          nullable: true // PostgreSQL은 기본적으로 필드 메타데이터에서 nullable 정보를 제공하지 않음
        })) : [],
        rowCount: result.rowCount || result.rows?.length || 0,
        executionTime,
        metadata: {
          adapter: 'postgresql',
          query: sql.substring(0, 100) + (sql.length > 100 ? '...' : ''),
          params: params?.length || 0,
          command: result.command
        }
      };

      this.emit('query_executed', {
        adapter: this.id,
        sql: sql.substring(0, 100),
        executionTime,
        rowCount: queryResult.rowCount
      });

      logger.debug('PostgreSQL query executed', {
        id: this.id,
        executionTime,
        rowCount: queryResult.rowCount,
        query: sql.substring(0, 100)
      });

      return queryResult;

    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.updateMetrics(false, executionTime);

      this.emit('query_failed', {
        adapter: this.id,
        sql: sql.substring(0, 100),
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      logger.error('PostgreSQL query failed', {
        id: this.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        query: sql.substring(0, 100)
      });

      throw error;

    } finally {
      this.connectionStatus.activeQueries--;
    }
  }

  /**
   * 트랜잭션 실행
   */
  async transaction(queries: Array<{ sql: string; params?: any[] }>): Promise<QueryResult[]> {
    if (!this.pool) {
      throw new Error('PostgreSQL adapter not connected');
    }

    const client = await this.pool.connect();
    const results: QueryResult[] = [];

    try {
      await client.query('BEGIN');

      for (const query of queries) {
        const startTime = Date.now();
        this.connectionStatus.activeQueries++;

        try {
          const result = await client.query(query.sql, query.params || []);
          const executionTime = Date.now() - startTime;

          results.push({
            rows: result.rows || [],
            fields: result.fields ? result.fields.map(field => ({
              name: field.name,
              type: field.dataTypeID,
              nullable: true
            })) : [],
            rowCount: result.rowCount || result.rows?.length || 0,
            executionTime,
            metadata: {
              adapter: 'postgresql',
              transaction: true,
              query: query.sql.substring(0, 100),
              command: result.command
            }
          });

          this.updateMetrics(true, executionTime);

        } catch (error) {
          this.updateMetrics(false, Date.now() - startTime);
          throw error;
        } finally {
          this.connectionStatus.activeQueries--;
        }
      }

      await client.query('COMMIT');

      logger.debug('PostgreSQL transaction completed', {
        id: this.id,
        queryCount: queries.length,
        totalRows: results.reduce((sum, r) => sum + r.rowCount, 0)
      });

      return results;

    } catch (error) {
      await client.query('ROLLBACK');

      logger.error('PostgreSQL transaction failed', {
        id: this.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        queryCount: queries.length
      });

      throw error;

    } finally {
      client.release();
    }
  }

  /**
   * 연결 상태 조회
   */
  async getConnectionStatus(): Promise<ConnectionStatus> {
    if (this.pool) {
      this.connectionStatus.connectionCount = this.pool.totalCount;
      this.connectionStatus.uptime = Date.now() - this.connectionStatus.lastConnectionTime.getTime();
    }

    return { ...this.connectionStatus };
  }

  /**
   * 헬스체크 수행
   */
  async healthCheck(): Promise<HealthStatus> {
    const startTime = Date.now();

    try {
      if (!this.pool) {
        return {
          isHealthy: false,
          responseTime: Date.now() - startTime,
          lastCheck: new Date(),
          error: 'Not connected'
        };
      }

      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();

      const responseTime = Date.now() - startTime;

      const healthStatus: HealthStatus = {
        isHealthy: true,
        responseTime,
        lastCheck: new Date(),
        details: {
          connectionPool: {
            total: this.pool.totalCount,
            active: this.pool.totalCount - this.pool.idleCount,
            idle: this.pool.idleCount
          },
          performance: {
            avgQueryTime: this.metrics.averageExecutionTime,
            slowQueries: 0 // TODO: 구현 필요
          }
        }
      };

      this.emit('health_check_passed', { adapter: this.id, responseTime });

      return healthStatus;

    } catch (error) {
      const healthStatus: HealthStatus = {
        isHealthy: false,
        responseTime: Date.now() - startTime,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };

      this.emit('health_check_failed', { adapter: this.id, error: healthStatus.error });

      return healthStatus;
    }
  }

  /**
   * 스키마 분석기 반환
   */
  getSchemaAnalyzer(): SchemaAnalyzerBase {
    return this.schemaAnalyzer;
  }

  /**
   * 데이터 프로파일러 반환
   */
  getDataProfiler(): DataProfilerBase {
    return this.dataProfiler;
  }

  /**
   * 메트릭스 조회
   */
  getMetrics(): AdapterMetrics {
    return { ...this.metrics };
  }

  /**
   * 메트릭스 초기화
   */
  resetMetrics(): void {
    this.metrics = {
      queriesExecuted: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0,
      errorCount: 0,
      successRate: 0,
      lastMetricsReset: new Date()
    };
  }

  /**
   * 연결 정보 조회
   */
  getConnectionInfo(): {
    host: string;
    port: number;
    database: string;
    type: DatabaseType;
    ssl: boolean;
    connectionLimit?: number;
  } {
    return {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database!,
      type: this.type,
      ssl: !!this.config.ssl,
      ...(this.options.poolOptions?.max ? { connectionLimit: this.options.poolOptions.max } : {})
    };
  }

  /**
   * 이벤트 리스너 등록 (타입 안전성 확보)
   */
  on(event: AdapterEventType, listener: AdapterEventListener): this {
    super.on(event, listener);
    return this;
  }

  /**
   * 이벤트 리스너 제거 (타입 안전성 확보)
   */
  off(event: AdapterEventType, listener: AdapterEventListener): this {
    super.off(event, listener);
    return this;
  }

  /**
   * 이벤트 발생 (타입 안전성 확보)
   */
  emit(event: AdapterEventType, data?: any): boolean {
    return super.emit(event, data);
  }

  /**
   * 내부 연결 풀 접근 (PostgreSQL 특화 기능용)
   */
  getPool(): Pool | null {
    return this.pool;
  }

  /**
   * 메트릭스 업데이트
   */
  private updateMetrics(success: boolean, executionTime: number): void {
    if (!this.options.metricsEnabled) return;

    this.metrics.queriesExecuted++;
    this.metrics.totalExecutionTime += executionTime;
    this.metrics.averageExecutionTime = this.metrics.totalExecutionTime / this.metrics.queriesExecuted;

    if (!success) {
      this.metrics.errorCount++;
    }

    this.metrics.successRate = ((this.metrics.queriesExecuted - this.metrics.errorCount) / this.metrics.queriesExecuted) * 100;

    // 주기적으로 메트릭스 이벤트 발생
    if (this.metrics.queriesExecuted % 100 === 0) {
      this.emit('metrics_collected', { adapter: this.id, metrics: this.getMetrics() });
    }
  }
}