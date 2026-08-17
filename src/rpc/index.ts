import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type Log,
  Eip1559FeesNotSupportedError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import type { ChainConfig, FeeModel } from "../types/index.ts";
import { getLogger } from "../logger/index.ts";

const chainMap: Record<number, Chain> = {
  56: bsc,
  97: bscTestnet,
};

function getViemChain(chainId: number): Chain {
  const chain = chainMap[chainId];
  if (!chain) {
    return {
      id: chainId,
      name: `Chain ${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [] } },
    } as Chain;
  }
  return chain;
}

/**
 * Create a public client (read-only) for the given chain config.
 */
export function createPublicClientForChain(config: ChainConfig) {
  const chain = getViemChain(config.chainId);
  return createPublicClient({
    chain,
    transport: http(config.rpcUrl, {
      timeout: 15_000,
    }),
  });
}

/**
 * Create a wallet client for sending transactions.
 */
export function createWalletClientForChain(
  config: ChainConfig,
  privateKey: Address,
) {
  const chain = getViemChain(config.chainId);
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl, {
      timeout: 15_000,
    }),
  });
}

export interface FeeEstimation {
  feeModel: FeeModel;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

/**
 * Detect the fee model and estimate fees for the given chain.
 * Uses viem's built-in estimateFeesPerGas: tries EIP-1559 first (checks
 * baseFeePerGas on the latest block), falls back to legacy gas price.
 * baseFeeMultiplier=2 preserves the previous formula: maxFee = baseFee*2 + priority.
 */
export async function estimateFees(
  config: ChainConfig,
): Promise<FeeEstimation> {
  const publicClient = createPublicClientForChain(config);
  const logger = getLogger();

  try {
    const { maxFeePerGas, maxPriorityFeePerGas } =
      await publicClient.estimateFeesPerGas({
        type: "eip1559",
        chain: {
          ...getViemChain(config.chainId),
          fees: { baseFeeMultiplier: 2 },
        },
      });

    // Keep the 1 gwei priority floor used previously when fee history was sparse
    const priorityFee =
      maxPriorityFeePerGas < 1_000_000_000n
        ? 1_000_000_000n
        : maxPriorityFeePerGas;
    const maxFee =
      maxFeePerGas - maxPriorityFeePerGas + priorityFee;

    return {
      feeModel: "eip1559",
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
    };
  } catch (err) {
    if (err instanceof Eip1559FeesNotSupportedError) {
      logger.info("Chain does not support EIP-1559, falling back to legacy");
    } else {
      logger.warn({ err }, "EIP-1559 fee estimation failed, falling back to legacy");
    }
  }

  const gasPrice = await publicClient.getGasPrice();
  return {
    feeModel: "legacy",
    gasPrice,
  };
}

/**
 * Current network gas price via a single eth_gasPrice call (fast path for
 * the gasPriceMultiplier mode).
 */
export async function getCurrentGasPrice(config: ChainConfig): Promise<bigint> {
  const publicClient = createPublicClientForChain(config);
  return publicClient.getGasPrice();
}

/**
 * Current base fee from the latest block, or undefined if the chain has no
 * EIP-1559 base fee (pure-legacy chains).
 */
export async function getCurrentBaseFee(
  config: ChainConfig,
): Promise<bigint | undefined> {
  const publicClient = createPublicClientForChain(config);
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return block.baseFeePerGas ?? undefined;
}

/**
 * Estimate gas for a transaction.
 */
export async function estimateGas(
  config: ChainConfig,
  from: Address,
  to: Address,
  value: bigint,
  data: Hex,
  gasMultiplier: bigint,
): Promise<bigint> {
  const publicClient = createPublicClientForChain(config);
  const logger = getLogger();

  try {
    const estimated = await publicClient.estimateGas({
      account: from,
      to,
      value,
      data,
    });

    const withBuffer = (estimated * (100n + gasMultiplier)) / 100n;
    return withBuffer;
  } catch (err) {
    // estimateGas failure means the call would revert on-chain.
    // Fallback gas would just burn fees on a known-failing tx — hard-reject instead.
    const reason = err instanceof Error ? err.message : "Gas estimation failed";
    logger.warn({ err }, "Gas estimation failed — rejecting");
    throw new Error(`Transaction would revert: ${reason}`);
  }
}

/**
 * Get the pending nonce for an account.
 */
export async function getPendingNonce(
  config: ChainConfig,
  address: Address,
): Promise<number> {
  const publicClient = createPublicClientForChain(config);
  const nonce = await publicClient.getTransactionCount({
    address,
    blockTag: "pending",
  });
  return nonce;
}

/**
 * Broadcast a raw signed transaction and wait for confirmation.
 */
export async function broadcastAndConfirm(
  config: ChainConfig,
  signedTx: Hex,
  confirmTimeout: number,
): Promise<{
  txHash: Hex;
  blockNumber?: string;
  status?: "success" | "reverted";
  gasUsed?: string;
  logs?: Log[];
}> {
  const publicClient = createPublicClientForChain(config);
  const logger = getLogger();

  const txHash = await publicClient.sendRawTransaction({
    serializedTransaction: signedTx,
  });

  logger.info({ txHash }, "Transaction broadcasted, waiting for confirmation");

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: confirmTimeout,
  });

  return {
    txHash,
    blockNumber: receipt.blockNumber?.toString(),
    status: receipt.status,
    gasUsed: receipt.gasUsed?.toString(),
    logs: receipt.logs,
  };
}
