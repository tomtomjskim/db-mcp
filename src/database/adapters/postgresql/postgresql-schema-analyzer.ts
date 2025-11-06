import { SchemaAnalyzerBase } from '../base/database-adapter.js';
import {
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  ViewInfo,
  ProcedureInfo,
  ParameterInfo
} from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import type { PostgreSQLAdapter } from './postgresql-adapter.js';

/**
 * PostgreSQL 전용 스키마 분석기
 * PostgreSQL의 information_schema와 pg_catalog을 사용하여 스키마 정보를 분석
 */
export class PostgreSQLSchemaAnalyzer extends SchemaAnalyzerBase {
  declare adapter: PostgreSQLAdapter;

  constructor(adapter: PostgreSQLAdapter) {
    super(adapter);
  }

  /**
   * 전체 스키마 분석
   */
  async analyzeFullSchema(options?: {
    includeTables?: boolean;
    includeViews?: boolean;
    includeProcedures?: boolean;
    includeIndexes?: boolean;
    includeForeignKeys?: boolean;
    schemas?: string[]; // 특정 스키마만 분석
  }): Promise<SchemaInfo> {
    const startTime = Date.now();

    try {
      logger.info('Starting PostgreSQL full schema analysis', {
        adapter: this.adapter.id,
        options
      });

      const schemas = options?.schemas || ['public']; // 기본적으로 public 스키마만 분석

      const [tables, views, procedures] = await Promise.all([
        options?.includeTables !== false ? this.analyzeTables(schemas, options) : [],
        options?.includeViews !== false ? this.analyzeViews(schemas) : [],
        options?.includeProcedures !== false ? this.analyzeProcedures(schemas) : []
      ]);

      const result: SchemaInfo = {
        tables,
        views,
        procedures
      };

      const executionTime = Date.now() - startTime;
      logger.info('PostgreSQL schema analysis completed', {
        adapter: this.adapter.id,
        executionTime,
        tableCount: tables.length,
        viewCount: views.length,
        procedureCount: procedures.length
      });

      return result;

    } catch (error) {
      logger.error('PostgreSQL schema analysis failed', {
        adapter: this.adapter.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 특정 테이블 분석
   */
  async analyzeTable(tableName: string, options?: {
    includeIndexes?: boolean;
    includeForeignKeys?: boolean;
    includeStatistics?: boolean;
    schema?: string;
  }): Promise<TableInfo> {
    const schema = options?.schema || 'public';

    try {
      logger.debug('Analyzing PostgreSQL table', {
        adapter: this.adapter.id,
        tableName,
        schema
      });

      const [columns, indexes, foreignKeys, stats] = await Promise.all([
        this.getTableColumns(tableName, schema),
        options?.includeIndexes !== false ? this.getTableIndexes(tableName, schema) : [],
        options?.includeForeignKeys !== false ? this.getTableForeignKeys(tableName, schema) : [],
        options?.includeStatistics !== false ? this.getTableStatistics(tableName, schema) : null
      ]);

      const tableInfo: TableInfo = {
        name: tableName,
        schema,
        columns,
        indexes,
        foreignKeys,
        ...(stats && {
          rowCount: stats.rowCount,
          sizeInBytes: stats.sizeInBytes
        })
      };

      return tableInfo;

    } catch (error) {
      logger.error('PostgreSQL table analysis failed', {
        adapter: this.adapter.id,
        tableName,
        schema,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 테이블 관계 분석
   */
  async getTableRelationships(): Promise<Map<string, string[]>> {
    try {
      const query = `
        SELECT
          tc.table_name as source_table,
          ccu.table_name as target_table,
          tc.table_schema
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('information_schema', 'pg_catalog')
        ORDER BY tc.table_name
      `;

      const result = await this.adapter.query(query);
      const relationships = new Map<string, string[]>();

      for (const row of result.rows) {
        const sourceTable = `${row.table_schema}.${row.source_table}`;
        const targetTable = `${row.table_schema}.${row.target_table}`;

        if (!relationships.has(sourceTable)) {
          relationships.set(sourceTable, []);
        }
        relationships.get(sourceTable)!.push(targetTable);
      }

      return relationships;

    } catch (error) {
      logger.error('PostgreSQL table relationships analysis failed', {
        adapter: this.adapter.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 데이터베이스 정보 조회
   */
  async getDatabaseInfo(): Promise<{
    version: string;
    encoding: string;
    collation: string;
    schemas: string[];
    extensions: Array<{ name: string; version: string }>;
    settings: Record<string, any>;
  }> {
    try {
      const [versionResult, dbInfoResult, schemasResult, extensionsResult, settingsResult] = await Promise.all([
        this.adapter.query('SELECT version()'),
        this.adapter.query(`
          SELECT
            pg_encoding_to_char(encoding) as encoding,
            datcollate as collation
          FROM pg_database
          WHERE datname = current_database()
        `),
        this.adapter.query(`
          SELECT schema_name
          FROM information_schema.schemata
          WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
          ORDER BY schema_name
        `),
        this.adapter.query(`
          SELECT extname as name, extversion as version
          FROM pg_extension
          ORDER BY extname
        `),
        this.adapter.query(`
          SELECT name, setting, unit, context, category, short_desc
          FROM pg_settings
          WHERE name IN (
            'max_connections', 'shared_buffers', 'effective_cache_size',
            'maintenance_work_mem', 'checkpoint_completion_target',
            'wal_buffers', 'default_statistics_target', 'random_page_cost',
            'effective_io_concurrency', 'work_mem'
          )
          ORDER BY name
        `)
      ]);

      const settings: Record<string, any> = {};
      settingsResult.rows.forEach((row) => {
        settings[row.name] = {
          value: row.setting,
          unit: row.unit,
          context: row.context,
          category: row.category,
          description: row.short_desc
        };
      });

      return {
        version: versionResult.rows[0]?.version || 'Unknown',
        encoding: dbInfoResult.rows[0]?.encoding || 'Unknown',
        collation: dbInfoResult.rows[0]?.collation || 'Unknown',
        schemas: schemasResult.rows.map(row => row.schema_name),
        extensions: extensionsResult.rows.map(row => ({
          name: row.name,
          version: row.version
        })),
        settings
      };

    } catch (error) {
      logger.error('PostgreSQL database info retrieval failed', {
        adapter: this.adapter.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 테이블 목록 분석
   */
  private async analyzeTables(schemas: string[], options?: any): Promise<TableInfo[]> {
    const tablesQuery = `
      SELECT
        table_name,
        table_schema
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema = ANY($1)
      ORDER BY table_schema, table_name
    `;

    const result = await this.adapter.query(tablesQuery, [schemas]);
    const tables: TableInfo[] = [];

    for (const row of result.rows) {
      try {
        const tableInfo = await this.analyzeTable(row.table_name, {
          schema: row.table_schema,
          includeIndexes: options?.includeIndexes,
          includeForeignKeys: options?.includeForeignKeys,
          includeStatistics: true
        });
        tables.push(tableInfo);
      } catch (error) {
        logger.warn('Failed to analyze table, skipping', {
          adapter: this.adapter.id,
          tableName: row.table_name,
          schema: row.table_schema,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return tables;
  }

  /**
   * 뷰 목록 분석
   */
  private async analyzeViews(schemas: string[]): Promise<ViewInfo[]> {
    const viewsQuery = `
      SELECT
        table_name as view_name,
        table_schema as schema,
        view_definition as definition
      FROM information_schema.views
      WHERE table_schema = ANY($1)
      ORDER BY table_schema, table_name
    `;

    const result = await this.adapter.query(viewsQuery, [schemas]);

    return result.rows.map(row => ({
      name: row.view_name,
      schema: row.schema,
      definition: row.definition
    }));
  }

  /**
   * 프로시저/함수 목록 분석
   */
  private async analyzeProcedures(schemas: string[]): Promise<ProcedureInfo[]> {
    const proceduresQuery = `
      SELECT
        p.proname as procedure_name,
        n.nspname as schema,
        pg_get_function_arguments(p.oid) as arguments
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = ANY($1)
        AND p.prokind IN ('f', 'p') -- 함수와 프로시저
      ORDER BY n.nspname, p.proname
    `;

    const result = await this.adapter.query(proceduresQuery, [schemas]);

    return result.rows.map(row => ({
      name: row.procedure_name,
      schema: row.schema,
      parameters: this.parseParameters(row.arguments || '')
    }));
  }

  /**
   * 테이블 컬럼 정보 조회
   */
  private async getTableColumns(tableName: string, schema: string): Promise<ColumnInfo[]> {
    const columnsQuery = `
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale,
        CASE
          WHEN pk.column_name IS NOT NULL THEN true
          ELSE false
        END as is_primary_key,
        CASE
          WHEN c.column_default LIKE 'nextval%' THEN true
          ELSE false
        END as is_auto_increment
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku
          ON tc.constraint_name = ku.constraint_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_name = $1
          AND tc.table_schema = $2
      ) pk ON c.column_name = pk.column_name
      WHERE c.table_name = $1
        AND c.table_schema = $2
      ORDER BY c.ordinal_position
    `;

    const result = await this.adapter.query(columnsQuery, [tableName, schema]);

    return result.rows.map(row => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      isPrimaryKey: row.is_primary_key,
      isAutoIncrement: row.is_auto_increment,
      maxLength: row.character_maximum_length,
      precision: row.numeric_precision,
      scale: row.numeric_scale
    }));
  }

  /**
   * 테이블 인덱스 정보 조회
   */
  private async getTableIndexes(tableName: string, schema: string): Promise<IndexInfo[]> {
    const indexesQuery = `
      SELECT
        i.relname as index_name,
        array_agg(a.attname ORDER BY c.ordinality) as columns,
        ix.indisunique as is_unique,
        ix.indisprimary as is_primary,
        am.amname as index_type
      FROM pg_class t
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_am am ON i.relam = am.oid
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS c(attnum, ordinality) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.attnum
      WHERE t.relname = $1
        AND n.nspname = $2
        AND t.relkind = 'r'
      GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname
      ORDER BY i.relname
    `;

    const result = await this.adapter.query(indexesQuery, [tableName, schema]);

    return result.rows.map(row => ({
      name: row.index_name,
      columns: row.columns,
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
      type: row.index_type
    }));
  }

  /**
   * 테이블 외래 키 정보 조회
   */
  private async getTableForeignKeys(tableName: string, schema: string): Promise<ForeignKeyInfo[]> {
    const foreignKeysQuery = `
      SELECT
        tc.constraint_name,
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) as columns,
        ccu.table_name as referenced_table,
        array_agg(ccu.column_name ORDER BY kcu.ordinal_position) as referenced_columns,
        rc.update_rule as on_update,
        rc.delete_rule as on_delete
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = $1
        AND tc.table_schema = $2
      GROUP BY tc.constraint_name, ccu.table_name, rc.update_rule, rc.delete_rule
      ORDER BY tc.constraint_name
    `;

    const result = await this.adapter.query(foreignKeysQuery, [tableName, schema]);

    return result.rows.map(row => ({
      name: row.constraint_name,
      columns: row.columns,
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns,
      onUpdate: row.on_update,
      onDelete: row.on_delete
    }));
  }

  /**
   * 테이블 통계 정보 조회
   */
  private async getTableStatistics(tableName: string, schema: string): Promise<{
    rowCount: number;
    sizeInBytes: number;
  } | null> {
    try {
      const statsQuery = `
        SELECT
          schemaname,
          tablename,
          n_tup_ins as inserts,
          n_tup_upd as updates,
          n_tup_del as deletes,
          n_live_tup as row_count,
          pg_total_relation_size(schemaname||'.'||tablename) as size_bytes
        FROM pg_stat_user_tables
        WHERE tablename = $1
          AND schemaname = $2
      `;

      const result = await this.adapter.query(statsQuery, [tableName, schema]);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          rowCount: parseInt(row.row_count) || 0,
          sizeInBytes: parseInt(row.size_bytes) || 0
        };
      }

      // pg_stat_user_tables에 없는 경우 직접 카운트
      const countResult = await this.adapter.query(
        `SELECT COUNT(*) as count FROM "${schema}"."${tableName}"`
      );

      return {
        rowCount: parseInt(countResult.rows[0]?.count) || 0,
        sizeInBytes: 0
      };

    } catch (error) {
      logger.warn('Failed to get table statistics', {
        adapter: this.adapter.id,
        tableName,
        schema,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * 프로시저 매개변수 파싱
   */
  private parseParameters(argumentsString: string): ParameterInfo[] {
    if (!argumentsString || argumentsString.trim() === '') {
      return [];
    }

    // 간단한 매개변수 파싱 (더 정교한 파싱이 필요할 수 있음)
    const params = argumentsString.split(',').map(param => param.trim());

    return params.map(param => {
      const parts = param.split(' ');
      const direction = parts[0]?.toUpperCase();

      if (direction && ['IN', 'OUT', 'INOUT'].includes(direction)) {
        return {
          name: parts[1] || 'unnamed',
          type: parts[2] || 'unknown',
          direction: direction as 'IN' | 'OUT' | 'INOUT'
        };
      } else {
        // direction이 명시되지 않은 경우 기본값은 IN
        return {
          name: parts[0] || 'unnamed',
          type: parts[1] || 'unknown',
          direction: 'IN' as const
        };
      }
    });
  }
}