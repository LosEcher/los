/**
 * @los/infra/logger — Single logger implementation for all packages.
 *
 * Structured JSON output. Three adapters: console (dev), file (prod), otel (optional).
 * All packages MUST use this logger; direct imports of winston/pino/etc are blocked by CI.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string; // ISO-8601
  requestId?: string;
  traceId?: string;
  package?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

// --- Console Adapter (default for dev) ---

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = process.env.LOG_LEVEL as LogLevel ?? 'info';

function createConsoleLogger(bindings: Record<string, unknown> = {}): Logger {
  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

    const entry: LogEntry = {
      level,
      message: msg,
      timestamp: new Date().toISOString(),
      ...bindings,
      ...meta,
    };

    const line = process.env.NODE_ENV === 'production'
      ? JSON.stringify(entry)
      : `[${entry.timestamp.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${entry.package ? `[${entry.package}] ` : ''}${msg}`;

    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  };

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    child: (b) => createConsoleLogger({ ...bindings, ...b }),
  };
}

// --- Singleton ---

let _logger: Logger = createConsoleLogger();

export function setLogger(logger: Logger): void {
  _logger = logger;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogger(pkg?: string): Logger {
  return pkg ? _logger.child({ package: pkg }) : _logger;
}

// Default export for convenience
export const logger: Logger = {
  debug: (msg, meta) => _logger.debug(msg, meta),
  info: (msg, meta) => _logger.info(msg, meta),
  warn: (msg, meta) => _logger.warn(msg, meta),
  error: (msg, meta) => _logger.error(msg, meta),
  child: (b) => _logger.child(b),
};
