import type { MiddlewareHandler } from "hono";
import type { EnvConfig } from "../config/index.ts";
import { AuthError } from "../errors/index.ts";

/**
 * API Key authentication middleware.
 *
 * Layer 2 — Rejects requests without a valid Authorization: Bearer <key> header.
 * Runs before expensive operations (rate limiting is applied after auth).
 */
export function authMiddleware(config: EnvConfig): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization");

    if (!header || !header.startsWith("Bearer ")) {
      throw new AuthError("Missing or invalid Authorization header");
    }

    const token = header.slice("Bearer ".length).trim();

    if (token !== config.apiKey) {
      throw new AuthError("Invalid API key");
    }

    await next();
  };
}
