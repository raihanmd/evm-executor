import { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";
import type { EnvConfig } from "../config/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import {
  FromMintBody,
  PositionCheckBody,
  RebalanceBody,
  ExitBody,
  GetPositionsQuery,
  GetPositionQuery,
  RecordUncollectedFeeBody,
} from "../validators/positions.ts";
import { ValidationError, NotFoundError } from "../errors/index.ts";
import { prisma } from "../lib/prisma.ts";
import { jsonSafe } from "../lib/json-safe.ts";
import { getLogger } from "../logger/index.ts";
import type { Prisma } from "@prisma/client";

export function createPositionsRouter(
  _config: EnvConfig,
  _signer: SignerAdapter,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/from-mint", async (c) => {
    const logger = getLogger();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = FromMintBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
    }

    const {
      chainId,
      tokenId,
      pool: poolData,
      configSnapshot,
      ...positionFields
    } = parsed.data;

    const nowUnix = BigInt(Math.floor(Date.now() / 1000));

    logger.info({ chainId, tokenId }, "Recording minted position");

    const pool = await prisma.pool.upsert({
      where: { chainId_address: { chainId, address: poolData.address } },
      update: {
        token0Address: poolData.token0Address,
        token1Address: poolData.token1Address,
        token0Symbol: poolData.token0Symbol,
        token1Symbol: poolData.token1Symbol,
        token0Decimals: poolData.token0Decimals,
        token1Decimals: poolData.token1Decimals,
        feeTier: poolData.feeTier,
      },
      create: { chainId, ...poolData, createdAt: nowUnix },
    });

    const position = await prisma.position.upsert({
      where: { chainId_tokenId: { chainId, tokenId } },
      update: {
        tickLower: positionFields.tickLower,
        tickUpper: positionFields.tickUpper,
        rangePercent: positionFields.rangePercent,
        tickAtMint: positionFields.tickAtMint,
        deployAmountUsdt: positionFields.deployAmountUsdt,
        amount0Deposited: positionFields.amount0Deposited,
        amount1Deposited: positionFields.amount1Deposited,
        liquidity: positionFields.liquidity,
        swapAmountIn: positionFields.swapAmountIn ?? null,
        swapAmountOutMin: positionFields.swapAmountOutMin ?? null,
        swapAmountOutActual: positionFields.swapAmountOutActual ?? null,
        mintTxHash: positionFields.mintTxHash,
        mintBlockNumber: BigInt(positionFields.mintBlockNumber),
        configSnapshot: configSnapshot as Prisma.InputJsonValue,
        recipientWallet: positionFields.recipientWallet,
        status: "ACTIVE",
        lastInRangeAt: nowUnix,
        updatedAt: nowUnix,
      },
      create: {
        chainId,
        tokenId,
        poolId: pool.id,
        status: "ACTIVE",
        tickLower: positionFields.tickLower,
        tickUpper: positionFields.tickUpper,
        rangePercent: positionFields.rangePercent,
        tickAtMint: positionFields.tickAtMint,
        deployAmountUsdt: positionFields.deployAmountUsdt,
        amount0Deposited: positionFields.amount0Deposited,
        amount1Deposited: positionFields.amount1Deposited,
        liquidity: positionFields.liquidity,
        swapAmountIn: positionFields.swapAmountIn ?? null,
        swapAmountOutMin: positionFields.swapAmountOutMin ?? null,
        swapAmountOutActual: positionFields.swapAmountOutActual ?? null,
        mintTxHash: positionFields.mintTxHash,
        mintBlockNumber: BigInt(positionFields.mintBlockNumber),
        mintedAt: nowUnix,
        lastInRangeAt: nowUnix,
        createdAt: nowUnix,
        updatedAt: nowUnix,
        configSnapshot: configSnapshot as Prisma.InputJsonValue,
        recipientWallet: positionFields.recipientWallet,
      },
    });

    logger.info({ positionId: position.id, tokenId }, "Position recorded");

    return c.json({ success: true, data: jsonSafe(position) }, 200);
  });

  router.patch("/record-uncollected-fee", async (c) => {
    const logger = getLogger();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = RecordUncollectedFeeBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
    }

    const { chainId, tokenId, uncollectedFeeUsd, pnlPct } = parsed.data;

    const nowUnix = BigInt(Math.floor(Date.now() / 1000));

    logger.info({ chainId, tokenId }, "Recording minted position");

    const lastPosition = await prisma.position.findUnique({
      where: { chainId_tokenId: { chainId, tokenId } },
    });

    const position = await prisma.position.update({
      where: { chainId_tokenId: { chainId, tokenId } },
      data: {
        uncollectedFeeUsd: uncollectedFeeUsd,
        lastInRangeAt: nowUnix,
        updatedAt: nowUnix,
        peakPnlPct:
          +pnlPct > +(lastPosition?.peakPnlPct ?? "-10")
            ? pnlPct
            : (lastPosition?.peakPnlPct ?? "-10"),
      },
    });

    logger.info({ positionId: position.id, tokenId }, "Position recorded");

    return c.json({ success: true, data: jsonSafe(position) }, 200);
  });

  router.patch("/:tokenId/check", async (c) => {
    const logger = getLogger();
    const { tokenId } = c.req.param();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = PositionCheckBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
    }

    const {
      chainId,
      currentTick,
      inRange,
      currentValueUsdt,
      drawdownPct,
      poolTvl,
      poolVolume24h,
      poolFeesApr,
      decision,
      decisionReason,
    } = parsed.data;

    const nowUnix = BigInt(Math.floor(Date.now() / 1000));

    logger.info({ tokenId, inRange, decision }, "Recording position check");

    const position = await prisma.position.findUnique({
      where: { chainId_tokenId: { chainId, tokenId } },
    });
    if (!position) {
      throw new NotFoundError(
        `Position not found for tokenId ${tokenId} on chain ${chainId}`,
      );
    }

    await prisma.positionCheck.create({
      data: {
        positionId: position.id,
        checkedAt: nowUnix,
        currentTick,
        inRange,
        currentValueUsdt,
        drawdownPct,
        poolTvl,
        poolVolume24h,
        poolFeesApr,
        decision,
        decisionReason,
      },
    });

    const updateData: Prisma.PositionUpdateInput = {
      lastCheckedAt: nowUnix,
      updatedAt: nowUnix,
    };

    if (inRange) {
      updateData.lastInRangeAt = nowUnix;
      updateData.oorSince = null;
      updateData.status = "ACTIVE";
    } else {
      if (position.oorSince === null) {
        updateData.oorSince = nowUnix;
      }
      updateData.status = "OUT_OF_RANGE";
    }

    const updated = await prisma.position.update({
      where: { id: position.id },
      data: updateData,
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    let oorDurationMinutes: number | null = null;
    if (updated.oorSince) {
      oorDurationMinutes = Math.floor(
        (nowSeconds - Number(updated.oorSince)) / 60,
      );
    }

    return c.json(
      { success: true, data: jsonSafe({ ...updated, oorDurationMinutes }) },
      200,
    );
  });

  router.post("/:tokenId/rebalance", async (c) => {
    const logger = getLogger();
    const { tokenId } = c.req.param();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = RebalanceBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
    }

    const {
      chainId,
      closeTxHash,
      closeBlockNumber,
      amount0Withdrawn,
      amount1Withdrawn,
      feesCollected0,
      feesCollected1,
      newPosition,
    } = parsed.data;

    const nowUnix = BigInt(Math.floor(Date.now() / 1000));

    logger.info({ tokenId, chainId }, "Rebalancing position");

    const oldPosition = await prisma.position.findUnique({
      where: { chainId_tokenId: { chainId, tokenId } },
    });
    if (!oldPosition) {
      throw new NotFoundError(
        `Position not found for tokenId ${tokenId} on chain ${chainId}`,
      );
    }

    const closedPosition = await prisma.position.update({
      where: { id: oldPosition.id },
      data: {
        status: "CLOSED",
        exitReason: "REBALANCED",
        closeTxHash,
        closeBlockNumber: BigInt(closeBlockNumber),
        closedAt: nowUnix,
        amount0Withdrawn,
        amount1Withdrawn,
        feesCollected0,
        feesCollected1,
        updatedAt: nowUnix,
      },
    });

    const rootPositionId = oldPosition.rootPositionId ?? oldPosition.id;

    const pool = await prisma.pool.upsert({
      where: {
        chainId_address: { chainId, address: newPosition.pool.address },
      },
      update: {
        token0Address: newPosition.pool.token0Address,
        token1Address: newPosition.pool.token1Address,
        token0Symbol: newPosition.pool.token0Symbol,
        token1Symbol: newPosition.pool.token1Symbol,
        token0Decimals: newPosition.pool.token0Decimals,
        token1Decimals: newPosition.pool.token1Decimals,
        feeTier: newPosition.pool.feeTier,
      },
      create: { chainId, ...newPosition.pool, createdAt: nowUnix },
    });

    const newPosRecord = await prisma.position.create({
      data: {
        chainId: newPosition.chainId,
        tokenId: newPosition.tokenId,
        poolId: pool.id,
        status: "ACTIVE",
        tickLower: newPosition.tickLower,
        tickUpper: newPosition.tickUpper,
        rangePercent: newPosition.rangePercent,
        tickAtMint: newPosition.tickAtMint,
        deployAmountUsdt: newPosition.deployAmountUsdt,
        amount0Deposited: newPosition.amount0Deposited,
        amount1Deposited: newPosition.amount1Deposited,
        liquidity: newPosition.liquidity,
        swapAmountIn: newPosition.swapAmountIn ?? null,
        swapAmountOutMin: newPosition.swapAmountOutMin ?? null,
        swapAmountOutActual: newPosition.swapAmountOutActual ?? null,
        mintTxHash: newPosition.mintTxHash,
        mintBlockNumber: BigInt(newPosition.mintBlockNumber),
        mintedAt: nowUnix,
        lastInRangeAt: nowUnix,
        createdAt: nowUnix,
        updatedAt: nowUnix,
        configSnapshot: newPosition.configSnapshot as Prisma.InputJsonValue,
        recipientWallet: newPosition.recipientWallet,
        previousPositionId: oldPosition.id,
        rootPositionId,
      },
    });

    logger.info(
      { closedId: closedPosition.id, newId: newPosRecord.id, rootPositionId },
      "Rebalance complete",
    );

    return c.json(
      {
        success: true,
        data: jsonSafe({ closedPosition, newPosition: newPosRecord }),
      },
      200,
    );
  });

  router.post("/:tokenId/exit", async (c) => {
    const logger = getLogger();
    const { tokenId } = c.req.param();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = ExitBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
    }

    const {
      chainId,
      exitReason,
      closeTxHash,
      closeBlockNumber,
      amount0Withdrawn,
      amount1Withdrawn,
      feesCollected0,
      feesCollected1,
      finalSweepAmountUsdt,
    } = parsed.data;

    const nowUnix = BigInt(Math.floor(Date.now() / 1000));

    logger.info({ tokenId, chainId, exitReason }, "Exiting position");

    const position = await prisma.position.findUnique({
      where: { chainId_tokenId: { chainId, tokenId } },
    });
    if (!position) {
      throw new NotFoundError(
        `Position not found for tokenId ${tokenId} on chain ${chainId}`,
      );
    }

    const deployRaw = BigInt(position.deployAmountUsdt);
    const sweepRaw = BigInt(finalSweepAmountUsdt);
    const pnlRaw = sweepRaw - deployRaw;
    const pnlPercentRaw =
      deployRaw !== 0n ? ((pnlRaw * 1_000_000n) / deployRaw).toString() : "0";
    const pnlUsdt = pnlRaw.toString();

    const updated = await prisma.position.update({
      where: { id: position.id },
      data: {
        status: "EXITED",
        exitReason,
        closeTxHash,
        closeBlockNumber: BigInt(closeBlockNumber),
        closedAt: nowUnix,
        amount0Withdrawn,
        amount1Withdrawn,
        feesCollected0,
        feesCollected1,
        finalSweepAmountUsdt,
        pnlUsdt,
        pnlPercent: pnlPercentRaw,
        updatedAt: nowUnix,
      },
    });

    logger.info(
      { positionId: updated.id, pnlUsdt, pnlPercent: pnlPercentRaw },
      "Position exited",
    );

    return c.json({ success: true, data: jsonSafe(updated) }, 200);
  });

  router.get("/", async (c) => {
    const logger = getLogger();

    const parsed = GetPositionsQuery.safeParse(c.req.query());
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(
        firstError?.message ?? "Invalid query parameters",
      );
    }

    const { status, chainId } = parsed.data;

    const where: Prisma.PositionWhereInput = {};
    if (status) where.status = status;
    if (chainId) where.chainId = chainId;

    const positions = await prisma.position.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { pool: true },
    });

    logger.info({ count: positions.length }, "Listed positions");

    return c.json({ success: true, data: jsonSafe(positions) }, 200);
  });

  router.get("/:tokenId", async (c) => {
    const { tokenId } = c.req.param();

    const parsed = GetPositionQuery.safeParse(c.req.query());
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(
        firstError?.message ?? "Invalid query parameters",
      );
    }

    const { chainId, checks: checksLimit } = parsed.data;

    const position = await prisma.position.findUnique({
      where: { chainId_tokenId: { chainId, tokenId } },
      include: { pool: true },
    });

    if (!position) {
      throw new NotFoundError(
        `Position not found for tokenId ${tokenId} on chain ${chainId}`,
      );
    }

    const checks = await prisma.positionCheck.findMany({
      where: { positionId: position.id },
      orderBy: { checkedAt: "desc" },
      take: checksLimit ?? 20,
    });

    return c.json(
      { success: true, data: jsonSafe({ ...position, checks }) },
      200,
    );
  });

  return router;
}
