import { readFileSync, existsSync } from 'fs';
import { MultiDatabaseConfig, DatabaseConnectionConfig } from '../database/connection-manager.js';
import { DatabaseConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * 다중 데이터베이스 설정 로더
 * JSON 파일이나 환경변수를 통해 여러 데이터베이스 설정을 로드
 */
export class MultiDatabaseConfigLoader {

  /**
   * JSON 파일에서 다중 DB 설정 로드
   */
  static loadFromFile(configPath: string): MultiDatabaseConfig {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    try {
      const configData = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configData) as MultiDatabaseConfig;

      // 설정 유효성 검사
      this.validateConfig(config);

      logger.info('Multi-database config loaded from file', {
        configPath,
        connectionCount: Object.keys(config.connections).length,
        defaultConnection: config.defaultConnection
      });

      return config;
    } catch (error) {
      logger.error('Failed to load multi-database config from file', {
        configPath,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 환경변수에서 다중 DB 설정 로드
   * 환경변수 패턴: DB_{CONNECTION_NAME}_{PROPERTY}
   */
  static loadFromEnvironment(): MultiDatabaseConfig {
    const connections: Record<string, DatabaseConnectionConfig> = {};
    const processedConnections = new Set<string>();

    // 모든 환경변수를 스캔하여 DB_ 접두사를 찾음
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('DB_') && value) {
        const parts = key.split('_');
        if (parts.length >= 3) {
          const connectionName = parts[1]?.toLowerCase() || '';
          const property = parts.slice(2).join('_').toLowerCase();

          if (!connections[connectionName]) {
            connections[connectionName] = {
              name: connectionName,
              host: '',
              port: 0,
              user: '',
              password: '',
              database: ''
            };
          }

          // 속성 매핑
          switch (property) {
            case 'host':
              connections[connectionName].host = value;
              break;
            case 'port':
              connections[connectionName].port = parseInt(value);
              break;
            case 'user':
              connections[connectionName].user = value;
              break;
            case 'password':
              connections[connectionName].password = value;
              break;
            case 'database':
            case 'db':
              connections[connectionName].database = value;
              break;
            case 'type':
              connections[connectionName].type = value as any;
              break;
            case 'description':
              connections[connectionName].description = value;
              break;
            case 'tags':
              connections[connectionName].tags = value.split(',').map(t => t.trim());
              break;
            case 'ssl_mode':
              if (!connections[connectionName].ssl) {
                connections[connectionName].ssl = {};
              }
              connections[connectionName].ssl!.mode = value as any;
              break;
            case 'ssl_ca':
              if (!connections[connectionName].ssl) {
                connections[connectionName].ssl = {};
              }
              connections[connectionName].ssl!.ca = value;
              break;
            case 'connection_timeout':
              connections[connectionName].connectionTimeout = parseInt(value);
              break;
            case 'connection_limit':
              connections[connectionName].connectionLimit = parseInt(value);
              break;
            case 'idle_timeout':
              connections[connectionName].idleTimeout = parseInt(value);
              break;
          }

          processedConnections.add(connectionName);
        }
      }
    }

    // 기본 연결 설정 찾기
    const defaultConnection = process.env.DB_DEFAULT_CONNECTION?.toLowerCase();

    const config: MultiDatabaseConfig = {
      connections,
      defaultConnection: defaultConnection || undefined
    };

    // 설정 유효성 검사
    this.validateConfig(config);

    logger.info('Multi-database config loaded from environment', {
      connectionCount: Object.keys(connections).length,
      connectionNames: Array.from(processedConnections),
      defaultConnection
    });

    return config;
  }

  /**
   * 기존 단일 DB 환경변수에서 설정 생성
   */
  static loadFromLegacyEnvironment(): MultiDatabaseConfig {
    const connections: Record<string, DatabaseConnectionConfig> = {};

    // MySQL 설정 확인
    if (process.env.MYSQL_HOST) {
      connections.mysql = {
        name: 'mysql',
        type: 'mysql',
        host: process.env.MYSQL_HOST,
        port: parseInt(process.env.MYSQL_PORT || '3306'),
        user: process.env.MYSQL_USER || '',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DB || '',
        description: 'Legacy MySQL connection',
        tags: ['legacy', 'mysql']
      };

      // SSL 설정
      if (process.env.MYSQL_SSL_MODE) {
        connections.mysql.ssl = {
          mode: process.env.MYSQL_SSL_MODE as any,
          ca: process.env.MYSQL_SSL_CA,
          cert: process.env.MYSQL_SSL_CERT,
          key: process.env.MYSQL_SSL_KEY
        };
      }
    }

    // PostgreSQL 설정 확인
    if (process.env.POSTGRES_HOST) {
      connections.postgresql = {
        name: 'postgresql',
        type: 'postgresql',
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT || '5432'),
        user: process.env.POSTGRES_USER || '',
        password: process.env.POSTGRES_PASSWORD || '',
        database: process.env.POSTGRES_DB || '',
        description: 'Legacy PostgreSQL connection',
        tags: ['legacy', 'postgresql']
      };

      // SSL 설정
      if (process.env.POSTGRES_SSL_MODE) {
        connections.postgresql.ssl = {
          mode: process.env.POSTGRES_SSL_MODE as any,
          ca: process.env.POSTGRES_SSL_CA,
          cert: process.env.POSTGRES_SSL_CERT,
          key: process.env.POSTGRES_SSL_KEY
        };
      }
    }

    // 기본 연결 설정
    let defaultConnection: string | undefined;
    if (process.env.DB_TYPE) {
      defaultConnection = process.env.DB_TYPE.toLowerCase();
    } else if (connections.mysql) {
      defaultConnection = 'mysql';
    } else if (connections.postgresql) {
      defaultConnection = 'postgresql';
    }

    const config: MultiDatabaseConfig = {
      connections,
      defaultConnection: defaultConnection || undefined
    };

    logger.info('Multi-database config created from legacy environment', {
      connectionCount: Object.keys(connections).length,
      connectionNames: Object.keys(connections),
      defaultConnection
    });

    return config;
  }

  /**
   * 설정 파일 예시 생성
   */
  static generateExampleConfig(): MultiDatabaseConfig {
    return {
      connections: {
        "user-service": {
          name: "user-service",
          type: "mysql",
          host: "user-db.cluster-xxx.us-east-1.rds.amazonaws.com",
          port: 3306,
          user: "readonly_user",
          password: "secure_password",
          database: "user_service",
          description: "User service database",
          tags: ["microservice", "user", "mysql"],
          ssl: {
            mode: "REQUIRED"
          },
          connectionLimit: 10,
          idleTimeout: 300000
        },
        "order-service": {
          name: "order-service",
          type: "postgresql",
          host: "order-db.cluster-yyy.us-east-1.rds.amazonaws.com",
          port: 5432,
          user: "readonly_user",
          password: "secure_password",
          database: "order_service",
          description: "Order service database",
          tags: ["microservice", "order", "postgresql"],
          ssl: {
            mode: "REQUIRED"
          },
          connectionLimit: 15
        },
        "analytics": {
          name: "analytics",
          type: "postgresql",
          host: "analytics-db.cluster-zzz.us-east-1.rds.amazonaws.com",
          port: 5432,
          user: "analytics_user",
          password: "analytics_password",
          database: "analytics",
          description: "Analytics and reporting database",
          tags: ["analytics", "reporting", "postgresql"],
          ssl: {
            mode: "REQUIRED"
          },
          connectionLimit: 20
        }
      },
      defaultConnection: "user-service"
    };
  }

  /**
   * 설정 유효성 검사
   */
  private static validateConfig(config: MultiDatabaseConfig): void {
    if (!config.connections || Object.keys(config.connections).length === 0) {
      throw new Error('No database connections configured');
    }

    for (const [name, connection] of Object.entries(config.connections)) {
      if (!connection.host) {
        throw new Error(`Connection '${name}': host is required`);
      }
      if (!connection.port || connection.port <= 0) {
        throw new Error(`Connection '${name}': valid port is required`);
      }
      if (!connection.user) {
        throw new Error(`Connection '${name}': user is required`);
      }
      if (!connection.password) {
        throw new Error(`Connection '${name}': password is required`);
      }
      if (!connection.database) {
        throw new Error(`Connection '${name}': database is required`);
      }
    }

    // 기본 연결이 설정되어 있다면 존재하는지 확인
    if (config.defaultConnection && !config.connections[config.defaultConnection]) {
      throw new Error(`Default connection '${config.defaultConnection}' not found in connections`);
    }
  }
}