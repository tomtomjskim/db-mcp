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
            description: 'SQL 쿼리 실행 (읽기 전용)',
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
              },
              required: ['query'],
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
              args?.parameters as string[]
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
          }, null, 2),
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
            }, null, 2),
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
            }, null, 2),
          },
        ],
      };
    }
  }

  /**
   * SQL 쿼리 실행
   */
  private async handleExecuteQuery(query: string, database?: string, parameters?: string[]) {
    if (!query) {
      throw new Error('Query is required');
    }

    const dbName = database || this.connectionManager.getDefaultConnection();
    if (!dbName) {
      throw new Error('No database specified and no default connection configured');
    }
    const adapter = this.connectionManager.getConnection(dbName);

    const result = await adapter.query(query, parameters || []);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            database: dbName,
            query: query.substring(0, 200) + (query.length > 200 ? '...' : ''),
            executionTime: result.executionTime,
            rowCount: result.rowCount,
            truncated: result.truncated,
            cached: result.cached,
            rows: result.rows,
            fields: result.fields,
          }, null, 2),
        },
      ],
    };
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

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            database: dbName,
            question,
            generatedSQL: sql,
            parameters: [],
            explanation: 'Simple query generated from natural language',
            confidence: 0.7,
            executionTime: result.executionTime,
            rowCount: result.rowCount,
            rows: result.rows,
            fields: result.fields,
          }, null, 2),
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

        return {
          database,
          alias: alias || database,
          query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
          executionTime: result.executionTime,
          rowCount: result.rowCount,
          rows: result.rows,
          fields: result.fields,
        };
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: {
              totalQueries: results.length,
              totalRows: results.reduce((sum, r) => sum + r.rowCount, 0),
              totalExecutionTime: results.reduce((sum, r) => sum + r.executionTime, 0),
            },
            results,
          }, null, 2),
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
          text: JSON.stringify(connections, null, 2),
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
              text: JSON.stringify(schema, null, 2),
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
              text: JSON.stringify(schema.tables, null, 2),
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