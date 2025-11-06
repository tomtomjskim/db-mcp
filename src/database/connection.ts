import mysql from 'mysql2/promise';
import { DatabaseConfig, ConnectionStatus } from '../types/index.js';
import { logger, logConnection } from '../utils/logger.js';

export class DatabaseConnection {
  private pool: mysql.Pool | null = null;
  private config: DatabaseConfig;
  private connectionStatus: ConnectionStatus;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.connectionStatus = {
      isConnected: false,
      connectionCount: 0,
      activeQueries: 0,
      lastConnectionTime: new Date(),
      uptime: 0,
      databaseType: 'mysql'
    };
  }

  async connect(): Promise<void> {
    try {
      logConnection('connect', { host: this.config.host, database: this.config.database });

      const poolConfig: mysql.PoolOptions = {
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        waitForConnections: true,
        connectionLimit: this.config.connectionLimit || 10,
        queueLimit: this.config.queueLimit || 0,
        idleTimeout: this.config.idleTimeout || 300000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      };

      // SSL configuration for remote databases (AWS RDS, etc.)
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

      // Test the connection
      await this.testConnection();

      this.connectionStatus = {
        isConnected: true,
        connectionCount: 1,
        activeQueries: 0,
        lastConnectionTime: new Date(),
        uptime: 0,
        databaseType: 'mysql'
      };

      logger.info('Database connection established successfully', {
        host: this.config.host,
        database: this.config.database,
        ssl: !!this.config.ssl,
      });

    } catch (error) {
      this.connectionStatus.isConnected = false;
      logConnection('error', { error: error instanceof Error ? error.message : 'Unknown error' });
      throw new Error(`Failed to connect to database: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async testConnection(): Promise<void> {
    if (!this.pool) {
      throw new Error('Pool not initialized');
    }

    try {
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();
      logger.info('Database connection test successful');
    } catch (error) {
      throw new Error(`Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<mysql.RowDataPacket[] | mysql.OkPacket> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }

    this.connectionStatus.activeQueries++;
    const startTime = Date.now();

    try {
      const [results] = await this.pool.execute(sql, params);
      const executionTime = Date.now() - startTime;

      logger.debug('Query executed', {
        sql: sql.replace(/\\s+/g, ' ').trim(),
        executionTime,
        paramCount: params?.length || 0,
      });

      return results as mysql.RowDataPacket[] | mysql.OkPacket;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      logger.error('Query execution failed', {
        sql: sql.replace(/\\s+/g, ' ').trim(),
        executionTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      this.connectionStatus.activeQueries--;
    }
  }

  async getConnection(): Promise<mysql.PoolConnection> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    return this.pool.getConnection();
  }

  getConnectionStatus(): ConnectionStatus {
    if (this.pool) {
      this.connectionStatus.uptime = Date.now() - this.connectionStatus.lastConnectionTime.getTime();
    }
    return { ...this.connectionStatus };
  }

  async checkHealth(): Promise<{ healthy: boolean; message: string; details?: any }> {
    try {
      if (!this.pool) {
        return { healthy: false, message: 'Pool not initialized' };
      }

      await this.testConnection();

      const status = this.getConnectionStatus();
      return {
        healthy: true,
        message: 'Database connection is healthy',
        details: {
          isConnected: status.isConnected,
          uptime: status.uptime,
          activeQueries: status.activeQueries,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.end();
        logConnection('disconnect');
        this.connectionStatus.isConnected = false;
        logger.info('Database connection closed');
      } catch (error) {
        logger.error('Error closing database connection', { error });
        throw error;
      } finally {
        this.pool = null;
      }
    }
  }

  isConnected(): boolean {
    return this.connectionStatus.isConnected && this.pool !== null;
  }
}