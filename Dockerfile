# ─────────────────────────────────────────────────────────
# Stage 1: Install dependencies & generate Prisma client
# ─────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder

# Prisma engine requires OpenSSL at build time
RUN apt-get update -y && apt-get install -y openssl ca-certificates tzdata

WORKDIR /app

# Install ALL dependencies (including dev — prisma CLI is devDep)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Copy Prisma schema + config, then generate client
COPY prisma ./prisma
COPY prisma.config.ts ./
ARG DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy
ENV DATABASE_URL=$DATABASE_URL
RUN bunx prisma generate

# Copy remaining source code
# (node_modules excluded by .dockerignore, so the installed deps survive)
COPY . .

# ─────────────────────────────────────────────────────────
# Stage 2: Production runtime image
# ─────────────────────────────────────────────────────────
FROM oven/bun:1 AS production

# openssl for Prisma engine, ca-certificates for HTTPS RPC, tzdata for logs
RUN apt-get update -y && apt-get install -y --no-install-recommends \
  openssl ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# Copy generated Prisma client from builder (the actual generated code)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Copy source code
COPY src ./src

ENV NODE_ENV=production

# Security: non-root user (oven/bun:1 ships with 'bun' user)
USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["bun", "run", "src/index.ts"]
