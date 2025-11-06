export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  type?: 'mysql' | 'postgresql' | 'sqlite'; // 어댑터 타입 지정
  ssl?: {
    mode?: 'REQUIRED' | 'PREFERRED' | 'DISABLED';
    ca?: string | undefined;
    cert?: string | undefined;
    key?: string | undefined;
  };
  connectionTimeout?: number;
  acquireTimeout?: number;
  timeout?: number;
  connectionLimit?: number;
  queueLimit?: number;
  idleTimeout?: number;
}

export interface SecurityConfig {
  maxExecutionTime: number;
  maxResultRows: number;
  maxResultSizeMB: number;
  maxQueryLength: number;
  enableQueryLogging: boolean;
  allowedKeywords: string[];
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
}

export interface QueryResult {
  rows: any[];
  fields: any[];
  rowCount: number;
  executionTime: number;
  truncated?: boolean;
  totalRows?: number;
  metadata?: any;
  cached?: boolean;
  cacheAge?: number;
  analysis?: any;
  dryRun?: boolean;
}

export interface SchemaInfo {
  tables: TableInfo[];
  views: ViewInfo[];
  procedures: ProcedureInfo[];
}

export interface TableInfo {
  name: string;
  schema: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  rowCount?: number;
  sizeInBytes?: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: any;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  type: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface ViewInfo {
  name: string;
  schema: string;
  definition: string;
}

export interface ProcedureInfo {
  name: string;
  schema: string;
  parameters: ParameterInfo[];
}

export interface ParameterInfo {
  name: string;
  type: string;
  direction: 'IN' | 'OUT' | 'INOUT';
}

export interface QueryStatistics {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  averageExecutionTime: number;
  slowQueries: number;
  lastQuery: Date;
}

export interface ConnectionStatus {
  isConnected: boolean;
  connectionCount: number;
  activeQueries: number;
  lastConnectionTime: Date;
  uptime: number;
  databaseType: 'mysql' | 'postgresql' | 'sqlite';
}

export interface AuditLog {
  timestamp: Date;
  query: string;
  executionTime: number;
  rowCount: number;
  success: boolean;
  errorMessage?: string;
  userAgent?: string;
  ipAddress?: string;
}