# Database MCP Server

🚀 **Enterprise-Ready Multi-Database MCP Server**

Model Context Protocol (MCP) 서버로 **다중 데이터베이스**와 AI 에이전트 간의 안전하고 효율적인 통신을 제공합니다.

## 🌟 주요 특징

- 🏢 **MSA 환경 완벽 지원**: 여러 마이크로서비스 DB를 하나의 MCP 서버에서 관리
- 🔒 **엔터프라이즈급 보안**: 읽기 전용, SSL/TLS, 쿼리 검증, 감사 로깅
- 🌐 **클라우드 네이티브**: AWS RDS, Azure Database, Google Cloud SQL 완벽 지원
- ⚡ **고성능**: 연결 풀링, 지능형 캐싱, 병렬 쿼리 처리
- 🤖 **AI 친화적**: 자연어 쿼리, 스키마 분석, 데이터 품질 분석

## 개요

이 프로젝트는 Anthropic의 Model Context Protocol을 사용하여 Claude와 같은 AI 모델이 **여러 데이터베이스에 동시에** 상호작용할 수 있도록 하는 고급 MCP 서버입니다. MSA(Microservices Architecture) 환경에서 분산된 데이터베이스들을 통합 관리하며, 자연어를 통한 크로스 데이터베이스 쿼리, 스키마 탐색, 데이터 분석 등의 기능을 안전하게 제공합니다.

## 🚀 Claude Code에서 사용하기

Claude Code 환경에서 이 DB MCP 서버를 사용하려면 [Claude Code 사용 가이드](./CLAUDE_CODE_GUIDE.md)를 참조하세요.

**빠른 시작:**
1. 환경 변수 설정 (`.env` 파일)
2. MCP 서버 설정에 추가
3. Claude에게 "데이터베이스 스키마를 분석해주세요" 요청
4. 자연어로 데이터 조회 및 분석

## 지원 데이터베이스

- ✅ **MySQL** - 완전 지원 (온프레미스, AWS RDS, Azure Database)
- ✅ **PostgreSQL** - 완전 지원 (온프레미스, AWS RDS, Azure Database, Google Cloud SQL)
- 🔄 **SQLite** (개발 예정)
- 🔄 **ClickHouse** (개발 예정)

### 데이터베이스 선택 가이드

#### MySQL vs PostgreSQL 비교

| 기능 | MySQL | PostgreSQL |
|------|-------|------------|
| **성능** | 읽기 최적화, 웹 애플리케이션에 적합 | 복잡한 쿼리, 대용량 데이터 처리에 적합 |
| **데이터 타입** | 기본 데이터 타입 지원 | JSON, Array, 커스텀 타입 등 풍부한 지원 |
| **확장성** | 수평 확장 (샤딩) 우수 | 수직 확장 우수, 병렬 처리 지원 |
| **ACID 준수** | InnoDB 엔진 사용 시 완전 지원 | 완전한 ACID 준수 |
| **고급 기능** | 기본 기능 중심 | Window Functions, CTE, Full-text Search 등 |
| **클라우드 지원** | AWS RDS, Azure Database | AWS RDS, Azure Database, Google Cloud SQL |

#### 어댑터 자동 선택

시스템이 자동으로 데이터베이스 타입을 감지합니다:

1. **명시적 지정**: `DB_TYPE` 환경변수 또는 config.type 설정
2. **포트 기반 감지**:
   - 3306 → MySQL
   - 5432 → PostgreSQL
3. **호스트명 기반 감지**:
   - 호스트명에 'mysql' 포함 → MySQL
   - 호스트명에 'postgres' 포함 → PostgreSQL
4. **기본값**: MySQL

#### 권장 사용 사례

**MySQL 권장:**
- 웹 애플리케이션 백엔드
- 단순한 CRUD 작업 중심
- 높은 동시성 읽기 작업
- 기존 MySQL 인프라 활용

**PostgreSQL 권장:**
- 복잡한 분석 쿼리
- JSON 데이터 처리
- 지리 정보 시스템 (PostGIS)
- 데이터 무결성이 중요한 애플리케이션

## MSA 환경에서의 다중 DB 연결

MSA(Microservices Architecture) 환경에서는 여러 데이터베이스에 동시에 접속해야 하는 경우가 많습니다. 이 MCP 서버는 두 가지 방법을 지원합니다:

### 방법 1: 단일 MCP 서버에서 다중 DB 지원 (권장)

하나의 MCP 서버 인스턴스에서 여러 데이터베이스를 관리합니다.

#### 설정 파일 방식
`db-config.json` 파일 생성:
```json
{
  "connections": {
    "user-service": {
      "name": "user-service",
      "type": "mysql",
      "host": "user-db.cluster-xxx.rds.amazonaws.com",
      "port": 3306,
      "user": "readonly_user",
      "password": "secure_password",
      "database": "user_service",
      "description": "사용자 서비스 DB",
      "tags": ["microservice", "user", "mysql"]
    },
    "order-service": {
      "name": "order-service",
      "type": "postgresql",
      "host": "order-db.cluster-yyy.rds.amazonaws.com",
      "port": 5432,
      "user": "readonly_user",
      "password": "secure_password",
      "database": "order_service",
      "description": "주문 서비스 DB",
      "tags": ["microservice", "order", "postgresql"]
    }
  },
  "defaultConnection": "user-service"
}
```

#### 환경변수 방식
```env
# 사용자 서비스 DB
DB_USER_HOST=user-db.cluster-xxx.rds.amazonaws.com
DB_USER_PORT=3306
DB_USER_TYPE=mysql
DB_USER_USER=readonly_user
DB_USER_PASSWORD=secure_password
DB_USER_DATABASE=user_service
DB_USER_DESCRIPTION=사용자 서비스 DB
DB_USER_TAGS=microservice,user,mysql

# 주문 서비스 DB
DB_ORDER_HOST=order-db.cluster-yyy.rds.amazonaws.com
DB_ORDER_PORT=5432
DB_ORDER_TYPE=postgresql
DB_ORDER_USER=readonly_user
DB_ORDER_PASSWORD=secure_password
DB_ORDER_DATABASE=order_service
DB_ORDER_DESCRIPTION=주문 서비스 DB
DB_ORDER_TAGS=microservice,order,postgresql

# 기본 연결
DB_DEFAULT_CONNECTION=user
```

#### Claude Desktop 설정 (다중 DB)
```json
{
  "mcpServers": {
    "multi-database": {
      "command": "node",
      "args": ["path/to/db-mcp/dist/multi-database-server.js"],
      "env": {
        "DB_CONFIG_FILE": "./db-config.json"
      }
    }
  }
}
```

#### Claude Code 설정 (다중 DB - Phase 4 개선)

**Phase 4 개선 사항**: 환경변수 간소화를 통한 설정 단순화 (8개 → 3개)

`~/.claude.json` 파일에 추가:
```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/db-mcp/dist/multi-index.js"],
      "env": {
        "DB_CONFIG_FILE": "/absolute/path/to/db-mcp/db-config.json",
        "LOG_LEVEL": "info",
        "MCP_SERVER_NAME": "db-mcp"
      }
    }
  }
}
```

**Phase 4의 핵심 개선점**:
- ✅ **불필요한 dummy 환경변수 제거**: MYSQL_HOST, MYSQL_PORT, MYSQL_DB, MYSQL_USER, MYSQL_PASSWORD 불필요
- ✅ **진정한 멀티테넌트 서버**: DB_CONFIG_FILE만으로 모든 연결 관리
- ✅ **코드 레벨 개선**: `src/config/index.ts`에서 multi-DB 모드 자동 감지
- ✅ **설정 간소화**: 환경변수 62.5% 감소 (8개 → 3개)

**동작 원리**:
1. `DB_CONFIG_FILE` 환경변수 존재 시 multi-DB 모드로 자동 전환
2. 모든 데이터베이스 연결 정보는 `db-config.json` 파일에서 관리
3. 환경변수 검증 로직 자동 스킵으로 dummy 값 불필요

**검증 방법**:
```bash
# MCP 서버 연결 확인
claude mcp list

# 헬스체크 실행
# Claude Code에서: "db-mcp 서버 헬스체크 실행해줘"
```

### 방법 2: DB별 별도 MCP 서버 (간단한 방법)

각 데이터베이스마다 별도의 MCP 서버 인스턴스를 실행합니다.

#### Claude Desktop 설정 (별도 서버)
```json
{
  "mcpServers": {
    "user-db": {
      "command": "node",
      "args": ["path/to/db-mcp/dist/index.js"],
      "env": {
        "DB_TYPE": "mysql",
        "MYSQL_HOST": "user-db.cluster-xxx.rds.amazonaws.com",
        "MYSQL_DB": "user_service"
      }
    },
    "order-db": {
      "command": "node",
      "args": ["path/to/db-mcp/dist/index.js"],
      "env": {
        "DB_TYPE": "postgresql",
        "POSTGRES_HOST": "order-db.cluster-yyy.rds.amazonaws.com",
        "POSTGRES_DB": "order_service"
      }
    }
  }
}
```

### 다중 DB 전용 기능

단일 MCP 서버에서 다중 DB를 사용할 때 추가로 제공되는 기능:

#### 1. 크로스 데이터베이스 쿼리
```
"사용자 서비스와 주문 서비스 데이터를 비교해서 보여줘"
→ 여러 DB에서 데이터를 조회하여 통합 분석
```

#### 2. 데이터베이스 태그 필터링
```
"microservice 태그가 붙은 모든 DB 상태를 확인해줘"
→ 태그 기반으로 DB 그룹 관리
```

#### 3. 통합 헬스체크
```
"모든 데이터베이스 연결 상태를 한번에 확인해줘"
→ 전체 인프라 상태 모니터링
```

#### 4. 데이터베이스 간 관계 분석
```
"사용자 ID로 모든 서비스의 관련 데이터를 찾아줘"
→ 마이크로서비스 간 데이터 추적
```

## 🛠 제공 기능

### 🔗 1. 다중 데이터베이스 연결 관리
- **🏢 MSA 완벽 지원**: 하나의 MCP 서버에서 수십 개의 마이크로서비스 DB 관리
- **⚡ 고성능 연결 풀링**: DB별 독립적인 연결 풀로 최적화된 리소스 관리
- **🔄 자동 페일오버**: 연결 끊김 시 자동 재연결 및 상태 복구
- **📊 실시간 모니터링**: 연결 상태, 활성 쿼리, 응답 시간 실시간 추적
- **🏷 태그 기반 관리**: 환경별, 서비스별 DB 그룹 관리 (production, staging, analytics 등)

### ⚙️ 2. 고급 쿼리 실행 도구 (Tools)

#### `list_databases` 🗂
- **기능**: 연결된 모든 데이터베이스 목록 및 상태 조회
- **출력**: DB 타입, 연결 상태, 태그, 설명, 성능 메트릭
- **활용**: 전체 인프라 현황 파악, 헬스체크

#### `execute_query` 🚀
- **기능**: 특정 데이터베이스에 SQL 쿼리 실행
- **입력**: SQL 문자열, 대상 DB, 파라미터
- **출력**: 구조화된 결과 + 실행 메트릭
- **보안**: 읽기 전용 쿼리만 허용, SQL 인젝션 방지

#### `cross_database_query` 🔄
- **기능**: 여러 데이터베이스에서 동시 쿼리 실행 및 결과 통합
- **입력**: 데이터베이스별 쿼리 배열
- **출력**: 통합된 결과셋 + 성능 비교
- **활용**: 마이크로서비스 간 데이터 비교, 통합 리포팅

#### `natural_language_query` 🤖
- **기능**: 자연어를 SQL로 변환하여 실행
- **입력**: 자연어 질문, 대상 DB, 컨텍스트
- **출력**: 생성된 SQL + 실행 결과 + 신뢰도
- **AI 지원**: 스키마 정보 기반 지능형 쿼리 생성

#### `database_health_check` 🏥
- **기능**: 전체 또는 개별 데이터베이스 상태 검사
- **출력**: 응답 시간, 연결 풀 상태, 성능 지표
- **활용**: 인프라 모니터링, 장애 조기 감지

### 📋 3. 통합 스키마 정보 리소스 (Resources)

#### `database://connections` 🔗
- **내용**: 모든 연결된 데이터베이스의 상세 정보
- **포함**: 연결 설정, 상태, 메타데이터, 태그

#### `database://{db_name}/schema` 📊
- **내용**: 특정 데이터베이스의 완전한 스키마 정보
- **포함**: 테이블, 뷰, 프로시저, 인덱스, 외래키 관계
- **지원**: MySQL, PostgreSQL 각각 최적화된 분석

#### `database://{db_name}/tables` 📁
- **내용**: 테이블별 상세 정보 및 통계
- **포함**: 컬럼 정보, 데이터 타입, 제약조건, 행 수, 크기

### 🔍 4. 고급 데이터 분석 도구

#### **스키마 분석 엔진**
- **MySQL 특화**: information_schema 최적화 쿼리
- **PostgreSQL 특화**: pg_catalog 및 확장 정보 분석
- **성능 최적화**: 지능형 캐싱으로 빠른 응답

#### **데이터 품질 분석**
- **컬럼 프로파일링**: 타입별 통계, NULL 비율, 고유값 분석
- **패턴 감지**: 이메일, 전화번호, URL 등 데이터 패턴 자동 감지
- **이상치 탐지**: 3-시그마 규칙 기반 수치 이상치 발견
- **품질 점수**: 데이터 완성도, 일관성, 정확도 종합 평가

#### **관계 분석**
- **테이블 관계 매핑**: 외래키 기반 자동 관계도 생성
- **데이터 링크 추적**: 마이크로서비스 간 데이터 연관성 분석
- **종속성 분석**: 스키마 변경 영향도 평가

## 보안 및 제한사항

### 보안 기능

#### 1. 쿼리 제한
- **읽기 전용**: DML(INSERT, UPDATE, DELETE) 및 DDL(CREATE, DROP) 금지
- **화이트리스트**: 허용된 SQL 키워드만 실행
- **구문 검증**: SQL 인젝션 방지를 위한 파싱 검증

#### 2. 실행 제한
```javascript
const SECURITY_LIMITS = {
  MAX_EXECUTION_TIME: 30000,    // 30초
  MAX_RESULT_ROWS: 10000,       // 최대 10,000행
  MAX_RESULT_SIZE: '50MB',      // 최대 50MB
  MAX_QUERY_LENGTH: 10000,      // 최대 10,000자
  ALLOWED_KEYWORDS: [
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'ORDER BY',
    'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET',
    'SHOW', 'DESCRIBE', 'EXPLAIN'
  ]
};
```

#### 3. 접근 제어
- **데이터베이스별 권한**: 각 DB 연결마다 별도 권한 설정
- **테이블별 제한**: 특정 테이블 접근 제한 가능
- **감사 로깅**: 모든 쿼리 실행 기록 저장

#### 4. 네트워크 보안
- **TLS/SSL 암호화**: 원격 DB 연결 암호화 강제 (AWS RDS, Azure DB 등)
- **VPC 지원**: AWS VPC, Azure VNet 내 접근
- **연결 제한**: IP 화이트리스트 지원
- **시간 기반 액세스**: 특정 시간대에만 접근 허용
- **Connection Timeout**: 원격 연결 시간 제한 설정

### 기능 제한사항

#### 1. 지원하지 않는 기능
- ❌ 데이터 수정 작업 (INSERT, UPDATE, DELETE)
- ❌ 스키마 변경 (CREATE, ALTER, DROP)
- ❌ 저장 프로시저 실행
- ❌ 트랜잭션 제어 (BEGIN, COMMIT, ROLLBACK)
- ❌ 사용자 관리 명령
- ❌ 파일 시스템 접근

#### 2. 성능 제한
- **동시 연결**: 최대 10개 동시 쿼리
- **캐싱**: 스키마 정보 5분 캐시
- **Rate Limiting**: 분당 100회 쿼리 제한

#### 3. 데이터 타입 제한
- **BLOB/TEXT**: 큰 데이터는 요약 정보만 제공
- **JSON/XML**: 구조화된 형태로 파싱하여 제공
- **Binary**: Base64 인코딩으로 제한적 지원

## 설치 및 설정

### 1. 설치
```bash
npm install
```

### 2. 환경 설정
`.env` 파일 생성:

#### MySQL 설정
```env
# MySQL 연결 정보 (로컬 또는 원격)
DB_TYPE=mysql                           # 명시적 타입 지정 (선택사항)
MYSQL_HOST=localhost                    # 또는 AWS RDS 엔드포인트
MYSQL_PORT=3306
MYSQL_DB=mydb
MYSQL_USER=readonly_user
MYSQL_PASSWORD=secure_password

# 원격 DB 설정 (AWS RDS 예시)
# MYSQL_HOST=mydb.cluster-xxx.us-east-1.rds.amazonaws.com
# MYSQL_SSL_MODE=REQUIRED
# MYSQL_SSL_CA=/path/to/rds-ca-2019-root.pem
# MYSQL_CONNECTION_TIMEOUT=60000
# MYSQL_ACQUIRECONNECTION_TIMEOUT=60000
```

#### PostgreSQL 설정
```env
# PostgreSQL 연결 정보 (로컬 또는 원격)
DB_TYPE=postgresql                      # 명시적 타입 지정 (선택사항)
POSTGRES_HOST=localhost                 # 또는 AWS RDS 엔드포인트
POSTGRES_PORT=5432
POSTGRES_DB=mydb
POSTGRES_USER=readonly_user
POSTGRES_PASSWORD=secure_password

# 원격 DB 설정 (AWS RDS PostgreSQL 예시)
# POSTGRES_HOST=mydb.cluster-xxx.us-east-1.rds.amazonaws.com
# POSTGRES_SSL_MODE=REQUIRED
# POSTGRES_SSL_CA=/path/to/rds-ca-2019-root.pem
# POSTGRES_CONNECTION_TIMEOUT=60000
```

#### 공통 보안 설정
```env
MAX_QUERY_EXECUTION_TIME=30000
MAX_RESULT_ROWS=10000
ENABLE_QUERY_LOGGING=true
```

### 3. Claude Desktop 설정

#### MySQL 사용 시
`claude_desktop_config.json`에 추가:
```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["path/to/db-mcp/dist/index.js"],
      "env": {
        "DB_TYPE": "mysql",
        "MYSQL_HOST": "localhost",
        "MYSQL_PORT": "3306",
        "MYSQL_DB": "mydb",
        "MYSQL_USER": "readonly_user",
        "MYSQL_PASSWORD": "secure_password"
      }
    }
  }
}
```

#### PostgreSQL 사용 시
`claude_desktop_config.json`에 추가:
```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["path/to/db-mcp/dist/index.js"],
      "env": {
        "DB_TYPE": "postgresql",
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5432",
        "POSTGRES_DB": "mydb",
        "POSTGRES_USER": "readonly_user",
        "POSTGRES_PASSWORD": "secure_password"
      }
    }
  }
}
```

## 💡 실제 사용 예시

### 🏢 MSA 환경에서의 활용

#### 마이크로서비스 간 데이터 분석
```
💬 "user-service와 order-service에서 최근 1주일 동안 신규 가입한 사용자들의 주문 패턴을 비교 분석해줘"

🤖 Claude가 자동으로:
1. user-service DB에서 최근 가입자 조회
2. order-service DB에서 해당 사용자들의 주문 데이터 조회
3. 크로스 데이터베이스 분석으로 패턴 식별
4. 통합 리포트 생성
```

#### 전체 인프라 모니터링
```
💬 "production 태그가 붙은 모든 데이터베이스의 상태를 확인하고 성능 문제가 있는 곳을 찾아줘"

🤖 결과:
- 5개 프로덕션 DB 중 4개 정상, 1개 경고
- analytics-db: 응답시간 3.2초 (평균의 2배)
- 연결 풀 사용률: order-service 90% (주의 필요)
```

### 🔍 고급 데이터 분석

#### 데이터 품질 검사
```
💬 "모든 서비스의 사용자 테이블에서 이메일 형식이 잘못된 데이터를 찾아줘"

🤖 자동 실행:
- user-service.users 테이블: 이메일 패턴 검증
- auth-service.profiles 테이블: 이메일 중복 검사
- notification-service.recipients 테이블: 유효하지 않은 도메인 탐지
```

#### 스키마 영향도 분석
```
💬 "user_id 컬럼을 사용하는 모든 테이블과 관계를 찾아서 스키마 변경 시 영향도를 분석해줘"

🤖 결과:
- 직접 참조: 15개 테이블
- 간접 참조: 8개 테이블
- 영향 받는 서비스: user, order, payment, notification, analytics
- 권장사항: 단계적 마이그레이션 계획 필요
```

### 🚀 자연어 쿼리

#### 비즈니스 질문 → SQL
```
💬 "지난 달 가장 많이 팔린 상품 카테고리는 뭐야?"

🤖 생성된 SQL:
SELECT c.name, COUNT(oi.product_id) as sales_count
FROM order_items oi
JOIN products p ON oi.product_id = p.id
JOIN categories c ON p.category_id = c.id
WHERE oi.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)
GROUP BY c.id
ORDER BY sales_count DESC
LIMIT 1
```

#### 복잡한 분석 쿼리
```
💬 "각 지역별로 월별 매출 추이를 보여주고, 전년 동기 대비 성장률도 계산해줘"

🤖 자동으로:
1. 지역, 날짜별 매출 집계
2. 전년 동기 데이터 조회
3. 성장률 계산
4. 시각화 가능한 형태로 결과 정리
```

### 📊 실시간 모니터링

#### 성능 이슈 탐지
```
💬 "현재 느리게 실행되고 있는 쿼리가 있는 데이터베이스를 찾아줘"

🤖 실시간 분석:
- order-service: 3개 쿼리가 10초 이상 실행 중
- analytics-db: 대용량 집계 쿼리 진행 중 (정상)
- user-service: 모든 쿼리 1초 이내 (양호)
```

#### 용량 관리
```
💬 "각 데이터베이스의 테이블별 크기를 조회하고 정리가 필요한 테이블을 추천해줘"

🤖 분석 결과:
- log_events 테이블: 15GB (파티셔닝 권장)
- user_sessions 테이블: 8GB (TTL 설정 권장)
- temp_data 테이블: 3GB (정리 스케줄 필요)
```

## 🗺 개발 로드맵 & 버전 히스토리

### ✅ 완료된 기능 (v1.0)
- [x] **Phase 1**: 기본 MCP 서버 + MySQL 연결
- [x] **Phase 2**: 쿼리 실행 도구 구현
- [x] **Phase 3**: 스키마 정보 리소스 추가
- [x] **Phase 4**: PostgreSQL 지원 확장
- [x] **Phase 5**: 다중 데이터베이스 지원 (MSA 대응)
- [x] **Phase 6**: 고급 데이터 분석 기능
- [x] **Phase 7**: 엔터프라이즈급 보안 및 성능 최적화

### 🚧 개발 예정 (v1.1+)

#### **Phase 8**: 추가 데이터베이스 지원
- [ ] **SQLite** 지원 (로컬 개발, 임베디드 환경)
- [ ] **ClickHouse** 지원 (대용량 분석 워크로드)
- [ ] **MongoDB** 지원 (NoSQL 문서 데이터베이스)
- [ ] **Redis** 지원 (캐시 및 세션 데이터 분석)

#### **Phase 9**: AI 기능 강화
- [ ] **고급 자연어 처리**: GPT-4 기반 복잡한 쿼리 생성
- [ ] **자동 인덱스 추천**: 쿼리 패턴 분석 기반 성능 최적화
- [ ] **이상 탐지**: ML 기반 데이터 품질 및 보안 이슈 감지
- [ ] **쿼리 최적화**: 실행 계획 분석 및 자동 개선 제안

#### **Phase 10**: 엔터프라이즈 기능
- [ ] **RBAC (Role-Based Access Control)**: 세밀한 권한 관리
- [ ] **감사 및 컴플라이언스**: GDPR, SOX 등 규정 준수
- [ ] **고가용성**: 클러스터링 및 로드 밸런싱
- [ ] **메트릭 & 알림**: Prometheus, Grafana 연동

#### **Phase 11**: 개발자 경험 개선
- [ ] **GUI 관리 도구**: 웹 기반 설정 및 모니터링 대시보드
- [ ] **CLI 도구**: 배포 및 관리 자동화
- [ ] **Docker 컨테이너**: 원클릭 배포 지원
- [ ] **Kubernetes Operator**: 클라우드 네이티브 배포

### 📊 성능 목표 (v2.0)
- **응답 시간**: 단순 쿼리 < 100ms, 복잡한 분석 < 5s
- **동시 연결**: 1000+ 데이터베이스 동시 관리
- **처리량**: 10,000+ qps (queries per second)
- **가용성**: 99.9% 업타임 보장

## 🤝 기여 가이드

우리는 커뮤니티의 기여를 환영합니다! 다음과 같은 방식으로 참여할 수 있습니다.

### 🐛 버그 리포트
- GitHub Issues를 통해 버그 신고
- 재현 가능한 예제 코드 포함
- 환경 정보 (OS, Node.js 버전, DB 타입) 명시

### 💡 기능 제안
- 새로운 데이터베이스 지원 요청
- MCP 도구 개선 아이디어
- 성능 최적화 제안

### 🔧 개발 참여
1. **Fork & Clone**: 저장소를 포크하고 로컬에 클론
2. **브랜치 생성**: `git checkout -b feature/your-feature`
3. **개발**: TypeScript, Jest 테스트 작성 필수
4. **테스트**: `npm test && npm run build` 통과 확인
5. **PR 생성**: 상세한 설명과 함께 Pull Request

### 📚 문서화
- README 개선
- 코드 주석 추가
- 사용 예시 확장
- 다국어 번역 (English, 한국어)

### 🔒 보안 이슈
민감한 보안 문제는 public issue 대신 직접 연락해 주세요.

## 📋 요구사항

- **Node.js**: ≥ 18.0.0
- **NPM**: ≥ 8.0.0
- **TypeScript**: ≥ 5.0.0
- **데이터베이스**: MySQL 5.7+ 또는 PostgreSQL 12+

## 🏗 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude AI Client                         │
├─────────────────────────────────────────────────────────────┤
│                Model Context Protocol                       │
├─────────────────────────────────────────────────────────────┤
│              Multi-Database MCP Server                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │ Connection Mgr  │  │  Query Executor  │  │ Schema Mgr  │ │
│  └─────────────────┘  └──────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│              Database Adapter Layer                         │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │  MySQL Adapter  │  │PostgreSQL Adapter│  │ Future DBs  │ │
│  └─────────────────┘  └──────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    Database Layer                           │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │ User Service DB │  │ Order Service DB │  │Analytics DB │ │
│  │     (MySQL)     │  │   (PostgreSQL)   │  │(PostgreSQL) │ │
│  └─────────────────┘  └──────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 🌟 후원 및 지원

이 프로젝트가 도움이 되었다면:
- ⭐ GitHub Star 눌러주기
- 🐛 이슈 리포트 및 피드백
- 💬 커뮤니티에서 사용 경험 공유
- 🔗 SNS에서 프로젝트 소개

## 📜 라이선스

MIT License - 자유롭게 사용, 수정, 배포 가능합니다.

## 🙏 감사의 말

- **Anthropic**: Model Context Protocol 및 Claude 제공
- **커뮤니티**: 피드백과 기여로 프로젝트 발전에 도움
- **오픈소스**: mysql2, pg, TypeScript 등 훌륭한 라이브러리들

---

## 📞 문의 및 지원

- **GitHub Issues**: 버그 리포트, 기능 요청
- **GitHub Discussions**: 사용법 질문, 아이디어 공유
- **Documentation**: 자세한 API 문서 및 가이드

**Enterprise Support가 필요하신가요?** 대용량 트래픽, 커스텀 개발, 기술 지원이 필요한 경우 별도 문의 가능합니다.

---

<div align="center">

**🚀 Database MCP Server - AI 시대의 데이터베이스 통합 솔루션**

Made with ❤️ for the AI & Database community

</div>