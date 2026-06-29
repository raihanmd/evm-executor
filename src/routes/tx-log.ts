import { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";
import type { EnvConfig } from "../config/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import { TxLogBody } from "../validators/tx-log.ts";
import { ValidationError } from "../errors/index.ts";
import { prisma } from "../lib/prisma.ts";
import { jsonSafe } from "../lib/json-safe.ts";
import { getLogger } from "../logger/index.ts";

export function createTxLogRouter(
  _config: EnvConfig,
  _signer: SignerAdapter,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/", async (c) => {
    const logger = getLogger();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = TxLogBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
    }

    const {
      positionId,
      txHash,
      action,
      status,
      blockNumber,
      gasUsed,
      gasPriceWei,
      gasCostBnb,
      gasCostUsd,
    } = parsed.data;

    logger.info({ txHash, action, status }, "Logging transaction");

    const txLog = await prisma.txLog.upsert({
      where: { txHash },
      update: {
        action,
        status,
        blockNumber: BigInt(blockNumber),
        gasUsed: BigInt(gasUsed ?? 0n),
        gasPriceWei,
        gasCostBnb,
        gasCostUsd,
        positionId: positionId ?? undefined,
      },
      create: {
        positionId: positionId ?? undefined,
        txHash,
        action,
        status,
        blockNumber: BigInt(blockNumber),
        gasUsed: BigInt(gasUsed ?? 0n),
        gasPriceWei,
        gasCostBnb,
        gasCostUsd,
      },
    });

    logger.info({ txHash, id: txLog.id }, "Transaction logged");

    return c.json({ success: true, data: jsonSafe(txLog) }, 200);
  });

  return router;
}
