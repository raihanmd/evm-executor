import { z } from "zod";

export const TxLogBody = z.object({
  positionId: z.string().nullable(),
  txHash: z.string().startsWith("0x"),
  action: z.enum(["APPROVE", "SWAP", "MINT", "DECREASE_LIQUIDITY", "COLLECT", "SWEEP"]),
  status: z.enum(["SUCCESS", "FAILED", "REVERTED"]),
  blockNumber: z.string().regex(/^\d+$/, "blockNumber must be a numeric string"),
  gasUsed: z.string().regex(/^\d+$/, "gasUsed must be a numeric string"),
  gasPriceWei: z.string().regex(/^\d+$/, "gasPriceWei must be a numeric string"),
  gasCostBnb: z.string().regex(/^\d+(\.\d+)?$/, "gasCostBnb must be a decimal string"),
  gasCostUsd: z.string().regex(/^\d+(\.\d+)?$/, "gasCostUsd must be a decimal string"),
});

export type TxLogBodyValidated = z.infer<typeof TxLogBody>;
