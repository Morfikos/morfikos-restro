-- CreateEnum
CREATE TYPE "TableTransferType" AS ENUM ('TRANSFER', 'SWAP', 'MERGE', 'ITEM_MOVE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedIntoId" TEXT;

-- CreateTable
CREATE TABLE "TableTransfer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "transferNumber" INTEGER NOT NULL,
    "businessDate" TEXT NOT NULL,
    "type" "TableTransferType" NOT NULL,
    "fromOrderId" TEXT NOT NULL,
    "toOrderId" TEXT NOT NULL,
    "fromOrderNumber" TEXT NOT NULL,
    "toOrderNumber" TEXT NOT NULL,
    "fromTableId" TEXT,
    "toTableId" TEXT,
    "fromTableName" TEXT,
    "toTableName" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "kitchenItemCount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TableTransfer_branchId_createdAt_idx" ON "TableTransfer"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "TableTransfer_fromOrderId_idx" ON "TableTransfer"("fromOrderId");

-- CreateIndex
CREATE INDEX "TableTransfer_toOrderId_idx" ON "TableTransfer"("toOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "TableTransfer_branchId_businessDate_transferNumber_key" ON "TableTransfer"("branchId", "businessDate", "transferNumber");

-- AddForeignKey
ALTER TABLE "TableTransfer" ADD CONSTRAINT "TableTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableTransfer" ADD CONSTRAINT "TableTransfer_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableTransfer" ADD CONSTRAINT "TableTransfer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

