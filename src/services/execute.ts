import { type Address, getAddress } from "viem";
import type { EnvConfig } from "../config/index.ts";
import type { ExecuteRequest, ExecuteResponse } from "../types/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import { estimateFees, estimateGas, getPendingNonce, type FeeEstimation } from "../rpc/index.ts";
import { getLogger } from "../logger/index.ts";

export class ExecuteService {
  private readonly config: EnvConfig;
  private readonly signer: SignerAdapter;

  /** M-01: Per-chain execution queue to serialize nonces */
  private readonly executionQueues = new Map<number, Promise<void>>();

  /**
   * M-03: Content-hash → promise cache for body-based idempotency.
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

  /** Compute a content-addressed key for idempotent dedup */
  private static contentKey(req: ExecuteRequest): string {
    return `${req.chainId}:${req.to}:${req.value}:${req.data}`;
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResponse> {
    const ck = ExecuteService.contentKey(req);

    // M-03: Check cache first — returns the SAME promise (in-flight or resolved)
    // for concurrent identical requests, preventing double broadcast.
    const existing = this.contentCache.get(ck);
    if (existing) {
      getLogger().info({ key: ck }, "Duplicate content — sharing in-flight/ cached promise");
      return existing;
    }

    // M-01: Serialize execution per chainId to prevent nonce race conditions.
    // Must always advance the queue even if executeInner rejects.
    const chainId = req.chainId;
    const prev = this.executionQueues.get(chainId) ?? Promise.resolve();
    const execution = prev
      .catch(() => {})
      .then(() => this.executeInner(req));

    // M-03: Cache the promise BEFORE it resolves so concurrent requests
    // share the SAME execution (not just the completed result).
    // TTL starts AFTER execution settles — not from insertion — so a slow
    // RPC (>30s) doesn't delete the entry mid-flight when retries are likely.
    this.contentCache.set(ck, execution);
    execution.then(
      () => setTimeout(() => this.contentCache.delete(ck), ExecuteService.CONTENT_CACHE_TTL),
      () => setTimeout(() => this.contentCache.delete(ck), ExecuteService.CONTENT_CACHE_TTL),
    );

    // Chain queue (handles rejection so next request still runs)
    this.executionQueues.set(chainId, execution.catch(() => {}).then(() => {}));

    return execution;
  }

  private async executeInner(req: ExecuteRequest): Promise<ExecuteResponse> {
    const logger = getLogger();

    // Layer 6 — Chain Whitelist
    const chainConfig = this.config.chains.get(req.chainId);
    if (!chainConfig) {
      logger.warn({ chainId: req.chainId }, "Chain not allowed");
      return { success: false, message: `Chain ${req.chainId} is not allowed` };
    }

    // Layer 7 — Destination Contract Whitelist
    let normalizedTo: Address;
    try {
      normalizedTo = getAddress(req.to);
    } catch {
      return { success: false, message: "Invalid destination address" };
    }

    const allowed = chainConfig.allowedContracts;
    if (allowed.length > 0) {
      const isAllowed = allowed.some(
        (addr) => addr.toLowerCase() === normalizedTo.toLowerCase(),
      );
      if (!isAllowed) {
        logger.warn(
          { to: normalizedTo, chainId: req.chainId },
          "Destination contract not allowed",
        );
        return {
          success: false,
          message: `Contract ${normalizedTo} is not allowed on chain ${req.chainId}`,
        };
      }
    }

    // Layer 8 — Native Value Restriction
    const value = BigInt(req.value);
    if (!this.config.allowNative && value > 0n) {
      logger.warn({ value: req.value }, "Native value transfer blocked");
      return {
        success: false,
        message: "Native value transfers are not allowed",
      };
    }

    // Layer 9 & 10 — Calldata & Address validation already done in validators

    // Get the signer address
    const fromAddress = await this.signer.getAddress();

    // Layer 18 — Nonce: always fetch from RPC
    // (serialized by execute() queue, so each call gets a unique nonce)
    const nonce = await getPendingNonce(chainConfig, fromAddress);
    logger.info({ nonce }, "Fetched pending nonce");

    // Layer 17 — Fee Strategy: auto-detect EIP-1559 vs Legacy
    const feeEstimate = await estimateFees(chainConfig);
    logger.info({ feeModel: feeEstimate.feeModel }, "Fee strategy determined");

    // L-02: Enforce gas price cap to prevent overpaying during congestion
    const cappedFee = this.applyGasPriceCap(feeEstimate);

    // Layer 16 — Gas Estimation
    // M-02: estimateGas throws on failure (call would revert) — catch here and return clean response
    let gas: bigint;
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

    // Build transaction parameters
    const txParams = {
      chainId: req.chainId,
      to: normalizedTo,
      value,
      data: req.data,
      nonce,
      gas,
      feeModel: cappedFee.feeModel,
      maxFeePerGas: cappedFee.maxFeePerGas,
      maxPriorityFeePerGas: cappedFee.maxPriorityFeePerGas,
      gasPrice: cappedFee.gasPrice,
    };

    // Sign the transaction
    const signedTx = await this.signer.sendTransaction(txParams);

    // Broadcast & confirm (Layer 19)
    const result = await this.signer.broadcastRawTransaction(
      req.chainId,
      signedTx,
    );

    return {
      success: true,
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      status: result.status,
    };
  }

  /**
   * Cap fee estimates against the configured max gas price.
   * Returns the fee estimate with prices capped. If the cap is 0 (unset),
   * the original estimate is returned unchanged.
   */
  private applyGasPriceCap(
    estimate: FeeEstimation,
  ): FeeEstimation {
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
