import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { redactPii } from "./redact.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

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
      // 脅威 I-03 緩和: Cloud Logging へ書き出す前に payload の PII を自動マスキングする
      // (defense-in-depth、CLAUDE.md ルール4 / NFR03)。`formatters.log` は merge 済 payload を
      // 受け取り変換後を返す seam。`msg`/`level`/`time` は本関数を通らない (redact.ts の限界参照)。
      log(payload: Record<string, unknown>) {
        return redactPii(payload) as Record<string, unknown>;
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
 * As defense-in-depth, structured payloads are auto-redacted before they reach
 * Cloud Logging (see redact.ts, threat-model I-03) — but the `msg` string is
 * NOT redacted, so PII interpolated into the message text still leaks. Keep PII
 * out of the message and pass identifiers, not people.
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
