import { SchemaAnalyzerBase } from '../base/database-adapter.js';
import { TableInfo, ColumnInfo, IndexInfo, ForeignKeyInfo, SchemaInfo, ViewInfo, ProcedureInfo } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { MySQLAdapter } from './mysql-adapter.js';

/**
 * MySQL 스키마 분석 옵션
 */
export interface MySQLSchemaAnalysisOptions {
  includeSystemTables?: boolean;
  includeViews?: boolean;
  includeProcedures?: boolean;
  includeIndexes?: boolean;
  includeForeignKeys?: boolean;
  includeStatistics?: boolean;
  includeTriggers?: boolean;
  includePartitions?: boolean;
}

/**
 * MySQL 테이블 통계
 */
export interface MySQLTableStatistics {
  tableName: string;
  rowCount: number;
  dataLength: number;
  indexLength: number;
  autoIncrement: number | null;
  createTime: Date | null;
  updateTime: Date | null;
  collation: string;
  engine: string;
  avgRowLength: number;
  dataFree: number;
}

/**
 * MySQL 특화 스키마 분석기
 * MySQL의 고유 기능과 메타데이터를 분석
 */
export class MySQLSchemaAnalyzer extends SchemaAnalyzerBase {
  public adapter: MySQLAdapter;
  private databaseName: string;

  constructor(adapter: MySQLAdapter) {
    super(adapter);
    this.adapter = adapter;
    this.databaseName = adapter.getConnectionInfo().database;
  }

  /**
   * 전체 스키마 분석
   */
  async analyzeFullSchema(options: MySQLSchemaAnalysisOptions = {}): Promise<SchemaInfo> {
    const defaultOptions: Required<MySQLSchemaAnalysisOptions> = {
      includeSystemTables: false,
      includeViews: true,
      includeProcedures: true,
      includeIndexes: true,
      includeForeignKeys: true,
      includeStatistics: true,
      includeTriggers: false,
      includePartitions: false
    };

    const opts = { ...defaultOptions, ...options };

    try {
      logger.info('Starting MySQL schema analysis', {
        database: this.databaseName,
        options: opts
      });

      const [tables, views, procedures] = await Promise.all([
        this.analyzeTables(opts),
        opts.includeViews ? this.analyzeViews() : Promise.resolve([]),
        opts.includeProcedures ? this.analyzeProcedures() : Promise.resolve([])
      ]);

      const schemaInfo: SchemaInfo = {
        tables,
        views,
        procedures
      };

      logger.info('MySQL schema analysis completed', {
        tablesCount: tables.length,
        viewsCount: views.length,
        proceduresCount: procedures.length
      });

      return schemaInfo;

    } catch (error) {
      logger.error('MySQL schema analysis failed', { error });
      throw new Error(
        `MySQL schema analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * 특정 테이블 분석
   */
  async analyzeTable(tableName: string, options: MySQLSchemaAnalysisOptions = {}): Promise<TableInfo> {
    logger.debug('Analyzing MySQL table', { table: tableName });

    const [columns, indexes, foreignKeys, statistics] = await Promise.all([
      this.getTableColumns(tableName),
      options.includeIndexes !== false ? this.getTableIndexes(tableName) : Promise.resolve([]),
      options.includeForeignKeys !== false ? this.getTableForeignKeys(tableName) : Promise.resolve([]),
      options.includeStatistics !== false ? this.getTableStatistics(tableName) : Promise.resolve(null)
    ]);

    const tableInfo: TableInfo = {
      name: tableName,
      schema: this.databaseName,
      columns,
      indexes,
      foreignKeys
    };

    if (statistics) {
      tableInfo.rowCount = statistics.rowCount;
      tableInfo.sizeInBytes = statistics.dataLength + statistics.indexLength;
    }

    return tableInfo;
  }

  /**
   * 테이블 관계 분석
   */
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

    const result = await this.adapter.query(query, [this.databaseName]);

    for (const row of result.rows) {
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

  /**
   * 데이터베이스 정보 조회
   */
  async getDatabaseInfo(): Promise<{
    name: string;
    charset: string;
    collation: string;
    tableCount: number;
    viewCount: number;
    procedureCount: number;
    version: string;
    engine: string;
  }> {
    const [dbInfo, counts, version] = await Promise.all([
      this.adapter.query(
        'SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
        [this.databaseName]
      ),
      this.adapter.query(`
        SELECT
          TABLE_TYPE,
          COUNT(*) as count
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_TYPE
      `, [this.databaseName]),
      this.adapter.query('SELECT VERSION() as version')
    ]);

    const db = (dbInfo.rows as any[])[0] || {};
    const tableCounts = (counts.rows as any[]).reduce((acc, row) => {
      acc[row.TABLE_TYPE] = row.count;
      return acc;
    }, {} as Record<string, number>);

    const versionInfo = (version.rows as any[])[0] || {};

    return {
      name: this.databaseName,
      charset: db.DEFAULT_CHARACTER_SET_NAME || 'unknown',
      collation: db.DEFAULT_COLLATION_NAME || 'unknown',
      tableCount: tableCounts['BASE TABLE'] || 0,
      viewCount: tableCounts['VIEW'] || 0,
      procedureCount: 0, // 별도 쿼리로 조회 필요
      version: versionInfo.version || 'unknown',
      engine: 'InnoDB' // 기본값
    };
  }

  /**
   * 테이블 목록 조회
   */
  private async analyzeTables(options: MySQLSchemaAnalysisOptions): Promise<TableInfo[]> {
    const tables: TableInfo[] = [];
    const tableList = await this.getTableList(options.includeSystemTables);

    for (const tableName of tableList) {
      try {
        const tableInfo = await this.analyzeTable(tableName, options);
        tables.push(tableInfo);
      } catch (error) {
        logger.warn('Failed to analyze MySQL table', { table: tableName, error });
      }
    }

    return tables;
  }

  /**
   * 테이블 목록 조회
   */
  private async getTableList(includeSystemTables: boolean = false): Promise<string[]> {
    const query = `
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ${includeSystemTables ? '' : "AND TABLE_NAME NOT LIKE 'mysql_%' AND TABLE_NAME NOT LIKE 'sys_%'"}
      ORDER BY TABLE_NAME
    `;

    const result = await this.adapter.query(query, [this.databaseName]);
    return (result.rows as any[]).map(row => row.TABLE_NAME);
  }

  /**
   * 테이블 컬럼 정보 조회
   */
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

    const result = await this.adapter.query(query, [this.databaseName, tableName]);

    return (result.rows as any[]).map(row => ({
      name: row.COLUMN_NAME,
      type: this.normalizeDataType(row.DATA_TYPE),
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
      isAutoIncrement: row.EXTRA.includes('auto_increment'),
      maxLength: row.CHARACTER_MAXIMUM_LENGTH,
      precision: row.NUMERIC_PRECISION,
      scale: row.NUMERIC_SCALE,
      comment: row.COLUMN_COMMENT
    }));
  }

  /**
   * 테이블 인덱스 정보 조회
   */
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

    const result = await this.adapter.query(query, [this.databaseName, tableName]);

    // 인덱스명별로 그룹핑
    const indexGroups = new Map<string, any[]>();
    for (const row of result.rows) {
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
        type: firstRow.INDEX_TYPE
      });
    }

    return indexes;
  }

  /**
   * 테이블 외래키 정보 조회
   */
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

    const result = await this.adapter.query(query, [this.databaseName, tableName]);

    // 제약조건명별로 그룹핑
    const fkGroups = new Map<string, any[]>();
    for (const row of result.rows) {
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
        onDelete: firstRow.DELETE_RULE
      });
    }

    return foreignKeys;
  }

  /**
   * 테이블 통계 정보 조회
   */
  private async getTableStatistics(tableName: string): Promise<MySQLTableStatistics | null> {
    const query = `
      SELECT
        TABLE_NAME,
        TABLE_ROWS,
        DATA_LENGTH,
        INDEX_LENGTH,
        AUTO_INCREMENT,
        CREATE_TIME,
        UPDATE_TIME,
        TABLE_COLLATION,
        ENGINE,
        AVG_ROW_LENGTH,
        DATA_FREE
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `;

    const result = await this.adapter.query(query, [this.databaseName, tableName]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0] as any;
    return {
      tableName: row.TABLE_NAME,
      rowCount: row.TABLE_ROWS || 0,
      dataLength: row.DATA_LENGTH || 0,
      indexLength: row.INDEX_LENGTH || 0,
      autoIncrement: row.AUTO_INCREMENT,
      createTime: row.CREATE_TIME,
      updateTime: row.UPDATE_TIME,
      collation: row.TABLE_COLLATION,
      engine: row.ENGINE,
      avgRowLength: row.AVG_ROW_LENGTH || 0,
      dataFree: row.DATA_FREE || 0
    };
  }

  /**
   * 뷰 정보 조회
   */
  private async analyzeViews(): Promise<ViewInfo[]> {
    const query = `
      SELECT
        TABLE_NAME,
        VIEW_DEFINITION
      FROM INFORMATION_SCHEMA.VIEWS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `;

    const result = await this.adapter.query(query, [this.databaseName]);

    return (result.rows as any[]).map(row => ({
      name: row.TABLE_NAME,
      schema: this.databaseName,
      definition: row.VIEW_DEFINITION
    }));
  }

  /**
   * 프로시저 정보 조회
   */
  private async analyzeProcedures(): Promise<ProcedureInfo[]> {
    const query = `
      SELECT
        ROUTINE_NAME,
        ROUTINE_TYPE
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_SCHEMA = ?
      ORDER BY ROUTINE_NAME
    `;

    const result = await this.adapter.query(query, [this.databaseName]);

    const procedures: ProcedureInfo[] = [];
    for (const row of result.rows) {
      const parameters = await this.getProcedureParameters(row.ROUTINE_NAME);
      procedures.push({
        name: row.ROUTINE_NAME,
        schema: this.databaseName,
        parameters
      });
    }

    return procedures;
  }

  /**
   * 프로시저 파라미터 조회
   */
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

    const result = await this.adapter.query(query, [this.databaseName, routineName]);

    return (result.rows as any[]).map(row => ({
      name: row.PARAMETER_NAME,
      type: row.DATA_TYPE,
      direction: row.PARAMETER_MODE as 'IN' | 'OUT' | 'INOUT'
    }));
  }

  /**
   * MySQL 데이터 타입 정규화
   */
  private normalizeDataType(mysqlType: string): string {
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
      'geometry': 'geometry'
    };

    return typeMap[mysqlType.toLowerCase()] || mysqlType;
  }

  /**
   * MySQL 특화 기능들
   */

  /**
   * 테이블 파티션 정보 조회
   */
  async getTablePartitions(tableName: string): Promise<any[]> {
    const query = `
      SELECT
        PARTITION_NAME,
        PARTITION_EXPRESSION,
        PARTITION_DESCRIPTION,
        TABLE_ROWS,
        DATA_LENGTH,
        INDEX_LENGTH
      FROM INFORMATION_SCHEMA.PARTITIONS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        AND PARTITION_NAME IS NOT NULL
      ORDER BY PARTITION_ORDINAL_POSITION
    `;

    const result = await this.adapter.query(query, [this.databaseName, tableName]);
    return result.rows;
  }

  /**
   * 트리거 정보 조회
   */
  async getTableTriggers(tableName: string): Promise<any[]> {
    const query = `
      SELECT
        TRIGGER_NAME,
        EVENT_MANIPULATION,
        ACTION_TIMING,
        ACTION_STATEMENT
      FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
      ORDER BY TRIGGER_NAME
    `;

    const result = await this.adapter.query(query, [this.databaseName, tableName]);
    return result.rows;
  }

  /**
   * 스토리지 엔진 정보 조회
   */
  async getAvailableEngines(): Promise<any[]> {
    const result = await this.adapter.query('SHOW ENGINES');
    return result.rows;
  }
}