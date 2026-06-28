import pino from "pino";

let loggerInstance: pino.Logger | null = null;

/**
 * Get or create the application logger.
 * Uses Pino with structured JSON output.
 */
export function createLogger(level?: string): pino.Logger {
  if (loggerInstance) {
    return loggerInstance;
  }

  const logLevel = level ?? process.env["LOG_LEVEL"] ?? "info";

  loggerInstance = pino({
    level: logLevel,
    transport:
      process.env["NODE_ENV"] === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname",
            },
          },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-signature']",
        "body.privateKey",
        "privateKey",
        "secret",
        "password",
        "token",
        "key",
      ],
      censor: "[REDACTED]",
    },
  });

  return loggerInstance;
}

/**
 * Returns the existing logger instance.
 * Throws if called before createLogger().
 */
export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    throw new Error("Logger not initialized. Call createLogger() first.");
  }
  return loggerInstance;
}

/**
 * Reset the logger instance (useful for testing).
 */
export function resetLogger(): void {
  loggerInstance = null;
}
