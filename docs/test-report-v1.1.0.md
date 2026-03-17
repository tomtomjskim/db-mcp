# db-mcp v1.1.0 토큰 최적화 테스트 보고서

> 테스트 일자: 2026-03-17
> 테스트 환경: macOS Darwin 24.6.0, Node.js, frecto-dev (MySQL)

---

## 테스트 대상

TIER 1~3 토큰 최적화 구현 (커밋 `53aeea8`) + 버그픽스

## 테스트 결과 요약

| 카테고리 | 항목 수 | PASS | FAIL | 비고 |
|---------|---------|------|------|------|
| 기본 동작 | 3 | 3 | 0 | |
| 파라미터 | 6 | 6 | 0 | |
| schema_check | 3 | 3 | 0 | |
| 하위 호환성 | 4 | 4 | 0 | |
| **합계** | **16** | **16** | **0** | |

---

## 상세 테스트 결과

### 1. 기본 동작 확인

| # | 테스트 | 쿼리 | 기대 결과 | 실제 결과 | 판정 |
|---|--------|------|----------|----------|------|
| 1-1 | compact Array-of-Arrays | `SELECT shop_idx, shop_id, shop_name FROM shop LIMIT 3` | `{columns:[], rows:[[]]}` | `{columns:[...], rows:[[1,0,"Burst Express"],...]}` | PASS |
| 1-2 | SHOW COLUMNS TSV | `SHOW COLUMNS FROM shop` | TSV 텍스트 + 요약 | TSV 형식, `-- 67 columns, 28ms` | PASS |
| 1-3 | 자동 LIMIT 50 | `SELECT ... FROM shop` (LIMIT 없음) | 50행 + truncated | `rowCount:50, truncated:true` | PASS |

### 2. 파라미터 테스트

| # | 테스트 | 파라미터 | 기대 결과 | 실제 결과 | 판정 |
|---|--------|---------|----------|----------|------|
| 2-1 | format: table | `format:"table"` | TSV + 요약 | `shop_idx\tshop_id\t...` + `-- 3 rows, 67ms` | PASS |
| 2-2 | format: compact | `format:"compact"` | JSON Array-of-Arrays | `{columns:[...], rows:[...]}` | PASS |
| 2-3 | format: minimal | `format:"minimal"` | 샘플 5행 + 요약 | `sampleRows:[[...]], totalReturned:50, hint:...` | PASS |
| 2-4 | maxRows: 10 | `maxRows:10` | 10행 제한 | `rowCount:10, truncated:true` | PASS |
| 2-5 | preview: true | `preview:true` | 3행 샘플 + totalRows | `sample:[[...]], totalRows:50, hint:...` | PASS |
| 2-6 | 기존 LIMIT 유지 | 쿼리에 `LIMIT 5` | 추가 LIMIT 미적용 | `rowCount:5`, truncated 없음 | PASS |

### 3. schema_check 도구

| # | 테스트 | 입력 | 기대 결과 | 실제 결과 | 판정 |
|---|--------|------|----------|----------|------|
| 3-1 | 스키마 반환 | `table:"order_detail"` | TSV 경량 텍스트 | 44 columns TSV + `-- 22ms` | PASS |
| 3-2 | 캐시 히트 | 동일 테이블 재호출 | 0ms, cached | `-- 0ms, cached` | PASS |
| 3-3 | 없는 테이블 | `table:"nonexistent_xyz"` | 에러 메시지 | `Table doesn't exist` | PASS |

### 4. 하위 호환성

| # | 테스트 | 도구 | 기대 결과 | 실제 결과 | 판정 |
|---|--------|------|----------|----------|------|
| 4-1 | 기본 execute_query | 파라미터 없이 호출 | compact JSON | 정상 반환 | PASS |
| 4-2 | natural_language_query | 자연어 질문 | compact JSON + SQL | 정상 반환 | PASS |
| 4-3 | cross_database_query | dev/prod 비교 | summary + results[] | 정상 반환 | PASS |
| 4-4 | 에러 응답 | 없는 테이블 SELECT | 에러 텍스트 | `Table doesn't exist` | PASS |

---

## 발견된 버그 및 수정

### Bug 1: 집계 쿼리에 `truncated: true` 오표시

- **증상**: `SELECT COUNT(*) as cnt FROM shop` → 1행 결과인데 `truncated: true`
- **원인**: `handleExecuteQuery`에서 autoLimited 시 무조건 COUNT 쿼리를 실행하여 totalRows(53) > rows.length(1) 판정
- **수정**: `result.rows.length >= limitUsed` 조건 추가 → 반환 행 수가 LIMIT 미만이면 COUNT 쿼리 스킵
- **파일**: `src/mcp/multi-database-server.ts` (line 485)

### Bug 2: 자동 LIMIT 시 `totalRows` 미반환

- **증상**: 자동 LIMIT 적용 시 `truncated: true`만 포함, `totalRows` 누락
- **원인**: `formatMultiDbQueryResponse` 기본 경로에서 `result.totalRows`를 응답에 포함하지 않음
- **수정**: truncated 시 `totalRows` 필드도 응답에 포함
- **파일**: `src/utils/response-formatter.ts` (line 369)

---

## 토큰 절감 효과 (실측)

| 시나리오 | 최적화 전 (추정) | 최적화 후 (실측) | 절감 |
|---------|-----------------|-----------------|------|
| 일반 쿼리 3행 (compact) | ~3,000 토큰 | ~200 토큰 | ~93% |
| SHOW COLUMNS 67컬럼 (TSV) | ~15,000 토큰 | ~2,000 토큰 | ~87% |
| schema_check 캐시 히트 | ~15,000 토큰 | ~2,000 토큰 (0ms) | ~87% |
| preview 모드 | ~15,000 토큰 | ~150 토큰 | ~99% |
| 집계 쿼리 COUNT | ~2,000 토큰 | ~50 토큰 | ~97% |

---

## 재검증 필요 항목 (빌드 후)

MCP 서버 재시작 후 Bug 1, 2 수정 검증:
- [ ] `SELECT COUNT(*) as cnt FROM shop` → `truncated` 없어야 함
- [ ] `SELECT shop_idx, shop_name FROM shop` (LIMIT 없이) → `truncated: true` + `totalRows` 모두 포함
