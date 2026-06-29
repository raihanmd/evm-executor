import type { MiddlewareHandler } from "hono";
import { ConflictError } from "../errors/index.ts";
import { getLogger } from "../logger/index.ts";

/**
 * Simple in-memory idempotency store.
 *
 * Layer 5 — If an X-Request-ID header is present and the request
 * has already been processed, returns 409 Conflict.
 *
 * Entries expire after 1 hour to prevent unbounded memory growth.
 */
const processedRequests = new Map<string, number>();

const EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Clean up expired entries every 10 minutes
const CLEANUP_INTERVAL = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedRequests) {
    if (now - timestamp > EXPIRY_MS) {
      processedRequests.delete(key);
    }
  }
}, 10 * 60 * 1000);

// Allow the process to exit cleanly
if (CLEANUP_INTERVAL.unref) {
  CLEANUP_INTERVAL.unref();
}

/**
 * Idempotency middleware.
 *
 * Ensures the same request is never broadcast twice.
 */
export function idempotencyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = c.req.header("X-Request-ID");

    if (!requestId || requestId.trim() === "") {
      await next();
      return;
    }

    const logger = getLogger();
    const key = `idempotent:${requestId}`;

    const existing = processedRequests.get(key);
    if (existing !== undefined) {
      logger.warn({ requestId }, "Duplicate request detected");
      throw new ConflictError(
        `Request with X-Request-ID '${requestId}' has already been processed`,
      );
    }

    // Mark as processed before the actual execution
    // (this means duplicate detection happens even if the first request fails)
    processedRequests.set(key, Date.now());

    // M-03: Do NOT remove the idempotency lock on failure.
    // If broadcast timed out after the tx was already mined, a retry would
    // use a new nonce and duplicate the tx. The caller must use a new
    // X-Request-ID for retries.
    await next();
  };
}
