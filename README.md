# EVM Transaction Executor

Production-grade EVM transaction signing and broadcasting service for SkillWallet.

## Purpose

This service is intentionally "dumb". It receives pre-built transaction parameters and safely signs + broadcasts them. It does **not** generate calldata, build swaps, interact with DeFi protocols, or manage portfolios — those responsibilities belong to upstream services.

```
Scheduler → Strategy Engine → Calldata Builder → Executor → Signer → Broadcast
```
## API

### `POST /v1/evm/execute`

**Headers:**
```
Authorization: Bearer <api_key>
X-Request-ID: <uuid> (optional, for idempotency)
X-Signer-Address: <signer_address> (optional, selects which wallet signs — see Multi-Signer below)
```

**Request:**
```json
{
  "chainId": 56,
  "to": "0x...",
  "value": "0",
  "data": "0x...",
  "gasPrice": "5000000000",
  "maxFeePerGas": "6000000000",
  "maxPriorityFeePerGas": "1000000000",
  "gasPriceMultiplier": "3.0",
  "gasLimit": "100000"
}
```

All gas fields are optional — absent = automatic estimation (current behavior).
Fee modes are mutually exclusive, see [Gas Price Control](#gas-price-control).

**Success Response (200):**
```json
{
  "success": true,
  "txHash": "0x...",
  "from": "0x..."
}
```

**Error Response (4xx/5xx):**
```json
{
  "success": false,
  "message": "Human-readable error"
}
```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `API_KEY` | Bearer token for authentication |
| `PRIVATE_KEY` | EVM private key (0x-prefixed) — default signer |
| `PRIVATE_KEY_2`, `PRIVATE_KEY_3`, ... | Additional signer keys, selectable via `X-Signer-Address` on `/execute` |
| `RPC_URL_<chainId>` | RPC endpoint per chain |
| `ALLOWED_CHAINS` | Comma-separated chain IDs |
| `CONTRACTS_<chainId>` | Comma-separated allowed contract addresses |
| `ALLOW_NATIVE` | Set to `1` to permit native value transfers |
| `GAS_MULTIPLIER` | Gas **limit** estimation multiplier (e.g., `1.20`) — distinct from `gasPriceMultiplier` |
| `MAX_GAS_PRICE_GWEI` | Rejects any fee price above this cap (400) instead of clamping |
| `RATE_LIMIT_MAX` | Max requests per window |
| `LOG_LEVEL` | Pino log level |

## Multi-Signer

The service can hold multiple wallets. The default signer is `PRIVATE_KEY`; additional wallets are configured with `PRIVATE_KEY_2`, `PRIVATE_KEY_3`, and so on.

On `POST /v1/evm/execute`, send the header to pick which wallet signs:

```
X-Signer-Address: 0x<address of PRIVATE_KEY_2's account>
```

- **Header absent** → `PRIVATE_KEY` (default) signs — behavior unchanged.
- **Header present + registered** → that wallet signs; the response includes a `from` field with the signer address.
- **Header present + unknown address** → `400` (`Signer <addr> is not registered`).
- **Header present + malformed address** → `400` (`Invalid X-Signer-Address`).
- Only `/execute` honors this header; all other endpoints always use the default signer.

## Gas Price Control

All gas fields on `/execute` are optional and **opt-in** — requests without them behave exactly as before (auto-estimation with the real P50 priority reward from fee history + `MAX_GAS_PRICE_GWEI` cap).

The fields are mutually exclusive (400 if combined):

| Mode | Field(s) | Behavior | RPC calls |
|------|----------|----------|-----------|
| **A — Multiplier** | `gasPriceMultiplier` e.g. `"3.0"` | Live `eth_gasPrice` × multiplier (≥ 1.0) | 1 |
| **B — Absolute** | `gasPrice` (legacy) **or** `maxFeePerGas` + `maxPriorityFeePerGas` (EIP-1559) | Use the exact price given; `maxPriorityFeePerGas` defaults to 0 | 0 |
| **C — Gas limit** | `gasLimit` | Skip gas estimation entirely — caller guarantees enough gas | 0 |

Notes:

- **Multiplier is not the same as `GAS_MULTIPLIER`.** `gasPriceMultiplier` scales the *price* for racing (e.g. `"3.0"` = 3× current price). `GAS_MULTIPLIER` is an env var that buffers the *gas limit* estimate.
- **Cap (D3):** any resulting price above `MAX_GAS_PRICE_GWEI` → `400` (rejected, never silently clamped).
- **Floor (D7):** an absolute price below the current on-chain base fee → `400` (prevents stuck/pending transactions).
- **EIP-1559 ceiling insight:** `maxFeePerGas` is a *ceiling*, not the amount paid — you pay `baseFee + tip`. A high ceiling cannot overpay on EIP-1559 chains (network only takes what it needs). On legacy chains, `gasPrice` **is** the exact amount paid.
- **Intended for racing** (submit-first) or cost-capping. On BSC tips are real competition; on sequencer L2s (Base, Robinhood Chain) tips are inert — the override there sets a cost ceiling, not speed.

| Chain | Fee model | What an override does |
|-------|-----------|-----------------------|
| BSC (56) | EIP-1559 | Real priority competition — higher tip = earlier inclusion |
| BSC Testnet (97) | EIP-1559 | Same as BSC |
| Base (8453) | EIP-1559 (OP Stack) | Sequencer FIFO — tips inert (collected to fee vault); override = cost ceiling + L1-cost buffer |
| Robinhood Chain (4663) | EIP-1559 (Arbitrum Orbit) | Sequencer FIFO, tips ignored, 0.1 gwei floor — override = cost ceiling + floor guarantee |

## Development

```bash
bun install
bun run dev
```

## Production

```bash
NODE_ENV=production bun run start
```

## Docker

### Image

Multi-stage build compiles the app into a standalone binary (~103 MB):

```bash
docker build -t evm-executor .
```

The image uses:
- **Stage 1** (`oven/bun:alpine`): install deps + `bun build --compile`
- **Stage 2** (`alpine:3.21`): minimal runtime — only the binary, libstdc++, CA certs, and tzdata
- Runs as **non-root** user (`appuser`)
- `NODE_ENV=production` set by default
- Health check on `GET /health`

### docker-compose

```bash
# Start
docker compose up -d

# Logs
docker compose logs -f

# Stop
docker compose down
```

The compose file maps port **3000**, restarts automatically unless stopped, and reads secrets from `.env`.

## Deployment (VPS)

### Prerequisites

- Ubuntu 22.04+ / Debian 12+ (or any Linux with Docker support)
- Docker + Docker Compose (v2)

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in, or: newgrp docker
```

### 2. Set up the project

```bash
# Create directory
mkdir -p /opt/evm-executor
cd /opt/evm-executor

# Copy files (from your build machine or git)
# Required: docker-compose.yml, .env, Dockerfile, src/
```

### 3. Configure secrets

```bash
cp .env.example .env
# Edit .env with production values:
#   API_KEY                              — generated via openssl rand -hex 32
#   PRIVATE_KEY                          — EVM private key (0x-prefixed)
#   RPC_URL_<chainId>                    — your private RPC endpoint
#   ALLOWED_CHAINS                       — only what you need
#   CONTRACTS_<chainId>                  — restrict destination contracts
#   ALLOW_NATIVE=0                       — keep disabled unless required
nano .env
```

### 4. Build & start

```bash
docker compose build --pull
docker compose up -d
```

### 5. Verify

```bash
# Health check
curl http://localhost:3000/health

# Logs
docker compose logs -f

# Test a ping
curl -s -X POST http://localhost:3000/v1/evm/execute \
  -H "Authorization: Bearer $(grep API_KEY .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"chainId":97,"to":"0x...","value":"0","data":"0x"}'
```

### 6. Firewall

Only expose the port if upstream services are on different machines:

```bash
sudo ufw allow 3000/tcp    # if needed
# Preferably: restrict to private subnet
sudo ufw allow from 10.0.0.0/8 to any port 3000
```

### 7. Updates

```bash
cd /opt/evm-executor
git pull                          # pull new code
docker compose build --pull       # rebuild image
docker compose up -d              # restart with new image
docker system prune -f            # clean old images
```
