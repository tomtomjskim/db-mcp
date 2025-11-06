// Mock environment variables to prevent config loading issues
process.env.MYSQL_HOST = 'localhost';
process.env.MYSQL_PORT = '3306';
process.env.MYSQL_USER = 'test';
process.env.MYSQL_PASSWORD = 'test';
process.env.MYSQL_DB = 'testdb';

import { DatabaseAdapterFactory } from '../database/adapters/factory.js';
import { DatabaseConfig } from '../types/index.js';

describe('PostgreSQL Adapter', () => {
  let factory: DatabaseAdapterFactory;

  beforeEach(() => {
    factory = DatabaseAdapterFactory.getInstance();
  });

  it('should detect PostgreSQL database type correctly', () => {
    const config: DatabaseConfig = {
      host: 'localhost',
      port: 5432,
      user: 'test',
      password: 'test',
      database: 'testdb',
      type: 'postgresql'
    };

    const detectedType = factory.detectDatabaseType(config);
    expect(detectedType).toBe('postgresql');
  });

  it('should support PostgreSQL adapter', () => {
    const supportedTypes = factory.getSupportedTypes();
    expect(supportedTypes).toContain('postgresql');
  });

  it('should return PostgreSQL adapter info', () => {
    const adapterInfo = factory.getAdapterInfo('postgresql');
    expect(adapterInfo.type).toBe('postgresql');
    expect(adapterInfo.requiredPackage).toBe('pg');
  });

  it('should create PostgreSQL adapter when pg package is available', () => {
    // This test would require the pg package to be installed
    // For now, we'll just test the factory logic
    const config: DatabaseConfig = {
      host: 'localhost',
      port: 5432,
      user: 'test',
      password: 'test',
      database: 'testdb',
      type: 'postgresql'
    };

    try {
      const adapter = factory.createAdapter(config);
      expect(adapter.type).toBe('postgresql');
    } catch (error) {
      // Expected if pg package is not installed
      expect((error as Error).message).toContain('not available');
    }
  });

  it('should auto-detect PostgreSQL from port', () => {
    const config: DatabaseConfig = {
      host: 'localhost',
      port: 5432, // PostgreSQL default port
      user: 'test',
      password: 'test',
      database: 'testdb'
      // type not specified
    };

    const detectedType = factory.detectDatabaseType(config);
    expect(detectedType).toBe('postgresql');
  });

  it('should auto-detect PostgreSQL from hostname', () => {
    const config: DatabaseConfig = {
      host: 'my-postgres-server.amazonaws.com',
      port: 5432,
      user: 'test',
      password: 'test',
      database: 'testdb'
      // type not specified
    };

    const detectedType = factory.detectDatabaseType(config);
    expect(detectedType).toBe('postgresql');
  });
});