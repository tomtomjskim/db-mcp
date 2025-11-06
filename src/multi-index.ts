#!/usr/bin/env node

import { MultiDatabaseMCPServer } from './mcp/multi-database-server.js';
import { logger } from './utils/logger.js';

async function main() {
  const server = new MultiDatabaseMCPServer();

  // Handle graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await server.stop();
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { reason, promise });
    process.exit(1);
  });

  try {
    await server.start();
    logger.info('Multi-Database MCP Server is running...');
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Only run if this file is being executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error('Fatal error', { error });
    process.exit(1);
  });
}
