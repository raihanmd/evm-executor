import type { Address, Hash, Hex } from "viem";
import type { FeeModel, BroadcastResult } from "../types/index.ts";

/** Parameters needed to sign and send a transaction */
export interface TransactionParams {
  chainId: number;
  to: Address;
  value: bigint;
  data: Hex;
  nonce: number;
  gas: bigint;
  feeModel: FeeModel;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

/** SignerAdapter — abstract interface for all signer backends */
export interface SignerAdapter {
  /** Get the account address this signer controls */
  getAddress(): Promise<Address>;

  /** Sign and broadcast a transaction, returning the hash */
  sendTransaction(params: TransactionParams): Promise<Hash>;

  /** Sign raw data (useful for future smart account / EIP-1271 support) */
  signMessage(message: Hex): Promise<Hex>;

  /** Broadcast a raw signed transaction */
  broadcastRawTransaction(
    chainId: number,
    signedTx: Hex,
  ): Promise<BroadcastResult>;
}
