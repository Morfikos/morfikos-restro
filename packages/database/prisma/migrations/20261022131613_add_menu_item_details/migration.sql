-- AlterTable
ALTER TABLE "BranchMenuItem" ADD COLUMN     "comparePrice" DECIMAL(10,2),
ADD COLUMN     "deliveryAvailable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dineInAvailable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "parcelAvailable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "availableDays" TEXT[] DEFAULT ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::TEXT[],
ADD COLUMN     "availableTimeEnd" TEXT,
ADD COLUMN     "availableTimeStart" TEXT,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "isJain" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isRecommended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kitchenStation" TEXT NOT NULL DEFAULT 'hot_kitchen',
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MenuItemVariant" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extraPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "dineInAvailable" BOOLEAN NOT NULL DEFAULT true,
    "parcelAvailable" BOOLEAN NOT NULL DEFAULT true,
    "deliveryAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItemVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemAddon" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItemAddon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemVariant_menuItemId_name_key" ON "MenuItemVariant"("menuItemId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemAddon_menuItemId_name_key" ON "MenuItemAddon"("menuItemId", "name");

-- AddForeignKey
ALTER TABLE "MenuItemVariant" ADD CONSTRAINT "MenuItemVariant_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemAddon" ADD CONSTRAINT "MenuItemAddon_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
