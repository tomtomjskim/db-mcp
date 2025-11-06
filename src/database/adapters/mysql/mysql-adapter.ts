import mysql from 'mysql2/promise';
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
import { MySQLSchemaAnalyzer } from './mysql-schema-analyzer.js';
import { MySQLDataProfiler } from './mysql-data-profiler.js';

/**
 * MySQL 데이터베이스 어댑터
 * MySQL 특화 기능을 제공하는 어댑터 구현
 */
export class MySQLAdapter extends EventEmitter implements EventEmittingAdapter {
  readonly type: DatabaseType = 'mysql';
  readonly id: string;

  private pool: mysql.Pool | null = null;
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
  private schemaAnalyzer: MySQLSchemaAnalyzer;
  private dataProfiler: MySQLDataProfiler;
  private isShuttingDown = false;

  constructor(options: AdapterOptions) {
    super();
    this.options = options;
    this.config = options.config;
    this.id = `mysql-${this.config.host}-${this.config.port}-${this.config.database}`;

    // 연결 상태 초기화
    this.connectionStatus = {
      isConnected: false,
      connectionCount: 0,
      activeQueries: 0,
      lastConnectionTime: new Date(),
      uptime: 0,
      databaseType: 'mysql'
    };

    // 메트릭스 초기화
    this.resetMetrics();

    // 분석기 및 프로파일러 초기화
    this.schemaAnalyzer = new MySQLSchemaAnalyzer(this);
    this.dataProfiler = new MySQLDataProfiler(this);

    logger.info('MySQL adapter initialized', {
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
      logger.warn('MySQL adapter already connected', { id: this.id });
      return;
    }

    try {
      logConnection('connect', {
        host: this.config.host,
        database: this.config.database,
        adapter: 'mysql'
      });

      const poolConfig: mysql.PoolOptions = {
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        waitForConnections: true,
        connectionLimit: this.options.poolOptions?.max || 10,
        queueLimit: 0,
        idleTimeout: this.options.poolOptions?.idleTimeoutMillis || 300000,
        // acquireTimeout은 mysql2에서 지원하지 않는 옵션이므로 제거
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      };

      // SSL 설정
      if (this.config.ssl) {
        poolConfig.ssl = {
          rejectUnauthorized: this.config.ssl.mode === 'REQUIRED',
        };

        if (this.config.ssl.ca) {
          poolConfig.ssl.ca = this.config.ssl.ca;
        }
        if (this.config.ssl.cert) {
          poolConfig.ssl.cert = this.config.ssl.cert;
        }
        if (this.config.ssl.key) {
          poolConfig.ssl.key = this.config.ssl.key;
        }
      }

      this.pool = mysql.createPool(poolConfig);

      // 연결 테스트
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      // 연결 상태 업데이트
      this.connectionStatus.isConnected = true;
      this.connectionStatus.lastConnectionTime = new Date();
      this.connectionStatus.connectionCount = this.pool.pool.config.connectionLimit || 0;

      this.emit('connected', { adapter: this.id, type: 'mysql' });

      logger.info('MySQL adapter connected successfully', {
        id: this.id,
        connectionLimit: poolConfig.connectionLimit
      });

    } catch (error) {
      this.connectionStatus.isConnected = false;
      this.emit('disconnected', { adapter: this.id, error });

      logger.error('Failed to connect MySQL adapter', {
        id: this.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw new Error(`MySQL connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 데이터베이스 연결 해제
   */
  async disconnect(): Promise<void> {
    if (!this.pool) {
      logger.warn('MySQL adapter not connected', { id: this.id });
      return;
    }

    try {
      this.isShuttingDown = true;

      logConnection('disconnect', {
        host: this.config.host,
        database: this.config.database,
        adapter: 'mysql'
      });

      await this.pool.end();
      this.pool = null;

      this.connectionStatus.isConnected = false;
      this.connectionStatus.connectionCount = 0;
      this.connectionStatus.activeQueries = 0;

      this.emit('disconnected', { adapter: this.id });

      logger.info('MySQL adapter disconnected', { id: this.id });

    } catch (error) {
      logger.error('Error disconnecting MySQL adapter', {
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
      throw new Error('MySQL adapter not connected');
    }

    if (this.isShuttingDown) {
      throw new Error('MySQL adapter is shutting down');
    }

    const startTime = Date.now();
    this.connectionStatus.activeQueries++;

    try {
      const [rows, fields] = await this.pool.execute(sql, params || []);
      const executionTime = Date.now() - startTime;

      // 메트릭스 업데이트
      this.updateMetrics(true, executionTime);

      const result: QueryResult = {
        rows: Array.isArray(rows) ? rows : [],
        fields: fields || [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
        executionTime,
        metadata: {
          adapter: 'mysql',
          query: sql.substring(0, 100) + (sql.length > 100 ? '...' : ''),
          params: params?.length || 0
        }
      };

      this.emit('query_executed', {
        adapter: this.id,
        sql: sql.substring(0, 100),
        executionTime,
        rowCount: result.rowCount
      });

      logger.debug('MySQL query executed', {
        id: this.id,
        executionTime,
        rowCount: result.rowCount,
        query: sql.substring(0, 100)
      });

      return result;

    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.updateMetrics(false, executionTime);

      this.emit('query_failed', {
        adapter: this.id,
        sql: sql.substring(0, 100),
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      logger.error('MySQL query failed', {
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
      throw new Error('MySQL adapter not connected');
    }

    const connection = await this.pool.getConnection();
    const results: QueryResult[] = [];

    try {
      await connection.beginTransaction();

      for (const query of queries) {
        const startTime = Date.now();
        this.connectionStatus.activeQueries++;

        try {
          const [rows, fields] = await connection.execute(query.sql, query.params || []);
          const executionTime = Date.now() - startTime;

          results.push({
            rows: Array.isArray(rows) ? rows : [],
            fields: fields || [],
            rowCount: Array.isArray(rows) ? rows.length : 0,
            executionTime,
            metadata: {
              adapter: 'mysql',
              transaction: true,
              query: query.sql.substring(0, 100)
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

      await connection.commit();

      logger.debug('MySQL transaction completed', {
        id: this.id,
        queryCount: queries.length,
        totalRows: results.reduce((sum, r) => sum + r.rowCount, 0)
      });

      return results;

    } catch (error) {
      await connection.rollback();

      logger.error('MySQL transaction failed', {
        id: this.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        queryCount: queries.length
      });

      throw error;

    } finally {
      connection.release();
    }
  }

  /**
   * 연결 상태 조회
   */
  async getConnectionStatus(): Promise<ConnectionStatus> {
    if (this.pool) {
      this.connectionStatus.connectionCount = this.pool.pool.config.connectionLimit || 0;
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

      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      const responseTime = Date.now() - startTime;

      const healthStatus: HealthStatus = {
        isHealthy: true,
        responseTime,
        lastCheck: new Date(),
        details: {
          connectionPool: {
            total: this.pool.pool.config.connectionLimit || 0,
            active: 0, // mysql2에서 직접 제공하지 않음
            idle: 0    // mysql2에서 직접 제공하지 않음
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
   * 내부 연결 풀 접근 (MySQL 특화 기능용)
   */
  getPool(): mysql.Pool | null {
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