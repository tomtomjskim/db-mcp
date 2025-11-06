import { TableInfo, ColumnInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface NLQueryResult {
  sql: string;
  confidence: number;
  explanation: string;
  suggestedImprovements?: string[];
  usedTables: string[];
  usedColumns: string[];
}

export interface QueryPattern {
  pattern: RegExp;
  sqlTemplate: string;
  description: string;
  confidence: number;
}

export interface SchemaContext {
  tables: TableInfo[];
  relationships: Map<string, string[]>;
  commonColumns: string[];
}

export class NaturalLanguageProcessor {
  private schemaContext: SchemaContext;
  private queryPatterns: QueryPattern[] = [];

  constructor() {
    this.schemaContext = {
      tables: [],
      relationships: new Map(),
      commonColumns: [],
    };
    this.initializeQueryPatterns();
  }

  setSchemaContext(tables: TableInfo[]): void {
    this.schemaContext.tables = tables;
    this.analyzeRelationships();
    this.extractCommonColumns();
    logger.info('Schema context updated', {
      tableCount: tables.length,
      relationshipCount: this.schemaContext.relationships.size,
    });
  }

  async processNaturalLanguage(question: string): Promise<NLQueryResult> {
    try {
      // Normalize the question
      const normalizedQuestion = this.normalizeQuestion(question);

      // Extract entities and intent
      const entities = this.extractEntities(normalizedQuestion);
      const intent = this.detectIntent(normalizedQuestion);

      // Find matching patterns
      const matchedPatterns = this.findMatchingPatterns(normalizedQuestion);

      if (matchedPatterns.length === 0) {
        throw new Error('Unable to understand the question. Try rephrasing with more specific table or column names.');
      }

      // Generate SQL using the best matching pattern
      const bestPattern = matchedPatterns[0]!;
      const sql = this.generateSQL(normalizedQuestion, bestPattern, entities);

      // Validate and improve the generated SQL
      const improvements = this.suggestImprovements(sql, entities);

      return {
        sql,
        confidence: bestPattern.confidence,
        explanation: this.generateExplanation(sql, bestPattern),
        suggestedImprovements: improvements,
        usedTables: entities.tables,
        usedColumns: entities.columns,
      };

    } catch (error) {
      logger.error('Natural language processing failed', { question, error });
      throw new Error(`Failed to process natural language query: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private initializeQueryPatterns(): void {
    this.queryPatterns = [
      // Count queries
      {
        pattern: /(?:how many|count|total number of)\\s+(.+?)(?:\\s+(?:are there|exist|in)\\s+(.+))?/i,
        sqlTemplate: 'SELECT COUNT(*) as count FROM {table} {where}',
        description: 'Count records in a table',
        confidence: 0.9,
      },

      // Top/bottom queries
      {
        pattern: /(?:top|best|highest|largest|biggest)\\s+(\\d+)?\\s*(.+?)\\s+(?:by|with|having)\\s+(.+)/i,
        sqlTemplate: 'SELECT * FROM {table} ORDER BY {column} DESC LIMIT {limit}',
        description: 'Get top records ordered by a column',
        confidence: 0.85,
      },

      {
        pattern: /(?:bottom|worst|lowest|smallest)\\s+(\\d+)?\\s*(.+?)\\s+(?:by|with|having)\\s+(.+)/i,
        sqlTemplate: 'SELECT * FROM {table} ORDER BY {column} ASC LIMIT {limit}',
        description: 'Get bottom records ordered by a column',
        confidence: 0.85,
      },

      // Average/sum queries
      {
        pattern: /(?:average|avg|mean)\\s+(.+?)\\s+(?:of|for|in)\\s+(.+)/i,
        sqlTemplate: 'SELECT AVG({column}) as average FROM {table} {where}',
        description: 'Calculate average value',
        confidence: 0.8,
      },

      {
        pattern: /(?:sum|total)\\s+(?:of\\s+)?(.+?)\\s+(?:for|in|from)\\s+(.+)/i,
        sqlTemplate: 'SELECT SUM({column}) as total FROM {table} {where}',
        description: 'Calculate sum of values',
        confidence: 0.8,
      },

      // List/show queries
      {
        pattern: /(?:list|show|display|get)\\s+(?:all\\s+)?(.+?)(?:\\s+(?:from|in)\\s+(.+?))?(?:\\s+where\\s+(.+))?/i,
        sqlTemplate: 'SELECT * FROM {table} {where} {limit}',
        description: 'List records from a table',
        confidence: 0.7,
      },

      // Specific value queries
      {
        pattern: /(?:what is|what are|find)\\s+(.+?)\\s+(?:of|for|where)\\s+(.+)/i,
        sqlTemplate: 'SELECT {column} FROM {table} WHERE {condition}',
        description: 'Find specific values',
        confidence: 0.75,
      },

      // Comparison queries
      {
        pattern: /(.+?)\\s+(?:greater than|more than|above)\\s+(\\d+|\\w+)/i,
        sqlTemplate: 'SELECT * FROM {table} WHERE {column} > {value}',
        description: 'Find records greater than a value',
        confidence: 0.8,
      },

      {
        pattern: /(.+?)\\s+(?:less than|below|under)\\s+(\\d+|\\w+)/i,
        sqlTemplate: 'SELECT * FROM {table} WHERE {column} < {value}',
        description: 'Find records less than a value',
        confidence: 0.8,
      },

      // Date range queries
      {
        pattern: /(.+?)\\s+(?:between|from)\\s+(.+?)\\s+(?:and|to)\\s+(.+)/i,
        sqlTemplate: 'SELECT * FROM {table} WHERE {column} BETWEEN {start} AND {end}',
        description: 'Find records in a date/value range',
        confidence: 0.85,
      },

      // Group by queries
      {
        pattern: /(.+?)\\s+(?:by|per|grouped by)\\s+(.+)/i,
        sqlTemplate: 'SELECT {groupColumn}, {aggregateFunction}({column}) FROM {table} GROUP BY {groupColumn}',
        description: 'Group and aggregate data',
        confidence: 0.8,
      },
    ];
  }

  private normalizeQuestion(question: string): string {
    return question
      .toLowerCase()
      .trim()
      .replace(/[?!.]+$/, '') // Remove ending punctuation
      .replace(/\\s+/g, ' '); // Normalize whitespace
  }

  private extractEntities(question: string): {
    tables: string[];
    columns: string[];
    values: string[];
    numbers: number[];
  } {
    const entities = {
      tables: [] as string[],
      columns: [] as string[],
      values: [] as string[],
      numbers: [] as number[],
    };

    // Extract tables by matching against known table names
    for (const table of this.schemaContext.tables) {
      const tableNameRegex = new RegExp(`\\\\b${table.name}\\\\b`, 'i');
      if (tableNameRegex.test(question)) {
        entities.tables.push(table.name);
      }

      // Also check for plural forms
      const pluralRegex = new RegExp(`\\\\b${table.name}s?\\\\b`, 'i');
      if (pluralRegex.test(question) && !entities.tables.includes(table.name)) {
        entities.tables.push(table.name);
      }
    }

    // Extract columns by matching against known column names
    for (const table of this.schemaContext.tables) {
      for (const column of table.columns) {
        const columnRegex = new RegExp(`\\\\b${column.name}\\\\b`, 'i');
        if (columnRegex.test(question)) {
          entities.columns.push(`${table.name}.${column.name}`);
        }
      }
    }

    // Extract numbers
    const numberMatches = question.match(/\\b\\d+(?:\\.\\d+)?\\b/g);
    if (numberMatches) {
      entities.numbers = numberMatches.map(Number);
    }

    // Extract quoted values
    const valueMatches = question.match(/'([^']+)'/g);
    if (valueMatches) {
      entities.values = valueMatches.map(match => match.slice(1, -1));
    }

    return entities;
  }

  private detectIntent(question: string): string {
    const intents = [
      { keywords: ['count', 'how many', 'total number'], intent: 'count' },
      { keywords: ['top', 'best', 'highest', 'largest'], intent: 'top' },
      { keywords: ['bottom', 'worst', 'lowest', 'smallest'], intent: 'bottom' },
      { keywords: ['average', 'avg', 'mean'], intent: 'average' },
      { keywords: ['sum', 'total'], intent: 'sum' },
      { keywords: ['list', 'show', 'display', 'get'], intent: 'list' },
      { keywords: ['find', 'what is', 'what are'], intent: 'find' },
      { keywords: ['between', 'from', 'to'], intent: 'range' },
      { keywords: ['group', 'by', 'per'], intent: 'group' },
    ];

    for (const { keywords, intent } of intents) {
      if (keywords.some(keyword => question.includes(keyword))) {
        return intent;
      }
    }

    return 'unknown';
  }

  private findMatchingPatterns(question: string): QueryPattern[] {
    const matches: (QueryPattern & { matchScore: number })[] = [];

    for (const pattern of this.queryPatterns) {
      const match = question.match(pattern.pattern);
      if (match) {
        matches.push({
          ...pattern,
          matchScore: match[0].length / question.length, // Score based on match coverage
        });
      }
    }

    // Sort by confidence and match score
    return matches
      .sort((a, b) => {
        const scoreA = a.confidence * a.matchScore;
        const scoreB = b.confidence * b.matchScore;
        return scoreB - scoreA;
      })
      .slice(0, 3); // Return top 3 matches
  }

  private generateSQL(
    question: string,
    pattern: QueryPattern,
    entities: any
  ): string {
    let sql = pattern.sqlTemplate;

    // Replace placeholders with actual values
    sql = this.replacePlaceholders(sql, question, entities);

    // Add default LIMIT if not specified
    if (!sql.includes('LIMIT') && !sql.includes('COUNT')) {
      sql += ' LIMIT 100';
    }

    return sql;
  }

  private replacePlaceholders(
    template: string,
    question: string,
    entities: any
  ): string {
    let sql = template;

    // Replace {table}
    if (entities.tables.length > 0) {
      sql = sql.replace(/{table}/g, entities.tables[0]);
    } else {
      // Try to infer table from context
      const inferredTable = this.inferTableFromQuestion(question);
      sql = sql.replace(/{table}/g, inferredTable);
    }

    // Replace {column}
    if (entities.columns.length > 0) {
      const columnName = entities.columns[0].split('.')[1];
      sql = sql.replace(/{column}/g, columnName);
    } else {
      // Try to infer column from context
      const inferredColumn = this.inferColumnFromQuestion(question);
      sql = sql.replace(/{column}/g, inferredColumn);
    }

    // Replace {limit}
    const limit = entities.numbers.find((n: number) => n <= 1000) || 10;
    sql = sql.replace(/{limit}/g, limit.toString());

    // Replace {where}
    const whereClause = this.generateWhereClause(question, entities);
    sql = sql.replace(/{where}/g, whereClause);

    // Replace {value}
    if (entities.numbers.length > 0) {
      sql = sql.replace(/{value}/g, entities.numbers[0].toString());
    }

    return sql.trim();
  }

  private inferTableFromQuestion(question: string): string {
    // Common table name patterns
    const tablePatterns = [
      { keywords: ['user', 'customer', 'account'], table: 'users' },
      { keywords: ['order', 'purchase', 'transaction'], table: 'orders' },
      { keywords: ['product', 'item', 'goods'], table: 'products' },
      { keywords: ['payment', 'billing', 'invoice'], table: 'payments' },
      { keywords: ['employee', 'staff', 'worker'], table: 'employees' },
    ];

    for (const { keywords, table } of tablePatterns) {
      if (keywords.some(keyword => question.includes(keyword))) {
        return table;
      }
    }

    // Default to first available table
    return this.schemaContext.tables[0]?.name || 'table_name';
  }

  private inferColumnFromQuestion(question: string): string {
    // Common column patterns
    const columnPatterns = [
      { keywords: ['price', 'cost', 'amount'], column: 'price' },
      { keywords: ['name', 'title'], column: 'name' },
      { keywords: ['date', 'time', 'created'], column: 'created_at' },
      { keywords: ['count', 'quantity', 'number'], column: 'quantity' },
      { keywords: ['email', 'mail'], column: 'email' },
      { keywords: ['id', 'identifier'], column: 'id' },
    ];

    for (const { keywords, column } of columnPatterns) {
      if (keywords.some(keyword => question.includes(keyword))) {
        return column;
      }
    }

    return '*';
  }

  private generateWhereClause(question: string, entities: any): string {
    const conditions: string[] = [];

    // Add value-based conditions
    if (entities.values.length > 0) {
      conditions.push(`column_name = '${entities.values[0]}'`);
    }

    // Add date-based conditions
    if (question.includes('today')) {
      conditions.push('DATE(created_at) = CURDATE()');
    } else if (question.includes('this week')) {
      conditions.push('WEEK(created_at) = WEEK(NOW())');
    } else if (question.includes('this month')) {
      conditions.push('MONTH(created_at) = MONTH(NOW())');
    }

    return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  }

  private generateExplanation(sql: string, pattern: QueryPattern): string {
    return `Generated SQL query based on "${pattern.description}". The query: ${sql}`;
  }

  private suggestImprovements(sql: string, entities: any): string[] {
    const suggestions: string[] = [];

    if (!sql.includes('LIMIT') && !sql.includes('COUNT')) {
      suggestions.push('Consider adding a LIMIT clause to prevent large result sets');
    }

    if (sql.includes('SELECT *') && entities.columns.length > 0) {
      suggestions.push('Consider selecting specific columns instead of * for better performance');
    }

    if (!sql.includes('WHERE') && !sql.includes('LIMIT')) {
      suggestions.push('Consider adding WHERE conditions to filter results');
    }

    return suggestions;
  }

  private analyzeRelationships(): void {
    this.schemaContext.relationships.clear();

    for (const table of this.schemaContext.tables) {
      const relatedTables: string[] = [];

      for (const fk of table.foreignKeys || []) {
        relatedTables.push(fk.referencedTable);
      }

      this.schemaContext.relationships.set(table.name, relatedTables);
    }
  }

  private extractCommonColumns(): void {
    const columnCounts = new Map<string, number>();

    for (const table of this.schemaContext.tables) {
      for (const column of table.columns) {
        columnCounts.set(column.name, (columnCounts.get(column.name) || 0) + 1);
      }
    }

    this.schemaContext.commonColumns = Array.from(columnCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([column]) => column);
  }

  // Public utility methods
  getSupportedPatterns(): string[] {
    return this.queryPatterns.map(p => p.description);
  }

  getSchemaInfo(): SchemaContext {
    return this.schemaContext;
  }
}