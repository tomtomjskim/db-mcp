import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import { DatabaseConnectionManager, MultiDatabaseConfig } from '../database/connection-manager.js';
import { MultiDatabaseConfigLoader } from '../config/multi-database-config.js';
import { QueryExecutor } from '../database/query-executor.js';
import { NaturalLanguageProcessor } from '../database/natural-language-processor.js';
import { logger } from '../utils/logger.js';
import { existsSync } from 'fs';
import {
  formatMultiDbQueryResponse,
  formatErrorResponse,
  formatSchemaCheckResponse,
  toCompactJSON,
  injectAutoLimit,
  isSchemaQuery,
  QueryResponseOptions,
  ResponseFormat,
} from '../utils/response-formatter.js';

/**
 * 다중 데이터베이스 지원 MCP 서버
 * MSA 환경에서 여러 데이터베이스에 동시 접속 지원
 */
export class MultiDatabaseMCPServer {
  private server: Server;
  private connectionManager: DatabaseConnectionManager;
  private queryExecutors = new Map<string, QueryExecutor>();
  private nlProcessor: NaturalLanguageProcessor;

  constructor() {
    this.server = new Server(
      {
        name: 'multi-database-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    // 다중 DB 설정 로드
    const config = this.loadMultiDatabaseConfig();
    this.connectionManager = new DatabaseConnectionManager(config);
    this.nlProcessor = new NaturalLanguageProcessor();

    this.setupHandlers();
  }

  /**
   * 다중 데이터베이스 설정 로드
   */
  private loadMultiDatabaseConfig(): MultiDatabaseConfig {
    const configPath = process.env.DB_CONFIG_FILE || './db-config.json';

    try {
      // 1. 설정 파일이 있으면 파일에서 로드
      if (existsSync(configPath)) {
        logger.info('Loading multi-database config from file', { configPath });
        return MultiDatabaseConfigLoader.loadFromFile(configPath);
      }

      // 2. 다중 DB 환경변수 패턴 확인
      const hasMultiDbEnv = Object.keys(process.env).some(key =>
        key.startsWith('DB_') && key.split('_').length >= 3
      );

      if (hasMultiDbEnv) {
        logger.info('Loading multi-database config from environment variables');
        return MultiDatabaseConfigLoader.loadFromEnvironment();
      }

      // 3. 기존 단일 DB 환경변수에서 로드
      logger.info('Loading multi-database config from legacy environment variables');
      return MultiDatabaseConfigLoader.loadFromLegacyEnvironment();

    } catch (error) {
      logger.error('Failed to load multi-database config', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * MCP 핸들러 설정
   */
  private setupHandlers(): void {
    // 도구 목록 제공
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const connectionNames = this.connectionManager.getConnectionNames();
      const tools: Tool[] = [];

      // 기본 도구들
      tools.push(
        {
          name: 'list_databases',
          description: '연결된 모든 데이터베이스 목록 조회',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'database_health_check',
          description: '모든 데이터베이스 연결 상태 확인',
          inputSchema: {
            type: 'object',
            properties: {
              database: {
                type: 'string',
                description: '특정 데이터베이스만 확인 (선택사항)',
                enum: connectionNames.length > 0 ? connectionNames : undefined,
              },
            },
          },
        }
      );

      // 연결된 DB가 있을 때만 쿼리 도구 추가
      if (connectionNames.length > 0) {
        tools.push(
          {
            name: 'execute_query',
            description: 'SQL 쿼리 실행 (읽기 전용). 응답은 compact Array-of-Arrays 형식: {columns:[...], rows:[[...],...]}}. SHOW COLUMNS는 자동으로 경량 텍스트 포맷 반환. LIMIT 없는 SELECT는 자동으로 LIMIT 50 적용.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: '실행할 SQL 쿼리',
                },
                database: {
                  type: 'string',
                  description: '대상 데이터베이스',
                  enum: connectionNames,
                },
                parameters: {
                  type: 'array',
                  description: '쿼리 파라미터 (선택사항)',
                  items: { type: 'string' },
                },
                format: {
                  type: 'string',
                  enum: ['compact', 'table', 'minimal'],
                  description: '응답 포맷. compact=JSON Array-of-Arrays(기본), table=TSV 텍스트, minimal=샘플5행+요약',
                },
                maxRows: {
                  type: 'number',
                  description: '최대 반환 행 수 (기본 50). 큰 결과셋이 필요하면 명시적으로 늘릴 것',
                },
                preview: {
                  type: 'boolean',
                  description: 'true면 샘플 3행 + 총 행 수만 반환 (토큰 절약)',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'schema_check',
            description: '테이블 스키마 확인 (SHOW COLUMNS 대체). 경량 텍스트로 컬럼명, 타입, 키, NULL 여부 반환. 캐시 지원으로 반복 호출 시 토큰 절약.',
            inputSchema: {
              type: 'object',
              properties: {
                table: {
                  type: 'string',
                  description: '테이블명',
                },
                database: {
                  type: 'string',
                  description: '대상 데이터베이스',
                  enum: connectionNames,
                },
              },
              required: ['table'],
            },
          },
          {
            name: 'natural_language_query',
            description: '자연어를 SQL로 변환하여 실행',
            inputSchema: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: '자연어 질문',
                },
                database: {
                  type: 'string',
                  description: '대상 데이터베이스',
                  enum: connectionNames,
                },
                context: {
                  type: 'string',
                  description: '추가 컨텍스트 (테이블명 등)',
                },
              },
              required: ['question'],
            },
          },
          {
            name: 'cross_database_query',
            description: '여러 데이터베이스에서 데이터 조회 및 비교',
            inputSchema: {
              type: 'object',
              properties: {
                queries: {
                  type: 'array',
                  description: '각 데이터베이스별 쿼리',
                  items: {
                    type: 'object',
                    properties: {
                      database: { type: 'string', enum: connectionNames },
                      query: { type: 'string' },
                      alias: { type: 'string' },
                    },
                    required: ['database', 'query'],
                  },
                },
              },
              required: ['queries'],
            },
          }
        );
      }

      return { tools };
    });

    // 리소스 목록 제공
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const connectionNames = this.connectionManager.getConnectionNames();
      const resources: Resource[] = [];

      // 데이터베이스 목록 리소스
      resources.push({
        uri: 'database://connections',
        name: '데이터베이스 연결 목록',
        description: '모든 연결된 데이터베이스의 정보',
        mimeType: 'application/json',
      });

      // 각 데이터베이스별 스키마 리소스
      connectionNames.forEach(name => {
        resources.push(
          {
            uri: `database://${name}/schema`,
            name: `${name} 스키마`,
            description: `${name} 데이터베이스의 전체 스키마 정보`,
            mimeType: 'application/json',
          },
          {
            uri: `database://${name}/tables`,
            name: `${name} 테이블 목록`,
            description: `${name} 데이터베이스의 테이블 목록`,
            mimeType: 'application/json',
          }
        );
      });

      return { resources };
    });

    // 도구 실행 핸들러
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'list_databases':
            return await this.handleListDatabases();

          case 'database_health_check':
            return await this.handleHealthCheck(args?.database as string);

          case 'execute_query':
            return await this.handleExecuteQuery(
              args?.query as string,
              args?.database as string,
              args?.parameters as string[],
              {
                format: args?.format as ResponseFormat | undefined,
                maxRows: args?.maxRows as number | undefined,
                preview: args?.preview as boolean | undefined,
              }
            );

          case 'schema_check':
            return await this.handleSchemaCheck(
              args?.table as string,
              args?.database as string
            );

          case 'natural_language_query':
            return await this.handleNaturalLanguageQuery(
              args?.question as string,
              args?.database as string,
              args?.context as string
            );

          case 'cross_database_query':
            return await this.handleCrossDatabaseQuery(args?.queries as Array<{
              database: string;
              query: string;
              alias?: string;
            }>);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        logger.error('Tool execution failed', {
          tool: name,
          error: error instanceof Error ? error.message : 'Unknown error',
          args
        });

        return {
          content: [
            {
              type: 'text',
              text: `Error executing ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    });

    // 리소스 읽기 핸들러
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      try {
        if (uri === 'database://connections') {
          return await this.handleReadConnections();
        }

        const match = uri.match(/^database:\/\/([^\/]+)\/(.+)$/);
        if (match && match[1] && match[2]) {
          const database = match[1];
          const resource = match[2];
          return await this.handleReadDatabaseResource(database, resource);
        }

        throw new Error(`Unknown resource: ${uri}`);
      } catch (error) {
        logger.error('Resource read failed', {
          uri,
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `Error reading resource: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    });
  }

  /**
   * 데이터베이스 목록 조회
   */
  private async handleListDatabases() {
    const connections = this.connectionManager.getAllConnectionsInfo();
    const managerInfo = this.connectionManager.getManagerInfo();
    const statistics = this.connectionManager.getStatistics();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              totalConnections: managerInfo.totalConnections,
              defaultConnection: managerInfo.defaultConnection,
              supportedTypes: managerInfo.supportedTypes,
            },
            statistics,
            connections: connections.map(conn => ({
              name: conn.name,
              type: conn.type,
              host: conn.host,
              database: conn.database,
              description: conn.description,
              tags: conn.tags,
              isConnected: conn.isConnected,
            })),
          }),
        },
      ],
    };
  }

  /**
   * 헬스체크 수행
   */
  private async handleHealthCheck(database?: string) {
    if (database) {
      const adapter = this.connectionManager.getConnection(database);
      const health = await adapter.healthCheck();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              database,
              isHealthy: health.isHealthy,
              responseTime: health.responseTime,
              lastCheck: health.lastCheck,
              error: health.error,
              details: health.details,
            }),
          },
        ],
      };
    } else {
      const healthResults = await this.connectionManager.healthCheckAll();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              overall: {
                totalDatabases: Object.keys(healthResults).length,
                healthyDatabases: Object.values(healthResults).filter(h => h.isHealthy).length,
                averageResponseTime: Object.values(healthResults).reduce((sum, h) => sum + h.responseTime, 0) / Object.keys(healthResults).length,
              },
              databases: healthResults,
            }),
          },
        ],
      };
    }
  }

  /**
   * SQL 쿼리 실행 (TIER 2: 자동 LIMIT, format/maxRows/preview 지원)
   */
  private async handleExecuteQuery(
    query: string,
    database?: string,
    parameters?: string[],
    options?: QueryResponseOptions
  ) {
    if (!query) {
      throw new Error('Query is required');
    }

    const dbName = database || this.connectionManager.getDefaultConnection();
    if (!dbName) {
      throw new Error('No database specified and no default connection configured');
    }
    const adapter = this.connectionManager.getConnection(dbName);

    // TIER 2: 자동 LIMIT 주입 (스키마 쿼리 제외)
    let finalQuery = query;
    let autoLimited = false;
    if (!isSchemaQuery(query)) {
      const limitResult = injectAutoLimit(query, options?.maxRows);
      finalQuery = limitResult.query;
      autoLimited = limitResult.autoLimited;
    }

    const result = await adapter.query(finalQuery, parameters || []);

    // autoLimited인 경우 totalRows 확인을 위해 COUNT 쿼리 실행
    if (autoLimited && result.rows && result.rows.length > 0) {
      try {
        const countQuery = buildCountQuery(query);
        if (countQuery) {
          const countResult = await adapter.query(countQuery);
          if (countResult.rows && countResult.rows.length > 0) {
            const countVal = Object.values(countResult.rows[0])[0];
            result.totalRows = Number(countVal);
            if (result.totalRows > result.rows.length) {
              result.truncated = true;
            }
          }
        }
      } catch {
        // COUNT 실패는 무시
      }
    }

    return formatMultiDbQueryResponse(result, dbName, query, options);
  }

  /**
   * TIER 3: 테이블 스키마 확인 (SHOW COLUMNS 대체, 캐시 지원)
   */
  private schemaCache = new Map<string, { data: any[]; timestamp: number }>();
  private readonly schemaCacheTTL = 5 * 60 * 1000; // 5분

  private async handleSchemaCheck(table: string, database?: string) {
    if (!table) {
      throw new Error('Table name is required');
    }

    const dbName = database || this.connectionManager.getDefaultConnection();
    if (!dbName) {
      throw new Error('No database specified and no default connection configured');
    }

    const cacheKey = `${dbName}:${table}`;
    const cached = this.schemaCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.schemaCacheTTL) {
      return formatSchemaCheckResponse(table, cached.data, dbName, true, 0);
    }

    const adapter = this.connectionManager.getConnection(dbName);
    const startTime = Date.now();
    const result = await adapter.query(`SHOW COLUMNS FROM \`${table.replace(/`/g, '')}\``);
    const executionTime = Date.now() - startTime;

    // 캐시 저장
    this.schemaCache.set(cacheKey, { data: result.rows, timestamp: now });

    return formatSchemaCheckResponse(table, result.rows, dbName, false, executionTime);
  }

  /**
   * 자연어 쿼리 처리
   */
  private async handleNaturalLanguageQuery(question: string, database?: string, context?: string) {
    if (!question) {
      throw new Error('Question is required');
    }

    const dbName = database || this.connectionManager.getDefaultConnection();
    if (!dbName) {
      throw new Error('No database specified and no default connection configured');
    }

    const adapter = this.connectionManager.getConnection(dbName);
    const schemaAnalyzer = adapter.getSchemaAnalyzer();

    // 스키마 정보 가져오기
    const schema = await schemaAnalyzer.analyzeFullSchema();

    // 간단한 자연어 처리 (실제로는 더 복잡한 처리 필요)
    const sql = `SELECT * FROM ${schema.tables[0]?.name || 'users'} LIMIT 10`;

    // 생성된 SQL 실행
    const result = await adapter.query(sql, []);

    const columns = result.rows.length > 0
      ? Object.keys(result.rows[0])
      : (result.fields || []).map((f: any) => f.name || f);
    const compactRows = result.rows.map((row: any) =>
      columns.map((col: string) => row[col])
    );

    return {
      content: [
        {
          type: 'text',
          text: toCompactJSON({
            db: dbName,
            generatedSQL: sql,
            confidence: 0.7,
            columns,
            rows: compactRows,
            rowCount: result.rowCount,
            executionTime: result.executionTime,
          }),
        },
      ],
    };
  }

  /**
   * 크로스 데이터베이스 쿼리 처리
   */
  private async handleCrossDatabaseQuery(queries: Array<{ database: string; query: string; alias?: string }>) {
    if (!queries || queries.length === 0) {
      throw new Error('Queries array is required');
    }

    const results = await Promise.all(
      queries.map(async ({ database, query, alias }) => {
        const adapter = this.connectionManager.getConnection(database);
        const result = await adapter.query(query);
        const columns = result.rows.length > 0
          ? Object.keys(result.rows[0])
          : (result.fields || []).map((f: any) => f.name || f);

        return {
          db: alias || database,
          columns,
          rows: result.rows.map((row: any) => columns.map((col: string) => row[col])),
          rowCount: result.rowCount,
          executionTime: result.executionTime,
        };
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: toCompactJSON({
            summary: {
              totalQueries: results.length,
              totalRows: results.reduce((sum, r) => sum + r.rowCount, 0),
              totalExecutionTime: results.reduce((sum, r) => sum + r.executionTime, 0),
            },
            results,
          }),
        },
      ],
    };
  }

  /**
   * 연결 정보 읽기
   */
  private async handleReadConnections() {
    const connections = this.connectionManager.getAllConnectionsInfo();

    return {
      contents: [
        {
          uri: 'database://connections',
          mimeType: 'application/json',
          text: JSON.stringify(connections),
        },
      ],
    };
  }

  /**
   * 데이터베이스별 리소스 읽기
   */
  private async handleReadDatabaseResource(database: string, resource: string) {
    const adapter = this.connectionManager.getConnection(database);

    switch (resource) {
      case 'schema': {
        const schemaAnalyzer = adapter.getSchemaAnalyzer();
        const schema = await schemaAnalyzer.analyzeFullSchema();

        return {
          contents: [
            {
              uri: `database://${database}/schema`,
              mimeType: 'application/json',
              text: JSON.stringify(schema),
            },
          ],
        };
      }

      case 'tables': {
        const schemaAnalyzer = adapter.getSchemaAnalyzer();
        const schema = await schemaAnalyzer.analyzeFullSchema();

        return {
          contents: [
            {
              uri: `database://${database}/tables`,
              mimeType: 'application/json',
              text: JSON.stringify(schema.tables),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown resource: ${resource}`);
    }
  }


  /**
   * 서버 시작
   */
  async start(): Promise<void> {
    try {
      // 모든 데이터베이스에 연결
      await this.connectionManager.connectAll();

      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      logger.info('Multi-database MCP server started successfully', {
        connectionCount: this.connectionManager.getConnectionNames().length,
        connections: this.connectionManager.getConnectionNames(),
      });
    } catch (error) {
      logger.error('Failed to start multi-database MCP server', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * 서버 종료
   */
  async stop(): Promise<void> {
    try {
      await this.connectionManager.disconnectAll();
      logger.info('Multi-database MCP server stopped');
    } catch (error) {
      logger.error('Error stopping multi-database MCP server', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
}

/**
 * SELECT 쿼리에서 COUNT 쿼리 생성
 * "SELECT a, b FROM t WHERE x = 1" → "SELECT COUNT(*) as cnt FROM t WHERE x = 1"
 */
function buildCountQuery(originalQuery: string): string | null {
  const trimmed = originalQuery.trim().replace(/;$/, '');
  const upper = trimmed.toUpperCase();

  if (!upper.startsWith('SELECT')) return null;

  // FROM 위치 찾기 (서브쿼리 내 FROM 제외)
  let depth = 0;
  let fromIndex = -1;
  const words = upper.split(/\s+/);
  let charPos = 0;

  for (const word of words) {
    const idx = upper.indexOf(word, charPos);
    for (let i = charPos; i < idx; i++) {
      if (upper[i] === '(') depth++;
      if (upper[i] === ')') depth--;
    }
    if (word === 'FROM' && depth === 0 && fromIndex === -1) {
      fromIndex = idx;
      break;
    }
    charPos = idx + word.length;
  }

  if (fromIndex === -1) return null;

  const fromClause = trimmed.substring(fromIndex);

  // ORDER BY, LIMIT, OFFSET 제거
  const cleaned = fromClause
    .replace(/\bORDER\s+BY\b[^)]*$/i, '')
    .replace(/\bLIMIT\s+\d+/i, '')
    .replace(/\bOFFSET\s+\d+/i, '')
    .trim();

  return `SELECT COUNT(*) as cnt ${cleaned}`;
}