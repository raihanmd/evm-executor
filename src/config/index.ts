import "dotenv/config";
import { type Address, getAddress } from "viem";
import type { ChainConfig } from "../types/index.ts";
import { InternalError } from "../errors/index.ts";

export interface EnvConfig {
  port: number;
  host: string;
  apiKey: string;
  hmacSecret: string;
  privateKey: Address;
  chains: Map<number, ChainConfig>;
  allowNative: boolean;
  gasMultiplier: bigint;
  requestTimeout: number;
  confirmationTimeout: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  maxBodySize: number;
  logLevel: string;
}

function parseBigInt(value: string, label: string): bigint {
  const num = Number.parseFloat(value);
  if (Number.isNaN(num) || num <= 0) {
    throw new InternalError(`Invalid ${label}: ${value}`);
  }
  return BigInt(Math.floor(num * 100)) / 100n;
}

function parseChains(raw: string | undefined): number[] {
  if (!raw || raw.trim() === "") {
    return [];
  }
  const chains: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const id = Number.parseInt(trimmed, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new InternalError(`Invalid chain ID: ${trimmed}`);
    }
    chains.push(id);
  }
  return chains;
}

function parseContracts(
  chainIds: number[],
  env: Record<string, string | undefined>,
): Map<number, Address[]> {
  const map = new Map<number, Address[]>();
  for (const chainId of chainIds) {
    const raw = env[`CONTRACTS_${chainId}`];
    if (!raw || raw.trim() === "") {
      map.set(chainId, []);
      continue;
    }
    const addresses: Address[] = [];
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      try {
        addresses.push(getAddress(trimmed));
      } catch {
        throw new InternalError(
          `Invalid address for chain ${chainId}: ${trimmed}`,
        );
      }
    }
    map.set(chainId, addresses);
  }
  return map;
}

function parseRpcUrls(
  chainIds: number[],
  env: Record<string, string | undefined>,
): Map<number, string> {
  const map = new Map<number, string>();
  for (const chainId of chainIds) {
    const url = env[`RPC_URL_${chainId}`];
    if (!url || url.trim() === "") {
      throw new InternalError(
        `Missing RPC_URL_${chainId} in environment configuration`,
      );
    }
    map.set(chainId, url.trim());
  }
  return map;
}

export function loadConfig(): EnvConfig {
  const env = process.env;

  const rawApiKey = env["API_KEY"];
  if (!rawApiKey || rawApiKey.trim() === "") {
    throw new InternalError("API_KEY is required");
  }

  const rawHmacSecret = env["HMAC_SECRET"];
  if (!rawHmacSecret || rawHmacSecret.trim() === "") {
    throw new InternalError("HMAC_SECRET is required");
  }

  const rawPrivateKey = env["PRIVATE_KEY"];
  if (!rawPrivateKey || rawPrivateKey.trim() === "") {
    throw new InternalError("PRIVATE_KEY is required");
  }

  const chainIds = parseChains(env["ALLOWED_CHAINS"]);
  if (chainIds.length === 0) {
    throw new InternalError("At least one ALLOWED_CHAINS must be configured");
  }

  const rpcUrls = parseRpcUrls(chainIds, env);
  const contracts = parseContracts(chainIds, env);

  const chains = new Map<number, ChainConfig>();
  for (const chainId of chainIds) {
    const rpcUrl = rpcUrls.get(chainId);
    const allowedContracts = contracts.get(chainId) ?? [];
    if (!rpcUrl) {
      throw new InternalError(
        `Missing RPC URL for chain ${chainId} — this should not happen`,
      );
    }
    chains.set(chainId, { chainId, rpcUrl, allowedContracts });
  }

  const rawGasMultiplier = env["GAS_MULTIPLIER"] ?? "1.20";
  const allowNative = env["ALLOW_NATIVE"] === "1";

  return {
    port: Number.parseInt(env["PORT"] ?? "3000", 10),
    host: env["HOST"] ?? "0.0.0.0",
    apiKey: rawApiKey.trim(),
    hmacSecret: rawHmacSecret.trim(),
    privateKey: rawPrivateKey.trim() as Address,
    chains,
    allowNative,
    gasMultiplier: parseBigInt(rawGasMultiplier, "GAS_MULTIPLIER"),
    requestTimeout: Number.parseInt(env["REQUEST_TIMEOUT"] ?? "10000", 10),
    confirmationTimeout: Number.parseInt(
      env["CONFIRMATION_TIMEOUT"] ?? "60000",
      10,
    ),
    rateLimitMax: Number.parseInt(env["RATE_LIMIT_MAX"] ?? "100", 10),
    rateLimitWindowMs: Number.parseInt(
      env["RATE_LIMIT_WINDOW_MS"] ?? "60000",
      10,
    ),
    maxBodySize: Number.parseInt(env["MAX_BODY_SIZE"] ?? "4096", 10),
    logLevel: env["LOG_LEVEL"] ?? "info",
  };
}
