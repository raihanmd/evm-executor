import type { Abi } from "viem";
import { ValidationError } from "../errors";

export function assertAbi(value: unknown, context: string): Abi {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${context}: abi must be an array`);
  }
  for (const item of value) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).type !== "string"
    ) {
      throw new ValidationError(`${context}: invalid ABI entry`);
    }
  }
  return value as unknown as Abi;
}
