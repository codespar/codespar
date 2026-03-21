/**
 * Structured logger — zero dependencies.
 *
 * Outputs JSON lines in production for log aggregators (Datadog, ELK, etc.)
 * and pretty-prints with [module] prefix in development.
 *
 * Usage:
 *   const log = createLogger("webhook-server");
 *   log.info("Listening", { port: 3000 });
 *   log.error("Handler failed", { error: err.message, route: "/webhooks/github" });
 *
 * Environment:
 *   LOG_LEVEL  — minimum level to emit: "debug" | "info" | "warn" | "error" (default: "info")
 *   NODE_ENV   — when "production", outputs JSON; otherwise pretty-prints
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || "info"];
const IS_PRODUCTION = process.env.NODE_ENV === "production";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= MIN_LEVEL;
}

function formatEntry(entry: LogEntry): string {
  if (IS_PRODUCTION) {
    return JSON.stringify(entry);
  }

  // Pretty format for development — matches the existing [module] prefix convention
  const { level: _level, module, message, timestamp: _ts, ...extra } = entry;
  const extraStr =
    Object.keys(extra).length > 0 ? " " + JSON.stringify(extra) : "";
  return `[${module}] ${message}${extraStr}`;
}

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
  function log(
    level: LogLevel,
    method: (...args: unknown[]) => void,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!shouldLog(level)) return;
    const entry: LogEntry = {
      level,
      module,
      message,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    method(formatEntry(entry));
  }

  return {
    debug(message: string, extra?: Record<string, unknown>) {
      log("debug", console.debug, message, extra);
    },
    info(message: string, extra?: Record<string, unknown>) {
      log("info", console.log, message, extra);
    },
    warn(message: string, extra?: Record<string, unknown>) {
      log("warn", console.warn, message, extra);
    },
    error(message: string, extra?: Record<string, unknown>) {
      log("error", console.error, message, extra);
    },
  };
}
