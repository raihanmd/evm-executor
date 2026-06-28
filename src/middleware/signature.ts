import type { MiddlewareHandler } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { EnvConfig } from "../config/index.ts";
import { AuthError } from "../errors/index.ts";
import { getLogger } from "../logger/index.ts";

const TIMESTAMP_AGE_MS = 30_000;
const CLOCK_DRIFT_MS = 5_000;

function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * HMAC request signature verification middleware.
 *
 * Layer 3 — Verifies X-Signature header using HMAC-SHA256 of
 * (timestamp + rawBody) with the shared secret.
 *
 * Layer 4 — Rejects timestamps older than 30s or from the future
 * (with 5s clock drift tolerance) to prevent replay attacks.
 */
export function signatureMiddleware(config: EnvConfig): MiddlewareHandler {
  return async (c, next) => {
    const logger = getLogger();

    const timestampHeader = c.req.header("X-Timestamp");
    const signatureHeader = c.req.header("X-Signature");

    if (!timestampHeader || !signatureHeader) {
      throw new AuthError("Missing X-Timestamp or X-Signature header");
    }

    const timestamp = Number.parseInt(timestampHeader, 10);
    if (Number.isNaN(timestamp)) {
      throw new AuthError("Invalid X-Timestamp: must be a Unix timestamp in milliseconds");
    }

    const now = Date.now();
    const age = now - timestamp;

    // Reject timestamps older than 30 seconds
    if (age > TIMESTAMP_AGE_MS) {
      logger.warn({ age, timestamp, now }, "Replay protection: timestamp too old");
      throw new AuthError("Request expired: timestamp is too old");
    }

    // Reject future timestamps (allow 5s clock drift)
    if (timestamp > now + CLOCK_DRIFT_MS) {
      logger.warn(
        { timestamp, now, drift: timestamp - now },
        "Replay protection: timestamp in the future",
      );
      throw new AuthError("Invalid timestamp: request is from the future");
    }

    // Read raw body for signature verification
    const rawBody = await c.req.text();

    const expectedSignature = createHmac("sha256", config.hmacSecret)
      .update(timestampHeader + rawBody)
      .digest("hex");

    if (!safeCompare(signatureHeader, expectedSignature)) {
      logger.warn("Request signature mismatch");
      throw new AuthError("Invalid request signature");
    }

    // Re-parse the body as JSON for downstream handlers
    const parsedBody = JSON.parse(rawBody);
    c.set("body", parsedBody);

    await next();
  };
}
