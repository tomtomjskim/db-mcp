import { createRequire } from 'module';
import { DatabaseConfig } from '../../types/index.js';
import { DatabaseAdapter, DatabaseType, AdapterOptions } from './base/database-adapter.js';
import { MySQLAdapter } from './mysql/mysql-adapter.js';
import { PostgreSQLAdapter } from './postgresql/postgresql-adapter.js';

const require = createRequire(import.meta.url);

/**
 * 어댑터 등록 정보
 */
interface AdapterRegistration {
  type: DatabaseType;
  adapterClass: new (options: AdapterOptions) => DatabaseAdapter;
  isAvailable: () => boolean;
}

/**
 * 데이터베이스 어댑터 팩토리
 * 설정에 따라 적절한 데이터베이스 어댑터를 생성
 */
export class DatabaseAdapterFactory {
  private static instance: DatabaseAdapterFactory;
  private registeredAdapters: Map<DatabaseType, AdapterRegistration>;

  private constructor() {
    this.registeredAdapters = new Map();
    this.registerDefaultAdapters();
  }

  /**
   * 싱글톤 인스턴스 반환
   */
  static getInstance(): DatabaseAdapterFactory {
    if (!DatabaseAdapterFactory.instance) {
      DatabaseAdapterFactory.instance = new DatabaseAdapterFactory();
    }
    return DatabaseAdapterFactory.instance;
  }

  /**
   * 기본 어댑터들 등록
   */
  private registerDefaultAdapters(): void {
    // MySQL 어댑터 등록
    this.registerAdapter({
      type: 'mysql',
      adapterClass: MySQLAdapter,
      isAvailable: () => {
        try {
          require('mysql2');
          return true;
        } catch {
          return false;
        }
      }
    });

    // PostgreSQL 어댑터 등록
    this.registerAdapter({
      type: 'postgresql',
      adapterClass: PostgreSQLAdapter,
      isAvailable: () => {
        try {
          require('pg');
          return true;
        } catch {
          return false;
        }
      }
    });
  }

  /**
   * 어댑터 등록
   */
  registerAdapter(registration: AdapterRegistration): void {
    this.registeredAdapters.set(registration.type, registration);
  }

  /**
   * 데이터베이스 설정에서 타입 자동 감지
   */
  detectDatabaseType(config: DatabaseConfig): DatabaseType {
    // 명시적으로 타입이 지정된 경우
    if ('type' in config && config.type) {
      return config.type as DatabaseType;
    }

    // 포트나 호스트 정보로 추측
    if (config.port === 3306 || config.host?.includes('mysql')) {
      return 'mysql';
    }

    if (config.port === 5432 || config.host?.includes('postgres')) {
      return 'postgresql';
    }

    // 기본값은 MySQL
    return 'mysql';
  }

  /**
   * 어댑터 생성
   */
  createAdapter(config: DatabaseConfig, options?: Partial<AdapterOptions>): DatabaseAdapter {
    const type = this.detectDatabaseType(config);
    const registration = this.registeredAdapters.get(type);

    if (!registration) {
      throw new Error(`Unsupported database type: ${type}`);
    }

    if (!registration.isAvailable()) {
      throw new Error(
        `Database driver for ${type} is not available. Please install the required package.`
      );
    }

    const adapterOptions: AdapterOptions = {
      config,
      type,
      poolOptions: {
        min: 2,
        max: config.connectionLimit || 10,
        idleTimeoutMillis: config.idleTimeout || 300000,
        acquireTimeoutMillis: config.acquireTimeout || 60000,
        ...options?.poolOptions
      },
      retryOptions: {
        retries: 3,
        minTimeout: 1000,
        maxTimeout: 5000,
        ...options?.retryOptions
      },
      metricsEnabled: options?.metricsEnabled ?? true,
      ...options
    };

    return new registration.adapterClass(adapterOptions);
  }

  /**
   * 지원되는 데이터베이스 타입 목록 반환
   */
  getSupportedTypes(): DatabaseType[] {
    return Array.from(this.registeredAdapters.keys());
  }

  /**
   * 특정 타입의 어댑터 사용 가능 여부 확인
   */
  isTypeSupported(type: DatabaseType): boolean {
    const registration = this.registeredAdapters.get(type);
    return registration ? registration.isAvailable() : false;
  }

  /**
   * 사용 가능한 어댑터 목록 반환
   */
  getAvailableAdapters(): DatabaseType[] {
    return Array.from(this.registeredAdapters.entries())
      .filter(([, registration]) => registration.isAvailable())
      .map(([type]) => type);
  }

  /**
   * 어댑터 정보 조회
   */
  getAdapterInfo(type: DatabaseType): {
    type: DatabaseType;
    available: boolean;
    requiredPackage?: string;
  } {
    const registration = this.registeredAdapters.get(type);

    const packageMap: Record<DatabaseType, string> = {
      mysql: 'mysql2',
      postgresql: 'pg',
      sqlite: 'sqlite3'
    };

    return {
      type,
      available: registration ? registration.isAvailable() : false,
      requiredPackage: packageMap[type]
    };
  }

  /**
   * 팩토리 상태 정보 반환
   */
  getFactoryInfo(): {
    supportedTypes: DatabaseType[];
    availableTypes: DatabaseType[];
    registeredCount: number;
  } {
    return {
      supportedTypes: this.getSupportedTypes(),
      availableTypes: this.getAvailableAdapters(),
      registeredCount: this.registeredAdapters.size
    };
  }
}

/**
 * 편의 함수: 어댑터 생성
 */
export function createDatabaseAdapter(
  config: DatabaseConfig,
  options?: Partial<AdapterOptions>
): DatabaseAdapter {
  return DatabaseAdapterFactory.getInstance().createAdapter(config, options);
}

/**
 * 편의 함수: 지원되는 데이터베이스 타입 조회
 */
export function getSupportedDatabaseTypes(): DatabaseType[] {
  return DatabaseAdapterFactory.getInstance().getSupportedTypes();
}

/**
 * 편의 함수: 사용 가능한 데이터베이스 타입 조회
 */
export function getAvailableDatabaseTypes(): DatabaseType[] {
  return DatabaseAdapterFactory.getInstance().getAvailableAdapters();
}