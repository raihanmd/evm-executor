/*
  Warnings:

  - You are about to drop the column `peakPnkPct` on the `Position` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Position" DROP COLUMN "peakPnkPct",
ADD COLUMN     "peakPnlPct" TEXT;
