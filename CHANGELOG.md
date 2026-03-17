# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-03-17

### Added

- **TIER 1: 기본 최적화**
  - JSON Pretty-print 제거 (~30% 토큰 절감)
  - Array-of-Arrays 변환 (~40% 절감) — `{columns:[], rows:[[]]}`
  - fields 메타데이터 경량화 — FieldPacket → 컬럼명 문자열 배열
  - 에코 필드 제거 (database, query.substring, cached)

- **TIER 2: 스마트 응답**
  - `format` 파라미터 (`compact` / `table` / `minimal`)
  - 자동 LIMIT 주입 — LIMIT 없는 SELECT에 LIMIT 50 자동 적용
  - SHOW COLUMNS 경량 포맷 — JSON → TSV 텍스트 (~70-80% 절감)
  - `maxRows` 파라미터 — 최대 반환 행 수 제어
  - `preview` 파라미터 — 3행 샘플 + 총 행 수만 반환

- **TIER 3: 고급 기능**
  - `schema_check` 전용 도구 — SHOW COLUMNS 대체, 5분 TTL 캐시
  - 적응형 포맷 — 결과 크기에 따라 compact/table/minimal 자동 선택
  - 집계 쿼리 자동 감지 — COUNT, SUM 등 단일 값 쿼리 최소 응답

- **신규 파일**: `src/utils/response-formatter.ts` — 통합 응답 포맷터

### Fixed

- 집계 쿼리(COUNT 등)에 `truncated: true`가 오표시되던 버그
  - 원인: autoLimited 후 반환 행 수 < LIMIT인 경우에도 COUNT 쿼리 실행
  - 수정: `rows.length >= limit` 조건 추가로 실제 truncation만 감지
- 자동 LIMIT 적용 시 `totalRows`가 응답에 누락되던 버그
  - 원인: `formatMultiDbQueryResponse` 기본 경로에서 totalRows 미포함
  - 수정: truncated 시 totalRows 필드 포함

### Changed

- `execute_query` 기본 응답: 객체 배열 → Array-of-Arrays (토큰 ~40% 절감)
- `SHOW COLUMNS` / `DESCRIBE` 응답: JSON → TSV 텍스트 (토큰 ~70% 절감)
- `fields` 타입: `any[]` → `string[]` (컬럼명만)
- MySQL/PostgreSQL 어댑터: FieldPacket 바이너리 → 컬럼명 추출
- `QueryResult.fields` 타입 변경 (`src/types/index.ts`)

### Performance

- **세션당 쿼리 가능 횟수**: 12-15회 → ~100회 (7x 증대)
- **일반 쿼리 토큰**: 14,500 → ~2,000 (86% 절감)
- **스키마 쿼리 토큰**: 5,000 → ~300 (94% 절감)
- **대형 쿼리 (preview)**: 35,000 → ~200 (99% 절감)

---

## [1.0.0] - 2025-01-06

### Added

- 초기 릴리즈
- MySQL & PostgreSQL 완전 지원
- 다중 데이터베이스 관리 (MSA 환경)
- MCP 프로토콜 구현 (Claude Code & Claude Desktop 호환)
- `execute_query` — SQL 쿼리 실행 (읽기 전용)
- `natural_language_query` — 자연어 → SQL 변환
- `cross_database_query` — 크로스 DB 쿼리
- `database_health_check` — DB 연결 상태 확인
- `list_databases` — 연결된 DB 목록 조회
- SQL 인젝션 방지, 화이트리스트 기반 쿼리 검증
- 스키마 분석 및 데이터 프로파일링
- 연결 풀링, 캐싱, 자동 재연결
- Winston 기반 감사 로깅
