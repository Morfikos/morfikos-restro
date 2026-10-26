-- AlterTable
ALTER TABLE "DiningTable" ADD COLUMN     "floorName" TEXT,
ADD COLUMN     "seats" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "DiningTable_branchId_isActive_idx" ON "DiningTable"("branchId", "isActive");
