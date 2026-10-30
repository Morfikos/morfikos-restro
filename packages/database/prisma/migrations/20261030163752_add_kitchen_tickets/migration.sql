-- CreateEnum
CREATE TYPE "KitchenTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'READY', 'SERVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Kot" ADD COLUMN     "roundNo" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "allergyNote" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "kitchenReadyAt" TIMESTAMP(3),
ADD COLUMN     "kitchenTicketId" TEXT;

-- CreateTable
CREATE TABLE "KitchenTicket" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kotId" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "status" "KitchenTicketStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "bumpedAt" TIMESTAMP(3),
    "lateNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KitchenTicket_branchId_status_createdAt_idx" ON "KitchenTicket"("branchId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "KitchenTicket_orderId_idx" ON "KitchenTicket"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenTicket_kotId_station_key" ON "KitchenTicket"("kotId", "station");

-- CreateIndex
CREATE INDEX "OrderItem_kitchenTicketId_idx" ON "OrderItem"("kitchenTicketId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_kitchenTicketId_fkey" FOREIGN KEY ("kitchenTicketId") REFERENCES "KitchenTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_kotId_fkey" FOREIGN KEY ("kotId") REFERENCES "Kot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: number each order's existing KOTs as rounds 1, 2, 3...
UPDATE "Kot" AS k
SET "roundNo" = ranked.round_no
FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "orderId" ORDER BY "createdAt", "kotNumber") AS round_no
    FROM "Kot"
) AS ranked
WHERE ranked."id" = k."id";

-- Backfill: one kitchen ticket per existing KOT and station, carrying the KOT's status.
INSERT INTO "KitchenTicket" ("id", "branchId", "orderId", "kotId", "station", "status", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    k."branchId",
    k."orderId",
    k."id",
    stations.station,
    CASE k."status"
        WHEN 'PENDING' THEN 'OPEN'::"KitchenTicketStatus"
        WHEN 'PREPARING' THEN 'IN_PROGRESS'::"KitchenTicketStatus"
        WHEN 'READY' THEN 'READY'::"KitchenTicketStatus"
        WHEN 'SERVED' THEN 'SERVED'::"KitchenTicketStatus"
        ELSE 'CANCELLED'::"KitchenTicketStatus"
    END,
    k."createdAt",
    CURRENT_TIMESTAMP
FROM "Kot" AS k
JOIN (
    SELECT DISTINCT "kotId", COALESCE("kitchenStation", 'hot_kitchen') AS station
    FROM "OrderItem"
    WHERE "kotId" IS NOT NULL
) AS stations ON stations."kotId" = k."id";

-- Backfill: link each sent item to its station's ticket.
UPDATE "OrderItem" AS i
SET "kitchenTicketId" = t."id"
FROM "KitchenTicket" AS t
WHERE t."kotId" = i."kotId"
  AND t."station" = COALESCE(i."kitchenStation", 'hot_kitchen');
