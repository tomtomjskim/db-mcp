import { DataProfilerBase } from '../base/database-adapter.js';
import { logger } from '../../../utils/logger.js';
import { MySQLAdapter } from './mysql-adapter.js';

/**
 * MySQL 데이터 프로파일링 옵션
 */
export interface MySQLProfilingOptions {
  sampleSize?: number;
  maxSampleRows?: number;
  includeDistribution?: boolean;
  includePatterns?: boolean;
  includeOutliers?: boolean;
  performanceMode?: boolean;
}

/**
 * MySQL 컬럼 프로필
 */
export interface MySQLColumnProfile {
  columnName: string;
  dataType: string;
  nullCount: number;
  nullPercentage: number;
  uniqueCount: number;
  uniquePercentage: number;
  totalRows: number;
  minValue?: any;
  maxValue?: any;
  avgValue?: number;
  medianValue?: any;
  mode?: any;
  standardDeviation?: number;
  variance?: number;
  topValues?: Array<{ value: any; count: number; percentage: number }>;
  distribution?: { [range: string]: number };
  patterns?: string[];
  outliers?: any[];
  dataQualityIssues: string[];
  mysqlSpecific?: {
    characterSet?: string;
    collation?: string;
    enumValues?: string[];
    setValues?: string[];
  };
}

/**
 * MySQL 테이블 프로필
 */
export interface MySQLTableProfile {
  tableName: string;
  totalRows: number;
  columnProfiles: MySQLColumnProfile[];
  qualityScore: number;
  completenessScore: number;
  consistencyScore: number;
  validityScore: number;
  recommendations: string[];
  mysqlSpecific: {
    engine: string;
    avgRowLength: number;
    dataLength: number;
    indexLength: number;
    autoIncrement?: number;
    createTime?: Date;
    updateTime?: Date;
    checkTime?: Date;
  };
  samplingInfo: {
    sampleSize: number;
    totalRows: number;
    samplingMethod: string;
    confidence: number;
  };
}

/**
 * MySQL 특화 데이터 프로파일러
 * MySQL의 고유 기능과 통계 함수를 활용한 데이터 분석
 */
export class MySQLDataProfiler extends DataProfilerBase {
  public adapter: MySQLAdapter;
  private databaseName: string;

  constructor(adapter: MySQLAdapter) {
    super(adapter);
    this.adapter = adapter;
    this.databaseName = adapter.getConnectionInfo().database;
  }

  /**
   * 테이블 데이터 프로파일링
   */
  async profileTable(tableName: string, options: MySQLProfilingOptions = {}): Promise<MySQLTableProfile> {
    const defaultOptions: Required<MySQLProfilingOptions> = {
      sampleSize: 1000,
      maxSampleRows: 10000,
      includeDistribution: true,
      includePatterns: true,
      includeOutliers: true,
      performanceMode: false
    };

    const opts = { ...defaultOptions, ...options };

    try {
      logger.info('Starting MySQL table profiling', {
        table: tableName,
        database: this.databaseName,
        options: opts
      });

      // 기본 테이블 정보 수집
      const tableInfo = await this.getTableBasicInfo(tableName);
      const columns = await this.getTableColumns(tableName);

      // 샘플링 전략 결정
      const samplingInfo = this.determineSamplingStrategy(tableInfo.totalRows, opts);

      // 컬럼별 프로파일링
      const columnProfiles: MySQLColumnProfile[] = [];
      for (const column of columns) {
        try {
          const profile = await this.analyzeColumn(tableName, column.name, opts);
          columnProfiles.push(profile);
        } catch (error) {
          logger.warn('Failed to profile column', {
            table: tableName,
            column: column.name,
            error
          });

          // 기본 프로필 생성
          columnProfiles.push({
            columnName: column.name,
            dataType: column.type,
            nullCount: 0,
            nullPercentage: 0,
            uniqueCount: 0,
            uniquePercentage: 0,
            totalRows: tableInfo.totalRows,
            dataQualityIssues: ['profiling_failed']
          });
        }
      }

      // 품질 점수 계산
      const qualityScores = this.calculateQualityScores(columnProfiles);

      // 권장사항 생성
      const recommendations = this.generateRecommendations(columnProfiles, tableInfo);

      const profile: MySQLTableProfile = {
        tableName,
        totalRows: tableInfo.totalRows,
        columnProfiles,
        qualityScore: qualityScores.overall,
        completenessScore: qualityScores.completeness,
        consistencyScore: qualityScores.consistency,
        validityScore: qualityScores.validity,
        recommendations,
        mysqlSpecific: {
          engine: tableInfo.engine,
          avgRowLength: tableInfo.avgRowLength,
          dataLength: tableInfo.dataLength,
          indexLength: tableInfo.indexLength,
          autoIncrement: tableInfo.autoIncrement,
          createTime: tableInfo.createTime,
          updateTime: tableInfo.updateTime,
          checkTime: tableInfo.checkTime
        },
        samplingInfo
      };

      logger.info('MySQL table profiling completed', {
        table: tableName,
        totalRows: profile.totalRows,
        qualityScore: profile.qualityScore,
        columnsAnalyzed: columnProfiles.length
      });

      return profile;

    } catch (error) {
      logger.error('MySQL table profiling failed', {
        table: tableName,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 컬럼 데이터 분석
   */
  async analyzeColumn(
    tableName: string,
    columnName: string,
    options: MySQLProfilingOptions = {}
  ): Promise<MySQLColumnProfile> {
    const opts = {
      sampleSize: 1000,
      includeDistribution: true,
      includePatterns: true,
      includeOutliers: true,
      ...options
    };

    try {
      // 컬럼 메타데이터 조회
      const columnInfo = await this.getColumnInfo(tableName, columnName);

      // 기본 통계 수집
      const basicStats = await this.getColumnBasicStats(tableName, columnName, opts.sampleSize);

      // 고급 분석 수행
      const [topValues, distribution, patterns, outliers] = await Promise.all([
        this.getTopValues(tableName, columnName, 10),
        opts.includeDistribution ? this.getValueDistribution(tableName, columnName, columnInfo.dataType) : Promise.resolve({}),
        opts.includePatterns ? this.analyzePatterns(tableName, columnName, columnInfo.dataType) : Promise.resolve([]),
        opts.includeOutliers ? this.detectOutliers(tableName, columnName, columnInfo.dataType) : Promise.resolve([])
      ]);

      // 데이터 품질 이슈 탐지
      const qualityIssues = this.detectQualityIssues(basicStats, topValues, columnInfo);

      // MySQL 특화 정보 수집
      const mysqlSpecific = await this.getMySQLSpecificInfo(tableName, columnName, columnInfo.dataType);

      const profile: MySQLColumnProfile = {
        columnName,
        dataType: columnInfo.dataType,
        nullCount: basicStats.nullCount,
        nullPercentage: basicStats.nullPercentage,
        uniqueCount: basicStats.uniqueCount,
        uniquePercentage: basicStats.uniquePercentage,
        totalRows: basicStats.totalRows,
        minValue: basicStats.minValue,
        maxValue: basicStats.maxValue,
        avgValue: basicStats.avgValue,
        medianValue: basicStats.medianValue,
        mode: basicStats.mode,
        standardDeviation: basicStats.standardDeviation,
        variance: basicStats.variance,
        topValues,
        distribution,
        patterns,
        outliers,
        dataQualityIssues: qualityIssues,
        mysqlSpecific
      };

      return profile;

    } catch (error) {
      logger.error('MySQL column analysis failed', {
        table: tableName,
        column: columnName,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 데이터 품질 점수 계산
   */
  async calculateQualityScore(tableName: string): Promise<number> {
    const profile = await this.profileTable(tableName, { performanceMode: true });
    return profile.qualityScore;
  }

  /**
   * 테이블 기본 정보 조회
   */
  private async getTableBasicInfo(tableName: string): Promise<any> {
    const query = `
      SELECT
        TABLE_ROWS as totalRows,
        ENGINE as engine,
        AVG_ROW_LENGTH as avgRowLength,
        DATA_LENGTH as dataLength,
        INDEX_LENGTH as indexLength,
        AUTO_INCREMENT as autoIncrement,
        CREATE_TIME as createTime,
        UPDATE_TIME as updateTime,
        CHECK_TIME as checkTime
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `;

    const result = await this.adapter.query(query, [this.databaseName, tableName]);
    return result.rows[0] || {};
  }

  /**
   * 테이블 컬럼 목록 조회
   */
  private async getTableColumns(tableName: string): Promise<Array<{ name: string; type: string }>> {
    const query = `
      SELECT COLUMN_NAME as name, DATA_TYPE as type
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;

    const result = await this.adapter.query(query, [this.databaseName, tableName]);
    return result.rows as Array<{ name: string; type: string }>;
  }

  /**
   * 컬럼 정보 조회
   */
  private async getColumnInfo(tableName: string, columnName: string): Promise<any> {
    const query = `
      SELECT
        DATA_TYPE as dataType,
        IS_NULLABLE as isNullable,
        CHARACTER_MAXIMUM_LENGTH as maxLength,
        NUMERIC_PRECISION as precision,
        NUMERIC_SCALE as scale,
        CHARACTER_SET_NAME as characterSet,
        COLLATION_NAME as collation,
        COLUMN_TYPE as columnType
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `;

    const result = await this.adapter.query(query, [this.databaseName, tableName, columnName]);
    return result.rows[0] || {};
  }

  /**
   * 컬럼 기본 통계 수집
   */
  private async getColumnBasicStats(tableName: string, columnName: string, sampleSize: number): Promise<any> {
    const isNumeric = await this.isNumericColumn(tableName, columnName);

    let statsQuery: string;

    if (isNumeric) {
      statsQuery = `
        SELECT
          COUNT(*) as totalRows,
          COUNT(\`${columnName}\`) as nonNullCount,
          COUNT(*) - COUNT(\`${columnName}\`) as nullCount,
          COUNT(DISTINCT \`${columnName}\`) as uniqueCount,
          MIN(\`${columnName}\`) as minValue,
          MAX(\`${columnName}\`) as maxValue,
          AVG(\`${columnName}\`) as avgValue,
          STDDEV(\`${columnName}\`) as standardDeviation,
          VARIANCE(\`${columnName}\`) as variance
        FROM \`${this.databaseName}\`.\`${tableName}\`
        ${sampleSize > 0 ? `ORDER BY RAND() LIMIT ${sampleSize}` : ''}
      `;
    } else {
      statsQuery = `
        SELECT
          COUNT(*) as totalRows,
          COUNT(\`${columnName}\`) as nonNullCount,
          COUNT(*) - COUNT(\`${columnName}\`) as nullCount,
          COUNT(DISTINCT \`${columnName}\`) as uniqueCount,
          MIN(\`${columnName}\`) as minValue,
          MAX(\`${columnName}\`) as maxValue
        FROM \`${this.databaseName}\`.\`${tableName}\`
        ${sampleSize > 0 ? `ORDER BY RAND() LIMIT ${sampleSize}` : ''}
      `;
    }

    const result = await this.adapter.query(statsQuery);
    const stats = result.rows[0] as any;

    // 중위값 계산 (샘플링된 데이터에서)
    let medianValue = null;
    if (isNumeric && stats.nonNullCount > 0) {
      const medianQuery = `
        SELECT \`${columnName}\` as medianValue
        FROM \`${this.databaseName}\`.\`${tableName}\`
        WHERE \`${columnName}\` IS NOT NULL
        ${sampleSize > 0 ? `ORDER BY RAND() LIMIT ${sampleSize}` : ''}
        ORDER BY \`${columnName}\`
        LIMIT 1 OFFSET ${Math.floor(stats.nonNullCount / 2)}
      `;
      const medianResult = await this.adapter.query(medianQuery);
      medianValue = medianResult.rows[0]?.medianValue || null;
    }

    // 최빈값 계산
    const modeQuery = `
      SELECT \`${columnName}\` as mode, COUNT(*) as frequency
      FROM \`${this.databaseName}\`.\`${tableName}\`
      WHERE \`${columnName}\` IS NOT NULL
      GROUP BY \`${columnName}\`
      ORDER BY frequency DESC
      LIMIT 1
    `;
    const modeResult = await this.adapter.query(modeQuery);
    const mode = modeResult.rows[0]?.mode || null;

    return {
      totalRows: stats.totalRows,
      nullCount: stats.nullCount,
      nullPercentage: (stats.nullCount / stats.totalRows) * 100,
      uniqueCount: stats.uniqueCount,
      uniquePercentage: (stats.uniqueCount / stats.nonNullCount) * 100,
      minValue: stats.minValue,
      maxValue: stats.maxValue,
      avgValue: stats.avgValue,
      medianValue,
      mode,
      standardDeviation: stats.standardDeviation,
      variance: stats.variance
    };
  }

  /**
   * 상위 값 조회
   */
  private async getTopValues(tableName: string, columnName: string, limit: number): Promise<Array<{ value: any; count: number; percentage: number }>> {
    const query = `
      SELECT
        \`${columnName}\` as value,
        COUNT(*) as count,
        COUNT(*) * 100.0 / SUM(COUNT(*)) OVER() as percentage
      FROM \`${this.databaseName}\`.\`${tableName}\`
      WHERE \`${columnName}\` IS NOT NULL
      GROUP BY \`${columnName}\`
      ORDER BY count DESC
      LIMIT ${limit}
    `;

    const result = await this.adapter.query(query);
    return result.rows as Array<{ value: any; count: number; percentage: number }>;
  }

  /**
   * 값 분포 분석
   */
  private async getValueDistribution(tableName: string, columnName: string, dataType: string): Promise<{ [range: string]: number }> {
    const isNumeric = ['int', 'bigint', 'decimal', 'float', 'double'].some(type => dataType.includes(type));

    if (!isNumeric) {
      // 문자열 길이 분포
      const query = `
        SELECT
          CASE
            WHEN LENGTH(\`${columnName}\`) = 0 THEN 'empty'
            WHEN LENGTH(\`${columnName}\`) <= 10 THEN '1-10'
            WHEN LENGTH(\`${columnName}\`) <= 50 THEN '11-50'
            WHEN LENGTH(\`${columnName}\`) <= 100 THEN '51-100'
            ELSE '100+'
          END as range_group,
          COUNT(*) as count
        FROM \`${this.databaseName}\`.\`${tableName}\`
        WHERE \`${columnName}\` IS NOT NULL
        GROUP BY range_group
      `;

      const result = await this.adapter.query(query);
      return result.rows.reduce((acc, row) => {
        acc[row.range_group] = row.count;
        return acc;
      }, {});
    }

    // 숫자형 데이터 분포 (히스토그램)
    const query = `
      SELECT
        MIN(\`${columnName}\`) as minVal,
        MAX(\`${columnName}\`) as maxVal
      FROM \`${this.databaseName}\`.\`${tableName}\`
      WHERE \`${columnName}\` IS NOT NULL
    `;

    const result = await this.adapter.query(query);
    const { minVal, maxVal } = result.rows[0] as any;

    if (minVal === null || maxVal === null) return {};

    const bucketCount = 10;
    const bucketSize = (maxVal - minVal) / bucketCount;
    const distribution: { [range: string]: number } = {};

    for (let i = 0; i < bucketCount; i++) {
      const rangeStart = minVal + (i * bucketSize);
      const rangeEnd = minVal + ((i + 1) * bucketSize);
      const rangeKey = `${rangeStart.toFixed(2)}-${rangeEnd.toFixed(2)}`;

      const countQuery = `
        SELECT COUNT(*) as count
        FROM \`${this.databaseName}\`.\`${tableName}\`
        WHERE \`${columnName}\` >= ${rangeStart} AND \`${columnName}\` < ${rangeEnd}
      `;

      const countResult = await this.adapter.query(countQuery);
      distribution[rangeKey] = (countResult.rows[0] as any).count;
    }

    return distribution;
  }

  /**
   * 패턴 분석
   */
  private async analyzePatterns(tableName: string, columnName: string, dataType: string): Promise<string[]> {
    if (!['varchar', 'text', 'char'].some(type => dataType.includes(type))) {
      return [];
    }

    const patterns: string[] = [];

    // 이메일 패턴
    const emailQuery = `
      SELECT COUNT(*) as count
      FROM \`${this.databaseName}\`.\`${tableName}\`
      WHERE \`${columnName}\` REGEXP '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}$'
    `;

    // 전화번호 패턴
    const phoneQuery = `
      SELECT COUNT(*) as count
      FROM \`${this.databaseName}\`.\`${tableName}\`
      WHERE \`${columnName}\` REGEXP '^[0-9-+()\\s]+$' AND LENGTH(\`${columnName}\`) BETWEEN 10 AND 15
    `;

    // URL 패턴
    const urlQuery = `
      SELECT COUNT(*) as count
      FROM \`${this.databaseName}\`.\`${tableName}\`
      WHERE \`${columnName}\` REGEXP '^https?://[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}'
    `;

    try {
      const [emailResult, phoneResult, urlResult] = await Promise.all([
        this.adapter.query(emailQuery),
        this.adapter.query(phoneQuery),
        this.adapter.query(urlQuery)
      ]);

      if ((emailResult.rows[0] as any).count > 0) patterns.push('email');
      if ((phoneResult.rows[0] as any).count > 0) patterns.push('phone');
      if ((urlResult.rows[0] as any).count > 0) patterns.push('url');

    } catch (error) {
      logger.warn('Pattern analysis failed', { table: tableName, column: columnName, error });
    }

    return patterns;
  }

  /**
   * 이상값 탐지
   */
  private async detectOutliers(tableName: string, columnName: string, dataType: string): Promise<any[]> {
    const isNumeric = await this.isNumericColumn(tableName, columnName);
    if (!isNumeric) return [];

    try {
      // IQR 방법을 사용한 이상값 탐지
      const query = `
        WITH quartiles AS (
          SELECT
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY \`${columnName}\`) as q1,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY \`${columnName}\`) as q3
          FROM \`${this.databaseName}\`.\`${tableName}\`
          WHERE \`${columnName}\` IS NOT NULL
        )
        SELECT \`${columnName}\` as value
        FROM \`${this.databaseName}\`.\`${tableName}\`, quartiles
        WHERE \`${columnName}\` < (q1 - 1.5 * (q3 - q1))
           OR \`${columnName}\` > (q3 + 1.5 * (q3 - q1))
        LIMIT 100
      `;

      const result = await this.adapter.query(query);
      return result.rows.map(row => row.value);

    } catch (error) {
      // PERCENTILE_CONT를 지원하지 않는 MySQL 버전의 경우 대안 사용
      logger.warn('Advanced outlier detection failed, using basic method', { error });
      return [];
    }
  }

  /**
   * 데이터 품질 이슈 탐지
   */
  private detectQualityIssues(basicStats: any, topValues: any[], columnInfo: any): string[] {
    const issues: string[] = [];

    // Null 비율이 높음
    if (basicStats.nullPercentage > 50) {
      issues.push('high_null_rate');
    }

    // 고유값 비율이 낮음 (중복이 많음)
    if (basicStats.uniquePercentage < 10) {
      issues.push('low_uniqueness');
    }

    // 하나의 값이 대부분을 차지
    if (topValues.length > 0 && topValues[0].percentage > 90) {
      issues.push('single_value_dominance');
    }

    // 문자열 길이 불일치
    if (columnInfo.dataType === 'varchar' && columnInfo.maxLength) {
      // 실제 사용되는 최대 길이와 컬럼 정의 길이 비교 로직 추가 가능
    }

    return issues;
  }

  /**
   * MySQL 특화 정보 수집
   */
  private async getMySQLSpecificInfo(tableName: string, columnName: string, dataType: string): Promise<any> {
    const info: any = {};

    try {
      const query = `
        SELECT
          CHARACTER_SET_NAME as characterSet,
          COLLATION_NAME as collation,
          COLUMN_TYPE as columnType
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      `;

      const result = await this.adapter.query(query, [this.databaseName, tableName, columnName]);
      const columnData = result.rows[0] as any;

      if (columnData) {
        info.characterSet = columnData.characterSet;
        info.collation = columnData.collation;

        // ENUM 값 추출
        if (columnData.columnType.includes('enum')) {
          const enumMatch = columnData.columnType.match(/enum\((.*)\)/);
          if (enumMatch) {
            info.enumValues = enumMatch[1].split(',').map((v: string) => v.trim().replace(/'/g, ''));
          }
        }

        // SET 값 추출
        if (columnData.columnType.includes('set')) {
          const setMatch = columnData.columnType.match(/set\((.*)\)/);
          if (setMatch) {
            info.setValues = setMatch[1].split(',').map((v: string) => v.trim().replace(/'/g, ''));
          }
        }
      }

    } catch (error) {
      logger.warn('Failed to get MySQL specific info', { table: tableName, column: columnName, error });
    }

    return info;
  }

  /**
   * 숫자형 컬럼 여부 확인
   */
  private async isNumericColumn(tableName: string, columnName: string): Promise<boolean> {
    const query = `
      SELECT DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `;

    const result = await this.adapter.query(query, [this.databaseName, tableName, columnName]);
    const dataType = (result.rows[0] as any)?.DATA_TYPE?.toLowerCase() || '';

    return ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double'].includes(dataType);
  }

  /**
   * 샘플링 전략 결정
   */
  private determineSamplingStrategy(totalRows: number, options: MySQLProfilingOptions): any {
    const maxSampleRows = options.maxSampleRows || 10000;
    const sampleSize = Math.min(totalRows, options.sampleSize || 1000);

    let samplingMethod = 'full';
    let confidence = 100;

    if (totalRows > maxSampleRows) {
      samplingMethod = 'random';
      confidence = Math.min(95, (sampleSize / totalRows) * 100);
    }

    return {
      sampleSize,
      totalRows,
      samplingMethod,
      confidence
    };
  }

  /**
   * 품질 점수 계산
   */
  private calculateQualityScores(columnProfiles: MySQLColumnProfile[]): {
    overall: number;
    completeness: number;
    consistency: number;
    validity: number;
  } {
    if (columnProfiles.length === 0) {
      return { overall: 0, completeness: 0, consistency: 0, validity: 0 };
    }

    // 완전성 점수 (null 비율 기반)
    const completeness = columnProfiles.reduce((sum, profile) => {
      return sum + (100 - profile.nullPercentage);
    }, 0) / columnProfiles.length;

    // 일관성 점수 (고유값 비율 기반)
    const consistency = columnProfiles.reduce((sum, profile) => {
      return sum + Math.min(100, profile.uniquePercentage * 2);
    }, 0) / columnProfiles.length;

    // 유효성 점수 (데이터 품질 이슈 기반)
    const validity = columnProfiles.reduce((sum, profile) => {
      const issueCount = profile.dataQualityIssues.length;
      return sum + Math.max(0, 100 - (issueCount * 20));
    }, 0) / columnProfiles.length;

    // 전체 점수
    const overall = (completeness + consistency + validity) / 3;

    return {
      overall: Math.round(overall * 100) / 100,
      completeness: Math.round(completeness * 100) / 100,
      consistency: Math.round(consistency * 100) / 100,
      validity: Math.round(validity * 100) / 100
    };
  }

  /**
   * 권장사항 생성
   */
  private generateRecommendations(columnProfiles: MySQLColumnProfile[], tableInfo: any): string[] {
    const recommendations: string[] = [];

    // 높은 null 비율 컬럼 확인
    const highNullColumns = columnProfiles.filter(p => p.nullPercentage > 30);
    if (highNullColumns.length > 0) {
      recommendations.push(`${highNullColumns.map(c => c.columnName).join(', ')} 컬럼의 null 비율이 높습니다. 데이터 수집 과정을 검토하세요.`);
    }

    // 낮은 고유성 컬럼 확인
    const lowUniquenessColumns = columnProfiles.filter(p => p.uniquePercentage < 10);
    if (lowUniquenessColumns.length > 0) {
      recommendations.push(`${lowUniquenessColumns.map(c => c.columnName).join(', ')} 컬럼의 고유성이 낮습니다. 인덱스 효율성을 검토하세요.`);
    }

    // 테이블 크기 기반 권장사항
    if (tableInfo.dataLength > 1000000000) { // 1GB 이상
      recommendations.push('테이블 크기가 큽니다. 파티셔닝을 고려해보세요.');
    }

    // 인덱스 비율 확인
    if (tableInfo.indexLength > tableInfo.dataLength * 2) {
      recommendations.push('인덱스 크기가 데이터 크기의 2배를 초과합니다. 불필요한 인덱스를 제거하세요.');
    }

    return recommendations;
  }
}