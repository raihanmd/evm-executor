# EVM Transaction Executor

Production-grade EVM transaction signing and broadcasting service for SkillWallet.

## Purpose

This service is intentionally "dumb". It receives pre-built transaction parameters and safely signs + broadcasts them. It does **not** generate calldata, build swaps, interact with DeFi protocols, or manage portfolios — those responsibilities belong to upstream services.

```
Scheduler → Strategy Engine → Calldata Builder → Executor → Signer → Broadcast → tx hash
```

## Architecture

### Security Layers

| Layer | Protection | Implementation |
|-------|-----------|----------------|
| 1 | Internal network only | Deployment-level isolation |
| 2 | API key authentication | `Authorization: Bearer <key>` |
| 3 | Idempotency | `X-Request-ID` deduplication |
| 6 | Chain whitelist | Only configured chain IDs accepted |
| 7 | Contract whitelist | Per-chain destination allowlist |
| 8 | Native value restriction | Blocks native currency transfers unless enabled |
| 9 | Calldata format validation | Hex prefix, even length |
| 10 | Address validation | Via viem utilities |
| 11 | Payload size limit | Configurable max body size |
| 12 | Rate limiting | Per-IP sliding window |
| 13-14 | Structured logging + safe errors | No stack traces, no secrets in logs |
| 15 | RPC from config only | Client cannot choose RPC |
| 16-19 | Gas estimation, fee strategy, nonce, confirmation | Fully automated |

### Signer Abstraction

The signer backend is decoupled behind a `SignerAdapter` interface. Currently implements:

- **`PrivateKeySigner`** — signs with a raw private key

Future backends can be added without changing the public API:

- AWS KMS
- Fireblocks
- Smart Accounts
- MPC

## API

### `POST /v1/evm/execute`

**Headers:**
```
Authorization: Bearer <api_key>
X-Request-ID: <uuid> (optional, for idempotency)
```

**Request:**
```json
{
  "chainId": 56,
  "to": "0x...",
  "value": "0",
  "data": "0x..."
}
```

**Success Response (200):**
```json
{
  "success": true,
  "txHash": "0x..."
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
| `PRIVATE_KEY` | EVM private key (0x-prefixed) |
| `RPC_URL_<chainId>` | RPC endpoint per chain |
| `ALLOWED_CHAINS` | Comma-separated chain IDs |
| `CONTRACTS_<chainId>` | Comma-separated allowed contract addresses |
| `ALLOW_NATIVE` | Set to `1` to permit native value transfers |
| `GAS_MULTIPLIER` | Gas estimation multiplier (e.g., `1.20`) |
| `RATE_LIMIT_MAX` | Max requests per window |
| `LOG_LEVEL` | Pino log level |

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
