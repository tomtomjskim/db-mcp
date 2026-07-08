import { DatabaseConnectionManager, MultiDatabaseConfig } from '../database/connection-manager.js';
import { DatabaseAdapter } from '../database/adapters/base/database-adapter.js';
import { DatabaseConfig, QueryResult } from '../types/index.js';

function createFakeAdapter(config: DatabaseConfig): DatabaseAdapter {
  let connected = false;

  return {
    type: config.type || 'mysql',
    id: `fake-${config.database}`,
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    async query(): Promise<QueryResult> {
      return {
        rows: [],
        fields: [],
        rowCount: 0,
        executionTime: 0,
      };
    },
    async transaction(): Promise<QueryResult[]> {
      return [];
    },
    async getConnectionStatus() {
      return {
        isConnected: connected,
        connectionCount: connected ? 1 : 0,
        activeQueries: 0,
        lastConnectionTime: new Date(),
        uptime: 0,
        databaseType: config.type || 'mysql',
      };
    },
    async healthCheck() {
      return {
        isHealthy: connected,
        responseTime: 0,
        lastCheck: new Date(),
      };
    },
    getSchemaAnalyzer() {
      throw new Error('not implemented');
    },
    getDataProfiler() {
      throw new Error('not implemented');
    },
    getMetrics() {
      return {
        queriesExecuted: 0,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
        errorCount: 0,
        successRate: 0,
        lastMetricsReset: new Date(),
      };
    },
    resetMetrics() {},
    getConnectionInfo() {
      const info: {
        host: string;
        port: number;
        database: string;
        type: 'mysql' | 'postgresql' | 'sqlite';
        ssl: boolean;
        connectionLimit?: number;
      } = {
        host: config.host,
        port: config.port,
        database: config.database,
        type: config.type || 'mysql',
        ssl: false,
      };
      if (config.connectionLimit !== undefined) {
        info.connectionLimit = config.connectionLimit;
      }
      return info;
    },
  };
}

describe('DatabaseConnectionManager lazy connections', () => {
  const config: MultiDatabaseConfig = {
    connections: {
      dev: {
        name: 'dev',
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'dev_user',
        password: 'dev_password',
        database: 'dev_db',
      },
      prod: {
        name: 'prod',
        type: 'mysql',
        host: 'localhost',
        port: 3306,
        user: 'prod_user',
        password: 'prod_password',
        database: 'prod_db',
        tags: ['production'],
      },
    },
    defaultConnection: 'dev',
  };

  it('lists configured databases without opening adapters', () => {
    const createdAdapters: string[] = [];
    const manager = new DatabaseConnectionManager(config, (databaseConfig: DatabaseConfig) => {
      createdAdapters.push(databaseConfig.database);
      return createFakeAdapter(databaseConfig);
    });

    expect(manager.getConfiguredConnectionNames()).toEqual(['dev', 'prod']);
    expect(manager.getConnectionNames()).toEqual([]);
    expect(createdAdapters).toEqual([]);
    expect(manager.getAllConnectionsInfo()).toEqual([
      expect.objectContaining({ name: 'dev', database: 'dev_db', isConnected: false }),
      expect.objectContaining({ name: 'prod', database: 'prod_db', isConnected: false }),
    ]);
  });

  it('connects only the requested database on first use', async () => {
    const createdAdapters: string[] = [];
    const manager = new DatabaseConnectionManager(config, (databaseConfig: DatabaseConfig) => {
      createdAdapters.push(databaseConfig.database);
      return createFakeAdapter(databaseConfig);
    });

    const devAdapter = await manager.getConnection('dev');
    const sameDevAdapter = await manager.getConnection('dev');

    expect(devAdapter).toBe(sameDevAdapter);
    expect(createdAdapters).toEqual(['dev_db']);
    expect(manager.getConnectionNames()).toEqual(['dev']);
    expect(manager.getAllConnectionsInfo()).toEqual([
      expect.objectContaining({ name: 'dev', database: 'dev_db', isConnected: true }),
      expect.objectContaining({ name: 'prod', database: 'prod_db', isConnected: false }),
    ]);
  });
});
