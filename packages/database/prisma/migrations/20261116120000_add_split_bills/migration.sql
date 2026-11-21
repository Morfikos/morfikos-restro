-- CreateEnum
CREATE TYPE "BillSplitMode" AS ENUM ('EQUAL', 'CUSTOM_AMOUNT', 'PERCENTAGE', 'ITEMS');

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "splitAt" TIMESTAMP(3),
ADD COLUMN     "splitById" TEXT,
ADD COLUMN     "splitMode" "BillSplitMode";

-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN     "splitPartId" TEXT;

-- CreateTable
CREATE TABLE "BillSplitPart" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "label" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "taxPaise" INTEGER NOT NULL DEFAULT 0,
    "paidPaise" INTEGER NOT NULL DEFAULT 0,
    "percent" DECIMAL(5,2),
    "items" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillSplitPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillSplitPart_billId_partNumber_key" ON "BillSplitPart"("billId", "partNumber");

-- CreateIndex
CREATE INDEX "BillPayment_splitPartId_idx" ON "BillPayment"("splitPartId");

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_splitById_fkey" FOREIGN KEY ("splitById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_splitPartId_fkey" FOREIGN KEY ("splitPartId") REFERENCES "BillSplitPart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillSplitPart" ADD CONSTRAINT "BillSplitPart_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

