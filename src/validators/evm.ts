import { z } from "zod";
import { getAddress } from "viem";

export const ExecuteRequestBody = z.object({
  chainId: z.number().int().positive(),
  to: z.string().refine(
    (val) => {
      try {
        getAddress(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid 'to' address" },
  ),
  value: z.string().regex(/^\d+$/, "value must be a numeric string"),
  data: z
    .string()
    .startsWith("0x", "data must start with 0x")
    .refine(
      (val) => val.length % 2 === 0,
      "data must have even length (hex-encoded bytes)",
    ),
});

export type ExecuteRequestValidated = z.infer<typeof ExecuteRequestBody>;

/**
 * Contract call — human-readable ABI + function + args.
 * The executor encodes calldata internally via viem.
 */
export const ContractCallRequestBody = z.object({
  chainId: z.number().int().positive(),
  to: z.string().refine(
    (val) => {
      try {
        getAddress(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid 'to' address" },
  ),
  value: z
    .string()
    .regex(/^\d+$/, "value must be a numeric string")
    .default("0"),
  abi: z
    .array(z.record(z.unknown()))
    .min(1, "abi must have at least one entry"),
  function: z.string().min(1, "function name is required"),
  args: z.array(z.unknown()).default([]),
});

export type ContractCallRequestValidated = z.infer<
  typeof ContractCallRequestBody
>;

export const MulticallRequestBody = z.object({
  chainId: z.number().int().positive(),
  to: z.string(), // NPM address
  value: z.string().regex(/^\d+$/).default("0"),
  calls: z
    .array(
      z.object({
        abi: z.array(z.record(z.unknown())).min(1),
        function: z.string().min(1),
        args: z.array(z.unknown()).default([]),
      }),
    )
    .min(1),
});

export type MulticallRequestValidated = z.infer<typeof MulticallRequestBody>;
