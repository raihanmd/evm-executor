import type { MiddlewareHandler } from "hono";
import type { EnvConfig } from "../config/index.ts";
import { ValidationError } from "../errors/index.ts";

/**
 * Payload size limit middleware.
 *
 * Layer 11 — Rejects unusually large request bodies before any parsing.
 */
export function payloadSizeMiddleware(config: EnvConfig): MiddlewareHandler {
  const maxSize = config.maxBodySize;

  return async (c, next) => {
    const contentLength = c.req.header("Content-Length");

    if (contentLength) {
      const length = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(length) && length > maxSize) {
        throw new ValidationError(
          `Request body too large: ${length} bytes exceeds limit of ${maxSize} bytes`,
        );
      }
    }

    await next();
  };
}
