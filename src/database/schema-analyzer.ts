import { DatabaseConnection } from './connection.js';
import { TableInfo, ColumnInfo, IndexInfo, ForeignKeyInfo, SchemaInfo, ViewInfo, ProcedureInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface SchemaAnalysisOptions {
  includeSystemTables?: boolean;
  includeViews?: boolean;
  includeProcedures?: boolean;
  includeIndexes?: boolean;
  includeForeignKeys?: boolean;
  includeStatistics?: boolean;
}

export interface TableStatistics {
  tableName: string;
  rowCount: number;
  dataLength: number;
  indexLength: number;
  autoIncrement: number | null;
  createTime: Date | null;
  updateTime: Date | null;
  collation: string;
}

export class SchemaAnalyzer {
  private database: DatabaseConnection;
  private databaseName: string;

  constructor(database: DatabaseConnection, databaseName: string) {
    this.database = database;
    this.databaseName = databaseName;
  }

  async analyzeFullSchema(options: SchemaAnalysisOptions = {}): Promise<SchemaInfo> {
    const defaultOptions = {
      includeSystemTables: false,
      includeViews: true,
      includeProcedures: true,
      includeIndexes: true,
      includeForeignKeys: true,
      includeStatistics: true,
    };

    const opts = { ...defaultOptions, ...options };

    try {
      logger.info('Starting full schema analysis', { database: this.databaseName, options: opts });

      const [tables, views, procedures] = await Promise.all([
        this.analyzeTables(opts),
        opts.includeViews ? this.analyzeViews() : Promise.resolve([]),
        opts.includeProcedures ? this.analyzeProcedures() : Promise.resolve([]),
      ]);

      const schemaInfo: SchemaInfo = {
        tables,
        views,
        procedures,
      };

      logger.info('Schema analysis completed', {
        tablesCount: tables.length,
        viewsCount: views.length,
        proceduresCount: procedures.length,
      });

      return schemaInfo;
    } catch (error) {
      logger.error('Schema analysis failed', { error });
      throw new Error(`Schema analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async analyzeTables(options: SchemaAnalysisOptions): Promise<TableInfo[]> {
    const tables: TableInfo[] = [];

    // Get table list
    const tableList = await this.getTableList(options.includeSystemTables);

    for (const tableName of tableList) {
      try {
        const tableInfo = await this.analyzeTable(tableName, options);
        tables.push(tableInfo);
      } catch (error) {
        logger.warn('Failed to analyze table', { table: tableName, error });
        // Continue with other tables
      }
    }

    return tables;
  }

  async analyzeTable(tableName: string, options: SchemaAnalysisOptions = {}): Promise<TableInfo> {
    logger.debug('Analyzing table', { table: tableName });

    const [columns, indexes, foreignKeys, statistics] = await Promise.all([
      this.getTableColumns(tableName),
      options.includeIndexes ? this.getTableIndexes(tableName) : Promise.resolve([]),
      options.includeForeignKeys ? this.getTableForeignKeys(tableName) : Promise.resolve([]),
      options.includeStatistics ? this.getTableStatistics(tableName) : Promise.resolve(null),
    ]);

    const tableInfo: TableInfo = {
      name: tableName,
      schema: this.databaseName,
      columns,
      indexes,
      foreignKeys,
    };

    if (statistics) {
      tableInfo.rowCount = statistics.rowCount;
      tableInfo.sizeInBytes = statistics.dataLength + statistics.indexLength;
    }

    return tableInfo;
  }

  private async getTableList(includeSystemTables: boolean = false): Promise<string[]> {
    const query = `
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ${includeSystemTables ? '' : 'AND TABLE_NAME NOT LIKE \'mysql_%\' AND TABLE_NAME NOT LIKE \'sys_%\''}
      ORDER BY TABLE_NAME
    `;

    const result = await this.database.query(query, [this.databaseName]) as any[];
    return result.map(row => row.TABLE_NAME);
  }

  private async getTableColumns(tableName: string): Promise<ColumnInfo[]> {
    const query = `
      SELECT
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_KEY,
        EXTRA,
        CHARACTER_MAXIMUM_LENGTH,
        NUMERIC_PRECISION,
        NUMERIC_SCALE,
        COLUMN_COMMENT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;

    const result = await this.database.query(query, [this.databaseName, tableName]) as any[];

    return result.map(row => ({
      name: row.COLUMN_NAME,
      type: this.normalizeDataType(row.DATA_TYPE),
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
      isAutoIncrement: row.EXTRA.includes('auto_increment'),
      maxLength: row.CHARACTER_MAXIMUM_LENGTH,
      precision: row.NUMERIC_PRECISION,
      scale: row.NUMERIC_SCALE,
      comment: row.COLUMN_COMMENT,
    }));
  }

  private async getTableIndexes(tableName: string): Promise<IndexInfo[]> {
    const query = `
      SELECT
        INDEX_NAME,
        COLUMN_NAME,
        NON_UNIQUE,
        INDEX_TYPE,
        SEQ_IN_INDEX
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `;

    const result = await this.database.query(query, [this.databaseName, tableName]) as any[];

    // Group by index name
    const indexGroups = new Map<string, any[]>();
    for (const row of result) {
      if (!indexGroups.has(row.INDEX_NAME)) {
        indexGroups.set(row.INDEX_NAME, []);
      }
      indexGroups.get(row.INDEX_NAME)!.push(row);
    }

    const indexes: IndexInfo[] = [];
    for (const [indexName, rows] of indexGroups) {
      const firstRow = rows[0];
      indexes.push({
        name: indexName,
        columns: rows.map(r => r.COLUMN_NAME),
        isUnique: firstRow.NON_UNIQUE === 0,
        isPrimary: indexName === 'PRIMARY',
        type: firstRow.INDEX_TYPE,
      });
    }

    return indexes;
  }

  private async getTableForeignKeys(tableName: string): Promise<ForeignKeyInfo[]> {
    const query = `
      SELECT
        kcu.CONSTRAINT_NAME,
        kcu.COLUMN_NAME,
        kcu.REFERENCED_TABLE_NAME,
        kcu.REFERENCED_COLUMN_NAME,
        rc.UPDATE_RULE,
        rc.DELETE_RULE
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
        ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
      WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `;

    const result = await this.database.query(query, [this.databaseName, tableName]) as any[];

    // Group by constraint name
    const fkGroups = new Map<string, any[]>();
    for (const row of result) {
      if (!fkGroups.has(row.CONSTRAINT_NAME)) {
        fkGroups.set(row.CONSTRAINT_NAME, []);
      }
      fkGroups.get(row.CONSTRAINT_NAME)!.push(row);
    }

    const foreignKeys: ForeignKeyInfo[] = [];
    for (const [constraintName, rows] of fkGroups) {
      const firstRow = rows[0];
      foreignKeys.push({
        name: constraintName,
        columns: rows.map(r => r.COLUMN_NAME),
        referencedTable: firstRow.REFERENCED_TABLE_NAME,
        referencedColumns: rows.map(r => r.REFERENCED_COLUMN_NAME),
        onUpdate: firstRow.UPDATE_RULE,
        onDelete: firstRow.DELETE_RULE,
      });
    }

    return foreignKeys;
  }

  private async getTableStatistics(tableName: string): Promise<TableStatistics | null> {
    const query = `
      SELECT
        TABLE_NAME,
        TABLE_ROWS,
        DATA_LENGTH,
        INDEX_LENGTH,
        AUTO_INCREMENT,
        CREATE_TIME,
        UPDATE_TIME,
        TABLE_COLLATION
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `;

    const result = await this.database.query(query, [this.databaseName, tableName]) as any[];
    if (result.length === 0) return null;

    const row = result[0];
    return {
      tableName: row.TABLE_NAME,
      rowCount: row.TABLE_ROWS || 0,
      dataLength: row.DATA_LENGTH || 0,
      indexLength: row.INDEX_LENGTH || 0,
      autoIncrement: row.AUTO_INCREMENT,
      createTime: row.CREATE_TIME,
      updateTime: row.UPDATE_TIME,
      collation: row.TABLE_COLLATION,
    };
  }

  private async analyzeViews(): Promise<ViewInfo[]> {
    const query = `
      SELECT
        TABLE_NAME,
        VIEW_DEFINITION
      FROM INFORMATION_SCHEMA.VIEWS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `;

    const result = await this.database.query(query, [this.databaseName]) as any[];

    return result.map(row => ({
      name: row.TABLE_NAME,
      schema: this.databaseName,
      definition: row.VIEW_DEFINITION,
    }));
  }

  private async analyzeProcedures(): Promise<ProcedureInfo[]> {
    const query = `
      SELECT
        ROUTINE_NAME,
        ROUTINE_TYPE
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_SCHEMA = ?
      ORDER BY ROUTINE_NAME
    `;

    const result = await this.database.query(query, [this.databaseName]) as any[];

    const procedures: ProcedureInfo[] = [];
    for (const row of result) {
      const parameters = await this.getProcedureParameters(row.ROUTINE_NAME);
      procedures.push({
        name: row.ROUTINE_NAME,
        schema: this.databaseName,
        parameters,
      });
    }

    return procedures;
  }

  private async getProcedureParameters(routineName: string): Promise<any[]> {
    const query = `
      SELECT
        PARAMETER_NAME,
        DATA_TYPE,
        PARAMETER_MODE
      FROM INFORMATION_SCHEMA.PARAMETERS
      WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;

    const result = await this.database.query(query, [this.databaseName, routineName]) as any[];

    return result.map(row => ({
      name: row.PARAMETER_NAME,
      type: row.DATA_TYPE,
      direction: row.PARAMETER_MODE as 'IN' | 'OUT' | 'INOUT',
    }));
  }

  private normalizeDataType(mysqlType: string): string {
    // Map MySQL types to standard types
    const typeMap: Record<string, string> = {
      'tinyint': 'integer',
      'smallint': 'integer',
      'mediumint': 'integer',
      'int': 'integer',
      'bigint': 'integer',
      'float': 'float',
      'double': 'float',
      'decimal': 'decimal',
      'char': 'string',
      'varchar': 'string',
      'text': 'text',
      'tinytext': 'text',
      'mediumtext': 'text',
      'longtext': 'text',
      'binary': 'binary',
      'varbinary': 'binary',
      'blob': 'binary',
      'tinyblob': 'binary',
      'mediumblob': 'binary',
      'longblob': 'binary',
      'date': 'date',
      'time': 'time',
      'datetime': 'datetime',
      'timestamp': 'timestamp',
      'year': 'integer',
      'json': 'json',
      'geometry': 'geometry',
    };

    return typeMap[mysqlType.toLowerCase()] || mysqlType;
  }

  // Public utility methods
  async getTableRelationships(): Promise<Map<string, string[]>> {
    const relationships = new Map<string, string[]>();

    const query = `
      SELECT
        TABLE_NAME,
        REFERENCED_TABLE_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `;

    const result = await this.database.query(query, [this.databaseName]) as any[];

    for (const row of result) {
      if (!relationships.has(row.TABLE_NAME)) {
        relationships.set(row.TABLE_NAME, []);
      }
      const relatedTables = relationships.get(row.TABLE_NAME)!;
      if (!relatedTables.includes(row.REFERENCED_TABLE_NAME)) {
        relatedTables.push(row.REFERENCED_TABLE_NAME);
      }
    }

    return relationships;
  }

  async getDatabaseInfo(): Promise<{
    name: string;
    charset: string;
    collation: string;
    tableCount: number;
    viewCount: number;
    procedureCount: number;
  }> {
    const [dbInfo, counts] = await Promise.all([
      this.database.query(
        'SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
        [this.databaseName]
      ),
      this.database.query(`
        SELECT
          TABLE_TYPE,
          COUNT(*) as count
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_TYPE
      `, [this.databaseName])
    ]) as [any[], any[]];

    const db = (dbInfo as any[])[0] || {};
    const tableCounts = (counts as any[]).reduce((acc, row) => {
      acc[row.TABLE_TYPE] = row.count;
      return acc;
    }, {} as Record<string, number>);

    return {
      name: this.databaseName,
      charset: db.DEFAULT_CHARACTER_SET_NAME || 'unknown',
      collation: db.DEFAULT_COLLATION_NAME || 'unknown',
      tableCount: tableCounts['BASE TABLE'] || 0,
      viewCount: tableCounts['VIEW'] || 0,
      procedureCount: 0, // Will be filled by separate query if needed
    };
  }
}