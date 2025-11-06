import { QueryResult, DatabaseConfig } from '../../../types/index.js';

/**
 * 데이터베이스 타입 열거형
 */
export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite';

/**
 * 연결 상태 정보
 */
export interface ConnectionStatus {
  isConnected: boolean;
  connectionCount: number;
  activeQueries: number;
  lastConnectionTime: Date;
  uptime: number;
  databaseType: DatabaseType;
}

/**
 * 헬스체크 결과
 */
export interface HealthStatus {
  isHealthy: boolean;
  responseTime: number;
  lastCheck: Date;
  error?: string;
  details?: {
    connectionPool?: {
      total: number;
      active: number;
      idle: number;
    };
    performance?: {
      avgQueryTime: number;
      slowQueries: number;
    };
  };
}

/**
 * 어댑터별 통계 정보
 */
export interface AdapterMetrics {
  queriesExecuted: number;
  totalExecutionTime: number;
  averageExecutionTime: number;
  errorCount: number;
  successRate: number;
  lastMetricsReset: Date;
}

/**
 * 데이터베이스 어댑터 기본 인터페이스
 * 모든 데이터베이스 어댑터가 구현해야 하는 표준 인터페이스
 */
export interface DatabaseAdapter {
  /**
   * 데이터베이스 타입
   */
  readonly type: DatabaseType;

  /**
   * 어댑터 고유 식별자
   */
  readonly id: string;

  /**
   * 데이터베이스 연결
   */
  connect(): Promise<void>;

  /**
   * 데이터베이스 연결 해제
   */
  disconnect(): Promise<void>;

  /**
   * 쿼리 실행
   * @param sql SQL 쿼리 문자열
   * @param params 쿼리 파라미터
   * @returns 쿼리 실행 결과
   */
  query(sql: string, params?: any[]): Promise<QueryResult>;

  /**
   * 트랜잭션 실행
   * @param queries 트랜잭션 내에서 실행할 쿼리들
   * @returns 트랜잭션 실행 결과
   */
  transaction(queries: Array<{ sql: string; params?: any[] }>): Promise<QueryResult[]>;

  /**
   * 연결 상태 확인
   */
  getConnectionStatus(): Promise<ConnectionStatus>;

  /**
   * 헬스체크 수행
   */
  healthCheck(): Promise<HealthStatus>;

  /**
   * 스키마 분석기 인스턴스 반환
   */
  getSchemaAnalyzer(): SchemaAnalyzerBase;

  /**
   * 데이터 프로파일러 인스턴스 반환
   */
  getDataProfiler(): DataProfilerBase;

  /**
   * 어댑터 메트릭스 조회
   */
  getMetrics(): AdapterMetrics;

  /**
   * 메트릭스 초기화
   */
  resetMetrics(): void;

  /**
   * 연결 설정 정보 조회 (보안 정보 제외)
   */
  getConnectionInfo(): {
    host: string;
    port: number;
    database: string;
    type: DatabaseType;
    ssl: boolean;
    connectionLimit?: number;
  };
}

/**
 * 스키마 분석기 기본 추상 클래스
 */
export abstract class SchemaAnalyzerBase {
  public adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  /**
   * 전체 스키마 분석
   */
  abstract analyzeFullSchema(options?: any): Promise<any>;

  /**
   * 특정 테이블 분석
   */
  abstract analyzeTable(tableName: string, options?: any): Promise<any>;

  /**
   * 테이블 관계 분석
   */
  abstract getTableRelationships(): Promise<Map<string, string[]>>;

  /**
   * 데이터베이스 정보 조회
   */
  abstract getDatabaseInfo(): Promise<any>;
}

/**
 * 데이터 프로파일러 기본 추상 클래스
 */
export abstract class DataProfilerBase {
  public adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  /**
   * 테이블 데이터 프로파일링
   */
  abstract profileTable(tableName: string, options?: any): Promise<any>;

  /**
   * 컬럼 데이터 분석
   */
  abstract analyzeColumn(tableName: string, columnName: string, options?: any): Promise<any>;

  /**
   * 데이터 품질 점수 계산
   */
  abstract calculateQualityScore(tableName: string): Promise<number>;
}

/**
 * 어댑터 생성 옵션
 */
export interface AdapterOptions {
  config: DatabaseConfig;
  type: DatabaseType;
  poolOptions?: {
    min?: number;
    max?: number;
    idleTimeoutMillis?: number;
    acquireTimeoutMillis?: number;
  };
  retryOptions?: {
    retries?: number;
    minTimeout?: number;
    maxTimeout?: number;
  };
  metricsEnabled?: boolean;
}

/**
 * 어댑터 이벤트 타입
 */
export type AdapterEventType =
  | 'connected'
  | 'disconnected'
  | 'query_executed'
  | 'query_failed'
  | 'health_check_passed'
  | 'health_check_failed'
  | 'metrics_collected';

/**
 * 어댑터 이벤트 리스너
 */
export interface AdapterEventListener {
  (event: AdapterEventType, data?: any): void;
}

/**
 * 이벤트 기반 어댑터 인터페이스
 */
export interface EventEmittingAdapter extends DatabaseAdapter {
  /**
   * 이벤트 리스너 등록
   */
  on(event: AdapterEventType, listener: AdapterEventListener): void;

  /**
   * 이벤트 리스너 제거
   */
  off(event: AdapterEventType, listener: AdapterEventListener): void;

  /**
   * 이벤트 발생
   */
  emit(event: AdapterEventType, data?: any): void;
}