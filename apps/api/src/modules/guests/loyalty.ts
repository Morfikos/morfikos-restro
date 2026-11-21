import type { createPrismaClient } from "@morfikos/database";

import { LoyaltyTransactionType, PAISE_PER_LOYALTY_POINT } from "./constants.js";

/**
 * Loyalty bookkeeping run inside the billing module's transactions, so a
 * visit and its points are saved together with the settlement (or credit
 * note) that caused them.
 */

/** The Prisma client available inside an interactive transaction. */
type TransactionClient = Omit<
  ReturnType<typeof createPrismaClient>,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/**
 * Records a guest's visit when their bill is settled: adds the spend, earns
 * points (1 per ₹10) and counts a visit once per business day. Running it
 * twice for the same bill has no effect.
 *
 * @param tx - The transaction client.
 * @param visit - The settled bill's guest, branch, total and business day.
 */
export async function recordGuestVisitInTx(
  tx: TransactionClient,
  visit: {
    guestId: string;
    organizationId: string;
    branchId: string;
    billId: string;
    billNumber: number;
    totalPaise: number;
    businessDate: string;
  },
): Promise<void> {
  const [guest, alreadyEarned] = await Promise.all([
    tx.guest.findUnique({
      where: { id: visit.guestId },
      select: { firstVisitAt: true, lastVisitDate: true },
    }),
    tx.loyaltyTransaction.findFirst({
      where: { billId: visit.billId, type: LoyaltyTransactionType.EARN },
      select: { id: true },
    }),
  ]);

  if (!guest || alreadyEarned) {
    return;
  }

  const points = Math.floor(visit.totalPaise / PAISE_PER_LOYALTY_POINT);
  const isNewVisitDay = guest.lastVisitDate !== visit.businessDate;
  const now = new Date();

  await tx.guest.update({
    where: { id: visit.guestId },
    data: {
      totalSpentPaise: { increment: visit.totalPaise },
      loyaltyPoints: { increment: points },
      ...(isNewVisitDay && { totalVisits: { increment: 1 } }),
      lastVisitAt: now,
      lastVisitDate: visit.businessDate,
      ...(guest.firstVisitAt === null && { firstVisitAt: now }),
    },
  });

  // Recorded even for 0 points, so the bill shows in the visit history.
  await tx.loyaltyTransaction.create({
    data: {
      organizationId: visit.organizationId,
      guestId: visit.guestId,
      branchId: visit.branchId,
      billId: visit.billId,
      type: LoyaltyTransactionType.EARN,
      points,
      spendPaise: visit.totalPaise,
      description: `Earned on bill #${visit.billNumber}`,
    },
  });
}

/**
 * Reverses spend and points for a refund: the guest loses the share of the
 * points earned on that bill matching the credited share of the invoice.
 * The balance never goes below zero; the visit itself still counts.
 *
 * @param tx - The transaction client.
 * @param refund - The credit note, its bill and the amounts involved.
 */
export async function reverseGuestLoyaltyInTx(
  tx: TransactionClient,
  refund: {
    billId: string;
    creditNoteId: string;
    creditNoteNumber: string;
    organizationId: string;
    branchId: string;
    creditAmountPaise: number;
    invoiceTotalPaise: number;
  },
): Promise<void> {
  const bill = await tx.bill.findUnique({
    where: { id: refund.billId },
    select: { guestId: true },
  });

  if (!bill?.guestId) {
    return;
  }

  const [guest, earned] = await Promise.all([
    tx.guest.findUnique({
      where: { id: bill.guestId },
      select: { loyaltyPoints: true, totalSpentPaise: true },
    }),
    tx.loyaltyTransaction.findFirst({
      where: { billId: refund.billId, type: LoyaltyTransactionType.EARN },
      select: { points: true },
    }),
  ]);

  if (!guest) {
    return;
  }

  const earnedPoints = earned?.points ?? 0;
  const creditedShare =
    refund.invoiceTotalPaise === 0 ? 0 : refund.creditAmountPaise / refund.invoiceTotalPaise;
  const pointsToRemove = Math.min(guest.loyaltyPoints, Math.round(earnedPoints * creditedShare));
  const spendToRemove = Math.min(guest.totalSpentPaise, refund.creditAmountPaise);

  await tx.guest.update({
    where: { id: bill.guestId },
    data: {
      loyaltyPoints: { decrement: pointsToRemove },
      totalSpentPaise: { decrement: spendToRemove },
    },
  });

  await tx.loyaltyTransaction.create({
    data: {
      organizationId: refund.organizationId,
      guestId: bill.guestId,
      branchId: refund.branchId,
      billId: refund.billId,
      creditNoteId: refund.creditNoteId,
      type: LoyaltyTransactionType.REVERSE,
      points: -pointsToRemove,
      spendPaise: -spendToRemove,
      description: `Reversed by credit note ${refund.creditNoteNumber}`,
    },
  });
}
