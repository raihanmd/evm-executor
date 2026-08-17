import { type Address, getAddress } from "viem";
import type { EnvConfig } from "../config/index.ts";
import type {
  ChainConfig,
  ExecuteRequest,
  ExecuteResponse,
} from "../types/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import {
  estimateFees,
  estimateGas,
  getPendingNonce,
  getCurrentGasPrice,
  getCurrentBaseFee,
  type FeeEstimation,
} from "../rpc/index.ts";
import { getLogger } from "../logger/index.ts";

export interface ExecuteOptions {
  signer?: SignerAdapter;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPriceMultiplier?: bigint;
  gasLimit?: bigint;
}

export class ExecuteService {
  private readonly config: EnvConfig;
  private readonly signer: SignerAdapter;

  /** Per (chainId, signer) execution queue to serialize nonces */
  private readonly executionQueues = new Map<string, Promise<void>>();

  /**
   * Content-hash → promise cache for body-based idempotency.
   * Stores the in-flight Promise so concurrent identical requests share
   * the same execution — not just the completed result.
   * Entries expire after 30s to prevent unbounded growth.
   */
  private readonly contentCache = new Map<string, Promise<ExecuteResponse>>();
  private static readonly CONTENT_CACHE_TTL = 30_000;

  constructor(config: EnvConfig, signer: SignerAdapter) {
    this.config = config;
    this.signer = signer;
  }

  /** Compute a content-addressed key for idempotent dedup (per signer!) */
  private static contentKey(req: ExecuteRequest, signerAddr: string): string {
    return `${req.chainId}:${signerAddr}:${req.to}:${req.value}:${req.data}`;
  }

  async execute(
    req: ExecuteRequest,
    opts?: ExecuteOptions,
  ): Promise<ExecuteResponse> {
    const signer = opts?.signer ?? this.signer;
    const signerAddr = await signer.getAddress();
    const ck = ExecuteService.contentKey(req, signerAddr);

    // Check cache first — returns the SAME promise (in-flight or resolved)
    // for concurrent identical requests, preventing double broadcast.
    const existing = this.contentCache.get(ck);
    if (existing) {
      getLogger().info(
        { key: ck },
        "Duplicate content — sharing in-flight/ cached promise",
      );
      return existing;
    }

    // Serialize execution per (chainId, signer) to prevent nonce race conditions.
    // Must always advance the queue even if executeInner rejects.
    const chainId = req.chainId;
    const queueKey = `${chainId}:${signerAddr}`;
    const prev = this.executionQueues.get(queueKey) ?? Promise.resolve();
    const execution = prev
      .catch(() => {})
      .then(() => this.executeInner(req, signer, opts));

    // Cache the promise BEFORE it resolves so concurrent requests
    // share the SAME execution (not just the completed result).
    // TTL starts AFTER execution settles — not from insertion — so a slow
    // RPC (>30s) doesn't delete the entry mid-flight when retries are likely.
    this.contentCache.set(ck, execution);
    execution.then(
      () =>
        setTimeout(
          () => this.contentCache.delete(ck),
          ExecuteService.CONTENT_CACHE_TTL,
        ),
      () =>
        setTimeout(
          () => this.contentCache.delete(ck),
          ExecuteService.CONTENT_CACHE_TTL,
        ),
    );

    // Chain queue (handles rejection so next request still runs)
    this.executionQueues.set(
      queueKey,
      execution.catch(() => {}).then(() => {}),
    );

    return execution;
  }

  private async executeInner(
    req: ExecuteRequest,
    signer: SignerAdapter,
    opts?: ExecuteOptions,
  ): Promise<ExecuteResponse> {
    const logger = getLogger();

    const chainConfig = this.config.chains.get(req.chainId);
    if (!chainConfig) {
      logger.warn({ chainId: req.chainId }, "Chain not allowed");
      return { success: false, message: `Chain ${req.chainId} is not allowed` };
    }

    // Normalize destination address
    let normalizedTo: Address;
    try {
      normalizedTo = getAddress(req.to);
    } catch {
      return { success: false, message: "Invalid destination address" };
    }

    const value = BigInt(req.value);

    // Get the signer address
    const fromAddress = await signer.getAddress();

    // (serialized by execute() queue, so each call gets a unique nonce)
    const nonce = await getPendingNonce(chainConfig, fromAddress);
    logger.info({ nonce }, "Fetched pending nonce");

    const feeEstimate = await this.resolveFees(chainConfig, opts);
    if ("message" in feeEstimate) {
      return { success: false, message: feeEstimate.message };
    }
    logger.info({ feeModel: feeEstimate.feeModel }, "Fee strategy determined");

    // Gas limit: Mode C override skips estimation (caller responsibility)
    let gas: bigint;
    if (opts?.gasLimit != null) {
      gas = opts.gasLimit;
      logger.info({ gas: gas.toString() }, "Gas limit provided by caller");
    } else {
      try {
        gas = await estimateGas(
          chainConfig,
          fromAddress,
          normalizedTo,
          value,
          req.data,
          this.config.gasMultiplier,
        );
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Gas estimation failed — transaction would revert";
        logger.warn({ err }, "Gas estimation failed — rejecting transaction");
        return { success: false, message };
      }
      logger.info({ gas: gas.toString() }, "Gas estimated");
    }

    // Build transaction parameters
    const txParams = {
      chainId: req.chainId,
      to: normalizedTo,
      value,
      data: req.data,
      nonce,
      gas,
      feeModel: feeEstimate.feeModel,
      maxFeePerGas: feeEstimate.maxFeePerGas,
      maxPriorityFeePerGas: feeEstimate.maxPriorityFeePerGas,
      gasPrice: feeEstimate.gasPrice,
    };

    // Sign the transaction
    const signedTx = await signer.sendTransaction(txParams);

    // Broadcast & confirm (Layer 19)
    const result = await signer.broadcastRawTransaction(
      req.chainId,
      signedTx,
    );

    return {
      success: true,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      status: result.status,
      gasUsed: result.gasUsed ?? gas.toString(),
      gasPriceWei: (
        feeEstimate.gasPrice ??
        feeEstimate.maxFeePerGas ??
        0n
      ).toString(),
      logs: result.logs,
    };
  }

  /**
   * Resolve the fee strategy:
   * - Mode A (gasPriceMultiplier): live gas price × multiplier (1 fast RPC call)
   * - Mode B (absolute gasPrice/maxFeePerGas): use fields directly (0 RPC calls)
   * - Default: auto-estimate + applyGasPriceCap (existing behavior)
   * Returns either a FeeEstimation or a rejection message.
   */
  private async resolveFees(
    chainConfig: ChainConfig,
    opts?: ExecuteOptions,
  ): Promise<FeeEstimation | { message: string }> {
    if (!opts) {
      const estimate = await estimateFees(chainConfig);
      return this.applyGasPriceCap(estimate);
    }

    if (opts.gasPriceMultiplier != null) {
      const live = await getCurrentGasPrice(chainConfig);
      const target = (live * opts.gasPriceMultiplier) / 100n;
      const capped = this.applyGasPriceCap({ feeModel: "legacy", gasPrice: target });
      if (capped.gasPrice !== target) {
        return {
          message: `gasPriceMultiplier result exceeds MAX_GAS_PRICE_GWEI cap (${this.config.maxGasPriceWei} wei)`,
        };
      }
      return capped;
    }

    const hasAbsolute =
      opts.gasPrice != null ||
      opts.maxFeePerGas != null ||
      opts.maxPriorityFeePerGas != null;
    if (hasAbsolute) {
      // Mode B — absolute values (skip RPC estimation entirely)
      if (this.config.maxGasPriceWei > 0n) {
        const overCap =
          (opts.gasPrice ?? 0n) > this.config.maxGasPriceWei ||
          (opts.maxFeePerGas ?? 0n) > this.config.maxGasPriceWei ||
          (opts.maxPriorityFeePerGas ?? 0n) > this.config.maxGasPriceWei;
        if (overCap) {
          return {
            message: `Gas price exceeds MAX_GAS_PRICE_GWEI cap (${this.config.maxGasPriceWei} wei)`,
          };
        }
      }

      // Floor check (D7): absolute override must be >= current base fee
      const baseFee = await getCurrentBaseFee(chainConfig);
      if (baseFee != null && opts.maxFeePerGas != null && opts.maxFeePerGas < baseFee) {
        return {
          message: `maxFeePerGas (${opts.maxFeePerGas} wei) is below the current base fee (${baseFee} wei)`,
        };
      }
      if (baseFee != null && opts.gasPrice != null && opts.gasPrice < baseFee) {
        return {
          message: `gasPrice (${opts.gasPrice} wei) is below the current base fee (${baseFee} wei)`,
        };
      }

      return {
        feeModel: opts.maxFeePerGas != null ? "eip1559" : "legacy",
        maxFeePerGas: opts.maxFeePerGas,
        maxPriorityFeePerGas: opts.maxPriorityFeePerGas ?? 0n,
        gasPrice: opts.gasPrice,
      };
    }

    // Only gasLimit set — no fee override
    const estimate = await estimateFees(chainConfig);
    return this.applyGasPriceCap(estimate);
  }

  /**
   * Cap fee estimates against the configured max gas price.
   * Returns the fee estimate with prices capped. If the cap is 0 (unset),
   * the original estimate is returned unchanged.
   */
  private applyGasPriceCap(estimate: FeeEstimation): FeeEstimation {
    const capWei = this.config.maxGasPriceWei;
    if (capWei === 0n) return estimate;
    if (estimate.feeModel === "eip1559") {
      const capped = {
        ...estimate,
        maxFeePerGas: estimate.maxFeePerGas
          ? estimate.maxFeePerGas > capWei
            ? capWei
            : estimate.maxFeePerGas
          : undefined,
        maxPriorityFeePerGas: estimate.maxPriorityFeePerGas
          ? estimate.maxPriorityFeePerGas > capWei
            ? capWei
            : estimate.maxPriorityFeePerGas
          : undefined,
      };
      return capped;
    }
    return {
      ...estimate,
      gasPrice: estimate.gasPrice
        ? estimate.gasPrice > capWei
          ? capWei
          : estimate.gasPrice
        : undefined,
    };
  }
}
