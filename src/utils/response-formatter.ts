import { QueryResult } from '../types/index.js';

/**
 * db-mcp 응답 토큰 최적화 모듈
 *
 * TIER 1: compact JSON, Array-of-Arrays, fields 경량화, 에코 제거
 * TIER 2: format 파라미터, 자동 LIMIT, SHOW COLUMNS 경량 포맷, maxRows
 * TIER 3: schema_check 전용, preview 모드, 적응형 포맷
 */

// ─── 타입 정의 ─────────────────────────────────────────────

export type ResponseFormat = 'compact' | 'table' | 'minimal';

export interface QueryResponseOptions {
  format?: ResponseFormat | undefined;
  maxRows?: number | undefined;
  preview?: boolean | undefined;
}

export interface CompactQueryResponse {
  columns: string[];
  rows: any[][];
  rowCount: number;
  executionTime: number;
  truncated?: boolean | undefined;
  totalRows?: number | undefined;
}

export interface PreviewResponse {
  columns: string[];
  sample: any[][];
  totalRows: number;
  executionTime: number;
  hint: string;
}

// ─── TIER 1: 기본 포맷팅 ───────────────────────────────────

/**
 * compact JSON 문자열로 직렬화 (pretty-print 없음)
 */
export function toCompactJSON(data: any): string {
  return JSON.stringify(data);
}

/**
 * 컬럼명 배열 추출
 */
function extractColumnNames(result: { rows: any[]; fields?: any[] | undefined }): string[] {
  if (result.rows && result.rows.length > 0) {
    return Object.keys(result.rows[0]);
  }
  if (result.fields && result.fields.length > 0) {
    return result.fields.map((f: any) => (typeof f === 'string' ? f : f.name || String(f)));
  }
  return [];
}

/**
 * rows 객체 배열을 Array-of-Arrays로 변환
 */
function convertToArrayOfArrays(rows: any[], columns: string[]): any[][] {
  return rows.map(row => columns.map(col => row[col]));
}

// ─── TIER 2: 포맷별 변환 ───────────────────────────────────

/**
 * SHOW COLUMNS / DESCRIBE 쿼리인지 감지
 */
export function isSchemaQuery(query: string): boolean {
  const trimmed = query.trim().toUpperCase();
  return trimmed.startsWith('SHOW COLUMNS') ||
    trimmed.startsWith('SHOW FULL COLUMNS') ||
    trimmed.startsWith('DESCRIBE ') ||
    trimmed.startsWith('DESC ') ||
    trimmed.startsWith('SHOW CREATE TABLE') ||
    trimmed.startsWith('SHOW INDEX') ||
    trimmed.startsWith('SHOW KEYS');
}

/**
 * 집계 쿼리인지 감지 (COUNT, SUM 등 단일 값 반환)
 */
function isAggregateQuery(result: { rows: any[] }): boolean {
  return result.rows.length === 1 && Object.keys(result.rows[0]).length <= 3;
}

/**
 * SHOW COLUMNS 결과를 경량 텍스트로 변환
 * 예: "order_detail_idx  int(11)  PRI  auto_increment  NOT NULL"
 */
function formatSchemaResult(rows: any[]): string {
  if (rows.length === 0) return '(empty)';

  const keys = Object.keys(rows[0]);
  const hasField = keys.includes('Field');

  if (hasField) {
    return rows.map(row => {
      const parts = [
        row.Field,
        row.Type || '',
        row.Key === 'PRI' ? 'PRI' : (row.Key === 'UNI' ? 'UNI' : (row.Key === 'MUL' ? 'MUL' : '')),
        row.Extra || '',
        row.Null === 'NO' ? 'NOT NULL' : 'NULL',
        row.Default !== null && row.Default !== undefined ? `DEFAULT ${row.Default}` : '',
      ].filter(Boolean);
      return parts.join('\t');
    }).join('\n');
  }

  // Fallback: tab-separated
  return formatAsTable(rows);
}

/**
 * rows를 TSV (tab-separated) 테이블 형식으로 변환
 */
function formatAsTable(rows: any[]): string {
  if (rows.length === 0) return '(empty)';
  const columns = Object.keys(rows[0]);
  const header = columns.join('\t');
  const dataRows = rows.map(row =>
    columns.map(col => {
      const val = row[col];
      return val === null ? '' : String(val);
    }).join('\t')
  );
  return header + '\n' + dataRows.join('\n');
}

// ─── TIER 2: 자동 LIMIT ────────────────────────────────────

const DEFAULT_AI_LIMIT = 50;

/**
 * SELECT 쿼리에 LIMIT가 없으면 자동 삽입
 * 반환: { modifiedQuery, autoLimited }
 */
export function injectAutoLimit(query: string, maxRows?: number): { query: string; autoLimited: boolean; limit: number } {
  const trimmed = query.trim();
  const upper = trimmed.toUpperCase();

  // SELECT가 아니면 패스
  if (!upper.startsWith('SELECT')) {
    return { query: trimmed, autoLimited: false, limit: 0 };
  }

  // 이미 LIMIT가 있으면 패스 (마지막 절에서만 체크, 서브쿼리 내 LIMIT 제외)
  const withoutSubqueries = upper.replace(/\([^)]*\)/g, '()');
  if (/\bLIMIT\s+\d+/i.test(withoutSubqueries)) {
    return { query: trimmed, autoLimited: false, limit: 0 };
  }

  const limit = maxRows || DEFAULT_AI_LIMIT;
  return {
    query: trimmed.replace(/;?\s*$/, '') + ` LIMIT ${limit}`,
    autoLimited: true,
    limit,
  };
}

// ─── TIER 3: Preview 모드 ───────────────────────────────────

/**
 * Preview 응답 생성: 첫 3행 + 총 행 수
 */
function formatPreviewResponse(result: { rows: any[]; rowCount: number; executionTime: number }): PreviewResponse {
  const columns = result.rows.length > 0 ? Object.keys(result.rows[0]) : [];
  const sampleRows = result.rows.slice(0, 3);

  return {
    columns,
    sample: convertToArrayOfArrays(sampleRows, columns),
    totalRows: result.rowCount,
    executionTime: result.executionTime,
    hint: result.rowCount > 3
      ? `${result.rowCount} rows total. Add LIMIT or use maxRows to get more data.`
      : `${result.rowCount} rows returned.`,
  };
}

// ─── TIER 3: 적응형 포맷 ───────────────────────────────────

/**
 * 결과 크기에 따라 최적 포맷 자동 결정
 */
function determineAdaptiveFormat(result: { rows: any[] }): ResponseFormat {
  const rowCount = result.rows.length;
  if (rowCount <= 10) return 'compact';
  if (rowCount <= 100) return 'table';
  return 'minimal';
}

// ─── 통합 포맷터 ─────────────────────────────────────────

/**
 * QueryResult를 compact 응답으로 변환
 */
export function formatQueryResult(result: QueryResult): CompactQueryResponse {
  const columns = extractColumnNames(result);
  const compactRows = convertToArrayOfArrays(result.rows, columns);

  const response: CompactQueryResponse = {
    columns,
    rows: compactRows,
    rowCount: result.rowCount,
    executionTime: result.executionTime,
  };

  if (result.truncated) {
    response.truncated = true;
    response.totalRows = result.totalRows;
  }

  return response;
}

/**
 * 쿼리 결과를 옵션에 따라 최적 형식으로 변환
 */
export function formatResult(
  result: { rows: any[]; rowCount: number; executionTime: number; truncated?: boolean; totalRows?: number; fields?: any[] | undefined },
  query: string,
  options: QueryResponseOptions = {}
): string {
  const { preview, maxRows } = options;
  let format = options.format;

  // Preview 모드
  if (preview) {
    return toCompactJSON(formatPreviewResponse(result));
  }

  // maxRows로 결과 자르기 (서버사이드 추가 제한)
  let rows = result.rows;
  let truncated = result.truncated || false;
  if (maxRows && rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    truncated = true;
  }

  // SHOW COLUMNS 등 스키마 쿼리는 table 포맷 강제
  if (isSchemaQuery(query) && !format) {
    format = 'table';
  }

  // 포맷 미지정이면 적응형
  if (!format) {
    format = determineAdaptiveFormat({ rows });
  }

  // 집계 쿼리 (단일 값)
  if (isAggregateQuery({ rows })) {
    return toCompactJSON({
      result: rows[0],
      executionTime: result.executionTime,
    });
  }

  switch (format) {
    case 'table': {
      // 스키마 쿼리는 특화 포맷
      if (isSchemaQuery(query)) {
        const meta = `-- ${rows.length} columns, ${result.executionTime}ms`;
        return formatSchemaResult(rows) + '\n' + meta;
      }
      // 일반 쿼리는 TSV
      const meta = `\n-- ${rows.length} rows, ${result.executionTime}ms` +
        (truncated ? `, truncated (total: ${result.totalRows || 'unknown'})` : '');
      return formatAsTable(rows) + meta;
    }

    case 'minimal': {
      const columns = extractColumnNames({ rows, fields: result.fields });
      const sample = convertToArrayOfArrays(rows.slice(0, 5), columns);
      return toCompactJSON({
        columns,
        sampleRows: sample,
        totalReturned: rows.length,
        executionTime: result.executionTime,
        truncated,
        hint: rows.length > 5 ? `Showing 5 of ${rows.length} rows. Use maxRows for more.` : undefined,
      });
    }

    case 'compact':
    default: {
      const columns = extractColumnNames({ rows, fields: result.fields });
      const compactRows = convertToArrayOfArrays(rows, columns);
      const response: any = {
        columns,
        rows: compactRows,
        rowCount: rows.length,
        executionTime: result.executionTime,
      };
      if (truncated) {
        response.truncated = true;
        response.totalRows = result.totalRows;
      }
      return toCompactJSON(response);
    }
  }
}

// ─── MCP 응답 래퍼 ──────────────────────────────────────

/**
 * execute_query 응답 (single DB - server.ts용)
 */
export function formatExecuteQueryResponse(
  result: QueryResult,
  query?: string,
  options?: QueryResponseOptions
): object {
  const text = query
    ? formatResult(result, query, options)
    : toCompactJSON(formatQueryResult(result));

  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * execute_query 응답 (multi DB - multi-database-server.ts용)
 */
export function formatMultiDbQueryResponse(
  result: any,
  dbName: string,
  query?: string,
  options?: QueryResponseOptions
): object {
  if (query && (options?.format || options?.preview || isSchemaQuery(query))) {
    const formatted = formatResult(result, query, options);
    // table/minimal 포맷은 텍스트에 db 정보 추가
    if (typeof formatted === 'string' && !formatted.startsWith('{')) {
      return {
        content: [{ type: 'text', text: `[${dbName}]\n${formatted}` }],
      };
    }
    // compact JSON이면 db 필드 추가
    const parsed = JSON.parse(formatted);
    parsed.db = dbName;
    return {
      content: [{ type: 'text', text: toCompactJSON(parsed) }],
    };
  }

  // 기본: compact Array-of-Arrays
  const columns = result.rows && result.rows.length > 0
    ? Object.keys(result.rows[0])
    : (result.fields || []).map((f: any) => (typeof f === 'string' ? f : f.name || String(f)));

  const compactRows = (result.rows || []).map((row: any) =>
    columns.map((col: string) => row[col])
  );

  const response: any = {
    db: dbName,
    columns,
    rows: compactRows,
    rowCount: result.rowCount,
    executionTime: result.executionTime,
  };

  if (result.truncated) {
    response.truncated = true;
    if (result.totalRows !== undefined) {
      response.totalRows = result.totalRows;
    }
  }

  return {
    content: [{ type: 'text', text: toCompactJSON(response) }],
  };
}

/**
 * 에러 응답
 */
export function formatErrorResponse(error: unknown, context?: Record<string, any>): object {
  return {
    content: [
      {
        type: 'text',
        text: toCompactJSON({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          ...context,
        }),
      },
    ],
  };
}

/**
 * schema_check 전용 응답 (TIER 3)
 */
export function formatSchemaCheckResponse(
  tableName: string,
  columns: any[],
  dbName: string,
  cached: boolean,
  executionTime: number
): object {
  const text = columns.map((col: any) => {
    const parts = [
      col.Field || col.name,
      col.Type || col.type || '',
      col.Key === 'PRI' ? 'PRI' : (col.Key === 'UNI' ? 'UNI' : (col.Key === 'MUL' ? 'MUL' : '')),
      col.Extra || '',
      (col.Null === 'NO' || col.nullable === false) ? 'NOT NULL' : 'NULL',
      col.Default !== null && col.Default !== undefined ? `DEFAULT ${col.Default}` : '',
    ].filter(Boolean);
    return parts.join('\t');
  }).join('\n');

  const meta = `-- ${tableName} (${dbName}), ${columns.length} columns, ${executionTime}ms${cached ? ', cached' : ''}`;

  return {
    content: [{ type: 'text', text: text + '\n' + meta }],
  };
}

/**
 * 일반 데이터 응답용 (compact JSON)
 */
export function formatDataResponse(data: any): string {
  return toCompactJSON(data);
}
