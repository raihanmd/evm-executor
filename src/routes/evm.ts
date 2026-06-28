import { Hono } from "hono";
import type { AppEnv } from "../types/hono.ts";
import type { EnvConfig } from "../config/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import { ExecuteService } from "../services/execute.ts";
import { type Address, type Hex, encodeFunctionData } from "viem";
import { ExecuteRequestBody, ContractCallRequestBody } from "../validators/evm.ts";
import { ValidationError } from "../errors/index.ts";
import { getLogger } from "../logger/index.ts";

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
      args,
    } = parsed.data;
    const to = rawTo as Address;

    logger.info(
      { chainId, to, function: functionName, argsCount: args.length },
      "Encoding contract call",
    );

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
