import { z } from "zod";

const NumericString = z.string().regex(/^\d+$/, "Must be a numeric string");
const EvmAddress = z.string().refine((val) => /^0x[a-fA-F0-9]{40}$/.test(val), {
  message: "Invalid EVM address",
});

const PoolData = z.object({
  address: EvmAddress,
  token0Address: EvmAddress,
  token1Address: EvmAddress,
  token0Symbol: z.string().min(1),
  token1Symbol: z.string().min(1),
  token0Decimals: z.number().int().positive(),
  token1Decimals: z.number().int().positive(),
  feeTier: z.number().int().positive(),
});

export const FromMintBody = z.object({
  chainId: z.number().int().positive(),
  tokenId: z.string().regex(/^\d+$/, "tokenId must be a numeric string"),
  pool: PoolData,
  tickLower: z.number().int(),
  tickUpper: z.number().int(),
  rangePercent: z.number().int(),
  tickAtMint: z.number().int(),
  deployAmountUsdt: NumericString,
  amount0Deposited: NumericString,
  amount1Deposited: NumericString,
  liquidity: NumericString,
  swapAmountIn: NumericString.optional(),
  swapAmountOutMin: NumericString.optional(),
  swapAmountOutActual: NumericString.optional(),
  mintTxHash: z.string().startsWith("0x"),
  mintBlockNumber: NumericString,
  configSnapshot: z.record(z.unknown()),
  recipientWallet: EvmAddress,
});

export type FromMintBodyValidated = z.infer<typeof FromMintBody>;

export const RecordUncollectedFeeBody = z.object({
  chainId: z.number().int().positive(),
  tokenId: z.string().regex(/^\d+$/, "tokenId must be a numeric string"),
  uncollectedFeeUsd: z.string().optional(),
  pnlPct: z.string().optional().default("0"),
  pnlUsdt: z.string().optional(),
  lastToken0Amount: z.string().optional(),
  lastToken1Amount: z.string().optional(),
});

export type RecordUncollectedFeeBodyValidated = z.infer<
  typeof RecordUncollectedFeeBody
>;

export const PositionCheckBody = z.object({
  chainId: z.number().int().positive(),
  currentTick: z.number().int(),
  inRange: z.boolean(),
  currentValueUsdt: z.string(),
  drawdownPct: z.string(),
  poolTvl: NumericString,
  poolVolume24h: NumericString,
  poolFeesApr: NumericString,
  decision: z.enum(["HOLD", "REBALANCE", "EXIT", "NONE"]),
  decisionReason: z.string().min(1),
});

export type PositionCheckBodyValidated = z.infer<typeof PositionCheckBody>;

const NewPositionData = z.object({
  chainId: z.number().int().positive(),
  tokenId: z.string().regex(/^\d+$/, "tokenId must be a numeric string"),
  pool: PoolData,
  tickLower: z.number().int(),
  tickUpper: z.number().int(),
  rangePercent: z.number().int(),
  tickAtMint: z.number().int(),
  deployAmountUsdt: NumericString,
  amount0Deposited: NumericString,
  amount1Deposited: NumericString,
  liquidity: NumericString,
  swapAmountIn: NumericString.optional(),
  swapAmountOutMin: NumericString.optional(),
  swapAmountOutActual: NumericString.optional(),
  mintTxHash: z.string().startsWith("0x"),
  mintBlockNumber: NumericString,
  configSnapshot: z.record(z.unknown()),
  recipientWallet: EvmAddress,
});

export const RebalanceBody = z.object({
  chainId: z.number().int().positive(),
  closeTxHash: z.string().startsWith("0x"),
  closeBlockNumber: NumericString,
  amount0Withdrawn: NumericString,
  amount1Withdrawn: NumericString,
  feesCollected0: NumericString,
  feesCollected1: NumericString,
  newPosition: NewPositionData,
});

export type RebalanceBodyValidated = z.infer<typeof RebalanceBody>;

export const ExitBody = z.object({
  chainId: z.number().int().positive(),
  exitReason: z.enum([
    "OOR_TIMEOUT",
    "DRAWDOWN_STOP",
    "RUG_TVL_DROP",
    "LOW_VOLUME",
    "MANUAL",
  ]).nullable(),
  closeTxHash: z.string().startsWith("0x"),
  closeBlockNumber: NumericString,
  amount0Withdrawn: NumericString,
  amount1Withdrawn: NumericString,
  feesCollected0: NumericString,
  feesCollected1: NumericString,
  finalSweepAmountUsdt: NumericString,
});

export type ExitBodyValidated = z.infer<typeof ExitBody>;

export const GetPositionsQuery = z.object({
  status: z
    .enum([
      "ACTIVE",
      "OUT_OF_RANGE",
      "REBALANCING",
      "CLOSED",
      "EXITED",
      "FAILED",
    ])
    .optional(),
  chainId: z.string().regex(/^\d+$/).transform(Number).optional(),
});

export type GetPositionsQueryValidated = z.infer<typeof GetPositionsQuery>;

export const GetPositionQuery = z.object({
  chainId: z.string().regex(/^\d+$/).transform(Number),
  checks: z.string().regex(/^\d+$/).transform(Number).optional(),
});

export type GetPositionQueryValidated = z.infer<typeof GetPositionQuery>;
