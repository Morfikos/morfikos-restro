import { createPrismaClient } from "@morfikos/database";
import { BillingServiceErrorCode } from "@morfikos/auth";
import type { RecordBillPaymentInput, SplitBillInput } from "@morfikos/validation";

import { calculateOrderTotals, toPaise } from "../orders/pricing.js";
import { OrderItemStatus } from "../orders/constants.js";
import {
  BillStatus,
  PAYMENT_METHOD_FROM_API,
  SPLIT_MODE_FROM_API,
} from "./constants.js";
import {
  BillingServiceError,
  findBill,
  formatRupees,
  getBillView,
  recordPaymentsInTx,
  runBillingTransaction,
  type BillingActor,
  type TransactionClient,
} from "./service.js";

const prisma = createPrismaClient();

/** One item (or a share of it) on an item-split part. */
interface SplitItem {
  orderItemId: string;
  name: string;
  quantity: number;
  amountPaise: number;
  taxPaise: number;
}

/** A computed split part, before it's saved. */
interface ComputedPart {
  partNumber: number;
  label: string;
  amountPaise: number;
  taxPaise: number;
  percent: number | null;
  items: SplitItem[];
}

/**
 * Divides an amount into shares by weight, rounding each share and giving
 * the leftover paise to the last share so they add up exactly.
 *
 * @param amount - The amount in paise.
 * @param weights - The relative weights.
 * @returns One share per weight.
 */
function allocate(amount: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  if (totalWeight === 0) {
    return weights.map(() => 0);
  }

  const shares = weights.map((weight) => Math.round((amount * weight) / totalWeight));
  const leftover = amount - shares.reduce((sum, share) => sum + share, 0);
  shares[shares.length - 1] = (shares[shares.length - 1] ?? 0) + leftover;

  return shares;
}

/**
 * Builds a part's default label.
 *
 * @param index - The part's 0-based position.
 * @param label - The label sent, if any.
 * @returns The label.
 */
function partLabel(index: number, label: string | undefined): string {
  return label ?? `Guest ${index + 1}`;
}

/**
 * Works out the parts of a split from the bill's current amounts. Equal,
 * custom-amount and percentage splits divide what is still due (payments
 * already taken count first); an item split divides the whole bill by
 * what each guest had, with GST and the bill discount on each item.
 *
 * @param tx - The transaction client.
 * @param billId - The bill ID.
 * @param input - The split request.
 * @returns The bill's amounts and the parts.
 * @throws BillingServiceError If the bill can't be split this way.
 */
async function computeSplit(tx: TransactionClient, billId: string, input: SplitBillInput) {
  const bill = await tx.bill.findUniqueOrThrow({
    where: { id: billId },
    select: {
      status: true,
      totalPaise: true,
      paidPaise: true,
      taxPaise: true,
      discountAmountPaise: true,
      splitParts: { select: { paidPaise: true } },
    },
  });

  if (bill.status !== BillStatus.OPEN) {
    throw new BillingServiceError(
      BillingServiceErrorCode.BILL_NOT_OPEN,
      bill.status === BillStatus.SETTLED ? "This bill is already settled" : "This bill is cancelled",
    );
  }

  if (bill.splitParts.some((part) => part.paidPaise > 0)) {
    throw new BillingServiceError(
      BillingServiceErrorCode.SPLIT_HAS_PAYMENTS,
      "Some parts of this split are already paid, so it can't be changed",
    );
  }

  const duePaise = bill.totalPaise - bill.paidPaise;

  if (duePaise <= 0) {
    throw new BillingServiceError(BillingServiceErrorCode.INVALID_SPLIT, "Nothing is left to pay on this bill");
  }

  /**
   * Gives each part its share of the bill's GST, for its printed slip.
   *
   * @param amounts - Each part's amount.
   * @returns Each part's tax share.
   */
  const taxShares = (amounts: number[]) =>
    allocate(Math.round((bill.taxPaise * duePaise) / Math.max(bill.totalPaise, 1)), amounts);

  let parts: ComputedPart[];

  switch (input.mode) {
    case "equal": {
      if (input.parts > duePaise) {
        throw new BillingServiceError(BillingServiceErrorCode.INVALID_SPLIT, "The amount due is too small to split that many ways");
      }

      const base = Math.floor(duePaise / input.parts);
      const extra = duePaise - base * input.parts;
      const amounts = Array.from({ length: input.parts }, (_, index) => base + (index < extra ? 1 : 0));
      const taxes = taxShares(amounts);

      parts = amounts.map((amountPaise, index) => ({
        partNumber: index + 1,
        label: partLabel(index, input.labels?.[index]),
        amountPaise,
        taxPaise: taxes[index] ?? 0,
        percent: null,
        items: [],
      }));
      break;
    }

    case "custom_amount": {
      const sum = input.parts.reduce((total, part) => total + part.amountPaise, 0);

      if (sum !== duePaise) {
        throw new BillingServiceError(
          BillingServiceErrorCode.INVALID_SPLIT,
          `The parts add up to ${formatRupees(sum)} but ${formatRupees(duePaise)} is due`,
        );
      }

      const taxes = taxShares(input.parts.map((part) => part.amountPaise));

      parts = input.parts.map((part, index) => ({
        partNumber: index + 1,
        label: partLabel(index, part.label),
        amountPaise: part.amountPaise,
        taxPaise: taxes[index] ?? 0,
        percent: null,
        items: [],
      }));
      break;
    }

    case "percentage": {
      const amounts = allocate(duePaise, input.parts.map((part) => part.percent));

      if (amounts.some((amount) => amount <= 0)) {
        throw new BillingServiceError(BillingServiceErrorCode.INVALID_SPLIT, "Each part must come to at least ₹0.01");
      }

      const taxes = taxShares(amounts);

      parts = input.parts.map((part, index) => ({
        partNumber: index + 1,
        label: partLabel(index, part.label),
        amountPaise: amounts[index] ?? 0,
        taxPaise: taxes[index] ?? 0,
        percent: part.percent,
        items: [],
      }));
      break;
    }

    case "items": {
      if (bill.paidPaise > 0) {
        throw new BillingServiceError(
          BillingServiceErrorCode.BILL_HAS_PAYMENTS,
          "This bill already has a payment. Split it equally or by amounts instead.",
        );
      }

      parts = await computeItemSplit(tx, billId, bill, input.parts);
      break;
    }
  }

  return { totalPaise: bill.totalPaise, paidPaise: bill.paidPaise, duePaise, parts };
}

/**
 * Item split: each line's final amount (after its share of the bill
 * discount, plus GST) goes to the parts that had it, in proportion to the
 * quantity each part took. The bill's round-off goes to the largest part.
 *
 * @param tx - The transaction client.
 * @param billId - The bill ID.
 * @param bill - The bill's total and discount.
 * @param requested - The parts and the item quantities each took.
 * @returns The parts.
 * @throws BillingServiceError If an item isn't on the bill or isn't fully assigned.
 */
async function computeItemSplit(
  tx: TransactionClient,
  billId: string,
  bill: { totalPaise: number; discountAmountPaise: number },
  requested: Extract<SplitBillInput, { mode: "items" }>["parts"],
): Promise<ComputedPart[]> {
  const orderItems = await tx.orderItem.findMany({
    where: { order: { billId }, status: { not: OrderItemStatus.VOID } },
    orderBy: [{ order: { createdAt: "asc" } }, { lineNumber: "asc" }],
    select: { id: true, name: true, variantName: true, quantity: true, lineSubtotal: true, discountAmount: true, gstRate: true },
  });

  const totals = calculateOrderTotals(
    orderItems.map((item) => ({
      key: item.id,
      lineSubtotal: toPaise(item.lineSubtotal) - toPaise(item.discountAmount),
      gstRate: item.gstRate.toNumber(),
    })),
    bill.discountAmountPaise,
  );
  const chargeById = new Map(totals.lines.map((line) => [line.key, line]));
  const itemById = new Map(orderItems.map((item) => [item.id, item]));

  // Which parts took each item, and how much of it.
  const allocations = new Map<string, { partIndex: number; quantity: number }[]>();

  requested.forEach((part, partIndex) => {
    for (const entry of part.items) {
      if (!itemById.has(entry.orderItemId)) {
        throw new BillingServiceError(BillingServiceErrorCode.INVALID_SPLIT, "An item in the split isn't on this bill");
      }

      const list = allocations.get(entry.orderItemId) ?? [];
      list.push({ partIndex, quantity: entry.quantity });
      allocations.set(entry.orderItemId, list);
    }
  });

  const parts: ComputedPart[] = requested.map((part, index) => ({
    partNumber: index + 1,
    label: partLabel(index, part.label),
    amountPaise: 0,
    taxPaise: 0,
    percent: null,
    items: [],
  }));

  for (const item of orderItems) {
    const name = item.variantName ? `${item.name} (${item.variantName})` : item.name;
    const list = allocations.get(item.id) ?? [];
    const assigned = list.reduce((sum, entry) => sum + entry.quantity, 0);

    if (Math.abs(assigned - item.quantity) > 0.0005) {
      throw new BillingServiceError(
        BillingServiceErrorCode.INVALID_SPLIT,
        `${name}: ${Math.round(assigned * 1000) / 1000} of ${item.quantity} assigned. Every item must be fully assigned.`,
      );
    }

    const charge = chargeById.get(item.id);
    const netPaise = toPaise(item.lineSubtotal) - toPaise(item.discountAmount);
    const finalPaise = netPaise - (charge?.discount ?? 0) + (charge?.tax ?? 0);
    const quantities = list.map((entry) => entry.quantity);
    const amounts = allocate(finalPaise, quantities);
    const taxes = allocate(charge?.tax ?? 0, quantities);

    list.forEach((entry, index) => {
      const part = parts[entry.partIndex]!;
      part.amountPaise += amounts[index] ?? 0;
      part.taxPaise += taxes[index] ?? 0;
      part.items.push({
        orderItemId: item.id,
        name,
        quantity: entry.quantity,
        amountPaise: amounts[index] ?? 0,
        taxPaise: taxes[index] ?? 0,
      });
    });
  }

  // Round-off (and any paise of difference) lands on the largest part.
  const difference = bill.totalPaise - parts.reduce((sum, part) => sum + part.amountPaise, 0);
  const largest = parts.reduce((best, part) => (part.amountPaise > best.amountPaise ? part : best), parts[0]!);
  largest.amountPaise += difference;

  if (parts.some((part) => part.amountPaise <= 0)) {
    throw new BillingServiceError(BillingServiceErrorCode.INVALID_SPLIT, "Each part must come to at least ₹0.01");
  }

  return parts;
}

/**
 * Finds a bill of the actor's organization at the branch.
 *
 * @param actor - The cashier.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @returns The bill ID, or null if not found.
 */
async function findActorBill(actor: BillingActor, branchId: string, billId: string) {
  return findBill(actor.organizationId, branchId, billId);
}

/**
 * Builds the split view: each part's amount, tax share, paid and due,
 * status, items (item split) and payments.
 *
 * @param client - The Prisma client or transaction client.
 * @param billId - The bill ID.
 * @returns The split view.
 * @throws BillingServiceError If the bill isn't split.
 */
async function getSplitView(client: TransactionClient, billId: string) {
  const bill = await client.bill.findUniqueOrThrow({
    where: { id: billId },
    select: {
      id: true,
      billNumber: true,
      businessDate: true,
      status: true,
      totalPaise: true,
      paidPaise: true,
      taxPaise: true,
      splitMode: true,
      splitAt: true,
      splitBy: { select: { id: true, name: true } },
      table: { select: { name: true } },
      invoice: { select: { id: true, invoiceNumber: true } },
      payments: { where: { splitPartId: null }, select: { amountPaise: true } },
      splitParts: {
        orderBy: { partNumber: "asc" },
        select: {
          id: true,
          partNumber: true,
          label: true,
          amountPaise: true,
          taxPaise: true,
          paidPaise: true,
          percent: true,
          items: true,
          payments: {
            orderBy: { paidAt: "asc" },
            select: {
              id: true,
              method: true,
              amountPaise: true,
              tenderedPaise: true,
              reference: true,
              paidAt: true,
              receivedBy: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  if (!bill.splitMode) {
    throw new BillingServiceError(BillingServiceErrorCode.BILL_NOT_SPLIT, "This bill isn't split");
  }

  const parts = bill.splitParts.map((part) => {
    const duePaise = Math.max(part.amountPaise - part.paidPaise, 0);

    return {
      partId: part.id,
      partNumber: part.partNumber,
      label: part.label,
      amountPaise: part.amountPaise,
      taxPaise: part.taxPaise,
      paidPaise: part.paidPaise,
      duePaise,
      status: duePaise === 0 ? "paid" : part.paidPaise > 0 ? "partially_paid" : "unpaid",
      percent: part.percent?.toNumber() ?? null,
      items: part.items as unknown as SplitItem[],
      payments: part.payments.map((payment) => ({
        ...payment,
        method: payment.method.toLowerCase(),
        changePaise: payment.tenderedPaise !== null ? payment.tenderedPaise - payment.amountPaise : null,
      })),
    };
  });

  return {
    billId: bill.id,
    billNumber: bill.billNumber,
    businessDate: bill.businessDate,
    tableName: bill.table?.name ?? null,
    status: bill.status.toLowerCase(),
    mode: bill.splitMode.toLowerCase(),
    splitAt: bill.splitAt,
    splitBy: bill.splitBy,
    totalPaise: bill.totalPaise,
    paidPaise: bill.paidPaise,
    remainingPaise: Math.max(bill.totalPaise - bill.paidPaise, 0),
    /** Paid before the bill was split (not part of any share). */
    paidBeforeSplitPaise: bill.payments.reduce((sum, payment) => sum + payment.amountPaise, 0),
    partsPaid: parts.filter((part) => part.status === "paid").length,
    partCount: parts.length,
    parts,
    invoice: bill.invoice,
  };
}

/**
 * Shows how a bill would be split, without saving anything — for the POS
 * to preview the parts before confirming.
 *
 * @param actor - The cashier.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param input - The split request.
 * @returns The amounts and parts, or null if the bill isn't found.
 * @throws BillingServiceError If the bill can't be split this way.
 */
export async function previewBillSplit(
  actor: BillingActor,
  branchId: string,
  billId: string,
  input: SplitBillInput,
) {
  const bill = await findActorBill(actor, branchId, billId);

  if (!bill) {
    return null;
  }

  const result = await computeSplit(prisma, bill.id, input);

  return { billId: bill.id, mode: input.mode, ...result };
}

/**
 * Splits a bill (or replaces its split, while no part is paid). Afterwards
 * every payment goes to a part; the GST invoice is issued once all parts
 * are paid.
 *
 * @param actor - The cashier.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param input - The split request.
 * @returns The split view, or null if the bill isn't found.
 * @throws BillingServiceError If the bill can't be split this way.
 */
export async function splitBill(
  actor: BillingActor,
  branchId: string,
  billId: string,
  input: SplitBillInput,
) {
  const bill = await findActorBill(actor, branchId, billId);

  if (!bill) {
    return null;
  }

  return runBillingTransaction(async (tx) => {
    const { parts } = await computeSplit(tx, bill.id, input);

    await tx.billSplitPart.deleteMany({ where: { billId: bill.id } });
    await tx.billSplitPart.createMany({
      data: parts.map((part) => ({
        billId: bill.id,
        partNumber: part.partNumber,
        label: part.label,
        amountPaise: part.amountPaise,
        taxPaise: part.taxPaise,
        percent: part.percent,
        items: part.items as unknown as object[],
      })),
    });
    await tx.bill.update({
      where: { id: bill.id },
      data: { splitMode: SPLIT_MODE_FROM_API[input.mode], splitAt: new Date(), splitById: actor.userId },
    });

    return getSplitView(tx, bill.id);
  });
}

/**
 * Retrieves a bill's split with each part's status and payments.
 *
 * @param actor - The cashier.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @returns The split view, or null if the bill isn't found.
 * @throws BillingServiceError If the bill isn't split.
 */
export async function getBillSplit(actor: BillingActor, branchId: string, billId: string) {
  const bill = await findActorBill(actor, branchId, billId);

  return bill ? getSplitView(prisma, bill.id) : null;
}

/**
 * Removes a bill's split (back to one payment for the whole bill). Not
 * allowed once any part has been paid.
 *
 * @param actor - The cashier.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @returns The bill, or null if not found.
 * @throws BillingServiceError If it isn't split, isn't open, or a part is paid.
 */
export async function removeBillSplit(actor: BillingActor, branchId: string, billId: string) {
  const bill = await findActorBill(actor, branchId, billId);

  if (!bill) {
    return null;
  }

  return runBillingTransaction(async (tx) => {
    const current = await tx.bill.findUniqueOrThrow({
      where: { id: bill.id },
      select: { status: true, splitMode: true, splitParts: { select: { paidPaise: true } } },
    });

    if (!current.splitMode) {
      throw new BillingServiceError(BillingServiceErrorCode.BILL_NOT_SPLIT, "This bill isn't split");
    }

    if (current.status !== BillStatus.OPEN) {
      throw new BillingServiceError(BillingServiceErrorCode.BILL_NOT_OPEN, "Only an open bill's split can be removed");
    }

    if (current.splitParts.some((part) => part.paidPaise > 0)) {
      throw new BillingServiceError(
        BillingServiceErrorCode.SPLIT_HAS_PAYMENTS,
        "Some parts are already paid, so the split can't be removed",
      );
    }

    await tx.billSplitPart.deleteMany({ where: { billId: bill.id } });
    await tx.bill.update({
      where: { id: bill.id },
      data: { splitMode: null, splitAt: null, splitById: null },
    });

    return getBillView(tx, bill.id);
  });
}

/**
 * Loads one part of a split bill.
 *
 * @param client - The Prisma client or transaction client.
 * @param billId - The bill ID.
 * @param partNumber - The part number (1, 2, …).
 * @returns The part's ID.
 * @throws BillingServiceError If the bill isn't split or the part doesn't exist.
 */
async function findPart(client: TransactionClient, billId: string, partNumber: number) {
  const part = await client.billSplitPart.findUnique({
    where: { billId_partNumber: { billId, partNumber } },
    select: { id: true },
  });

  if (!part) {
    throw new BillingServiceError(BillingServiceErrorCode.SPLIT_PART_NOT_FOUND, `Part ${partNumber} not found on this bill`);
  }

  return part;
}

/**
 * Takes a payment for one part of a split bill (a part can be paid in
 * several payments, e.g. cash and UPI). When the last part is paid the
 * bill settles and its GST invoice is issued.
 *
 * @param actor - The cashier.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param partNumber - The part number.
 * @param input - The payment.
 * @returns The payment, the part and the bill's status, or null if the bill isn't found.
 * @throws BillingServiceError If the part isn't found or the payment exceeds its due.
 */
export async function payBillSplitPart(
  actor: BillingActor,
  branchId: string,
  billId: string,
  partNumber: number,
  input: RecordBillPaymentInput,
) {
  const bill = await findActorBill(actor, branchId, billId);

  if (!bill) {
    return null;
  }

  const result = await runBillingTransaction(async (tx) => {
    const part = await findPart(tx, bill.id, partNumber);
    const [payment] = await recordPaymentsInTx(
      tx,
      actor,
      bill.id,
      [
        {
          method: PAYMENT_METHOD_FROM_API[input.method],
          amountPaise: input.amountPaise,
          tenderedPaise: input.tenderedPaise,
          reference: input.reference ?? null,
          idempotencyKey: input.idempotencyKey,
        },
      ],
      part.id,
    );

    return payment!;
  });

  const [payment, split, view] = await Promise.all([
    prisma.billPayment.findUniqueOrThrow({
      where: { id: result.id },
      select: { id: true, method: true, amountPaise: true, tenderedPaise: true, reference: true, paidAt: true },
    }),
    getSplitView(prisma, bill.id),
    getBillView(prisma, bill.id),
  ]);

  return {
    payment: {
      ...payment,
      method: payment.method.toLowerCase(),
      changePaise: payment.tenderedPaise !== null ? payment.tenderedPaise - payment.amountPaise : null,
    },
    replayed: result.replayed,
    part: split.parts.find((entry) => entry.partNumber === partNumber) ?? null,
    bill: {
      status: view.status,
      totalPaise: view.totalPaise,
      paidPaise: view.paidPaise,
      remainingPaise: view.remainingPaise,
      partsPaid: split.partsPaid,
      partCount: split.partCount,
      settledAt: view.settledAt,
    },
    invoice: view.invoice,
  };
}

/**
 * Retrieves one part as a slip to print for that guest: bill header, the
 * part's items (item split) or share, its GST share, and what's paid.
 *
 * @param actor - The cashier.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param partNumber - The part number.
 * @returns The part slip, or null if the bill isn't found.
 * @throws BillingServiceError If the bill isn't split or the part doesn't exist.
 */
export async function getBillSplitPart(
  actor: BillingActor,
  branchId: string,
  billId: string,
  partNumber: number,
) {
  const bill = await findActorBill(actor, branchId, billId);

  if (!bill) {
    return null;
  }

  await findPart(prisma, bill.id, partNumber);
  const split = await getSplitView(prisma, bill.id);
  const part = split.parts.find((entry) => entry.partNumber === partNumber)!;
  const { parts, ...header } = split;

  return {
    ...header,
    part,
    shareOfBillPercent: split.totalPaise > 0 ? Math.round((part.amountPaise / split.totalPaise) * 10_000) / 100 : 0,
    otherParts: parts
      .filter((entry) => entry.partNumber !== partNumber)
      .map(({ partNumber: number, label, amountPaise, status }) => ({ partNumber: number, label, amountPaise, status })),
  };
}

