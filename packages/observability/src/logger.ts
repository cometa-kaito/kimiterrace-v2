import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * pino level label → Cloud Logging `severity` mapping.
 *
 * Cloud Logging recognises a top-level `severity` field on each log entry
 * and uses it for filtering / alerting. pino emits a numeric `level` field
 * by default, so we translate the symbolic label.
 *
 * https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#logseverity
 */
const SEVERITY_MAP: Readonly<Record<string, string>> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

export interface CreateLoggerOptions {
  /** Minimum level to emit. Defaults to `info` in production, `debug` otherwise. */
  level?: LogLevel;
  /**
   * Optional pino destination. Primarily used by tests to capture output;
   * leave undefined in production so pino writes JSON to stdout (which
   * Cloud Run forwards to Cloud Logging automatically).
   */
  destination?: DestinationStream;
}

/**
 * Build the pino options for a given environment. Exported so tests can
 * assert on the formatter behaviour without going through stdout.
 */
export function buildLoggerOptions(name: string, opts: CreateLoggerOptions = {}): LoggerOptions {
  const isProduction = process.env.NODE_ENV === "production";
  const level = opts.level ?? (isProduction ? "info" : "debug");

  const base: LoggerOptions = {
    name,
    level,
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { severity: SEVERITY_MAP[label] ?? "DEFAULT", level: label };
      },
    },
  };

  if (isProduction) {
    return base;
  }

  return {
    ...base,
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname,service",
      },
    },
  };
}

/**
 * Create a pino-based logger.
 *
 * - In production (`NODE_ENV=production`) emits single-line JSON to stdout
 *   with a `severity` field mapped for Cloud Logging.
 * - In development uses `pino-pretty` for human-readable output.
 *
 * NOTE (CLAUDE.md rule 4): do not pass raw PII (student names, addresses,
 * phone numbers, guardian names) through any log call. Use stable IDs.
 */
export function createLogger(name: string, opts: CreateLoggerOptions = {}): Logger {
  const options = buildLoggerOptions(name, opts);
  if (opts.destination) {
    // When a destination is supplied (typically tests) we skip the
    // pino-pretty transport so output is deterministic JSON.
    const { transport: _transport, ...rest } = options;
    return pino(rest, opts.destination);
  }
  return pino(options);
}
