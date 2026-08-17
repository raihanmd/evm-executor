# Plan: Multi-Key Signer + Gas Price Override for `/execute`

## Goal

1. **Multi private key support** — select the signing wallet per-request via an `X-Signer-Address` header on `POST /v1/evm/execute` only.
2. **Gas price override** — optional body fields on `/execute` to control legacy gas price or EIP-1559 max fees.
3. **Strictly non-breaking** — no header = today's exact behavior (default `PRIVATE_KEY`, auto fee estimation). All other routes untouched.

---

## Non-Breaking Guarantees (verify before merge)

| Aspect | Status |
|---|---|
| Request body fields (`chainId`, `to`, `value`, `data`, `abi`) | Unchanged, same requirements |
| Response shape (`success`, `txHash`, `blockNumber`, `status`, `gasUsed`, `gasPriceWei`, `logs`) | Unchanged (+ additive `from` field, optional) |
| No header → default `PRIVATE_KEY` signer | Identical behavior |
| No gas override fields → auto fee estimation | Identical behavior (formula preserved, see §5) |
| `/call`, `/read`, `/call-multicall`, `/pool-volume` | Not modified |
| Auth / idempotency / rate-limit / payload-size middleware | Not modified |
| Unknown `X-Signer-Address` → hard reject (never silent fallback) | New, only triggers when header sent (impossible in current prod) |

---

## Design Decisions (confirmed)

- **D1 — Env config**: `PRIVATE_KEY` remains default. Additional keys via `PRIVATE_KEY_2`, `PRIVATE_KEY_3`, … parsed until a missing index. Invalid key format → **fail fast at startup**.
- **D2 — Header name**: `X-Signer-Address`, value = signer's checksummed/raw address. Absent → default signer. Present but unknown → **400 error** (`Signer <addr> is not registered`). Present but malformed → **400 error**.
- **D3 — Cap interaction (DEFAULT: reject, flag for user veto)**: if `MAX_GAS_PRICE_GWEI` is set (>0) and an override field exceeds the cap → **reject with 400** (no silent clamp, no silent bypass). Rationale: clamp causes stuck txs without notice; allow-bypass defeats the safety layer. User may switch to clamp if preferred.
- **D4 — Override field shape (two-variant, best practice)**:
  - `gasPrice` (numeric string, wei) → forces **legacy** tx.
  - `maxFeePerGas` + optional `maxPriorityFeePerGas` (numeric strings, wei) → forces **EIP-1559**; missing `maxPriorityFeePerGas` defaults to 1 gwei (matches current fallback).
  - Both `gasPrice` AND `maxFeePerGas` present → **400 conflict error**.
  - Neither present → auto-estimate (existing behavior).
- **D5 — Fee estimation refactor (user-mandated)**: replace manual `getBlock`+`getFeeHistory` logic in `estimateFees()` with viem's built-in `estimateFeesPerGas` (try eip1559 → catch `Eip1559FeesNotSupportedError` → fallback legacy), preserving the exact current formula via `fees.baseFeeMultiplier = 2` on the estimation client (current prod: `maxFee = baseFee × 2 + priorityFee`). Keep the 1 gwei priority floor on the **auto-estimate path** (preserves prod behavior exactly).
- **D6 — L2 compatibility (verified against official docs, Aug 2026)**:
  - **BSC** = L1 (PoSA, 21 validators), EIP-1559 live since Bruno fork. Real block-space competition → override buys real inclusion speed. **Legacy `gasPrice` and EIP-1559 both accepted.**
  - **Base** = OP Stack, single sequencer. Priority fees follow EIP-1559 spec but are collected by the Sequencer Fee Vault — a higher tip does **not** accelerate inclusion (sequencer orders FIFO). Dominant cost is the L1-cost fee. Both tx types accepted (EIP-2718 legacy allowed).
  - **Robinhood Chain (RH Chain, chainId 4663)** = Arbitrum Orbit. Docs: *"tips are ignored... users always pay the basefee regardless of the tip"*; gas price floor 0.1 gwei (`getMinimumGasPrice`). Legacy and EIP-1559 both accepted.
  - **Implication**: on sequencer L2s (Base, RH/Arbitrum) `maxPriorityFeePerGas` is effectively inert — only **BSC** benefits from it. The override's real value on L2s = cost ceiling + floor guarantee, not speed. Feature still ships (BSC needs it), semantics documented per-chain in README.
- **D7 — Floor check (new, safety)**: when an override is present, reject 400 if it is **below the current on-chain base fee** (from `getBlock().baseFeePerGas`, only when base fee exists — skip on pure-legacy chains). Prevents: underpriced txs that sit pending forever on Base (where L1 fee adds on top), and below-floor txs on Arbitrum/RH. Auto-estimate path unaffected (already produces valid prices).
- **D8 — Override path priority default = 0 gwei**: when only `maxFeePerGas` is sent (no `maxPriorityFeePerGas`), default priority to **0 gwei** — the user explicitly controls the ceiling; a 1 gwei artificial floor would inflate cost on low-base-fee L2s (Base ~0.001 gwei) and is meaningless on Arbitrum where tips are ignored. (The 1 gwei floor in D5 applies only to the auto-estimate path.)
- **D9 — Racing modes (user-requested; ALL opt-in, default = current behavior unchanged)**. Three fee-control modes on `/execute`:
  - **Mode A — Multiplier (recommended for racing)**: field `gasPriceMultiplier` (decimal string ≥ 1.0, e.g. `"3.0"`). Server fetches **current** network price via a single fast `eth_gasPrice` call and multiplies: `target = price × multiplier`. Legacy → `gasPrice = target`; EIP-1559 → `maxFeePerGas = target` + priority 0. **Never underpriced** (relative to live price) — this is the robust racing answer; the reference price already reflects recent blocks (answers "multiplier of previous average" but live, not stale).
  - **Mode B — Absolute bypass**: `gasPrice` / `maxFeePerGas`(±`maxPriorityFeePerGas`) as previously designed (D4). **Skips all fee RPC calls** — fastest path; caller owns the underpricing risk. Only mode subject to the D7 floor check.
  - **Mode C — Gas limit bypass**: optional `gasLimit` (numeric string) **skips `estimateGas`** (the slowest RPC call in the critical path). Caller responsible for correctness — too-low limit = on-chain out-of-gas. Skips the revert-guard; documented clearly in README.
  - **Mutual exclusion**: `gasPriceMultiplier` XOR any absolute field (400 "cannot combine gasPriceMultiplier with gasPrice/maxFeePerGas"); `gasPrice` XOR `maxFeePerGas` (existing D4 rule). `gasLimit` may combine with any fee mode.
  - **EIP-1559 ceiling insight (README)**: on EIP-1559 chains `maxFeePerGas` is a ceiling, not the amount paid (you pay `baseFee + tip` actual). A high ceiling cannot overpay — it only guarantees no price-stuck tx. On legacy chains `gasPrice` IS the amount paid, so overshooting = overpay. This is why Mode A is the safe racing default.
  - **Cap (D3) applies to ALL modes**: multiplier result or absolute > `MAX_GAS_PRICE_GWEI` → 400.
  - **Naming guard**: new field `gasPriceMultiplier` is DISTINCT from existing env `GAS_MULTIPLIER` (which buffers the gas *limit* estimate, not price) — documented to avoid confusion.

---

## Critical Internal Correctness Fixes

The `ExecuteService` has two per-request caches that are currently keyed **without** the signer. With multi-key these must include the resolved signer address, otherwise:

1. **Content idempotency cache** — key is `chainId:to:value:data`. Two identical bodies signed by *different* wallets would share the cached result (wallet B would "succeed" with wallet A's tx).
   → New key: `chainId:signerAddr:to:value:data`.
2. **Per-chain nonce queue** — keyed by `chainId` only. Different wallets have independent nonces; serializing them is unnecessary but harmless. **However** the queue MUST be per-`(chainId, signerAddr)` so a slow tx for wallet A doesn't block wallet B.
   → New key: `${chainId}:${signerAddr}`.

These are internal-only; no external behavior change.

---

## File Changes

### 1. `src/config/index.ts`
- `EnvConfig` += `additionalPrivateKeys: string[]`.
- `loadConfig()`: loop `PRIVATE_KEY_${i}` from `i=2` until missing/empty; validate each against `/^0x[0-9a-fA-F]{64}$/` → `InternalError` on invalid (fail fast).
- `.env.example`: document `PRIVATE_KEY_2=`, `PRIVATE_KEY_3=`.

### 2. `src/signer/private-key.ts`
- Constructor: `constructor(config: EnvConfig, privateKey: Address = config.privateKey)` — backward compatible; existing `new PrivateKeySigner(config)` call sites unchanged.
- All methods use `this.privateKey` instead of `this.config.privateKey`.

### 3. `src/signer/registry.ts` (NEW)
- `class SignerRegistry implements SignerAdapter`:
  - `static fromConfig(config): SignerRegistry` — builds one `PrivateKeySigner` per key (`PRIVATE_KEY` + all `PRIVATE_KEY_N`), maps `lowercase address → signer` via `privateKeyToAccount`.
  - `static single(signer): SignerRegistry` — wraps an existing single signer (used by tests).
  - Delegates `getAddress` / `sendTransaction` / `signMessage` / `broadcastRawTransaction` to the **default** signer.
  - `resolve(address?: string): SignerAdapter` — empty → default; normalize via `getAddress` (malformed → `ValidationError` 400); unknown → `ValidationError` 400 (`Signer <addr> is not registered`); found → signer. **(Consistent: both malformed and unknown → 400, matching D2 + test #3.)**

### 4. `src/app/index.ts`
- `createApp(config, signers: SignerRegistry | SignerAdapter)` — wraps plain signer via `SignerRegistry.single()`; passes registry to `createEvmRoutes`.

### 5. `src/index.ts`
- Build `SignerRegistry.fromConfig(config)` instead of `new PrivateKeySigner(config)`.

### 6. `src/validators/evm.ts`
- `ExecuteRequestBody` += optional `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `gasPriceMultiplier` (decimal string, e.g. `"3.0"`), `gasLimit` — all numeric-string style like `value`; `gasPriceMultiplier` accepts decimals (`/^\d+(\.\d+)?$/`), others integers.
- `.superRefine`/`refine`:
  - reject `gasPrice` + `maxFeePerGas` together ("cannot set both legacy gasPrice and EIP-1559 maxFeePerGas")
  - reject `gasPriceMultiplier` + any of (`gasPrice`/`maxFeePerGas`/`maxPriorityFeePerGas`) ("cannot combine gasPriceMultiplier with absolute fee fields")
  - `gasPriceMultiplier` must be ≥ 1.0 (lower would be racing sabotage / stuck tx)
  - `gasLimit` optional positive integer

### 7. `src/routes/evm.ts` — `/execute` ONLY
- Read `X-Signer-Address` header → `signers.resolve(header)`.
- Parse override fields from validated body → `bigint` (multiplier → scaled bigint via same parse as `GAS_MULTIPLIER`).
- Call `executeService.execute(req, { signer, gasPrice, maxFeePerGas, maxPriorityFeePerGas, gasPriceMultiplier, gasLimit })`.
- Log resolved signer address + fee mode used.
- Additive: include `from: signerAddress` in success response.

### 8. `src/services/execute.ts`
- `execute(req, opts?: ExecuteOptions)`; `ExecuteOptions = { signer: SignerAdapter; gasPrice?; maxFeePerGas?; maxPriorityFeePerGas?; gasPriceMultiplier?; gasLimit? }` (bigints). Default signer = `this.signer` (kept for `/call` etc. — actually all other routes also go through this service? **No**: `/call`, `/read`, `/call-multicall` call `executeService.execute` too → they pass no opts → default signer. Confirmed non-breaking.)
- Content-cache key += signer address; queue key = `${chainId}:${signerAddr}`.
- Fee resolution in `executeInner`:
  - **Mode A (multiplier)**: `target = getGasPrice(chainConfig) × multiplier`; then per chain fee model → legacy `gasPrice` or eip1559 `maxFeePerGas` (priority 0). (One fast RPC call.)
  - **Mode B (absolute)**: build `FeeEstimation` directly from fields (no RPC estimate).
  - **Mode C (gasLimit)**: if `opts.gasLimit` set → skip `estimateGas`, use it directly. Else existing `estimateGas` flow.
  - **Floor check (D7)**: Mode B only — if `baseFeePerGas` exists on latest block → reject 400 if absolute override < baseFee. Skip on pure-legacy chains (no baseFee). (Mode A is ≥ live price by construction; Mode C is about gas limit, not price.)
  - Cap check (D3): if `maxGasPriceWei > 0` and **any** effective fee (multiplier result or absolute) > cap → return `{ success: false, message }` with **400** (return the response object, don't throw `ForbiddenError`/403 — must match test #7).
  - No override → existing `estimateFees()` (now viem-based) + `applyGasPriceCap`.

### 9. `src/rpc/index.ts`
- Rewrite `estimateFees()` using viem built-ins:
  - `estimateFeesPerGas({ type: 'eip1559' })` on a client whose chain has `fees.baseFeeMultiplier = 2` (preserves `baseFee×2 + priority`).
  - Catch `Eip1559FeesNotSupportedError` → `estimateFeesPerGas({ type: 'legacy' })`.
  - Priority floor 1 gwei retained on auto-estimate path only (D5).
- Keep exported `FeeEstimation` shape identical (internal contract unchanged).
- Add helper `getCurrentGasPrice(chainConfig): Promise<bigint>` (single `eth_gasPrice` call — fast path for Mode A multiplier).
- Add helper `getCurrentBaseFee(chainConfig): Promise<bigint | undefined>` (latest block `baseFeePerGas`) for the D7 floor check.

### 10. README.md
- Document `X-Signer-Address` header, `PRIVATE_KEY_N` env vars, **all three fee modes** (multiplier / absolute / gasLimit), cap-reject behavior, mutual-exclusion rules, **EIP-1559 ceiling insight** (maxFeePerGas is a ceiling, not amount paid — high ceiling cannot overpay on EIP-1559; on legacy `gasPrice` IS the paid amount), and **per-chain fee semantics table** (D6): BSC = real priority competition; Base/RH Chain = sequencer FIFO, tips inert, override = cost ceiling + floor guarantee only.
- **Naming guard**: `gasPriceMultiplier` (price) vs existing `GAS_MULTIPLIER` (gas-limit buffer) — explicitly called out.

---

## Tests

**Existing** (must keep passing, minimal churn):
- `security-layers.test.ts` / `bsc-testnet.test.ts` use `new PrivateKeySigner(config)` + `createApp(config, signer)` → still compile via `SignerRegistry.single()` wrapper; no assertion changes expected.

**New**:
- `src/__tests__/multi-key.test.ts`:
  1. No header → default signer used (assert `from` address = default).
  2. `X-Signer-Address` matching `PRIVATE_KEY_2` → signs with that wallet (assert `from`).
  3. Unknown address → 400 with `not registered`.
  4. Malformed address → 400.
  5. `gasPrice` override forces legacy; `maxFeePerGas` forces eip1559.
  6. `gasPrice` + `maxFeePerGas` both → 400.
  7. Override > `MAX_GAS_PRICE_GWEI` cap → 400 (D3).
  8. Override < current base fee (mock baseFee) → 400 floor reject (D7, Mode B only).
  9. `gasPriceMultiplier` mode: multiplier result > cap → 400; multiplier < 1.0 → 400 (validator).
  10. `gasPriceMultiplier` + absolute fee field → 400 (mutual exclusion).
  11. `gasLimit` override skips estimateGas (assert gas limit used = provided value).
  12. Unit: content cache does not collide across two signers for identical bodies.
  13. Unit: nonce queue is per `(chainId, signerAddr)`.

---

## Implementation Order

1. Config (`additionalPrivateKeys`) + env docs.
2. `PrivateKeySigner` constructor param.
3. `SignerRegistry`.
4. Wire `index.ts` + `app/index.ts`.
5. Validator fields (gas modes + mutual exclusion) + conflict refine.
6. `rpc/index.ts` `estimateFees` viem rewrite + `getCurrentGasPrice` / `getCurrentBaseFee` helpers.
7. `ExecuteService` opts + cache/queue keying + fee resolution (Mode A/B/C + floor + cap).
8. `/execute` route (header resolution + override parsing + `from` field).
9. README.
10. Tests (new + run existing). `bun test` must pass.

## Rollback

Feature is additive + env-gated: removing `PRIVATE_KEY_N` and not sending the header/fields reverts to today's behavior with zero code change needed.
