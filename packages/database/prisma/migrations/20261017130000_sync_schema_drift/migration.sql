-- Records schema changes that were applied to the database outside the
-- migration history (Branch.fssaiNo, required city/state, unique org email).

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN "fssaiNo" TEXT;

-- AlterTable
ALTER TABLE "Branch" ALTER COLUMN "city" SET NOT NULL,
ALTER COLUMN "state" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_email_key" ON "Organization"("email");
