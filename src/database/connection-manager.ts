import { DatabaseConfig } from '../types/index.js';
import { DatabaseAdapter, DatabaseType } from './adapters/base/database-adapter.js';
import { createDatabaseAdapter } from './adapters/factory.js';
import { logger } from '../utils/logger.js';

/**
 * 다중 데이터베이스 연결 설정
 */
export interface MultiDatabaseConfig {
  connections: Record<string, DatabaseConnectionConfig>;
  defaultConnection?: string | undefined;
}

export interface DatabaseConnectionConfig extends DatabaseConfig {
  name: string;
  description?: string;
  tags?: string[];
}

/**
 * 다중 데이터베이스 연결 관리자
 * MSA 환경에서 여러 데이터베이스를 효율적으로 관리
 */
export class DatabaseConnectionManager {
  private connections = new Map<string, DatabaseAdapter>();
  private config: MultiDatabaseConfig;
  private defaultConnectionName?: string | undefined;

  constructor(config: MultiDatabaseConfig) {
    this.config = config;
    this.defaultConnectionName = config.defaultConnection || undefined;
  }

  /**
   * 모든 데이터베이스에 연결
   */
  async connectAll(): Promise<void> {
    const connectionPromises = Object.entries(this.config.connections).map(
      async ([name, connectionConfig]) => {
        try {
          logger.info('Connecting to database', {
            name,
            host: connectionConfig.host,
            database: connectionConfig.database,
            type: connectionConfig.type
          });

          const adapter = createDatabaseAdapter(connectionConfig);
          await adapter.connect();

          this.connections.set(name, adapter);

          logger.info('Database connected successfully', {
            name,
            adapterId: adapter.id
          });
        } catch (error) {
          logger.error('Failed to connect to database', {
            name,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          throw new Error(`Failed to connect to database '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    );

    await Promise.all(connectionPromises);

    logger.info('All databases connected', {
      connectionCount: this.connections.size,
      connectionNames: Array.from(this.connections.keys())
    });
  }

  /**
   * 모든 데이터베이스 연결 해제
   */
  async disconnectAll(): Promise<void> {
    const disconnectionPromises = Array.from(this.connections.entries()).map(
      async ([name, adapter]) => {
        try {
          await adapter.disconnect();
          logger.info('Database disconnected', { name, adapterId: adapter.id });
        } catch (error) {
          logger.error('Error disconnecting database', {
            name,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    );

    await Promise.all(disconnectionPromises);
    this.connections.clear();

    logger.info('All databases disconnected');
  }

  /**
   * 특정 데이터베이스 어댑터 조회
   */
  getConnection(name?: string): DatabaseAdapter {
    const connectionName = name || this.defaultConnectionName;

    if (!connectionName) {
      throw new Error('No connection name specified and no default connection configured');
    }

    const adapter = this.connections.get(connectionName);
    if (!adapter) {
      throw new Error(`Database connection '${connectionName}' not found. Available: ${Array.from(this.connections.keys()).join(', ')}`);
    }

    return adapter;
  }

  /**
   * 연결된 모든 데이터베이스 목록 조회
   */
  getConnectionNames(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * 연결 정보 조회
   */
  getConnectionInfo(name?: string): {
    name: string;
    host: string;
    port: number;
    database: string;
    type: DatabaseType;
    ssl: boolean;
    isConnected: boolean;
    description?: string | undefined;
    tags?: string[] | undefined;
  } {
    const connectionName = name || this.defaultConnectionName;
    if (!connectionName) {
      throw new Error('No connection name specified');
    }

    const adapter = this.getConnection(connectionName);
    const connectionConfig = this.config.connections[connectionName];
    const connectionInfo = adapter.getConnectionInfo();

    return {
      name: connectionName,
      ...connectionInfo,
      isConnected: true,
      description: connectionConfig?.description || undefined,
      tags: connectionConfig?.tags || undefined
    };
  }

  /**
   * 모든 연결의 정보 조회
   */
  getAllConnectionsInfo(): Array<{
    name: string;
    host: string;
    port: number;
    database: string;
    type: DatabaseType;
    ssl: boolean;
    isConnected: boolean;
    description?: string | undefined;
    tags?: string[] | undefined;
  }> {
    return this.getConnectionNames().map(name => this.getConnectionInfo(name));
  }

  /**
   * 헬스체크 수행
   */
  async healthCheckAll(): Promise<Record<string, {
    isHealthy: boolean;
    responseTime: number;
    error?: string;
  }>> {
    const healthChecks = Object.fromEntries(
      await Promise.all(
        Array.from(this.connections.entries()).map(async ([name, adapter]) => {
          try {
            const health = await adapter.healthCheck();
            return [name, {
              isHealthy: health.isHealthy,
              responseTime: health.responseTime,
              error: health.error
            }];
          } catch (error) {
            return [name, {
              isHealthy: false,
              responseTime: 0,
              error: error instanceof Error ? error.message : 'Unknown error'
            }];
          }
        })
      )
    );

    return healthChecks;
  }

  /**
   * 태그로 연결 필터링
   */
  getConnectionsByTag(tag: string): string[] {
    return Object.entries(this.config.connections)
      .filter(([, config]) => config.tags?.includes(tag))
      .map(([name]) => name)
      .filter(name => this.connections.has(name));
  }

  /**
   * 데이터베이스 타입별 연결 필터링
   */
  getConnectionsByType(type: DatabaseType): string[] {
    return Array.from(this.connections.entries())
      .filter(([, adapter]) => adapter.type === type)
      .map(([name]) => name);
  }

  /**
   * 기본 연결 설정
   */
  setDefaultConnection(name: string): void {
    if (!this.connections.has(name)) {
      throw new Error(`Connection '${name}' not found`);
    }
    this.defaultConnectionName = name;
    logger.info('Default connection updated', { defaultConnection: name });
  }

  /**
   * 현재 기본 연결 조회
   */
  getDefaultConnection(): string | undefined {
    return this.defaultConnectionName;
  }

  /**
   * 연결 통계 조회
   */
  getStatistics(): {
    totalConnections: number;
    connectionsByType: Record<DatabaseType, number>;
    connectionsByTag: Record<string, number>;
    healthyConnections: number;
  } {
    const connectionsByType: Record<string, number> = {};
    const connectionsByTag: Record<string, number> = {};

    for (const [name, adapter] of this.connections) {
      // 타입별 카운트
      connectionsByType[adapter.type] = (connectionsByType[adapter.type] || 0) + 1;

      // 태그별 카운트
      const config = this.config.connections[name];
      if (config?.tags) {
        for (const tag of config.tags) {
          connectionsByTag[tag] = (connectionsByTag[tag] || 0) + 1;
        }
      }
    }

    return {
      totalConnections: this.connections.size,
      connectionsByType: connectionsByType as Record<DatabaseType, number>,
      connectionsByTag,
      healthyConnections: this.connections.size // 연결된 것은 모두 healthy로 가정
    };
  }

  /**
   * 연결 관리자 정보 조회
   */
  getManagerInfo(): {
    totalConnections: number;
    connectedDatabases: string[];
    defaultConnection?: string | undefined;
    supportedTypes: DatabaseType[];
  } {
    const supportedTypes = Array.from(
      new Set(Array.from(this.connections.values()).map(adapter => adapter.type))
    ) as DatabaseType[];

    return {
      totalConnections: this.connections.size,
      connectedDatabases: this.getConnectionNames(),
      defaultConnection: this.defaultConnectionName || undefined,
      supportedTypes
    };
  }
}