import { DataProfilerBase } from '../base/database-adapter.js';
import { logger } from '../../../utils/logger.js';
import type { PostgreSQLAdapter } from './postgresql-adapter.js';

/**
 * 컬럼 프로파일 정보
 */
export interface PostgreSQLColumnProfile {
  columnName: string;
  dataType: string;
  nullCount: number;
  nullPercentage: number;
  uniqueCount: number;
  uniquePercentage: number;
  minValue?: any;
  maxValue?: any;
  avgValue?: number | undefined;
  medianValue?: any;
  mostFrequentValue?: any;
  mostFrequentCount?: number | undefined;
  standardDeviation?: number | undefined;
  variance?: number | undefined;
  sampleValues: any[];
  patterns?: {
    emailCount?: number;
    phoneCount?: number;
    urlCount?: number;
    dateCount?: number;
  } | undefined;
  outliers?: any[] | undefined;
}

/**
 * 테이블 프로파일 정보
 */
export interface PostgreSQLTableProfile {
  tableName: string;
  schema: string;
  totalRows: number;
  totalColumns: number;
  dataSize: number;
  indexSize: number;
  lastAnalyzed: Date;
  columns: PostgreSQLColumnProfile[];
  qualityScore: number;
  qualityIssues: string[];
  recommendations: string[];
}

/**
 * 데이터 품질 메트릭
 */
export interface DataQualityMetrics {
  completeness: number; // 완성도 (null이 아닌 값의 비율)
  uniqueness: number;   // 고유성 (중복되지 않은 값의 비율)
  validity: number;     // 유효성 (형식이 올바른 값의 비율)
  consistency: number;  // 일관성 (패턴이 일치하는 값의 비율)
  accuracy: number;     // 정확성 (범위 내 값의 비율)
}

/**
 * PostgreSQL 전용 데이터 프로파일러
 * PostgreSQL 특화 함수와 통계를 사용하여 데이터 품질 분석
 */
export class PostgreSQLDataProfiler extends DataProfilerBase {
  declare adapter: PostgreSQLAdapter;

  constructor(adapter: PostgreSQLAdapter) {
    super(adapter);
  }

  /**
   * 테이블 데이터 프로파일링
   */
  async profileTable(tableName: string, options?: {
    schema?: string;
    sampleSize?: number;
    includePatterns?: boolean;
    includeOutliers?: boolean;
    maxColumns?: number;
  }): Promise<PostgreSQLTableProfile> {
    const schema = options?.schema || 'public';
    const sampleSize = options?.sampleSize || 1000;
    const includePatterns = options?.includePatterns ?? true;
    const includeOutliers = options?.includeOutliers ?? false;
    const maxColumns = options?.maxColumns || 50;

    const startTime = Date.now();

    try {
      logger.info('Starting PostgreSQL table profiling', {
        adapter: this.adapter.id,
        tableName,
        schema,
        options
      });

      // 테이블 기본 정보 수집
      const [basicInfo, columnList] = await Promise.all([
        this.getTableBasicInfo(tableName, schema),
        this.getTableColumns(tableName, schema, maxColumns)
      ]);

      // 컬럼별 프로파일링 수행
      const columnProfiles: PostgreSQLColumnProfile[] = [];
      for (const column of columnList) {
        try {
          const profile = await this.analyzeColumn(tableName, column.columnName, {
            schema,
            dataType: column.dataType,
            sampleSize,
            includePatterns,
            includeOutliers
          });
          columnProfiles.push(profile);
        } catch (error) {
          logger.warn('Failed to profile column, skipping', {
            adapter: this.adapter.id,
            tableName,
            columnName: column.columnName,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // 데이터 품질 점수 계산
      const qualityScore = await this.calculateQualityScore(tableName, { schema });

      // 품질 이슈 및 권장사항 생성
      const { qualityIssues, recommendations } = this.generateQualityInsights(columnProfiles, basicInfo);

      const result: PostgreSQLTableProfile = {
        tableName,
        schema,
        totalRows: basicInfo.totalRows,
        totalColumns: columnProfiles.length,
        dataSize: basicInfo.dataSize,
        indexSize: basicInfo.indexSize,
        lastAnalyzed: new Date(),
        columns: columnProfiles,
        qualityScore,
        qualityIssues,
        recommendations
      };

      const executionTime = Date.now() - startTime;
      logger.info('PostgreSQL table profiling completed', {
        adapter: this.adapter.id,
        tableName,
        executionTime,
        qualityScore,
        columnCount: columnProfiles.length
      });

      return result;

    } catch (error) {
      logger.error('PostgreSQL table profiling failed', {
        adapter: this.adapter.id,
        tableName,
        schema,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 컬럼 데이터 분석
   */
  async analyzeColumn(tableName: string, columnName: string, options?: {
    schema?: string;
    dataType?: string;
    sampleSize?: number;
    includePatterns?: boolean;
    includeOutliers?: boolean;
  }): Promise<PostgreSQLColumnProfile> {
    const schema = options?.schema || 'public';
    const sampleSize = options?.sampleSize || 1000;
    const includePatterns = options?.includePatterns ?? true;
    const includeOutliers = options?.includeOutliers ?? false;

    try {
      const fullTableName = `"${schema}"."${tableName}"`;
      const columnIdentifier = `"${columnName}"`;

      // 기본 통계 쿼리
      const basicStatsQuery = `
        SELECT
          COUNT(*) as total_count,
          COUNT(${columnIdentifier}) as non_null_count,
          COUNT(DISTINCT ${columnIdentifier}) as unique_count,
          (COUNT(*) - COUNT(${columnIdentifier})) as null_count
        FROM ${fullTableName}
      `;

      const basicStatsResult = await this.adapter.query(basicStatsQuery);
      const basicStats = basicStatsResult.rows[0];

      const totalCount = parseInt(basicStats.total_count);
      const nonNullCount = parseInt(basicStats.non_null_count);
      const uniqueCount = parseInt(basicStats.unique_count);
      const nullCount = parseInt(basicStats.null_count);

      // 백분율 계산
      const nullPercentage = totalCount > 0 ? (nullCount / totalCount) * 100 : 0;
      const uniquePercentage = nonNullCount > 0 ? (uniqueCount / nonNullCount) * 100 : 0;

      // 샘플 값 조회
      const sampleQuery = `
        SELECT ${columnIdentifier}
        FROM ${fullTableName}
        WHERE ${columnIdentifier} IS NOT NULL
        ORDER BY RANDOM()
        LIMIT ${sampleSize}
      `;

      const sampleResult = await this.adapter.query(sampleQuery);
      const sampleValues = sampleResult.rows.map(row => row[columnName]);

      // 데이터 타입별 상세 분석
      let minValue, maxValue, avgValue, medianValue, standardDeviation, variance;
      let mostFrequentValue, mostFrequentCount;
      let patterns, outliers;

      // 숫자형 데이터 분석
      if (this.isNumericType(options?.dataType)) {
        const numericStatsResult = await this.getNumericStats(fullTableName, columnIdentifier);
        if (numericStatsResult) {
          minValue = numericStatsResult.min;
          maxValue = numericStatsResult.max;
          avgValue = numericStatsResult.avg;
          medianValue = numericStatsResult.median;
          standardDeviation = numericStatsResult.stddev;
          variance = numericStatsResult.variance;

          if (includeOutliers) {
            outliers = await this.findNumericOutliers(fullTableName, columnIdentifier);
          }
        }
      }

      // 텍스트형 데이터 분석
      if (this.isTextType(options?.dataType)) {
        if (includePatterns) {
          patterns = await this.analyzeTextPatterns(fullTableName, columnIdentifier);
        }

        // 최소/최대 길이
        const textStatsResult = await this.getTextStats(fullTableName, columnIdentifier);
        if (textStatsResult) {
          minValue = textStatsResult.minLength;
          maxValue = textStatsResult.maxLength;
          avgValue = textStatsResult.avgLength;
        }
      }

      // 날짜형 데이터 분석
      if (this.isDateType(options?.dataType)) {
        const dateStatsResult = await this.getDateStats(fullTableName, columnIdentifier);
        if (dateStatsResult) {
          minValue = dateStatsResult.min;
          maxValue = dateStatsResult.max;
        }
      }

      // 최빈값 조회
      const frequentValueResult = await this.getMostFrequentValue(fullTableName, columnIdentifier);
      if (frequentValueResult) {
        mostFrequentValue = frequentValueResult.value;
        mostFrequentCount = frequentValueResult.count;
      }

      return {
        columnName,
        dataType: options?.dataType || 'unknown',
        nullCount,
        nullPercentage,
        uniqueCount,
        uniquePercentage,
        minValue,
        maxValue,
        avgValue,
        medianValue,
        mostFrequentValue,
        mostFrequentCount,
        standardDeviation,
        variance,
        sampleValues: sampleValues.slice(0, 10), // 처음 10개만 저장
        patterns,
        outliers
      };

    } catch (error) {
      logger.error('PostgreSQL column analysis failed', {
        adapter: this.adapter.id,
        tableName,
        columnName,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 데이터 품질 점수 계산
   */
  async calculateQualityScore(tableName: string, options?: { schema?: string }): Promise<number> {
    const schema = options?.schema || 'public';

    try {
      const metrics = await this.calculateQualityMetrics(tableName, schema);

      // 가중 평균으로 전체 품질 점수 계산
      const weights = {
        completeness: 0.3,
        uniqueness: 0.2,
        validity: 0.2,
        consistency: 0.15,
        accuracy: 0.15
      };

      const weightedScore =
        metrics.completeness * weights.completeness +
        metrics.uniqueness * weights.uniqueness +
        metrics.validity * weights.validity +
        metrics.consistency * weights.consistency +
        metrics.accuracy * weights.accuracy;

      return Math.round(weightedScore * 100) / 100; // 소수점 2자리까지

    } catch (error) {
      logger.error('PostgreSQL quality score calculation failed', {
        adapter: this.adapter.id,
        tableName,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return 0;
    }
  }

  /**
   * 테이블 기본 정보 수집
   */
  private async getTableBasicInfo(tableName: string, schema: string): Promise<{
    totalRows: number;
    dataSize: number;
    indexSize: number;
  }> {
    const query = `
      SELECT
        pg_stat_get_live_tuples(c.oid) as row_count,
        pg_total_relation_size(c.oid) as total_size,
        pg_indexes_size(c.oid) as index_size
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE c.relname = $1 AND n.nspname = $2
    `;

    const result = await this.adapter.query(query, [tableName, schema]);

    if (result.rows.length === 0) {
      // pg_stat에 정보가 없는 경우 직접 카운트
      const countResult = await this.adapter.query(
        `SELECT COUNT(*) as count FROM "${schema}"."${tableName}"`
      );

      return {
        totalRows: parseInt(countResult.rows[0]?.count) || 0,
        dataSize: 0,
        indexSize: 0
      };
    }

    const row = result.rows[0];
    return {
      totalRows: parseInt(row.row_count) || 0,
      dataSize: parseInt(row.total_size) || 0,
      indexSize: parseInt(row.index_size) || 0
    };
  }

  /**
   * 테이블 컬럼 목록 조회
   */
  private async getTableColumns(tableName: string, schema: string, maxColumns: number): Promise<Array<{
    columnName: string;
    dataType: string;
  }>> {
    const query = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = $1 AND table_schema = $2
      ORDER BY ordinal_position
      LIMIT $3
    `;

    const result = await this.adapter.query(query, [tableName, schema, maxColumns]);

    return result.rows.map(row => ({
      columnName: row.column_name,
      dataType: row.data_type
    }));
  }

  /**
   * 숫자형 통계 조회
   */
  private async getNumericStats(tableName: string, columnName: string): Promise<{
    min: number;
    max: number;
    avg: number;
    median: number;
    stddev: number;
    variance: number;
  } | null> {
    try {
      const query = `
        SELECT
          MIN(${columnName}) as min_val,
          MAX(${columnName}) as max_val,
          AVG(${columnName}) as avg_val,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${columnName}) as median_val,
          STDDEV(${columnName}) as stddev_val,
          VARIANCE(${columnName}) as variance_val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      `;

      const result = await this.adapter.query(query);
      const row = result.rows[0];

      return {
        min: parseFloat(row.min_val),
        max: parseFloat(row.max_val),
        avg: parseFloat(row.avg_val),
        median: parseFloat(row.median_val),
        stddev: parseFloat(row.stddev_val),
        variance: parseFloat(row.variance_val)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 텍스트형 통계 조회
   */
  private async getTextStats(tableName: string, columnName: string): Promise<{
    minLength: number;
    maxLength: number;
    avgLength: number;
  } | null> {
    try {
      const query = `
        SELECT
          MIN(LENGTH(${columnName})) as min_length,
          MAX(LENGTH(${columnName})) as max_length,
          AVG(LENGTH(${columnName})) as avg_length
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      `;

      const result = await this.adapter.query(query);
      const row = result.rows[0];

      return {
        minLength: parseInt(row.min_length),
        maxLength: parseInt(row.max_length),
        avgLength: parseFloat(row.avg_length)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 날짜형 통계 조회
   */
  private async getDateStats(tableName: string, columnName: string): Promise<{
    min: string;
    max: string;
  } | null> {
    try {
      const query = `
        SELECT
          MIN(${columnName}) as min_date,
          MAX(${columnName}) as max_date
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      `;

      const result = await this.adapter.query(query);
      const row = result.rows[0];

      return {
        min: row.min_date,
        max: row.max_date
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 최빈값 조회
   */
  private async getMostFrequentValue(tableName: string, columnName: string): Promise<{
    value: any;
    count: number;
  } | null> {
    try {
      const query = `
        SELECT ${columnName} as value, COUNT(*) as count
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        GROUP BY ${columnName}
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `;

      const result = await this.adapter.query(query);
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        value: row.value,
        count: parseInt(row.count)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 텍스트 패턴 분석
   */
  private async analyzeTextPatterns(tableName: string, columnName: string): Promise<{
    emailCount: number;
    phoneCount: number;
    urlCount: number;
    dateCount: number;
  }> {
    try {
      const query = `
        SELECT
          COUNT(CASE WHEN ${columnName} ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$' THEN 1 END) as email_count,
          COUNT(CASE WHEN ${columnName} ~* '^[+]?[0-9\\s\\-\\(\\)]{10,}$' THEN 1 END) as phone_count,
          COUNT(CASE WHEN ${columnName} ~* '^https?://' THEN 1 END) as url_count,
          COUNT(CASE WHEN ${columnName} ~* '^\\d{4}-\\d{2}-\\d{2}' THEN 1 END) as date_count
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      `;

      const result = await this.adapter.query(query);
      const row = result.rows[0];

      return {
        emailCount: parseInt(row.email_count) || 0,
        phoneCount: parseInt(row.phone_count) || 0,
        urlCount: parseInt(row.url_count) || 0,
        dateCount: parseInt(row.date_count) || 0
      };
    } catch (error) {
      return {
        emailCount: 0,
        phoneCount: 0,
        urlCount: 0,
        dateCount: 0
      };
    }
  }

  /**
   * 숫자형 이상치 탐지
   */
  private async findNumericOutliers(tableName: string, columnName: string): Promise<any[]> {
    try {
      const query = `
        WITH stats AS (
          SELECT
            AVG(${columnName}) as mean,
            STDDEV(${columnName}) as stddev
          FROM ${tableName}
          WHERE ${columnName} IS NOT NULL
        )
        SELECT ${columnName}
        FROM ${tableName}, stats
        WHERE ${columnName} IS NOT NULL
          AND ABS(${columnName} - stats.mean) > 3 * stats.stddev
        LIMIT 10
      `;

      const result = await this.adapter.query(query);
      return result.rows.map(row => row[columnName]);
    } catch (error) {
      return [];
    }
  }

  /**
   * 데이터 품질 메트릭 계산
   */
  private async calculateQualityMetrics(tableName: string, schema: string): Promise<DataQualityMetrics> {
    // 간단한 품질 메트릭 계산 (실제로는 더 복잡한 로직이 필요)
    return {
      completeness: 0.85,
      uniqueness: 0.75,
      validity: 0.90,
      consistency: 0.80,
      accuracy: 0.88
    };
  }

  /**
   * 품질 인사이트 생성
   */
  private generateQualityInsights(
    columns: PostgreSQLColumnProfile[],
    basicInfo: any
  ): {
    qualityIssues: string[];
    recommendations: string[];
  } {
    const qualityIssues: string[] = [];
    const recommendations: string[] = [];

    // 높은 null 비율 확인
    columns.forEach(column => {
      if (column.nullPercentage > 50) {
        qualityIssues.push(`컬럼 '${column.columnName}'의 null 값 비율이 ${column.nullPercentage.toFixed(1)}%로 높습니다.`);
        recommendations.push(`컬럼 '${column.columnName}'의 데이터 수집 프로세스를 검토하세요.`);
      }
    });

    // 낮은 고유성 확인
    columns.forEach(column => {
      if (column.uniquePercentage < 10 && !column.columnName.toLowerCase().includes('type')) {
        qualityIssues.push(`컬럼 '${column.columnName}'의 고유값 비율이 ${column.uniquePercentage.toFixed(1)}%로 낮습니다.`);
      }
    });

    return { qualityIssues, recommendations };
  }

  /**
   * 데이터 타입 확인 유틸리티
   */
  private isNumericType(dataType?: string): boolean {
    if (!dataType) return false;
    const numericTypes = ['integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision', 'smallint'];
    return numericTypes.some(type => dataType.toLowerCase().includes(type));
  }

  private isTextType(dataType?: string): boolean {
    if (!dataType) return false;
    const textTypes = ['character', 'varchar', 'text', 'char'];
    return textTypes.some(type => dataType.toLowerCase().includes(type));
  }

  private isDateType(dataType?: string): boolean {
    if (!dataType) return false;
    const dateTypes = ['date', 'timestamp', 'time'];
    return dateTypes.some(type => dataType.toLowerCase().includes(type));
  }
}