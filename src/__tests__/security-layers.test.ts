/**
 * HTTP-level security-layer integration tests.
 *
 * Every test sends real HTTP requests to a local Bun server,
 * exercising the full middleware chain + route handler.
 *
 * Security layers tested:
 *   2  — API key auth
 *   5  — Idempotency
 *   6  — Chain whitelist
 *   9  — Calldata format validation
 *  10  — Address validation
 *  11  — Payload size limit
 *  12  — Rate limiting (smoke)
 *  13–14 — Structured logging + safe errors (response format)
 */

// ── Test env (must be set BEFORE any imports that read process.env) ─────────
process.env.API_KEY = "test-api-key";
process.env.PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.ALLOWED_CHAINS = "1,56";
process.env.RPC_URL_1 = "http://127.0.0.1:1";
process.env.RPC_URL_56 = "http://127.0.0.1:1";

process.env.LOG_LEVEL = "silent";
process.env.RATE_LIMIT_MAX = "100";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.MAX_BODY_SIZE = "512";
process.env.GAS_MULTIPLIER = "1.20";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { createLogger, resetLogger } from "../logger/index.ts";
import { PrivateKeySigner } from "../signer/private-key.ts";
import { createApp } from "../app/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_API_KEY = "test-api-key";

const DEFAULT_BODY = {
  chainId: 56,
  to: "0x0000000000000000000000000000000000000001",
  value: "0",
  data: "0x",
};

interface RequestOpts {
  body?: unknown;
  apiKey?: string;
  requestId?: string;
  headers?: Record<string, string>;
}

async function signedRequest(
  baseUrl: string,
  opts: RequestOpts = {},
): Promise<Response> {
  const {
    body = DEFAULT_BODY,
    apiKey = TEST_API_KEY,
    requestId,
    headers: extraHeaders = {},
  } = opts;

  const rawBody = JSON.stringify(body);

  const allHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(requestId ? { "X-Request-ID": requestId } : {}),
    ...extraHeaders,
  };

  return fetch(`${baseUrl}/v1/evm/execute`, {
    method: "POST",
    headers: allHeaders,
    body: rawBody,
  });
}

async function expectJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const body = await response.json();
  expect(typeof body).toBe("object");
  return body as Record<string, unknown>;
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe("Security layers — POST /v1/evm/execute", () => {
  let server: any;
  let baseUrl: string;

  beforeAll(() => {
    resetLogger();
    createLogger("silent");

    const config = loadConfig();
    const signer = new PrivateKeySigner(config);
    const app = createApp(config, signer);

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop();
  });

  // ── Layer 2 — API Key Authentication ──────────────────────────────────────

  describe("Layer 2 — API Key Auth", () => {
    it("rejects requests without Authorization header", async () => {
      const rawBody = JSON.stringify(DEFAULT_BODY);

      const res = await fetch(`${baseUrl}/v1/evm/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
      });

      expect(res.status).toBe(401);
      const body = await expectJson(res);
      expect(body.success).toBe(false);
      expect(body.message).toMatch(/authorization/i);
    });

    it("rejects requests with wrong API key", async () => {
      const res = await signedRequest(baseUrl, { apiKey: "wrong-key" });
      expect(res.status).toBe(401);
      const body = await expectJson(res);
      expect(body.success).toBe(false);
      expect(body.message).toMatch(/api key/i);
    });
  });

  // ── Layer 5 — Idempotency ─────────────────────────────────────────────────

  describe("Layer 5 — Idempotency", () => {
    it("returns 409 when the same X-Request-ID is sent twice", async () => {
      const requestId = "idem-test-001";

      // First request fails (fake RPC, no contract whitelist anymore),
      // but the 500 is still cached by idempotency middleware.
      const res1 = await signedRequest(baseUrl, {
        requestId,
        body: { ...DEFAULT_BODY, chainId: 1, to: "0x0000000000000000000000000000000000000001" },
      });
      expect(res1.status).toBe(500);

      // Second request with same ID — idempotency key exists → 409
      const res2 = await signedRequest(baseUrl, { requestId });
      expect(res2.status).toBe(409);
      const body2 = await expectJson(res2);
      expect(body2.message).toMatch(/already been processed/i);
    });

    it("allows requests without X-Request-ID", async () => {
      const res = await signedRequest(baseUrl);
      expect(res.status).toBe(500);
    });
  });

  // ── Layer 6 — Chain Whitelist ─────────────────────────────────────────────

  describe("Layer 6 — Chain Whitelist", () => {
    it("rejects chain not in ALLOWED_CHAINS", async () => {
      const res = await signedRequest(baseUrl, {
        body: { ...DEFAULT_BODY, chainId: 999 },
      });
      expect(res.status).toBe(400);
      const body = await expectJson(res);
      expect(body.success).toBe(false);
      expect(body.message).toMatch(/not allowed/i);
    });
  });



  // ── Layer 9+10 — Calldata + Address Validation ───────────────────────────

  describe("Layer 9+10 — Calldata & Address Validation", () => {
    it("rejects data without 0x prefix", async () => {
      const res = await signedRequest(baseUrl, {
        body: { ...DEFAULT_BODY, data: "aabbccdd" },
      });
      expect(res.status).toBe(400);
      const body = await expectJson(res);
      expect(body.message).toMatch(/0x/i);
    });

    it("rejects data with odd length", async () => {
      const res = await signedRequest(baseUrl, {
        body: { ...DEFAULT_BODY, data: "0xaaa" },
      });
      expect(res.status).toBe(400);
      const body = await expectJson(res);
      expect(body.message).toMatch(/even|length/i);
    });

    it("rejects invalid 'to' address", async () => {
      const res = await signedRequest(baseUrl, {
        body: { ...DEFAULT_BODY, to: "not-an-address" },
      });
      expect(res.status).toBe(400);
      const body = await expectJson(res);
      expect(body.message).toMatch(/address/i);
    });
  });

  // ── Layer 11 — Payload Size ───────────────────────────────────────────────

  describe("Layer 11 — Payload Size", () => {
    it("rejects body larger than MAX_BODY_SIZE", async () => {
      const longHex = "0x" + "ab".repeat(260);
      const bigBody = { ...DEFAULT_BODY, data: longHex };

      const rawBody = JSON.stringify(bigBody);
      expect(rawBody.length).toBeGreaterThan(512);

      const res = await fetch(`${baseUrl}/v1/evm/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY}`,
          "Content-Length": String(rawBody.length),
        },
        body: rawBody,
      });

      expect(res.status).toBe(400);
      const body = await expectJson(res);
      expect(body.message).toMatch(/too large|exceeds limit/i);
    });
  });

  // ── Layer 12 — Rate Limiting (smoke) ──────────────────────────────────────

  describe("Layer 12 — Rate Limiting", () => {
    it("rate limiter is wired up and passes under limit", async () => {
      const res = await signedRequest(baseUrl);
      expect(res.status).toBe(500);
    });
  });

  // ── Layers 13–14 — Safe Error Response Format ─────────────────────────────

  describe("Layers 13–14 — Safe Error Responses", () => {
    it("all error responses have { success, message } shape", async () => {
      const res = await signedRequest(baseUrl, { apiKey: "bad" });
      expect(res.status).toBe(401);
      const body = await expectJson(res);
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("message");
      const text = JSON.stringify(body).toLowerCase();
      expect(text).not.toContain("stack");
      expect(text).not.toContain("privatekey");
    });

    it("does not expose internal error details", async () => {
      const res = await signedRequest(baseUrl);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text.toLowerCase()).not.toContain("stack");
      expect(text.toLowerCase()).not.toContain("trace");
    });
  });
});
