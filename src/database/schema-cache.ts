import { SchemaInfo, TableInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { TableProfile } from './data-profiler.js';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  hits: number;
  size?: number;
}

export interface CacheStats {
  totalEntries: number;
  totalSize: number;
  hitRate: number;
  missRate: number;
  totalHits: number;
  totalMisses: number;
  oldestEntry?: number;
  newestEntry?: number;
}

export interface CacheOptions {
  defaultTTL?: number;
  maxSize?: number;
  maxEntries?: number;
  cleanupInterval?: number;
}

export class SchemaCache {
  private cache = new Map<string, CacheEntry<any>>();
  private stats = {
    hits: 0,
    misses: 0,
  };
  private options: Required<CacheOptions>;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(options: CacheOptions = {}) {
    this.options = {
      defaultTTL: options.defaultTTL || 5 * 60 * 1000, // 5 minutes
      maxSize: options.maxSize || 100 * 1024 * 1024, // 100MB
      maxEntries: options.maxEntries || 1000,
      cleanupInterval: options.cleanupInterval || 60 * 1000, // 1 minute
    };

    this.startCleanupTimer();
  }

  // Schema-specific cache methods
  async getFullSchema(databaseName: string): Promise<SchemaInfo | null> {
    const key = `schema:${databaseName}`;
    return this.get(key);
  }

  async setFullSchema(databaseName: string, schema: SchemaInfo, ttl?: number): Promise<void> {
    const key = `schema:${databaseName}`;
    await this.set(key, schema, ttl);
  }

  async getTableInfo(databaseName: string, tableName: string): Promise<TableInfo | null> {
    const key = `table:${databaseName}:${tableName}`;
    return this.get(key);
  }

  async setTableInfo(databaseName: string, tableName: string, tableInfo: TableInfo, ttl?: number): Promise<void> {
    const key = `table:${databaseName}:${tableName}`;
    await this.set(key, tableInfo, ttl);
  }

  async getTableProfile(databaseName: string, tableName: string): Promise<TableProfile | null> {
    const key = `profile:${databaseName}:${tableName}`;
    return this.get(key);
  }

  async setTableProfile(databaseName: string, tableName: string, profile: TableProfile, ttl?: number): Promise<void> {
    const key = `profile:${databaseName}:${tableName}`;
    await this.set(key, profile, ttl);
  }

  async getTableRelationships(databaseName: string): Promise<Map<string, string[]> | null> {
    const key = `relationships:${databaseName}`;
    const relationships = await this.get<Array<[string, string[]]>>(key);
    return relationships ? new Map(relationships) : null;
  }

  async setTableRelationships(databaseName: string, relationships: Map<string, string[]>, ttl?: number): Promise<void> {
    const key = `relationships:${databaseName}`;
    await this.set(key, Array.from(relationships.entries()), ttl);
  }

  async getDatabaseInfo(databaseName: string): Promise<any | null> {
    const key = `dbinfo:${databaseName}`;
    return this.get(key);
  }

  async setDatabaseInfo(databaseName: string, info: any, ttl?: number): Promise<void> {
    const key = `dbinfo:${databaseName}`;
    await this.set(key, info, ttl);
  }

  // Generic cache methods
  private async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    entry.hits++;
    this.stats.hits++;

    logger.debug('Cache hit', { key, hits: entry.hits });
    return entry.data as T;
  }

  private async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const currentTime = Date.now();
    const entryTTL = ttl || this.options.defaultTTL;

    // Estimate size (rough approximation)
    const size = this.estimateSize(data);

    // Check if adding this entry would exceed limits
    if (this.shouldEvict(size)) {
      await this.evictEntries(size);
    }

    const entry: CacheEntry<T> = {
      data,
      timestamp: currentTime,
      ttl: entryTTL,
      hits: 0,
      size,
    };

    this.cache.set(key, entry);

    logger.debug('Cache set', {
      key,
      size,
      ttl: entryTTL,
      totalEntries: this.cache.size
    });
  }

  private shouldEvict(newEntrySize: number): boolean {
    if (this.cache.size >= this.options.maxEntries) {
      return true;
    }

    const currentSize = this.getTotalSize();
    return (currentSize + newEntrySize) > this.options.maxSize;
  }

  private async evictEntries(requiredSpace: number): Promise<void> {
    const entriesToEvict: string[] = [];
    let freedSpace = 0;

    // Sort entries by last access time (LRU) and hit count
    const sortedEntries = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => {
        // First by hits (ascending), then by timestamp (ascending)
        if (a.hits !== b.hits) {
          return a.hits - b.hits;
        }
        return a.timestamp - b.timestamp;
      });

    // Evict least recently used entries until we have enough space
    for (const [key, entry] of sortedEntries) {
      entriesToEvict.push(key);
      freedSpace += entry.size || 0;

      if (freedSpace >= requiredSpace && entriesToEvict.length > 0) {
        break;
      }
    }

    // Remove selected entries
    for (const key of entriesToEvict) {
      this.cache.delete(key);
    }

    if (entriesToEvict.length > 0) {
      logger.info('Cache eviction completed', {
        evictedEntries: entriesToEvict.length,
        freedSpace,
        remainingEntries: this.cache.size,
      });
    }
  }

  private estimateSize(data: any): number {
    try {
      // Rough estimation based on JSON string length
      const jsonString = JSON.stringify(data);
      return jsonString.length * 2; // Assuming UTF-16 encoding
    } catch (error) {
      // Fallback to a default size if JSON.stringify fails
      return 1024; // 1KB default
    }
  }

  private getTotalSize(): number {
    let totalSize = 0;
    for (const entry of this.cache.values()) {
      totalSize += entry.size || 0;
    }
    return totalSize;
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.options.cleanupInterval);
  }

  private cleanup(): void {
    const currentTime = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (currentTime - entry.timestamp > entry.ttl) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key);
    }

    if (expiredKeys.length > 0) {
      logger.debug('Cache cleanup completed', {
        expiredEntries: expiredKeys.length,
        remainingEntries: this.cache.size,
      });
    }
  }

  // Cache management methods
  invalidate(pattern?: string): void {
    if (!pattern) {
      // Clear all cache
      this.cache.clear();
      this.stats.hits = 0;
      this.stats.misses = 0;
      logger.info('All cache cleared');
      return;
    }

    // Clear entries matching pattern
    const keysToDelete: string[] = [];
    const regex = new RegExp(pattern);

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    logger.info('Cache invalidated', { pattern, deletedEntries: keysToDelete.length });
  }

  invalidateDatabase(databaseName: string): void {
    this.invalidate(`^(schema|table|profile|relationships|dbinfo):${databaseName}`);
  }

  invalidateTable(databaseName: string, tableName: string): void {
    this.invalidate(`^(table|profile):${databaseName}:${tableName}`);
  }

  getStats(): CacheStats {
    const entries = Array.from(this.cache.values());
    const totalSize = this.getTotalSize();
    const totalRequests = this.stats.hits + this.stats.misses;

    let oldestEntry: number | undefined;
    let newestEntry: number | undefined;

    if (entries.length > 0) {
      const timestamps = entries.map(e => e.timestamp);
      oldestEntry = Math.min(...timestamps);
      newestEntry = Math.max(...timestamps);
    }

    const stats: CacheStats = {
      totalEntries: this.cache.size,
      totalSize,
      hitRate: totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0,
      missRate: totalRequests > 0 ? (this.stats.misses / totalRequests) * 100 : 0,
      totalHits: this.stats.hits,
      totalMisses: this.stats.misses,
    };

    if (oldestEntry !== undefined) stats.oldestEntry = oldestEntry;
    if (newestEntry !== undefined) stats.newestEntry = newestEntry;

    return stats;
  }

  // Cache warming methods
  async warmup(databaseName: string, analyzer: any, profiler: any): Promise<void> {
    logger.info('Starting cache warmup', { database: databaseName });

    try {
      // Warm up basic database info
      const dbInfo = await analyzer.getDatabaseInfo();
      await this.setDatabaseInfo(databaseName, dbInfo);

      // Warm up schema
      const schema = await analyzer.analyzeFullSchema();
      await this.setFullSchema(databaseName, schema);

      // Warm up relationships
      const relationships = await analyzer.getTableRelationships();
      await this.setTableRelationships(databaseName, relationships);

      // Warm up individual tables (for smaller tables)
      for (const table of schema.tables) {
        await this.setTableInfo(databaseName, table.name, table);

        // Only profile smaller tables during warmup
        if ((table.rowCount || 0) < 10000) {
          try {
            const profile = await profiler.profileTable(table.name, { sampleSize: 1000 });
            if (profile) {
              await this.setTableProfile(databaseName, table.name, profile);
            }
          } catch (error) {
            logger.warn('Failed to warm up table profile', { table: table.name, error });
          }
        }
      }

      logger.info('Cache warmup completed', {
        database: databaseName,
        entries: this.cache.size
      });
    } catch (error) {
      logger.error('Cache warmup failed', { database: databaseName, error });
      throw error;
    }
  }

  async preloadPopularTables(databaseName: string, tableNames: string[], analyzer: any, profiler: any): Promise<void> {
    logger.info('Preloading popular tables', { database: databaseName, tables: tableNames });

    for (const tableName of tableNames) {
      try {
        // Load table info if not cached
        let tableInfo = await this.getTableInfo(databaseName, tableName);
        if (!tableInfo) {
          tableInfo = await analyzer.analyzeTable(tableName);
          if (tableInfo) {
            await this.setTableInfo(databaseName, tableName, tableInfo);
          }
        }

        // Load table profile if not cached
        let profile = await this.getTableProfile(databaseName, tableName);
        if (!profile) {
          profile = await profiler.profileTable(tableName);
          if (profile) {
            await this.setTableProfile(databaseName, tableName, profile);
          }
        }
      } catch (error) {
        logger.warn('Failed to preload table', { table: tableName, error });
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined as NodeJS.Timeout | undefined;
    }
    this.cache.clear();
    logger.info('Schema cache destroyed');
  }
}