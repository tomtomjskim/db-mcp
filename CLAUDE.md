# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Database MCP Server** - an enterprise-ready Model Context Protocol server that enables AI agents like Claude to interact with multiple databases simultaneously. It supports both MySQL and PostgreSQL databases and provides advanced features like multi-database management, natural language queries, schema analysis, and data profiling.

## Development Commands

### Build and Run
```bash
npm run build        # Compile TypeScript to JavaScript
npm run dev          # Run in development mode with tsx
npm start            # Run the compiled JavaScript server
npm run clean        # Remove dist directory
```

### Testing
```bash
npm test             # Run Jest test suite
npm test:watch       # Run tests in watch mode
```

### Code Quality
```bash
npm run lint         # Run ESLint on TypeScript files
npm run lint:fix     # Auto-fix ESLint issues
npm run format       # Format code with Prettier
```

## Architecture Overview

The codebase follows a layered architecture:

### Core Components
- **MCP Server Layer** (`src/mcp/`): Implements the Model Context Protocol interface
  - `server.ts` - Single database MCP server
  - `multi-database-server.ts` - Multi-database MCP server
- **Database Layer** (`src/database/`): Database abstraction and management
  - `connection-manager.ts` - Manages multiple database connections
  - `connection.ts` - Individual database connection wrapper
  - `query-executor.ts` - SQL query execution with security validation
  - `schema-analyzer.ts` - Database schema introspection
  - `data-profiler.ts` - Data quality analysis and profiling
  - `schema-cache.ts` - Caching layer for schema information
- **Adapter Pattern** (`src/database/adapters/`): Database-specific implementations
  - `factory.ts` - Adapter factory
  - `mysql/` - MySQL-specific implementation
  - `postgresql/` - PostgreSQL-specific implementation
- **Configuration** (`src/config/`): Environment-based configuration management
- **Security** (`src/security/`): SQL validation and security enforcement
- **Types** (`src/types/`): TypeScript type definitions

### Key Features
1. **Multi-Database Support**: Single MCP server can manage multiple databases
2. **Security-First**: Read-only operations with SQL injection protection
3. **Natural Language Processing**: Convert natural language to SQL queries
4. **Schema Analysis**: Automatic database structure introspection
5. **Data Profiling**: Data quality analysis and column profiling
6. **Intelligent Caching**: Schema and query result caching for performance

## Configuration

The system supports multiple configuration approaches:

### Single Database via Environment Variables
```env
DB_TYPE=mysql|postgresql
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_DB=database_name
MYSQL_USER=username
MYSQL_PASSWORD=password
```

### Multi-Database via Config File
Create `db-config.json` with connection definitions:
```json
{
  "connections": {
    "db-name": {
      "type": "mysql",
      "host": "localhost",
      "port": 3306,
      "user": "username",
      "password": "password",
      "database": "db_name"
    }
  },
  "defaultConnection": "db-name"
}
```

## Database Adapters

The adapter pattern allows supporting multiple database types:

- **MySQL Adapter**: Uses `mysql2` with connection pooling
- **PostgreSQL Adapter**: Uses `pg` with connection pooling
- **Future**: SQLite, ClickHouse planned

Each adapter implements:
- Connection management
- Schema analysis
- Data profiling
- Query execution

## MCP Interface

The server provides:

### Tools (executable functions)
- `execute_query` - Execute SQL queries with validation
- `execute_natural_language_query` - Convert natural language to SQL
- `analyze_schema` - Analyze database schema
- `profile_table` - Analyze table data quality
- `get_table_relationships` - Extract table relationships

### Resources (readable data)
- `database://schema` - Complete schema information
- `database://table/{name}` - Individual table details
- `database://connections` - Multi-database connection status

## Security Features

- **Read-only operations**: Only SELECT, SHOW, DESCRIBE allowed
- **SQL injection protection**: Query parsing and validation
- **Execution limits**: Timeout, row count, and size limits
- **Query logging**: All executed queries are logged for audit

## Testing Strategy

- Unit tests in `src/__tests__/`
- Jest configuration supports ES modules
- Coverage reporting with lcov and HTML formats
- Test database adapters and core functionality

## Development Patterns

### Error Handling
- Comprehensive error catching in all database operations
- Structured logging with Winston
- Graceful degradation for connection failures

### Type Safety
- Strict TypeScript configuration
- Zod schemas for runtime validation
- Comprehensive type definitions

### Performance
- Connection pooling for all database types
- Schema caching with TTL
- Query result caching
- Lazy loading of database metadata

## Common Development Tasks

When adding a new database type:
1. Create adapter in `src/database/adapters/{type}/`
2. Implement the base adapter interface
3. Add to factory in `adapters/factory.ts`
4. Update configuration types
5. Add tests for the new adapter

When adding new MCP tools:
1. Define tool schema in server setup
2. Implement tool handler in server class
3. Add security validation if needed
4. Update documentation and tests