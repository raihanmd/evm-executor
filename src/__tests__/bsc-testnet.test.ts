import { describe, it, expect, beforeAll } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { createLogger, resetLogger } from "../logger/index.ts";
import { PrivateKeySigner } from "../signer/private-key.ts";
import { ExecuteService } from "../services/execute.ts";

describe("BSC Testnet — native transfer to self", () => {
  const config = loadConfig();
  const signer = new PrivateKeySigner(config);
  const service = new ExecuteService(config, signer);

  beforeAll(() => {
    resetLogger();
    createLogger(config.logLevel);
  });

  it("sends 0.0001 BNB to the signer's own address", async () => {
    const from = await signer.getAddress();
    console.log(`Signer address: ${from}`);
    console.log(`Chain: 97 (BSC Testnet)`);
    console.log(`Value: 0.0001 BNB (100000000000000 wei)`);

    const response = await service.execute({
      chainId: 97,
      to: from,
      value: "100000000000000",
      data: "0x",
    });

    if (!response.success) {
      console.log(`Error: ${response.message}`);
      expect(false).toBe(true);
      return;
    }

    expect(response.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    console.log(`Tx hash: ${response.txHash}`);
    if (response.blockNumber) {
      console.log(`Block: ${response.blockNumber}`);
    }
    if (response.status) {
      console.log(`Status: ${response.status}`);
    }
  }, 120_000);
});
