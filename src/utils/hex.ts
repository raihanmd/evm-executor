import type { Hex } from "viem";

/** Check if a string is valid hex (starts with 0x, even length, valid hex chars) */
export function isValidHex(value: string): value is Hex {
  if (typeof value !== "string") return false;
  if (!value.startsWith("0x")) return false;
  if (value.length % 2 !== 0) return false;
  return /^0x[0-9a-fA-F]*$/.test(value);
}
