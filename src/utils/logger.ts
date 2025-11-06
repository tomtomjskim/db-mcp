import winston from 'winston';
import { serverConfig } from '../config/index.js';

const { combine, timestamp, errors, json, printf, colorize } = winston.format;

const customFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  if (stack) {
    return `${timestamp} [${level}]: ${message}\n${stack}`;
  }

  const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
  return `${timestamp} [${level}]: ${message}${metaStr}`;
});

const logger = winston.createLogger({
  level: serverConfig.logLevel,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    serverConfig.isDevelopment ? combine(colorize(), customFormat) : json()
  ),
  defaultMeta: { service: serverConfig.name },
  transports: [
    new winston.transports.Stream({
      stream: process.stderr,
      silent: process.env.NODE_ENV === 'test',
    }),
  ],
});

// Add file logging in production
if (serverConfig.isProduction) {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );

  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );
}

export { logger };

// Query logging utility
export const logQuery = (query: string, executionTime: number, rowCount: number, success: boolean, error?: string) => {
  const logData = {
    type: 'query',
    query: query.replace(/\s+/g, ' ').trim(),
    executionTime,
    rowCount,
    success,
    error,
  };

  if (success) {
    logger.info('Query executed successfully', logData);
  } else {
    logger.error('Query execution failed', logData);
  }
};

// Security logging utility
export const logSecurityEvent = (event: string, details: any) => {
  logger.warn('Security event', {
    type: 'security',
    event,
    ...details,
  });
};

// Connection logging utility
export const logConnection = (event: 'connect' | 'disconnect' | 'error', details?: any) => {
  logger.info(`Database ${event}`, {
    type: 'connection',
    event,
    ...details,
  });
};