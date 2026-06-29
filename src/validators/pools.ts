import { z } from "zod";

export const PoolUpsertBody = z.object({
  chainId: z.number().int().positive(),
  address: z.string().refine(
    (val) => /^0x[a-fA-F0-9]{40}$/.test(val),
    { message: "Invalid EVM address" },
  ),
  token0Address: z.string().refine(
    (val) => /^0x[a-fA-F0-9]{40}$/.test(val),
    { message: "Invalid token0 address" },
  ),
  token1Address: z.string().refine(
    (val) => /^0x[a-fA-F0-9]{40}$/.test(val),
    { message: "Invalid token1 address" },
  ),
  token0Symbol: z.string().min(1),
  token1Symbol: z.string().min(1),
  token0Decimals: z.number().int().positive(),
  token1Decimals: z.number().int().positive(),
  feeTier: z.number().int().positive(),
});

export type PoolUpsertBodyValidated = z.infer<typeof PoolUpsertBody>;
