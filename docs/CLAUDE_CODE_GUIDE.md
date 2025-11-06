# Claude Code에서 DB MCP 서버 사용 가이드

## 개요

이 가이드는 Claude Code 환경에서 Database MCP (Model Context Protocol) 서버를 설정하고 사용하는 방법을 설명합니다. DB MCP 서버를 통해 Claude가 MySQL 데이터베이스에 안전하게 연결하여 스키마 분석, 데이터 조회, 품질 분석 등을 수행할 수 있습니다.

## 1. 초기 설정

### 1.1 환경 변수 설정

`.env` 파일을 프로젝트 루트에 생성하고 데이터베이스 연결 정보를 설정하세요:

```bash
# 필수 설정
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_DB=your_database_name
MYSQL_USER=your_username
MYSQL_PASSWORD=your_password

# 선택적 설정 (기본값 있음)
MYSQL_CONNECTION_LIMIT=10
MYSQL_TIMEOUT=60000

# 원격 데이터베이스 (AWS RDS 등) SSL 설정
MYSQL_SSL_MODE=REQUIRED
MYSQL_SSL_CA=/path/to/ca-cert.pem

# 보안 설정
MAX_QUERY_EXECUTION_TIME=30000
MAX_RESULT_ROWS=10000
MAX_RESULT_SIZE_MB=50
ENABLE_QUERY_LOGGING=true

# 서버 설정
MCP_SERVER_NAME=database-mcp
LOG_LEVEL=info
NODE_ENV=development
```

### 1.2 MCP 서버 설정

Claude Code의 MCP 설정 파일에 DB MCP 서버를 추가하세요:

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["/path/to/db-mcp/dist/index.js"],
      "env": {
        "MYSQL_HOST": "localhost",
        "MYSQL_PORT": "3306",
        "MYSQL_DB": "your_database",
        "MYSQL_USER": "your_user",
        "MYSQL_PASSWORD": "your_password"
      }
    }
  }
}
```

### 1.3 서버 시작

```bash
# 개발 모드
npm run dev

# 프로덕션 모드
npm run build
npm start
```

## 2. 핵심 기능 사용법

### 2.1 데이터베이스 스키마 분석

Claude에게 다음과 같이 요청할 수 있습니다:

```
"데이터베이스의 전체 스키마를 분석해주세요"
```

**사용 가능한 리소스:**
- `database://schema` - 전체 스키마 정보
- `database://relationships` - 테이블 간 관계
- `database://summary` - 스키마 요약

**응답 예시:**
```json
{
  "database": "ecommerce_db",
  "schema": {
    "tables": [
      {
        "name": "users",
        "columns": [...],
        "indexes": [...],
        "foreignKeys": [...]
      }
    ]
  }
}
```

### 2.2 특정 테이블 정보 조회

```
"users 테이블의 구조를 분석해주세요"
```

**사용 가능한 리소스:**
- `database://table/users` - 테이블 구조 정보
- `database://table/users/profile` - 데이터 품질 분석

**응답 예시:**
```json
{
  "tableName": "users",
  "columns": [
    {
      "name": "id",
      "type": "integer",
      "isPrimaryKey": true,
      "nullable": false
    }
  ],
  "rowCount": 1250,
  "sizeInBytes": 204800
}
```

### 2.3 데이터 품질 분석

```
"orders 테이블의 데이터 품질을 분석해주세요"
```

**도구 사용:**
- `profile_table` - 테이블 데이터 프로파일링

**응답 예시:**
```json
{
  "tableName": "orders",
  "profile": {
    "totalRows": 5000,
    "qualityScore": 85.5,
    "columnProfiles": [
      {
        "columnName": "email",
        "nullPercentage": 0.02,
        "uniqueCount": 4950,
        "dataQualityIssues": ["format_inconsistency"]
      }
    ],
    "recommendations": [
      "email 컬럼의 형식 일관성 개선 필요"
    ]
  }
}
```

### 2.4 자연어 SQL 쿼리

```
"지난 30일간 주문량이 가장 많은 상위 10개 상품을 조회해주세요"
```

**도구 사용:**
- `execute_query` - SQL 쿼리 실행
- `execute_natural_language_query` - 자연어 쿼리

**자동 생성되는 SQL:**
```sql
SELECT
    p.name,
    p.id,
    COUNT(oi.product_id) as order_count
FROM products p
JOIN order_items oi ON p.id = oi.product_id
JOIN orders o ON oi.order_id = o.id
WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY p.id, p.name
ORDER BY order_count DESC
LIMIT 10
```

## 3. 고급 기능

### 3.1 캐시 관리

```
"스키마 캐시 상태를 확인해주세요"
```

**리소스:**
- `database://cache-stats` - 쿼리 캐시 통계
- `database://schema-cache/stats` - 스키마 캐시 통계

**응답 예시:**
```json
{
  "totalEntries": 45,
  "hitRate": 78.5,
  "totalSize": 2097152,
  "oldestEntry": 1640995200000
}
```

### 3.2 테이블 관계 분석

```
"데이터베이스의 테이블 관계를 시각화해주세요"
```

**도구 사용:**
- `get_table_relationships` - 테이블 관계 분석

### 3.3 성능 모니터링

```
"데이터베이스 연결 상태와 성능을 확인해주세요"
```

**리소스:**
- `database://config` - 데이터베이스 설정 정보
- `database://audit-logs` - 쿼리 실행 로그

## 4. 보안 및 제한사항

### 4.1 허용된 작업
- ✅ SELECT 쿼리
- ✅ SHOW 명령어
- ✅ DESCRIBE 명령어
- ✅ 스키마 분석
- ✅ 데이터 품질 분석

### 4.2 제한된 작업
- ❌ INSERT, UPDATE, DELETE 쿼리
- ❌ DROP, CREATE, ALTER 명령어
- ❌ 시스템 테이블 접근
- ❌ 사용자 권한 변경

### 4.3 자동 보안 검증
- SQL 인젝션 패턴 탐지
- 쿼리 복잡성 분석
- 실행 시간 제한 (30초)
- 결과 크기 제한 (10,000행, 50MB)

## 5. 실제 사용 예시

### 5.1 전자상거래 분석

```
Claude: "이커머스 데이터베이스를 분석해서 다음을 알려주세요:
1. 전체 테이블 구조
2. 고객별 주문 패턴
3. 상품 카테고리별 매출
4. 데이터 품질 이슈"
```

**예상 워크플로:**
1. 스키마 분석 → `analyze_schema`
2. 관계 분석 → `get_table_relationships`
3. 자연어 쿼리 → `execute_natural_language_query`
4. 데이터 프로파일링 → `profile_table`

### 5.2 데이터 품질 감사

```
Claude: "모든 테이블의 데이터 품질을 체크하고 개선점을 제안해주세요"
```

**예상 워크플로:**
1. 전체 스키마 조회
2. 각 테이블별 프로파일링
3. 품질 점수 계산
4. 개선 권장사항 제공

## 6. 문제 해결

### 6.1 연결 오류
```bash
# 연결 테스트
npm run dev
# 로그 확인
tail -f logs/database.log
```

### 6.2 권한 오류
- MySQL 사용자 권한 확인
- SELECT 권한이 있는지 확인
- 원격 접속 허용 여부 확인

### 6.3 성능 이슈
- 캐시 히트율 확인
- 쿼리 실행 시간 모니터링
- 인덱스 사용 최적화

## 7. 고급 설정

### 7.1 캐시 튜닝
```env
# 캐시 설정 (옵션)
SCHEMA_CACHE_TTL=300000      # 5분
SCHEMA_CACHE_MAX_ENTRIES=500
SCHEMA_CACHE_MAX_SIZE=104857600  # 100MB
```

### 7.2 로깅 설정
```env
LOG_LEVEL=debug              # 상세 로깅
ENABLE_QUERY_LOGGING=true    # 쿼리 로깅
```

### 7.3 AWS RDS 연결
```env
MYSQL_HOST=your-rds-endpoint.amazonaws.com
MYSQL_SSL_MODE=REQUIRED
MYSQL_SSL_CA=/opt/ssl/rds-ca-2019-root.pem
```

## 8. API 참조

### 8.1 도구 (Tools)
| 도구명 | 설명 | 파라미터 |
|--------|------|----------|
| `execute_query` | SQL 쿼리 실행 | `query`, `dryRun?` |
| `execute_natural_language_query` | 자연어 쿼리 | `question` |
| `analyze_schema` | 스키마 분석 | 없음 |
| `profile_table` | 테이블 프로파일링 | `tableName` |
| `get_table_relationships` | 관계 분석 | 없음 |

### 8.2 리소스 (Resources)
| 리소스 URI | 설명 |
|------------|------|
| `database://schema` | 전체 스키마 |
| `database://table/{name}` | 테이블 정보 |
| `database://table/{name}/profile` | 테이블 프로필 |
| `database://relationships` | 테이블 관계 |
| `database://summary` | 스키마 요약 |
| `database://cache-stats` | 캐시 통계 |

이제 Claude Code에서 DB MCP 서버를 통해 안전하고 효율적으로 데이터베이스를 분석하고 활용할 수 있습니다!