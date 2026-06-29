import { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";
import type { EnvConfig } from "../config/index.ts";
import { createLogger } from "../logger/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { idempotencyMiddleware } from "../middleware/idempotency.ts";
import { rateLimitMiddleware } from "../middleware/rate-limit.ts";
import { payloadSizeMiddleware } from "../middleware/payload-size.ts";
import { errorHandler } from "./error-handler.ts";
import { createEvmRoutes } from "../routes/evm.ts";
import { createPositionsRouter } from "../routes/positions.ts";
import { createPoolsRouter } from "../routes/pools.ts";
import { createTxLogRouter } from "../routes/tx-log.ts";
import type { SignerAdapter } from "../signer/types.ts";

export function createApp(config: EnvConfig, signer: SignerAdapter): Hono<AppEnv> {
  const logger = createLogger(config.logLevel);

  const app = new Hono<AppEnv>();

  // Global error handler (must be first)
  app.onError(errorHandler);

  // Layer 1 — Internal service only: this is enforced by deployment (private network)
  // Layer 11 — Payload size check (before parsing)
  app.use(payloadSizeMiddleware(config));

  // Layer 2 — API Authentication (before expensive operations)
  app.use(authMiddleware(config));

  // Layer 12 — Rate Limiting
  app.use(rateLimitMiddleware(config));

  // Layer 5 — Idempotency
  app.use(idempotencyMiddleware());

  // Routes — EVM
  const evmRouter = createEvmRoutes(config, signer);
  app.route("/v1/evm", evmRouter);

  // Routes — LP Position Tracking
  const positionsRouter = createPositionsRouter(config, signer);
  app.route("/v1/positions", positionsRouter);

  const poolsRouter = createPoolsRouter(config, signer);
  app.route("/v1/pools", poolsRouter);

  const txLogRouter = createTxLogRouter(config, signer);
  app.route("/v1/tx-log", txLogRouter);

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  logger.info("Application initialized");
  return app;
}
