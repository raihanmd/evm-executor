import { type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SignerAdapter, TransactionParams } from "./types.ts";
import type { ChainConfig, BroadcastResult } from "../types/index.ts";
import { broadcastAndConfirm } from "../rpc/index.ts";
import { getLogger } from "../logger/index.ts";
import { InternalError } from "../errors/index.ts";
import type { EnvConfig } from "../config/index.ts";

/**
 * PrivateKeySigner — signs transactions using a raw private key.
 *
 * This is the simplest signer backend and should be replaced with
 * KMS / Fireblocks / MPC in production.
 */
export class PrivateKeySigner implements SignerAdapter {
  private readonly config: EnvConfig;
  private readonly chainConfigs: Map<number, ChainConfig>;

  constructor(config: EnvConfig) {
    this.config = config;
    this.chainConfigs = config.chains;
  }

  async getAddress(): Promise<Address> {
    const account = privateKeyToAccount(this.config.privateKey);
    return account.address;
  }

  async sendTransaction(params: TransactionParams): Promise<Hash> {
    const logger = getLogger();
    const account = privateKeyToAccount(this.config.privateKey);

    const chainConfig = this.chainConfigs.get(params.chainId);
    if (!chainConfig) {
      throw new InternalError(`Chain ${params.chainId} is not configured`);
    }

    logger.info(
      {
        chainId: params.chainId,
        to: params.to,
        nonce: params.nonce,
        gas: params.gas.toString(),
      },
      "Signing transaction",
    );

    if (params.feeModel === "eip1559") {
      const hash = await account.signTransaction({
        chainId: params.chainId,
        to: params.to,
        value: params.value,
        data: params.data,
        nonce: params.nonce,
        gas: params.gas,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas,
        type: "eip1559",
      });

      logger.info({ txHash: hash }, "Transaction signed (EIP-1559)");
      return hash;
    }

    const hash = await account.signTransaction({
      chainId: params.chainId,
      to: params.to,
      value: params.value,
      data: params.data,
      nonce: params.nonce,
      gas: params.gas,
      gasPrice: params.gasPrice,
      type: "legacy",
    });

    logger.info({ txHash: hash }, "Transaction signed (legacy)");
    return hash;
  }

  async signMessage(message: Hex): Promise<Hex> {
    const account = privateKeyToAccount(this.config.privateKey);
    return account.signMessage({ message: { raw: message } });
  }

  async broadcastRawTransaction(
    chainId: number,
    signedTx: Hex,
  ): Promise<BroadcastResult> {
    const chainConfig = this.chainConfigs.get(chainId);
    if (!chainConfig) {
      throw new InternalError(`Chain ${chainId} is not configured`);
    }

    const result = await broadcastAndConfirm(
      chainConfig,
      signedTx,
      this.config.confirmationTimeout,
    );

    return {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      status: result.status,
      logs: result.logs,
    };
  }
}
