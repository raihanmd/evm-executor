import { z } from "zod";

const NumericString = z.string().regex(/^\d+$/, "Must be a numeric string");

export const TxLogBody = z.object({
  positionId: z.string().nullable(),
  txHash: z.string().startsWith("0x"),
  action: z.enum([
    "APPROVE",
    "SWAP",
    "MINT",
    "DECREASE_LIQUIDITY",
    "COLLECT",
    "SWEEP",
  ]),
  status: z.enum(["SUCCESS", "FAILED", "REVERTED"]),
  blockNumber: NumericString,
  gasUsed: NumericString.optional(),
  gasPriceWei: NumericString.optional(),
  gasCostBnb: NumericString.optional(),
  gasCostUsd: NumericString.optional(),
});

export type TxLogBodyValidated = z.infer<typeof TxLogBody>;
