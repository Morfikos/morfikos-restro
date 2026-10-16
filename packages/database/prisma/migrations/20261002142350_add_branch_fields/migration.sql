
-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "address" TEXT NOT NULL,
ADD COLUMN     "businessDays" JSONB NOT NULL,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "gstin" TEXT NOT NULL,
ADD COLUMN     "invoiceFy" TEXT NOT NULL,
ADD COLUMN     "invoiceLastNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "phone" TEXT NOT NULL,
ADD COLUMN     "settings" JSONB,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "timezone" TEXT NOT NULL,
ALTER COLUMN "tables" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Branch_organizationId_idx" ON "Branch"("organizationId");

-- CreateIndex
CREATE INDEX "Branch_organizationId_status_idx" ON "Branch"("organizationId", "status");
