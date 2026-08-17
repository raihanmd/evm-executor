import { loadConfig } from "./config/index.ts";
import { createLogger, getLogger } from "./logger/index.ts";
import { createApp } from "./app/index.ts";
import { SignerRegistry } from "./signer/registry.ts";

function main(): void {
  // Load configuration from environment
  const config = loadConfig();

  // Initialize structured logging
  createLogger(config.logLevel);
  const logger = getLogger();

  logger.info("Starting EVM Transaction Executor");

  // Initialize signer registry (default + additional keys)
  const signers = SignerRegistry.fromConfig(config);

  // Create the Hono application
  const app = createApp(config, signers);

  // Start the server
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: app.fetch,
  });

  logger.info(
    {
      port: server.port,
      hostname: server.hostname,
    },
    "EVM Transaction Executor is running",
  );
}

main();
