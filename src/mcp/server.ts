import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DatabaseConnection } from '../database/connection.js';
import { QueryExecutor } from '../database/query-executor.js';
import { NaturalLanguageProcessor } from '../database/natural-language-processor.js';
import { SchemaAnalyzer } from '../database/schema-analyzer.js';
import { DataProfiler } from '../database/data-profiler.js';
import { SchemaCache } from '../database/schema-cache.js';
import { databaseConfig, securityConfig, serverConfig, validateConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

export class DatabaseMCPServer {
  private server: Server;
  private database: DatabaseConnection;
  private queryExecutor: QueryExecutor;
  private nlProcessor: NaturalLanguageProcessor;
  private schemaAnalyzer: SchemaAnalyzer;
  private dataProfiler: DataProfiler;
  private schemaCache: SchemaCache;

  constructor() {
    validateConfig();

    this.server = new Server(
      {
        name: serverConfig.name,
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.database = new DatabaseConnection(databaseConfig);
    this.queryExecutor = new QueryExecutor(this.database);
    this.nlProcessor = new NaturalLanguageProcessor();
    this.schemaAnalyzer = new SchemaAnalyzer(this.database, databaseConfig.database!);
    this.dataProfiler = new DataProfiler(this.database, databaseConfig.database!);
    this.schemaCache = new SchemaCache({
      defaultTTL: 5 * 60 * 1000, // 5 minutes
      maxEntries: 500,
      maxSize: 50 * 1024 * 1024, // 50MB
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'execute_query',
            description: 'Execute a SQL query against the database (read-only operations only)',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'SQL query to execute (SELECT, SHOW, DESCRIBE, EXPLAIN only)',
                },
                parameters: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional query parameters for prepared statements',
                },
                options: {
                  type: 'object',
                  description: 'Query execution options (timeout, maxRows, dryRun)',
                  properties: {
                    timeout: { type: 'number' },
                    maxRows: { type: 'number' },
                    dryRun: { type: 'boolean' },
                  },
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'natural_language_query',
            description: 'Convert natural language question to SQL and execute it',
            inputSchema: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'Natural language question about the database',
                },
                executeQuery: {
                  type: 'boolean',
                  description: 'Whether to execute the generated SQL (default: true)',
                  default: true,
                },
              },
              required: ['question'],
            },
          },
          {
            name: 'analyze_query',
            description: 'Analyze a SQL query for validation, performance, and security',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'SQL query to analyze',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'explain_query',
            description: 'Get execution plan and performance analysis for a query',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'SQL query to explain',
                },
                parameters: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional query parameters',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'test_connection',
            description: 'Test database connection and return status',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_database_info',
            description: 'Get basic information about the connected database',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'analyze_schema',
            description: 'Analyze database schema and get detailed table information',
            inputSchema: {
              type: 'object',
              properties: {
                includeViews: {
                  type: 'boolean',
                  description: 'Include views in analysis (default: true)',
                  default: true,
                },
                includeProcedures: {
                  type: 'boolean',
                  description: 'Include stored procedures in analysis (default: true)',
                  default: true,
                },
                includeStatistics: {
                  type: 'boolean',
                  description: 'Include table statistics (default: true)',
                  default: true,
                },
              },
            },
          },
          {
            name: 'profile_table',
            description: 'Generate detailed data profile for a specific table',
            inputSchema: {
              type: 'object',
              properties: {
                tableName: {
                  type: 'string',
                  description: 'Name of the table to profile',
                },
                sampleSize: {
                  type: 'number',
                  description: 'Number of rows to sample for analysis (default: 10000)',
                  default: 10000,
                },
                includeTopValues: {
                  type: 'boolean',
                  description: 'Include top values analysis (default: true)',
                  default: true,
                },
                analyzeDataQuality: {
                  type: 'boolean',
                  description: 'Perform data quality analysis (default: true)',
                  default: true,
                },
              },
              required: ['tableName'],
            },
          },
          {
            name: 'get_table_relationships',
            description: 'Get foreign key relationships between tables',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'clear_schema_cache',
            description: 'Clear schema cache for better performance or after schema changes',
            inputSchema: {
              type: 'object',
              properties: {
                pattern: {
                  type: 'string',
                  description: 'Optional pattern to clear specific cache entries',
                },
              },
            },
          },
        ],
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          {
            uri: 'database://connection-status',
            name: 'Database Connection Status',
            description: 'Current status of the database connection',
            mimeType: 'application/json',
          },
          {
            uri: 'database://config',
            name: 'Database Configuration',
            description: 'Current database configuration (sanitized)',
            mimeType: 'application/json',
          },
          {
            uri: 'database://cache-stats',
            name: 'Query Cache Statistics',
            description: 'Statistics about query cache performance',
            mimeType: 'application/json',
          },
          {
            uri: 'database://audit-logs',
            name: 'Recent Audit Logs',
            description: 'Recent query execution audit logs',
            mimeType: 'application/json',
          },
          {
            uri: 'database://supported-patterns',
            name: 'Natural Language Patterns',
            description: 'Supported natural language query patterns',
            mimeType: 'application/json',
          },
          {
            uri: 'database://schema',
            name: 'Database Schema',
            description: 'Complete database schema including tables, views, and relationships',
            mimeType: 'application/json',
          },
          {
            uri: 'database://table/{table_name}',
            name: 'Table Information',
            description: 'Detailed information about a specific table',
            mimeType: 'application/json',
          },
          {
            uri: 'database://table/{table_name}/profile',
            name: 'Table Data Profile',
            description: 'Data quality and statistics profile for a specific table',
            mimeType: 'application/json',
          },
          {
            uri: 'database://relationships',
            name: 'Table Relationships',
            description: 'Foreign key relationships between tables',
            mimeType: 'application/json',
          },
          {
            uri: 'database://tables/summary',
            name: 'Tables Summary',
            description: 'Summary information for all tables',
            mimeType: 'application/json',
          },
          {
            uri: 'database://schema-cache/stats',
            name: 'Schema Cache Statistics',
            description: 'Performance statistics for schema cache',
            mimeType: 'application/json',
          },
        ],
      };
    });

    // Handle resource reads
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      switch (uri) {
        case 'database://connection-status':
          const status = this.database.getConnectionStatus();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(status, null, 2),
              },
            ],
          };

        case 'database://config':
          const sanitizedConfig = {
            host: databaseConfig.host,
            port: databaseConfig.port,
            database: databaseConfig.database,
            user: databaseConfig.user,
            ssl: !!databaseConfig.ssl,
            connectionLimit: databaseConfig.connectionLimit,
            timeout: databaseConfig.timeout,
          };
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(sanitizedConfig, null, 2),
              },
            ],
          };

        case 'database://cache-stats':
          const queryCacheStats = this.queryExecutor.getCacheStats();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(queryCacheStats, null, 2),
              },
            ],
          };

        case 'database://audit-logs':
          const auditLogs = this.queryExecutor.getAuditLogs(50);
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(auditLogs, null, 2),
              },
            ],
          };

        case 'database://supported-patterns':
          const patterns = this.nlProcessor.getSupportedPatterns();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ patterns }, null, 2),
              },
            ],
          };

        case 'database://schema':
          const schema = await this.getSchemaResource();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(schema, null, 2),
              },
            ],
          };

        case 'database://relationships':
          const relationships = await this.getRelationshipsResource();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(relationships, null, 2),
              },
            ],
          };

        case 'database://tables/summary':
          const summary = await this.getTablesSummaryResource();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(summary, null, 2),
              },
            ],
          };

        case 'database://schema-cache/stats':
          const schemaCacheStats = this.schemaCache.getStats();
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(schemaCacheStats, null, 2),
              },
            ],
          };

        default:
          // Handle dynamic table resources
          if (uri.startsWith('database://table/')) {
            return this.handleTableResource(uri);
          }
          throw new Error(`Unknown resource: ${uri}`);
      }
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'execute_query':
          return this.handleExecuteQuery(args);

        case 'natural_language_query':
          return this.handleNaturalLanguageQuery(args);

        case 'analyze_query':
          return this.handleAnalyzeQuery(args);

        case 'explain_query':
          return this.handleExplainQuery(args);

        case 'test_connection':
          return this.handleTestConnection();

        case 'get_database_info':
          return this.handleGetDatabaseInfo();

        case 'analyze_schema':
          return this.handleAnalyzeSchema(args);

        case 'profile_table':
          return this.handleProfileTable(args);

        case 'get_table_relationships':
          return this.handleGetTableRelationships();

        case 'clear_schema_cache':
          return this.handleClearSchemaCache(args);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  // New tool handlers for Phase 3
  private async handleAnalyzeSchema(args: any) {
    const {
      includeViews = true,
      includeProcedures = true,
      includeStatistics = true,
    } = args;

    try {
      // Check cache first
      let schema = await this.schemaCache.getFullSchema(databaseConfig.database!);

      if (!schema) {
        // Analyze schema if not cached
        schema = await this.schemaAnalyzer.analyzeFullSchema({
          includeViews,
          includeProcedures,
          includeStatistics,
          includeIndexes: true,
          includeForeignKeys: true,
        });

        // Cache the result
        await this.schemaCache.setFullSchema(databaseConfig.database!, schema);
      }

      // Update natural language processor with schema context
      this.nlProcessor.setSchemaContext(schema!.tables);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              schema,
              cached: !!await this.schemaCache.getFullSchema(databaseConfig.database!),
              summary: {
                totalTables: schema!.tables.length,
                totalViews: schema!.views.length,
                totalProcedures: schema!.procedures.length,
              },
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Schema analysis failed', { error });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleProfileTable(args: any) {
    const {
      tableName,
      sampleSize = 10000,
      includeTopValues = true,
      analyzeDataQuality = true,
    } = args;

    if (!tableName || typeof tableName !== 'string') {
      throw new Error('tableName is required and must be a string');
    }

    try {
      // Check cache first
      let profile = await this.schemaCache.getTableProfile(databaseConfig.database, tableName);

      if (!profile) {
        // Profile table if not cached
        profile = await this.dataProfiler.profileTable(tableName, {
          sampleSize,
          includeTopValues,
          analyzeDataQuality,
        });

        // Cache the result with shorter TTL for profiles
        await this.schemaCache.setTableProfile(databaseConfig.database, tableName, profile, 2 * 60 * 1000);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              profile,
              cached: !!await this.schemaCache.getTableProfile(databaseConfig.database, tableName),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Table profiling failed', { table: tableName, error });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              tableName,
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleGetTableRelationships() {
    try {
      // Check cache first
      let relationships = await this.schemaCache.getTableRelationships(databaseConfig.database);

      if (!relationships) {
        // Get relationships if not cached
        relationships = await this.schemaAnalyzer.getTableRelationships();

        // Cache the result
        await this.schemaCache.setTableRelationships(databaseConfig.database, relationships);
      }

      const relationshipsObj = Object.fromEntries(relationships);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              relationships: relationshipsObj,
              cached: !!await this.schemaCache.getTableRelationships(databaseConfig.database),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Failed to get table relationships', { error });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleClearSchemaCache(args: any) {
    const { pattern } = args;

    try {
      if (pattern) {
        this.schemaCache.invalidate(pattern);
      } else {
        this.schemaCache.invalidate();
      }

      const stats = this.schemaCache.getStats();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: pattern ? `Cache cleared for pattern: ${pattern}` : 'All cache cleared',
              remainingEntries: stats.totalEntries,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Failed to clear cache', { pattern, error });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            }, null, 2),
          },
        ],
      };
    }
  }

  // Resource helper methods
  private async getSchemaResource() {
    // Check cache first
    let schema = await this.schemaCache.getFullSchema(databaseConfig.database);

    if (!schema) {
      schema = await this.schemaAnalyzer.analyzeFullSchema({
        includeViews: true,
        includeProcedures: true,
        includeStatistics: true,
        includeIndexes: true,
        includeForeignKeys: true,
      });

      await this.schemaCache.setFullSchema(databaseConfig.database, schema);
    }

    return {
      database: databaseConfig.database,
      schema,
      cached: true,
      lastUpdated: new Date().toISOString(),
    };
  }

  private async getRelationshipsResource() {
    let relationships = await this.schemaCache.getTableRelationships(databaseConfig.database);

    if (!relationships) {
      relationships = await this.schemaAnalyzer.getTableRelationships();
      await this.schemaCache.setTableRelationships(databaseConfig.database, relationships);
    }

    return {
      database: databaseConfig.database,
      relationships: Object.fromEntries(relationships),
      cached: true,
    };
  }

  private async getTablesSummaryResource() {
    const summaries: any[] = [];

    // Get basic schema first
    let schema = await this.schemaCache.getFullSchema(databaseConfig.database);
    if (!schema) {
      schema = await this.schemaAnalyzer.analyzeFullSchema();
      await this.schemaCache.setFullSchema(databaseConfig.database, schema);
    }

    // Generate summary for each table
    for (const table of schema.tables) {
      try {
        const summary = await this.dataProfiler.generateTableSummary(table.name);
        summaries.push(summary);
      } catch (error) {
        logger.warn('Failed to generate table summary', { table: table.name, error });
        summaries.push({
          name: table.name,
          rowCount: table.rowCount || 0,
          columnCount: table.columns.length,
          sizeBytes: table.sizeInBytes || 0,
          error: 'Failed to generate summary',
        });
      }
    }

    return {
      database: databaseConfig.database,
      totalTables: summaries.length,
      tables: summaries,
      generatedAt: new Date().toISOString(),
    };
  }

  private async handleTableResource(uri: string) {
    const match = uri.match(/^database:\/\/table\/([^\/]+)(?:\/(.+))?$/);
    if (!match) {
      throw new Error(`Invalid table resource URI: ${uri}`);
    }

    const tableName = match[1]!; // Safe because regex ensures group 1 exists
    const action = match[2]; // 'profile' or undefined

    try {
      if (action === 'profile') {
        // Get table profile
        const dbName = databaseConfig.database!;
        let profile = await this.schemaCache.getTableProfile(dbName, tableName);

        if (!profile) {
          profile = await this.dataProfiler.profileTable(tableName);
          if (profile) {
            await this.schemaCache.setTableProfile(dbName, tableName, profile);
          }
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({
                tableName,
                profile,
                cached: true,
              }, null, 2),
            },
          ],
        };
      } else {
        // Get table info
        const dbName = databaseConfig.database!;
        let tableInfo = await this.schemaCache.getTableInfo(dbName, tableName);

        if (!tableInfo) {
          tableInfo = await this.schemaAnalyzer.analyzeTable(tableName);
          await this.schemaCache.setTableInfo(dbName, tableName, tableInfo);
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({
                tableName,
                tableInfo,
                cached: true,
              }, null, 2),
            },
          ],
        };
      }
    } catch (error) {
      logger.error('Failed to get table resource', { uri, tableName, action, error });

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : 'Unknown error',
              tableName,
              action,
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleExecuteQuery(args: any) {
    const { query, parameters = [], options = {} } = args;

    if (!query || typeof query !== 'string') {
      throw new Error('Query is required and must be a string');
    }

    try {
      const result = await this.queryExecutor.executeQuery(query, parameters, options);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              ...result,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Query execution failed', { query, error });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleNaturalLanguageQuery(args: any) {
    const { question, executeQuery = true } = args;

    if (!question || typeof question !== 'string') {
      throw new Error('Question is required and must be a string');
    }

    try {
      const nlResult = await this.nlProcessor.processNaturalLanguage(question);

      if (!executeQuery) {
        // Just return the generated SQL without executing
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                question,
                generatedSQL: nlResult.sql,
                confidence: nlResult.confidence,
                explanation: nlResult.explanation,
                suggestedImprovements: nlResult.suggestedImprovements,
                executed: false,
              }, null, 2),
            },
          ],
        };
      }

      // Execute the generated SQL
      const queryResult = await this.queryExecutor.executeQuery(nlResult.sql, [], {
        enableAudit: true,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              question,
              generatedSQL: nlResult.sql,
              confidence: nlResult.confidence,
              explanation: nlResult.explanation,
              suggestedImprovements: nlResult.suggestedImprovements,
              queryResult,
              executed: true,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Natural language query failed', { question, error });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              question: question.substring(0, 200),
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleAnalyzeQuery(args: any) {
    const { query } = args;

    if (!query || typeof query !== 'string') {
      throw new Error('Query is required and must be a string');
    }

    try {
      const analysis = await this.queryExecutor.analyzeQuery(query);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: query.substring(0, 200),
              ...analysis,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Query analysis failed', { query, error });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              query: query.substring(0, 100),
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleExplainQuery(args: any) {
    const { query, parameters = [] } = args;

    if (!query || typeof query !== 'string') {
      throw new Error('Query is required and must be a string');
    }

    try {
      const result = await this.queryExecutor.explainQuery(query, parameters);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: query.substring(0, 200),
              executionPlan: result,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Query explain failed', { query, error });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              query: query.substring(0, 100),
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleTestConnection() {
    try {
      const health = await this.database.checkHealth();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(health, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              healthy: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            }, null, 2),
          },
        ],
      };
    }
  }

  private async handleGetDatabaseInfo() {
    try {
      const [rows] = await this.database.query('SELECT DATABASE() as current_database, VERSION() as version, USER() as current_user') as any;
      const dbInfo = rows[0];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              database: dbInfo.current_database,
              version: dbInfo.version,
              user: dbInfo.current_user,
              connectionStatus: this.database.getConnectionStatus(),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            }, null, 2),
          },
        ],
      };
    }
  }

  async start(): Promise<void> {
    try {
      // Connect to database
      await this.database.connect();
      logger.info('Database connected successfully');

      // Start cache warmup in background (don't wait for it)
      this.warmupCache().catch(error => {
        logger.warn('Cache warmup failed', { error });
      });

      // Start MCP server
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      logger.info('MCP server started successfully');

    } catch (error) {
      logger.error('Failed to start server', { error });
      throw error;
    }
  }

  private async warmupCache(): Promise<void> {
    try {
      logger.info('Starting cache warmup');

      // Basic database info
      const dbInfo = await this.schemaAnalyzer.getDatabaseInfo();
      await this.schemaCache.setDatabaseInfo(databaseConfig.database, dbInfo);

      // Basic schema analysis (without heavy operations)
      const schema = await this.schemaAnalyzer.analyzeFullSchema({
        includeViews: false,
        includeProcedures: false,
        includeStatistics: false,
      });

      await this.schemaCache.setFullSchema(databaseConfig.database, schema);
      this.nlProcessor.setSchemaContext(schema.tables);

      // Relationships
      const relationships = await this.schemaAnalyzer.getTableRelationships();
      await this.schemaCache.setTableRelationships(databaseConfig.database, relationships);

      logger.info('Cache warmup completed', {
        tables: schema.tables.length,
        views: schema.views.length,
        procedures: schema.procedures.length,
      });
    } catch (error) {
      logger.warn('Cache warmup failed', { error });
    }
  }

  async stop(): Promise<void> {
    try {
      // Clean up cache
      this.schemaCache.destroy();

      await this.database.disconnect();
      logger.info('Server stopped successfully');
    } catch (error) {
      logger.error('Error stopping server', { error });
      throw error;
    }
  }
}