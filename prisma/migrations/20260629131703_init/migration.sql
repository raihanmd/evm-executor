-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('ACTIVE', 'OUT_OF_RANGE', 'REBALANCING', 'CLOSED', 'EXITED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExitReason" AS ENUM ('OOR_TIMEOUT', 'DRAWDOWN_STOP', 'RUG_TVL_DROP', 'REBALANCED', 'MANUAL');

-- CreateEnum
CREATE TYPE "CheckDecision" AS ENUM ('HOLD', 'REBALANCE', 'EXIT', 'NONE');

-- CreateEnum
CREATE TYPE "TxAction" AS ENUM ('APPROVE', 'SWAP', 'MINT', 'DECREASE_LIQUIDITY', 'COLLECT', 'SWEEP');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('SUCCESS', 'FAILED', 'REVERTED');

-- CreateTable
CREATE TABLE "Pool" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "token0Address" TEXT NOT NULL,
    "token1Address" TEXT NOT NULL,
    "token0Symbol" TEXT NOT NULL,
    "token1Symbol" TEXT NOT NULL,
    "token0Decimals" INTEGER NOT NULL,
    "token1Decimals" INTEGER NOT NULL,
    "feeTier" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenId" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'ACTIVE',
    "tickLower" INTEGER NOT NULL,
    "tickUpper" INTEGER NOT NULL,
    "rangePercent" INTEGER NOT NULL,
    "tickAtMint" INTEGER NOT NULL,
    "deployAmountUsdt" DECIMAL(30,6) NOT NULL,
    "amount0Deposited" TEXT NOT NULL,
    "amount1Deposited" TEXT NOT NULL,
    "liquidity" TEXT NOT NULL,
    "swapAmountIn" TEXT,
    "swapAmountOutMin" TEXT,
    "swapAmountOutActual" TEXT,
    "mintTxHash" TEXT NOT NULL,
    "mintBlockNumber" BIGINT NOT NULL,
    "mintedAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "lastInRangeAt" TIMESTAMP(3),
    "oorSince" TIMESTAMP(3),
    "exitReason" "ExitReason",
    "closeTxHash" TEXT,
    "closeBlockNumber" BIGINT,
    "closedAt" TIMESTAMP(3),
    "amount0Withdrawn" TEXT,
    "amount1Withdrawn" TEXT,
    "feesCollected0" TEXT,
    "feesCollected1" TEXT,
    "finalSweepAmountUsdt" DECIMAL(30,6),
    "pnlUsdt" DECIMAL(30,6),
    "pnlPercent" DECIMAL(10,4),
    "previousPositionId" TEXT,
    "rootPositionId" TEXT,
    "configSnapshot" JSONB NOT NULL,
    "recipientWallet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionCheck" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockNumber" BIGINT NOT NULL,
    "currentTick" INTEGER NOT NULL,
    "inRange" BOOLEAN NOT NULL,
    "currentValueUsdt" DECIMAL(30,6) NOT NULL,
    "drawdownPct" DECIMAL(10,4) NOT NULL,
    "poolTvl" DECIMAL(30,6) NOT NULL,
    "poolVolume24h" DECIMAL(30,6) NOT NULL,
    "poolFeesApr" DECIMAL(10,4) NOT NULL,
    "decision" "CheckDecision" NOT NULL,
    "decisionReason" TEXT NOT NULL,

    CONSTRAINT "PositionCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TxLog" (
    "id" TEXT NOT NULL,
    "positionId" TEXT,
    "txHash" TEXT NOT NULL,
    "action" "TxAction" NOT NULL,
    "status" "TxStatus" NOT NULL,
    "blockNumber" BIGINT,
    "gasUsed" BIGINT,
    "gasPriceWei" TEXT,
    "gasCostBnb" DECIMAL(20,10),
    "gasCostUsd" DECIMAL(20,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TxLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pool_chainId_address_key" ON "Pool"("chainId", "address");

-- CreateIndex
CREATE UNIQUE INDEX "Position_previousPositionId_key" ON "Position"("previousPositionId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_chainId_tokenId_key" ON "Position"("chainId", "tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "TxLog_txHash_key" ON "TxLog"("txHash");

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "Pool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_previousPositionId_fkey" FOREIGN KEY ("previousPositionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionCheck" ADD CONSTRAINT "PositionCheck_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TxLog" ADD CONSTRAINT "TxLog_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;
