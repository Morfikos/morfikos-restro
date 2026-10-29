-- Adds floors, floor objects and photo-to-floor-map imports.
-- Existing DiningTable."floorName" text values are converted into Floor rows
-- (one per branch + name) and linked through DiningTable."floorId" before the
-- old column is dropped, so no table loses its floor.

-- CreateEnum
CREATE TYPE "TableShape" AS ENUM ('ROUND', 'SQUARE', 'RECTANGLE');

-- CreateEnum
CREATE TYPE "FloorObjectType" AS ENUM ('WALL', 'BAR_COUNTER', 'ENTRANCE', 'KITCHEN', 'WASHROOM', 'PILLAR', 'STAIRS', 'WINDOW', 'OTHER');

-- CreateEnum
CREATE TYPE "LayoutImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY_FOR_REVIEW', 'APPLIED', 'FAILED', 'DISCARDED');

-- AlterTable: add the new columns first; floorName is dropped at the end.
ALTER TABLE "DiningTable"
ADD COLUMN     "floorId" TEXT,
ADD COLUMN     "height" DOUBLE PRECISION NOT NULL DEFAULT 80,
ADD COLUMN     "positionX" DOUBLE PRECISION,
ADD COLUMN     "positionY" DOUBLE PRECISION,
ADD COLUMN     "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "shape" "TableShape" NOT NULL DEFAULT 'SQUARE',
ADD COLUMN     "width" DOUBLE PRECISION NOT NULL DEFAULT 80;

-- CreateTable
CREATE TABLE "Floor" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 1000,
    "height" INTEGER NOT NULL DEFAULT 600,
    "backgroundImageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorObject" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "type" "FloorObjectType" NOT NULL,
    "label" TEXT,
    "positionX" DOUBLE PRECISION NOT NULL,
    "positionY" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorLayoutImport" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "status" "LayoutImportStatus" NOT NULL DEFAULT 'PENDING',
    "proposedLayout" JSONB,
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorLayoutImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Floor_branchId_isActive_idx" ON "Floor"("branchId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_branchId_name_key" ON "Floor"("branchId", "name");

-- CreateIndex
CREATE INDEX "FloorObject_floorId_idx" ON "FloorObject"("floorId");

-- CreateIndex
CREATE INDEX "FloorLayoutImport_floorId_createdAt_idx" ON "FloorLayoutImport"("floorId", "createdAt");

-- CreateIndex
CREATE INDEX "DiningTable_floorId_idx" ON "DiningTable"("floorId");

-- AddForeignKey
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorObject" ADD CONSTRAINT "FloorObject_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLayoutImport" ADD CONSTRAINT "FloorLayoutImport_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLayoutImport" ADD CONSTRAINT "FloorLayoutImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data migration: one Floor per distinct (branch, floorName).
INSERT INTO "Floor" ("id", "branchId", "name", "updatedAt")
SELECT gen_random_uuid()::text, named."branchId", named."floorName", CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT "branchId", "floorName"
    FROM "DiningTable"
    WHERE "floorName" IS NOT NULL
) AS named;

-- Data migration: link each table to its new Floor.
UPDATE "DiningTable" AS t
SET "floorId" = f."id"
FROM "Floor" AS f
WHERE f."branchId" = t."branchId"
  AND f."name" = t."floorName";

-- AlterTable: the floor name now lives on Floor.
ALTER TABLE "DiningTable" DROP COLUMN "floorName";
