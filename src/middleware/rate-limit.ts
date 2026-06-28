import type { MiddlewareHandler } from "hono";
import type { EnvConfig } from "../config/index.ts";
import { RateLimitError } from "../errors/index.ts";

/**
 * Simple in-memory sliding window rate limiter.
 *
 * Layer 12 — Applied after authentication to protect the endpoint from abuse.
 */
const requestLog = new Map<string, number[]>();

function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, timestamps] of requestLog) {
    const valid = timestamps.filter((ts) => now - ts < 60_000);
    if (valid.length === 0) {
      requestLog.delete(key);
    } else {
      requestLog.set(key, valid);
    }
  }
}

// Run cleanup every minute
const CLEANUP_INTERVAL = setInterval(cleanupExpired, 60_000);
if (CLEANUP_INTERVAL.unref) {
  CLEANUP_INTERVAL.unref();
}

export function rateLimitMiddleware(config: EnvConfig): MiddlewareHandler {
  const maxRequests = config.rateLimitMax;
  const windowMs = config.rateLimitWindowMs;

  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")
      ?? c.req.header("x-real-ip")
      ?? "unknown";
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = requestLog.get(ip) ?? [];
    timestamps = timestamps.filter((ts) => ts > windowStart);
    timestamps.push(now);
    requestLog.set(ip, timestamps);

    if (timestamps.length > maxRequests) {
      throw new RateLimitError(
        `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000}s`,
      );
    }

    await next();
  };
}
