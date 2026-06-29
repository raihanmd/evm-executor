import { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";
import type { EnvConfig } from "../config/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import { ExecuteService } from "../services/execute.ts";
import { type Address, type Hex, type AbiParameter, getAddress, encodeFunctionData } from "viem";
import { ExecuteRequestBody, ContractCallRequestBody } from "../validators/evm.ts";
import { ValidationError, ForbiddenError } from "../errors/index.ts";
import { getLogger } from "../logger/index.ts";

/** Parameter names that control fund/asset destination — must equal signer */
const SENSITIVE_ADDRESS_PARAMS = new Set(["recipient", "to", "owner", "dst"]);
const INT_RE = /^u?int(\d+)?$/;

/**
 * Recursively walk ABI inputs to:
 *  - H-01: enforce sensitive address args match signer
 *  - L-01: coerce string → BigInt for uint/int args
 *
 * Handles nested tuple(struct)/tuple[] types that NFPM functions use.
 */
function walkAndValidate(
  input: AbiParameter & { components?: readonly AbiParameter[] },
  value: unknown,
  path: string,
  signerAddrLower: string,
): unknown {
  const type = input.type;

  // tuple struct — recurse into components
  if (type === "tuple" && input.components && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const c of input.components) {
      out[c.name!] = walkAndValidate(
        c as AbiParameter & { components?: readonly AbiParameter[] },
        obj[c.name!],
        `${path}.${c.name}`,
        signerAddrLower,
      );
    }
    return out;
  }

  // tuple[] — recurse each element as tuple
  if (type === "tuple[]" && input.components && Array.isArray(value)) {
    return value.map((item, i) =>
      walkAndValidate(
        { ...input, type: "tuple" } as AbiParameter & { components?: readonly AbiParameter[] },
        item,
        `${path}[${i}]`,
        signerAddrLower,
      ),
    );
  }

  // uint[]/int[] — coerce each element to BigInt
  if (Array.isArray(value) && /\[\]$/.test(type) && INT_RE.test(type.slice(0, -2))) {
    return value.map((v) => (typeof v === "string" ? BigInt(v) : v));
  }

  // scalar uint/int — coerce to BigInt
  if (INT_RE.test(type) && typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      throw new ValidationError(`Invalid integer at '${path}': cannot parse "${value}" as BigInt`);
    }
  }

  // scalar address — check if sensitive, must equal signer
  if (type === "address" && value != null && SENSITIVE_ADDRESS_PARAMS.has((input.name ?? "").toLowerCase())) {
    let addr: string;
    try {
      addr = getAddress(value as string).toLowerCase();
    } catch {
      throw new ValidationError(`Invalid address at '${path}'`);
    }
    if (addr !== signerAddrLower) {
      throw new ForbiddenError(
        `'${path}' must be the bot's own address (${signerAddrLower}), got ${value}`,
      );
    }
  }

  return value;
}

export function createEvmRoutes(config: EnvConfig, signer: SignerAdapter): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const executeService = new ExecuteService(config, signer);

  router.post("/execute", async (c) => {
    const logger = getLogger();

    // Get the body (already parsed by signature middleware, or parse directly)
    const bodyRaw = c.get("body") ?? await c.req.json();

    // Validate with Zod
    const parsed = ExecuteRequestBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(
        firstError?.message ?? "Invalid request body",
      );
    }

    const { chainId, to: rawTo, value, data: rawData } = parsed.data;
    const to = rawTo as Address;
    const data = rawData as Hex;

    logger.info(
      { chainId, to, dataLength: data.length },
      "Executing transaction request",
    );

    const response = await executeService.execute({
      chainId,
      to,
      value,
      data,
    });

    if (!response.success) {
      return c.json(response, 400);
    }

    return c.json(response, 200);
  });

  router.post("/call", async (c) => {
    const logger = getLogger();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = ContractCallRequestBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(
        firstError?.message ?? "Invalid request body",
      );
    }

    const {
      chainId,
      to: rawTo,
      value,
      abi,
      function: functionName,
      args: rawArgs,
    } = parsed.data;
    const to = rawTo as Address;

    logger.info(
      { chainId, to, function: functionName, argsCount: rawArgs.length },
      "Encoding contract call",
    );

    // ── Find the function definition in the ABI ──────────────────────────
    const functionAbi = (abi as unknown[]).find(
      (entry: unknown): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).type === "function" &&
        (entry as Record<string, unknown>).name === functionName,
    ) as (Record<string, unknown> & { inputs?: AbiParameter[] }) | undefined;

    // H-01 + L-01: Single recursive walk — handles both scalar and tuple(struct) params
    const signerAddressLower = (await signer.getAddress()).toLowerCase();
    const args: unknown[] =
      functionAbi && Array.isArray(functionAbi.inputs)
        ? functionAbi.inputs.map((input, i) =>
            walkAndValidate(
              input as AbiParameter & { components?: readonly AbiParameter[] },
              rawArgs[i],
              input.name ?? `arg${i}`,
              signerAddressLower,
            ),
          )
        : [...rawArgs];

    let data: Hex;
    try {
      data = encodeFunctionData({
        abi: abi as unknown[],
        functionName,
        args,
      });
    } catch (err) {
      throw new ValidationError(
        `Failed to encode calldata: ${err instanceof Error ? err.message : "ABI encoding error"}`,
      );
    }

    const response = await executeService.execute({
      chainId,
      to,
      value,
      data,
    });

    if (!response.success) {
      return c.json(response, 400);
    }

    return c.json(response, 200);
  });

  return router;
}
