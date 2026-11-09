-- CreateEnum
CREATE TYPE "TableSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "QrOrderStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ServiceRequestType" AS ENUM ('CALL_WAITER', 'WATER', 'NAPKINS', 'CUTLERY', 'BILL', 'CLEANING', 'OTHER');

-- CreateEnum
CREATE TYPE "ServiceRequestStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Kot" DROP CONSTRAINT "Kot_createdById_fkey";

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Kot" ALTER COLUMN "createdById" DROP NOT NULL;

-- CreateTable
CREATE TABLE "TableSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "TableSessionStatus" NOT NULL DEFAULT 'OPEN',
    "guestName" TEXT,
    "guestPhone" TEXT,
    "guestId" TEXT,
    "orderId" TEXT,
    "deviceCount" INTEGER NOT NULL DEFAULT 1,
    "billRequestedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,

    CONSTRAINT "TableSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "status" "QrOrderStatus" NOT NULL DEFAULT 'PENDING',
    "items" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "estimatedTotal" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "allergyNote" TEXT,
    "orderId" TEXT,
    "kotId" TEXT,
    "rejectReason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QrOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "type" "ServiceRequestType" NOT NULL,
    "status" "ServiceRequestStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "ServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrSettings" (
    "branchId" TEXT NOT NULL,
    "orderingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoAcceptOrders" BOOLEAN NOT NULL DEFAULT true,
    "requireGuestPhone" BOOLEAN NOT NULL DEFAULT false,
    "serviceRequestsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QrSettings_pkey" PRIMARY KEY ("branchId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TableSession_token_key" ON "TableSession"("token");

-- CreateIndex
CREATE INDEX "TableSession_tableId_status_idx" ON "TableSession"("tableId", "status");

-- CreateIndex
CREATE INDEX "TableSession_branchId_status_idx" ON "TableSession"("branchId", "status");

-- CreateIndex
CREATE INDEX "TableSession_orderId_idx" ON "TableSession"("orderId");

-- CreateIndex
CREATE INDEX "QrOrder_branchId_status_idx" ON "QrOrder"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "QrOrder_sessionId_roundNumber_key" ON "QrOrder"("sessionId", "roundNumber");

-- CreateIndex
CREATE INDEX "ServiceRequest_branchId_status_idx" ON "ServiceRequest"("branchId", "status");

-- CreateIndex
CREATE INDEX "ServiceRequest_sessionId_type_status_idx" ON "ServiceRequest"("sessionId", "type", "status");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Kot" ADD CONSTRAINT "Kot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrOrder" ADD CONSTRAINT "QrOrder_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TableSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrOrder" ADD CONSTRAINT "QrOrder_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TableSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrSettings" ADD CONSTRAINT "QrSettings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

