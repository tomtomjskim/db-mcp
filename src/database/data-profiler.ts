import { DatabaseConnection } from './connection.js';
import { TableInfo, ColumnInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface ColumnProfile {
  columnName: string;
  dataType: string;
  totalRows: number;
  nullCount: number;
  nullPercentage: number;
  uniqueCount: number;
  uniquePercentage: number;
  minValue?: any;
  maxValue?: any;
  avgValue?: number;
  topValues?: Array<{ value: any; count: number; percentage: number }>;
  dataQuality: {
    score: number; // 0-100
    issues: string[];
  };
}

export interface TableProfile {
  tableName: string;
  totalRows: number;
  totalColumns: number;
  estimatedSizeBytes: number;
  columns: ColumnProfile[];
  dataQuality: {
    overallScore: number;
    issues: string[];
    recommendations: string[];
  };
  relationships: {
    parentTables: string[];
    childTables: string[];
  };
}

export interface DataProfileOptions {
  sampleSize?: number;
  includeTopValues?: boolean;
  topValuesLimit?: number;
  analyzeDataQuality?: boolean;
  maxStringLength?: number;
}

export class DataProfiler {
  private database: DatabaseConnection;
  private databaseName: string;

  constructor(database: DatabaseConnection, databaseName: string) {
    this.database = database;
    this.databaseName = databaseName;
  }

  async profileTable(tableName: string, options: DataProfileOptions = {}): Promise<TableProfile> {
    const defaultOptions: Required<DataProfileOptions> = {
      sampleSize: 10000,
      includeTopValues: true,
      topValuesLimit: 10,
      analyzeDataQuality: true,
      maxStringLength: 1000,
    };

    const opts = { ...defaultOptions, ...options };

    logger.info('Starting table profiling', { table: tableName, options: opts });

    try {
      // Get table structure
      const columns = await this.getTableColumns(tableName);
      const totalRows = await this.getTableRowCount(tableName);

      // Profile each column
      const columnProfiles: ColumnProfile[] = [];
      for (const column of columns) {
        try {
          const profile = await this.profileColumn(tableName, column, totalRows, opts);
          columnProfiles.push(profile);
        } catch (error) {
          logger.warn('Failed to profile column', { table: tableName, column: column.name, error });
        }
      }

      // Get relationships
      const relationships = await this.getTableRelationships(tableName);

      // Calculate overall data quality
      const dataQuality = this.calculateTableDataQuality(columnProfiles);

      // Estimate table size
      const estimatedSizeBytes = await this.estimateTableSize(tableName);

      const tableProfile: TableProfile = {
        tableName,
        totalRows,
        totalColumns: columns.length,
        estimatedSizeBytes,
        columns: columnProfiles,
        dataQuality,
        relationships,
      };

      logger.info('Table profiling completed', {
        table: tableName,
        rows: totalRows,
        columns: columns.length,
        qualityScore: dataQuality.overallScore,
      });

      return tableProfile;
    } catch (error) {
      logger.error('Table profiling failed', { table: tableName, error });
      throw new Error(`Table profiling failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getTableColumns(tableName: string): Promise<ColumnInfo[]> {
    const query = `
      SELECT
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_KEY,
        CHARACTER_MAXIMUM_LENGTH,
        NUMERIC_PRECISION,
        NUMERIC_SCALE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;

    const result = await this.database.query(query, [this.databaseName, tableName]) as any[];

    return result.map(row => ({
      name: row.COLUMN_NAME,
      type: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
      isAutoIncrement: false, // Will be determined if needed
      maxLength: row.CHARACTER_MAXIMUM_LENGTH,
      precision: row.NUMERIC_PRECISION,
      scale: row.NUMERIC_SCALE,
    }));
  }

  private async getTableRowCount(tableName: string): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM \`${tableName}\``;
    const result = await this.database.query(query) as any[];
    return result[0]?.count || 0;
  }

  private async profileColumn(
    tableName: string,
    column: ColumnInfo,
    totalRows: number,
    options: Required<DataProfileOptions>
  ): Promise<ColumnProfile> {
    const columnName = column.name;
    const isNumeric = this.isNumericType(column.type);
    const isString = this.isStringType(column.type);
    const isDate = this.isDateType(column.type);

    // Basic statistics
    const nullCount = await this.getNullCount(tableName, columnName);
    const uniqueCount = await this.getUniqueCount(tableName, columnName);

    // Min/Max values for appropriate types
    let minValue, maxValue, avgValue;
    if (isNumeric) {
      const stats = await this.getNumericStats(tableName, columnName);
      minValue = stats.min;
      maxValue = stats.max;
      avgValue = stats.avg;
    } else if (isDate) {
      const stats = await this.getDateStats(tableName, columnName);
      minValue = stats.min;
      maxValue = stats.max;
    } else if (isString) {
      const stats = await this.getStringStats(tableName, columnName, options.maxStringLength);
      minValue = stats.minLength;
      maxValue = stats.maxLength;
    }

    // Top values
    let topValues;
    if (options.includeTopValues) {
      topValues = await this.getTopValues(tableName, columnName, options.topValuesLimit, totalRows);
    }

    // Data quality analysis
    const dataQuality = options.analyzeDataQuality
      ? await this.analyzeColumnDataQuality(tableName, column, nullCount, uniqueCount, totalRows, topValues)
      : { score: 100, issues: [] };

    const profile: ColumnProfile = {
      columnName,
      dataType: column.type,
      totalRows,
      nullCount,
      nullPercentage: totalRows > 0 ? (nullCount / totalRows) * 100 : 0,
      uniqueCount,
      uniquePercentage: totalRows > 0 ? (uniqueCount / totalRows) * 100 : 0,
      dataQuality,
    };

    if (minValue !== undefined) profile.minValue = minValue;
    if (maxValue !== undefined) profile.maxValue = maxValue;
    if (avgValue !== undefined) profile.avgValue = avgValue;
    if (topValues !== undefined) profile.topValues = topValues;

    return profile;
  }

  private async getNullCount(tableName: string, columnName: string): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM \`${tableName}\` WHERE \`${columnName}\` IS NULL`;
    const result = await this.database.query(query) as any[];
    return result[0]?.count || 0;
  }

  private async getUniqueCount(tableName: string, columnName: string): Promise<number> {
    const query = `SELECT COUNT(DISTINCT \`${columnName}\`) as count FROM \`${tableName}\``;
    const result = await this.database.query(query) as any[];
    return result[0]?.count || 0;
  }

  private async getNumericStats(tableName: string, columnName: string): Promise<{
    min: number;
    max: number;
    avg: number;
  }> {
    const query = `
      SELECT
        MIN(\`${columnName}\`) as min_val,
        MAX(\`${columnName}\`) as max_val,
        AVG(\`${columnName}\`) as avg_val
      FROM \`${tableName}\`
      WHERE \`${columnName}\` IS NOT NULL
    `;
    const result = await this.database.query(query) as any[];
    const row = result[0] || {};
    return {
      min: row.min_val,
      max: row.max_val,
      avg: row.avg_val,
    };
  }

  private async getDateStats(tableName: string, columnName: string): Promise<{
    min: Date;
    max: Date;
  }> {
    const query = `
      SELECT
        MIN(\`${columnName}\`) as min_val,
        MAX(\`${columnName}\`) as max_val
      FROM \`${tableName}\`
      WHERE \`${columnName}\` IS NOT NULL
    `;
    const result = await this.database.query(query) as any[];
    const row = result[0] || {};
    return {
      min: row.min_val,
      max: row.max_val,
    };
  }

  private async getStringStats(tableName: string, columnName: string, maxLength: number): Promise<{
    minLength: number;
    maxLength: number;
    avgLength: number;
  }> {
    const query = `
      SELECT
        MIN(LENGTH(\`${columnName}\`)) as min_len,
        MAX(LENGTH(\`${columnName}\`)) as max_len,
        AVG(LENGTH(\`${columnName}\`)) as avg_len
      FROM \`${tableName}\`
      WHERE \`${columnName}\` IS NOT NULL
        AND LENGTH(\`${columnName}\`) <= ?
    `;
    const result = await this.database.query(query, [maxLength]) as any[];
    const row = result[0] || {};
    return {
      minLength: row.min_len || 0,
      maxLength: row.max_len || 0,
      avgLength: row.avg_len || 0,
    };
  }

  private async getTopValues(
    tableName: string,
    columnName: string,
    limit: number,
    totalRows: number
  ): Promise<Array<{ value: any; count: number; percentage: number }>> {
    const query = `
      SELECT
        \`${columnName}\` as value,
        COUNT(*) as count
      FROM \`${tableName}\`
      WHERE \`${columnName}\` IS NOT NULL
      GROUP BY \`${columnName}\`
      ORDER BY count DESC
      LIMIT ?
    `;

    const result = await this.database.query(query, [limit]) as any[];

    return result.map(row => ({
      value: row.value,
      count: row.count,
      percentage: totalRows > 0 ? (row.count / totalRows) * 100 : 0,
    }));
  }

  private async analyzeColumnDataQuality(
    tableName: string,
    column: ColumnInfo,
    nullCount: number,
    uniqueCount: number,
    totalRows: number,
    topValues?: Array<{ value: any; count: number; percentage: number }>
  ): Promise<{ score: number; issues: string[] }> {
    const issues: string[] = [];
    let score = 100;

    // Null value analysis
    const nullPercentage = totalRows > 0 ? (nullCount / totalRows) * 100 : 0;
    if (nullPercentage > 50) {
      issues.push(`High null percentage (${nullPercentage.toFixed(1)}%)`);
      score -= 30;
    } else if (nullPercentage > 20) {
      issues.push(`Moderate null percentage (${nullPercentage.toFixed(1)}%)`);
      score -= 15;
    }

    // Uniqueness analysis
    const uniquePercentage = totalRows > 0 ? (uniqueCount / totalRows) * 100 : 0;
    if (column.isPrimaryKey && uniquePercentage < 100) {
      issues.push('Primary key column has duplicate values');
      score -= 40;
    }

    // Data distribution analysis
    if (topValues && topValues.length > 0) {
      const topValuePercentage = topValues[0]!.percentage;
      if (topValuePercentage > 90) {
        issues.push(`Single value dominates (${topValuePercentage.toFixed(1)}%)`);
        score -= 20;
      } else if (topValuePercentage > 70) {
        issues.push(`Top value has high frequency (${topValuePercentage.toFixed(1)}%)`);
        score -= 10;
      }
    }

    // Type-specific validations
    if (this.isNumericType(column.type)) {
      const numericIssues = await this.validateNumericColumn(tableName, column.name);
      issues.push(...numericIssues);
      score -= numericIssues.length * 5;
    }

    if (this.isStringType(column.type)) {
      const stringIssues = await this.validateStringColumn(tableName, column.name, column.maxLength);
      issues.push(...stringIssues);
      score -= stringIssues.length * 5;
    }

    return {
      score: Math.max(0, score),
      issues,
    };
  }

  private async validateNumericColumn(tableName: string, columnName: string): Promise<string[]> {
    const issues: string[] = [];

    // Check for outliers (values more than 3 standard deviations from mean)
    const query = `
      SELECT COUNT(*) as outlier_count
      FROM \`${tableName}\`
      WHERE \`${columnName}\` IS NOT NULL
        AND ABS(\`${columnName}\` - (SELECT AVG(\`${columnName}\`) FROM \`${tableName}\`))
        > 3 * (SELECT STDDEV(\`${columnName}\`) FROM \`${tableName}\`)
    `;

    try {
      const result = await this.database.query(query) as any[];
      const outlierCount = result[0]?.outlier_count || 0;
      if (outlierCount > 0) {
        issues.push(`Contains ${outlierCount} potential outliers`);
      }
    } catch (error) {
      // Ignore errors in outlier detection
    }

    return issues;
  }

  private async validateStringColumn(tableName: string, columnName: string, maxLength?: number): Promise<string[]> {
    const issues: string[] = [];

    // Check for empty strings
    const emptyQuery = `SELECT COUNT(*) as count FROM \`${tableName}\` WHERE \`${columnName}\` = ''`;
    const emptyResult = await this.database.query(emptyQuery) as any[];
    const emptyCount = emptyResult[0]?.count || 0;
    if (emptyCount > 0) {
      issues.push(`Contains ${emptyCount} empty strings`);
    }

    // Check for leading/trailing whitespace
    const whitespaceQuery = `
      SELECT COUNT(*) as count
      FROM \`${tableName}\`
      WHERE \`${columnName}\` != TRIM(\`${columnName}\`)
        AND \`${columnName}\` IS NOT NULL
    `;
    const whitespaceResult = await this.database.query(whitespaceQuery) as any[];
    const whitespaceCount = whitespaceResult[0]?.count || 0;
    if (whitespaceCount > 0) {
      issues.push(`Contains ${whitespaceCount} values with leading/trailing whitespace`);
    }

    return issues;
  }

  private async getTableRelationships(tableName: string): Promise<{
    parentTables: string[];
    childTables: string[];
  }> {
    // Get parent tables (tables this table references)
    const parentQuery = `
      SELECT DISTINCT REFERENCED_TABLE_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `;

    // Get child tables (tables that reference this table)
    const childQuery = `
      SELECT DISTINCT TABLE_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
    `;

    const [parentResult, childResult] = await Promise.all([
      this.database.query(parentQuery, [this.databaseName, tableName]) as Promise<any[]>,
      this.database.query(childQuery, [this.databaseName, tableName]) as Promise<any[]>,
    ]);

    return {
      parentTables: parentResult.map(row => row.REFERENCED_TABLE_NAME),
      childTables: childResult.map(row => row.TABLE_NAME),
    };
  }

  private async estimateTableSize(tableName: string): Promise<number> {
    const query = `
      SELECT DATA_LENGTH + INDEX_LENGTH as size_bytes
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `;

    const result = await this.database.query(query, [this.databaseName, tableName]) as any[];
    return result[0]?.size_bytes || 0;
  }

  private calculateTableDataQuality(columnProfiles: ColumnProfile[]): {
    overallScore: number;
    issues: string[];
    recommendations: string[];
  } {
    if (columnProfiles.length === 0) {
      return { overallScore: 0, issues: ['No columns analyzed'], recommendations: [] };
    }

    const totalScore = columnProfiles.reduce((sum, col) => sum + col.dataQuality.score, 0);
    const overallScore = totalScore / columnProfiles.length;

    const allIssues = columnProfiles.flatMap(col =>
      col.dataQuality.issues.map(issue => `${col.columnName}: ${issue}`)
    );

    const recommendations: string[] = [];

    // Generate recommendations based on issues
    if (overallScore < 70) {
      recommendations.push('Consider data cleaning to improve overall quality');
    }

    const highNullColumns = columnProfiles.filter(col => col.nullPercentage > 30);
    if (highNullColumns.length > 0) {
      recommendations.push(`Review nullable columns: ${highNullColumns.map(c => c.columnName).join(', ')}`);
    }

    const lowUniqueColumns = columnProfiles.filter(col => col.uniquePercentage < 10 && !col.columnName.toLowerCase().includes('status'));
    if (lowUniqueColumns.length > 0) {
      recommendations.push(`Consider indexing or normalization for: ${lowUniqueColumns.map(c => c.columnName).join(', ')}`);
    }

    return {
      overallScore,
      issues: allIssues,
      recommendations,
    };
  }

  // Utility methods
  private isNumericType(type: string): boolean {
    const numericTypes = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'float', 'double', 'decimal'];
    return numericTypes.includes(type.toLowerCase());
  }

  private isStringType(type: string): boolean {
    const stringTypes = ['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext'];
    return stringTypes.includes(type.toLowerCase());
  }

  private isDateType(type: string): boolean {
    const dateTypes = ['date', 'time', 'datetime', 'timestamp', 'year'];
    return dateTypes.includes(type.toLowerCase());
  }

  // Public utility methods
  async generateTableSummary(tableName: string): Promise<{
    name: string;
    rowCount: number;
    columnCount: number;
    sizeBytes: number;
    lastUpdated?: Date;
    qualityScore?: number;
  }> {
    const [rowCount, columnCount, sizeInfo] = await Promise.all([
      this.getTableRowCount(tableName),
      this.database.query(
        'SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [this.databaseName, tableName]
      ),
      this.database.query(
        'SELECT DATA_LENGTH + INDEX_LENGTH as size_bytes, UPDATE_TIME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [this.databaseName, tableName]
      ),
    ]) as [number, any[], any[]];

    const colCount = (columnCount as any[])[0]?.count || 0;
    const sizeData = (sizeInfo as any[])[0] || {};

    return {
      name: tableName,
      rowCount,
      columnCount: colCount,
      sizeBytes: sizeData.size_bytes || 0,
      lastUpdated: sizeData.UPDATE_TIME,
    };
  }
}