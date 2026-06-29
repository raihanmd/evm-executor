import type { Address, Hash, Hex, Log } from "viem";

/** Incoming request to execute an EVM transaction */
export interface ExecuteRequest {
  chainId: number;
  to: Address;
  value: string;
  data: Hex;
}

/** Successful execution response */
export interface ExecuteSuccess {
  success: true;
  txHash: Hash;
  blockNumber?: string;
  status?: "success" | "reverted";
  gasUsed?: string;
  gasPriceWei?: string;
  logs?: Log[];
}

/** Failure execution response */
export interface ExecuteFailure {
  success: false;
  message: string;
}

export type ExecuteResponse = ExecuteSuccess | ExecuteFailure;

/** Result of broadcasting and confirming a transaction */
export interface BroadcastResult {
  txHash: Hash;
  blockNumber?: string;
  status?: "success" | "reverted";
  gasUsed?: string;
  logs?: Log[];
}

/** Supported fee models */
export type FeeModel = "eip1559" | "legacy";

/** Configuration for a single chain */
export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
}

/** Transaction confirmation status */
export type ConfirmationStatus = "confirmed" | "reverted" | "dropped";
