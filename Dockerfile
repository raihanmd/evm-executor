# ─────────────────────────────────────────────────────────
# Stage 1: Install dependencies & compile standalone binary
# ─────────────────────────────────────────────────────────
FROM oven/bun:alpine AS builder

WORKDIR /app

# Install ALL dependencies (including dev for build)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Compile to a single static binary (includes Bun runtime + all deps)
# --compile produces a standalone executable with no external dependencies
RUN bun build --compile \
  src/index.ts \
  --outfile=/app/evm-executor

# ─────────────────────────────────────────────────────────
# Stage 2: Minimal runtime image
# ─────────────────────────────────────────────────────────
FROM alpine:3.21 AS runtime

# The compiled Bun binary requires C++ standard libraries at runtime.
# Also add ca-certificates (HTTPS/RPC) and tzdata (log timestamps).
RUN apk add --no-cache libstdc++ libgcc ca-certificates tzdata

# Security: non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy ONLY the compiled binary — nothing else
COPY --from=builder /app/evm-executor ./

ENV NODE_ENV=production

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["./evm-executor"]
