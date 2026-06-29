import { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";
import type { EnvConfig } from "../config/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import { PoolUpsertBody } from "../validators/pools.ts";
import { ValidationError } from "../errors/index.ts";
import { prisma } from "../lib/prisma.ts";
import { jsonSafe } from "../lib/json-safe.ts";
import { getLogger } from "../logger/index.ts";

export function createPoolsRouter(_config: EnvConfig, _signer: SignerAdapter): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", async (c) => {
    const logger = getLogger();
    const pools = await prisma.pool.findMany({ orderBy: { createdAt: "desc" } });
    logger.info({ count: pools.length }, "Listed pools");
    return c.json({ success: true, data: jsonSafe(pools) }, 200);
  });

  router.post("/upsert", async (c) => {
    const logger = getLogger();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = PoolUpsertBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
    }

    const { chainId, address, ...rest } = parsed.data;

    logger.info({ chainId, address }, "Upserting pool");

    const pool = await prisma.pool.upsert({
      where: { chainId_address: { chainId, address } },
      update: rest,
      create: { chainId, address, ...rest },
    });

    logger.info({ poolId: pool.id, address }, "Pool upserted");

    return c.json({ success: true, data: jsonSafe(pool) }, 200);
  });

  return router;
}
