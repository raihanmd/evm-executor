import { type Address, getAddress } from "viem";
import type { EnvConfig } from "../config/index.ts";
import type { ExecuteRequest, ExecuteResponse } from "../types/index.ts";
import type { SignerAdapter } from "../signer/types.ts";
import { estimateFees, estimateGas, getPendingNonce } from "../rpc/index.ts";
import { getLogger } from "../logger/index.ts";

export class ExecuteService {
  private readonly config: EnvConfig;
  private readonly signer: SignerAdapter;

  constructor(config: EnvConfig, signer: SignerAdapter) {
    this.config = config;
    this.signer = signer;
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResponse> {
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
    const nonce = await getPendingNonce(chainConfig, fromAddress);
    logger.info({ nonce }, "Fetched pending nonce");

    // Layer 17 — Fee Strategy: auto-detect EIP-1559 vs Legacy
    const feeEstimate = await estimateFees(chainConfig);
    logger.info({ feeModel: feeEstimate.feeModel }, "Fee strategy determined");

    // Layer 16 — Gas Estimation
    const gas = await estimateGas(
      chainConfig,
      fromAddress,
      normalizedTo,
      value,
      req.data,
      this.config.gasMultiplier,
    );
    logger.info({ gas: gas.toString() }, "Gas estimated");

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
}
