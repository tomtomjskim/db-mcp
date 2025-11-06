import dotenv from 'dotenv';
import { DatabaseConfig, SecurityConfig } from '../types/index.js';

dotenv.config();

// 멀티 DB 모드 확인 (DB_CONFIG_FILE이 있으면 멀티 DB 모드)
const isMultiDbMode = !!process.env.DB_CONFIG_FILE;

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  // 멀티 DB 모드에서는 환경변수를 선택적으로 처리
  if (!value && defaultValue === undefined && !isMultiDbMode) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value || defaultValue || '';
}

function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid number`);
  }
  return parsed;
}

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

const createDatabaseConfig = (): DatabaseConfig => {
  const config: DatabaseConfig = {
    host: getEnvVar('MYSQL_HOST', 'localhost'),
    port: getEnvNumber('MYSQL_PORT', 3306),
    database: getEnvVar('MYSQL_DB'),
    user: getEnvVar('MYSQL_USER'),
    password: getEnvVar('MYSQL_PASSWORD'),
    connectionTimeout: getEnvNumber('MYSQL_CONNECTION_TIMEOUT', 60000),
    acquireTimeout: getEnvNumber('MYSQL_ACQUIRE_TIMEOUT', 60000),
    timeout: getEnvNumber('MYSQL_TIMEOUT', 60000),
    connectionLimit: getEnvNumber('MYSQL_CONNECTION_LIMIT', 10),
    queueLimit: getEnvNumber('MYSQL_QUEUE_LIMIT', 0),
    idleTimeout: getEnvNumber('MYSQL_IDLE_TIMEOUT', 300000),
  };

  if (process.env.MYSQL_SSL_MODE) {
    config.ssl = {
      mode: process.env.MYSQL_SSL_MODE as 'REQUIRED' | 'PREFERRED' | 'DISABLED',
      ca: process.env.MYSQL_SSL_CA || undefined,
      cert: process.env.MYSQL_SSL_CERT || undefined,
      key: process.env.MYSQL_SSL_KEY || undefined,
    };
  }

  return config;
};

export const databaseConfig = createDatabaseConfig();

export const securityConfig: SecurityConfig = {
  maxExecutionTime: getEnvNumber('MAX_QUERY_EXECUTION_TIME', 30000),
  maxResultRows: getEnvNumber('MAX_RESULT_ROWS', 10000),
  maxResultSizeMB: getEnvNumber('MAX_RESULT_SIZE_MB', 50),
  maxQueryLength: getEnvNumber('MAX_QUERY_LENGTH', 10000),
  enableQueryLogging: getEnvBoolean('ENABLE_QUERY_LOGGING', true),
  rateLimitMaxRequests: getEnvNumber('RATE_LIMIT_MAX_REQUESTS', 100),
  rateLimitWindowMs: getEnvNumber('RATE_LIMIT_WINDOW_MS', 60000),
  allowedKeywords: [
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
    'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT',
    'AS', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL',
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'UNION', 'INTERSECT', 'EXCEPT', 'WITH', 'RECURSIVE',
    'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'ANALYZE',
  ],
};

export const serverConfig = {
  name: getEnvVar('MCP_SERVER_NAME', 'database-mcp'),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
  nodeEnv: getEnvVar('NODE_ENV', 'development'),
  isDevelopment: getEnvVar('NODE_ENV', 'development') === 'development',
  isProduction: getEnvVar('NODE_ENV', 'development') === 'production',
};

export const validateConfig = (): void => {
  // 멀티 DB 모드에서는 검증 스킵 (각 연결 설정이 별도로 검증됨)
  if (isMultiDbMode) {
    return;
  }

  // Database config validation
  if (!databaseConfig.host) {
    throw new Error('MYSQL_HOST is required');
  }
  if (!databaseConfig.database) {
    throw new Error('MYSQL_DB is required');
  }
  if (!databaseConfig.user) {
    throw new Error('MYSQL_USER is required');
  }
  if (!databaseConfig.password) {
    throw new Error('MYSQL_PASSWORD is required');
  }

  // Security config validation
  if (securityConfig.maxExecutionTime < 1000) {
    throw new Error('MAX_QUERY_EXECUTION_TIME must be at least 1000ms');
  }
  if (securityConfig.maxResultRows < 1) {
    throw new Error('MAX_RESULT_ROWS must be at least 1');
  }
  if (securityConfig.maxResultSizeMB < 1) {
    throw new Error('MAX_RESULT_SIZE_MB must be at least 1');
  }
};