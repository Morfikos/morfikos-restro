/*
  Warnings:

  - Added the required column `city` to the `Branch` table without a default value. This is not possible if the table is not empty.
  - Added the required column `state` to the `Branch` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
-- ALTER TABLE "Branch" ADD COLUMN     "city" TEXT NOT NULL,
-- ADD COLUMN     "state" TEXT NOT NULL;
-- ALTER TABLE "Branch"
-- ADD COLUMN "city" TEXT,
-- ADD COLUMN "state" TEXT;

-- UPDATE "Branch"
-- SET
--   "city" = 'Sohna',
--   "state" = 'Haryana'
-- WHERE "id" = '567385f3-b257-4926-a307-f78cec4705e7';

-- ALTER TABLE "Branch"
-- ALTER COLUMN "city" SET NOT NULL;

-- ALTER TABLE "Branch"
-- ALTER COLUMN "state" SET NOT NULL;
ALTER TABLE "Branch"
ADD COLUMN "city" TEXT,
ADD COLUMN "state" TEXT;