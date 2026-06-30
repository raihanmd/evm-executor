-- AlterTable: Pool
-- Convert TIMESTAMP(3) createdAt to BIGINT Unix epoch seconds
ALTER TABLE "Pool" ALTER COLUMN "createdAt" DROP DEFAULT;
ALTER TABLE "Pool" ALTER COLUMN "createdAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "createdAt")::bigint);

-- AlterTable: Position
-- Convert all TIMESTAMP(3) columns to BIGINT Unix epoch seconds
ALTER TABLE "Position" ALTER COLUMN "mintedAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "mintedAt")::bigint);
ALTER TABLE "Position" ALTER COLUMN "lastCheckedAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "lastCheckedAt")::bigint);
ALTER TABLE "Position" ALTER COLUMN "lastInRangeAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "lastInRangeAt")::bigint);
ALTER TABLE "Position" ALTER COLUMN "oorSince" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "oorSince")::bigint);
ALTER TABLE "Position" ALTER COLUMN "closedAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "closedAt")::bigint);
ALTER TABLE "Position" ALTER COLUMN "createdAt" DROP DEFAULT;
ALTER TABLE "Position" ALTER COLUMN "createdAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "createdAt")::bigint);
ALTER TABLE "Position" ALTER COLUMN "updatedAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "updatedAt")::bigint);

-- AlterTable: PositionCheck
ALTER TABLE "PositionCheck" ALTER COLUMN "checkedAt" DROP DEFAULT;
ALTER TABLE "PositionCheck" ALTER COLUMN "checkedAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "checkedAt")::bigint);

-- AlterTable: TxLog
ALTER TABLE "TxLog" ALTER COLUMN "createdAt" DROP DEFAULT;
ALTER TABLE "TxLog" ALTER COLUMN "createdAt" SET DATA TYPE BIGINT USING (EXTRACT(EPOCH FROM "createdAt")::bigint);
