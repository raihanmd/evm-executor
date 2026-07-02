import { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";
import type { EnvConfig } from "../config/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import { ExecuteService } from "../services/execute.ts";
import {
  type Address,
  type Hex,
  type AbiParameter,
  getAddress,
  encodeFunctionData,
  decodeFunctionResult,
  parseEventLogs,
  type Abi,
  decodeEventLog,
  type Log,
} from "viem";
import {
  ExecuteRequestBody,
  ContractCallRequestBody,
  MulticallRequestBody,
  PoolVolumeQuery,
} from "../validators/evm.ts";
import { ValidationError, ForbiddenError } from "../errors/index.ts";
import { createPublicClientForChain } from "../rpc/index.ts";
import { getLogger } from "../logger/index.ts";
import { jsonSafe } from "../lib/json-safe.ts";
import { assertAbi } from "../utils/assert-abi.ts";

/** Parameter names that control fund/asset destination — must equal signer */
const SENSITIVE_ADDRESS_PARAMS = new Set(["recipient", "to", "owner", "dst"]);
const INT_RE = /^u?int(\d+)?$/;

/**
 * Recursively walk ABI inputs to:
 *  - enforce sensitive address args match signer
 *  - coerce string → BigInt for uint/int args
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
  if (
    type === "tuple" &&
    input.components &&
    typeof value === "object" &&
    value !== null
  ) {
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
        { ...input, type: "tuple" } as AbiParameter & {
          components?: readonly AbiParameter[];
        },
        item,
        `${path}[${i}]`,
        signerAddrLower,
      ),
    );
  }

  // uint[]/int[] — coerce each element to BigInt
  if (
    Array.isArray(value) &&
    /\[\]$/.test(type) &&
    INT_RE.test(type.slice(0, -2))
  ) {
    return value.map((v) => (typeof v === "string" ? BigInt(v) : v));
  }

  // scalar uint/int — coerce to BigInt
  if (INT_RE.test(type) && typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      throw new ValidationError(
        `Invalid integer at '${path}': cannot parse "${value}" as BigInt`,
      );
    }
  }

  // scalar address — check if sensitive, must equal signer
  if (
    type === "address" &&
    value != null &&
    SENSITIVE_ADDRESS_PARAMS.has((input.name ?? "").toLowerCase())
  ) {
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

export function createEvmRoutes(
  config: EnvConfig,
  signer: SignerAdapter,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const executeService = new ExecuteService(config, signer);

  router.post("/execute", async (c) => {
    const logger = getLogger();

    // Get the body (already parsed by signature middleware, or parse directly)
    const bodyRaw = c.get("body") ?? (await c.req.json());

    // Validate with Zod
    const parsed = ExecuteRequestBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
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
      return c.json(jsonSafe(response), 400);
    }

    return c.json(jsonSafe(response), 200);
  });

  router.post("/call", async (c) => {
    const logger = getLogger();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = ContractCallRequestBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
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

    // Single recursive walk — handles both scalar and tuple(struct) params
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
      return c.json(jsonSafe(response), 400);
    }

    let events: unknown[] = [];
    if (response.logs && response.logs.length > 0) {
      try {
        events = parseEventLogs({
          abi: abi as Parameters<typeof parseEventLogs>[0]["abi"],
          logs: response.logs,
        });
      } catch (err) {
        logger.warn({ err }, "Failed to decode event logs from receipt");
      }
    }

    const { logs: _rawLogs, ...rest } = response;

    return c.json(jsonSafe({ ...rest, events }), 200);
  });

  /**
   * POST /read — Proxy read-only contract call (eth_call).
   * Same request body as /call, but executes a read instead of a transaction.
   */
  router.post("/read", async (c) => {
    const logger = getLogger();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = ContractCallRequestBody.safeParse(bodyRaw);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(firstError?.message ?? "Invalid request body");
    }

    const {
      chainId,
      to: rawTo,
      abi,
      function: functionName,
      args: rawArgs,
    } = parsed.data;
    const to = rawTo as Address;

    logger.info(
      { chainId, to, function: functionName, argsCount: rawArgs.length },
      "Proxy reading contract",
    );

    // ── Find the function definition in the ABI ──────────────────────
    const functionAbi = (abi as unknown[]).find(
      (entry: unknown): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).type === "function" &&
        (entry as Record<string, unknown>).name === functionName,
    ) as
      | (Record<string, unknown> & {
          inputs?: AbiParameter[];
          outputs?: AbiParameter[];
        })
      | undefined;

    // Walk and validate args (same as /call)
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

    // ── Perform eth_call ─────────────────────────────────────────────
    const chainConfig = config.chains.get(chainId);
    if (!chainConfig) {
      return c.json(
        {
          success: false,
          message: `Chain ${chainId} is not configured`,
        },
        400,
      );
    }

    try {
      const publicClient = createPublicClientForChain(chainConfig);
      const result = await publicClient.call({
        to,
        data,
      });

      if (!result.data) {
        return c.json(
          { success: false, message: "No data returned from contract call" },
          400,
        );
      }

      const outputs = functionAbi?.outputs as AbiParameter[] | undefined;
      if (!outputs || outputs.length === 0) {
        return c.json({ success: true, data: null }, 200);
      }

      const decoded = decodeFunctionResult({
        abi: abi as unknown[],
        functionName,
        data: result.data,
      });

      return c.json({ success: true, data: jsonSafe(decoded) }, 200);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Contract read failed";
      logger.warn(
        { err, chainId, to, function: functionName },
        "Contract read failed",
      );
      return c.json({ success: false, message }, 400);
    }
  });

  router.post("/call-multicall", async (c) => {
    const logger = getLogger();
    const bodyRaw = c.get("body") ?? (await c.req.json());

    const parsed = MulticallRequestBody.safeParse(bodyRaw);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.errors[0]?.message ?? "Invalid body",
      );
    }

    const { chainId, to: rawTo, value, calls } = parsed.data;
    const to = rawTo as Address;

    // Encode setiap sub-call jadi bytes
    const encodedCalls: Hex[] = calls.map((call, i) => {
      try {
        return encodeFunctionData({
          abi: call.abi as unknown[],
          functionName: call.function,
          args: call.args,
        });
      } catch (err) {
        throw new ValidationError(
          `Failed to encode call[${i}] (${call.function}): ${err instanceof Error ? err.message : "ABI encoding error"}`,
        );
      }
    });

    const MULTICALL_ABI = [
      {
        name: "multicall",
        type: "function",
        stateMutability: "payable",
        inputs: [{ name: "data", type: "bytes[]" }],
        outputs: [{ name: "results", type: "bytes[]" }],
      },
    ] as const;

    const data = encodeFunctionData({
      abi: MULTICALL_ABI,
      functionName: "multicall",
      args: [encodedCalls],
    });

    logger.info(
      { chainId, to, callsCount: calls.length },
      "Executing multicall",
    );

    const abiSources: { address: Address; abi: Abi }[] = calls.map(
      (call, i) => ({
        address: to,
        abi: assertAbi(call.abi, `call[${i}]`),
      }),
    );

    const response = await executeService.execute({ chainId, to, value, data });

    if (response.success && response.logs) {
      const decodedLogs = response.logs.map((log: Log) => {
        for (const src of abiSources) {
          try {
            const decoded = decodeEventLog({
              abi: src.abi,
              data: log.data as Hex,
              topics: log.topics as [Hex, ...Hex[]],
            });
            return { ...log, decoded };
          } catch {
            continue;
          }
        }
        return { ...log, decoded: null };
      });

      return c.json(jsonSafe({ ...response, logs: decodedLogs }), 200);
    }

    if (!response.success) {
      return c.json(jsonSafe(response), 400);
    }

    return c.json(jsonSafe(response), 200);
  });

  router.get("/pool-volume/:poolAddress", async (c) => {
    const logger = getLogger();
    const { poolAddress: rawPoolAddress } = c.req.param();

    // Validate poolAddress
    let poolAddress: Address;
    try {
      poolAddress = getAddress(rawPoolAddress);
    } catch {
      throw new ValidationError(
        "Invalid poolAddress: must be a valid EVM address",
      );
    }

    // Validate query params
    const parsed = PoolVolumeQuery.safeParse(c.req.query());
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ValidationError(
        firstError?.message ?? "Invalid query parameters",
      );
    }

    const { chainId, fromBlock, toBlock } = parsed.data;

    // Chain config guard
    const chainConfig = config.chains.get(chainId);
    if (!chainConfig) {
      return c.json(
        { success: false, message: `Chain ${chainId} is not configured` },
        400,
      );
    }

    const publicClient = createPublicClientForChain(chainConfig);

    const SWAP_EVENT_ABI = [
      {
        type: "event",
        name: "Swap",
        inputs: [
          { name: "sender", type: "address", indexed: true },
          { name: "recipient", type: "address", indexed: true },
          { name: "amount0", type: "int256", indexed: false },
          { name: "amount1", type: "int256", indexed: false },
          { name: "sqrtPriceX96", type: "uint160", indexed: false },
          { name: "liquidity", type: "uint128", indexed: false },
          { name: "tick", type: "int24", indexed: false },
        ],
      },
    ] as const;

    const resolvedFromBlock: bigint | "earliest" | "latest" | undefined =
      fromBlock
        ? /^\d+$/.test(fromBlock)
          ? BigInt(fromBlock)
          : (fromBlock as "earliest" | "latest")
        : "earliest";
    const resolvedToBlock: bigint | "latest" | "earliest" | undefined = toBlock
      ? /^\d+$/.test(toBlock)
        ? BigInt(toBlock)
        : (toBlock as "latest" | "earliest")
      : "latest";

    logger.info(
      {
        chainId,
        poolAddress,
        fromBlock: resolvedFromBlock?.toString() ?? fromBlock,
        toBlock: resolvedToBlock?.toString() ?? toBlock,
      },
      "Fetching pool volume",
    );

    try {
      const logs = await publicClient.getLogs({
        address: poolAddress,
        event: SWAP_EVENT_ABI[0],
        fromBlock: resolvedFromBlock,
        toBlock: resolvedToBlock,
      });

      // Setiap swap: volume = abs(amount0) dalam token0 terms
      const swaps = logs.map((log) => ({
        blockNumber: log.blockNumber?.toString(),
        txHash: log.transactionHash,
        amount0: log.args.amount0?.toString(),
        amount1: log.args.amount1?.toString(),
        tick: log.args.tick,
      }));

      // Volume = sum abs(amount0) kalau token0 = USDT
      const volumeRaw = logs.reduce((sum, log) => {
        const a0 = log.args.amount0 ?? 0n;
        return sum + (a0 < 0n ? -a0 : a0);
      }, 0n);

      const volumeUsdt = Number(volumeRaw) / 1e18;

      logger.info(
        { poolAddress, swapCount: logs.length, volumeUsdt },
        "Pool volume calculated",
      );

      return c.json(
        jsonSafe({
          success: true,
          data: {
            poolAddress,
            chainId,
            fromBlock: fromBlock ?? "earliest",
            toBlock: toBlock ?? "latest",
            swapCount: logs.length,
            volumeUsdt,
            swaps,
          },
        }),
        200,
      );
    } catch (err) {
      const rpcError = err as {
        details?: string;
        shortMessage?: string;
        message?: string;
      };
      const message =
        rpcError.details ??
        rpcError.shortMessage ??
        "Failed to fetch swap logs";
      logger.warn({ err, poolAddress, chainId }, message);
      return c.json({ success: false, message }, 400);
    }
  });

  return router;
}
