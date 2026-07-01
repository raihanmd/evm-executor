/*
  Warnings:

  - You are about to drop the column `blockNumber` on the `PositionCheck` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PositionCheck" DROP COLUMN "blockNumber";
