import { type Address, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EnvConfig } from "../config/index.ts";
import type { SignerAdapter } from "./types.ts";
import { PrivateKeySigner } from "./private-key.ts";
import { ValidationError } from "../errors/index.ts";

/**
 * Registry of signer adapters keyed by lowercase address.
 * Implements SignerAdapter by delegating to the default signer, so it is a
 * drop-in replacement for a single signer in route wiring. /execute resolves
 * a specific signer via the X-Signer-Address header.
 */
export class SignerRegistry implements SignerAdapter {
  private readonly signers: Map<string, SignerAdapter>;
  private readonly defaultSigner: SignerAdapter;

  private constructor(
    signers: Map<string, SignerAdapter>,
    defaultSigner: SignerAdapter,
  ) {
    this.signers = signers;
    this.defaultSigner = defaultSigner;
  }

  static fromConfig(config: EnvConfig): SignerRegistry {
    const keys = [config.privateKey, ...config.additionalPrivateKeys];
    const signers = new Map<string, SignerAdapter>();
    for (const key of keys) {
      const signer = new PrivateKeySigner(config, key as Address);
      const address = privateKeyToAccount(key as Address).address.toLowerCase();
      signers.set(address, signer);
    }
    const defaultSigner = signers.get(
      privateKeyToAccount(config.privateKey).address.toLowerCase(),
    );
    if (!defaultSigner) {
      throw new Error("Default signer missing from registry");
    }
    return new SignerRegistry(signers, defaultSigner);
  }

  static single(signer: SignerAdapter): SignerRegistry {
    return new SignerRegistry(new Map(), signer);
  }

  resolve(address?: string): SignerAdapter {
    if (!address || address.trim() === "") {
      return this.defaultSigner;
    }
    let normalized: string;
    try {
      normalized = getAddress(address).toLowerCase();
    } catch {
      throw new ValidationError("Invalid X-Signer-Address");
    }
    const signer = this.signers.get(normalized);
    if (!signer) {
      throw new ValidationError(`Signer ${address} is not registered`);
    }
    return signer;
  }

  getDefaultSigner(): SignerAdapter {
    return this.defaultSigner;
  }

  getAddress(): Promise<Address> {
    return this.defaultSigner.getAddress();
  }

  sendTransaction(
    params: Parameters<SignerAdapter["sendTransaction"]>[0],
  ): ReturnType<SignerAdapter["sendTransaction"]> {
    return this.defaultSigner.sendTransaction(params);
  }

  signMessage(message: Parameters<SignerAdapter["signMessage"]>[0]): ReturnType<
    SignerAdapter["signMessage"]
  > {
    return this.defaultSigner.signMessage(message);
  }

  broadcastRawTransaction(
    chainId: number,
    signedTx: Parameters<SignerAdapter["broadcastRawTransaction"]>[1],
  ): ReturnType<SignerAdapter["broadcastRawTransaction"]> {
    return this.defaultSigner.broadcastRawTransaction(chainId, signedTx);
  }
}
