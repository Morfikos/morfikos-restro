import { createPrismaClient } from "@morfikos/database";
import { BillingServiceErrorCode, verifyPassword, type UserRole } from "@morfikos/auth";
import type {
  ApplyBillDiscountInput,
  CancelBillInput,
  CreateBillInput,
  CreateCreditNoteInput,
  ListBillsQuery,
  ListInvoicesQuery,
  RecordBillPaymentInput,
  SettleBillInput,
} from "@morfikos/validation";

import { getBusinessDate, getFinancialYear } from "../../utils/branch-time.js";
import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import { OrderItemStatus, OrderStatus, PaymentStatus } from "../orders/constants.js";
import { calculateOrderTotals, fromPaise, toPaise } from "../orders/pricing.js";
import {
  BILLING_MANAGER_ROLES,
  BILLING_TRANSACTION_OPTIONS,
  BILL_STATUS_FROM_API,
  BillStatus,
  DEFAULT_DISCOUNT_APPROVAL_PERCENT,
  DISCOUNT_TYPE_FROM_API,
  DiscountType,
  INVOICE_STATUS_FROM_API,
  InvoiceStatus,
  MAX_NUMBERING_RETRIES,
  PAYMENT_METHOD_FROM_API,
  PaymentMethod,
} from "./constants.js";

const prisma = createPrismaClient();

/** The Prisma client available inside an interactive transaction. */
export type TransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/**
 * The authenticated user performing a billing operation.
 */
export interface BillingActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

/**
 * Represents errors that can occur during billing operations.
 */
export class BillingServiceError extends Error {
  /**
   * Creates a billing service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: BillingServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BillingServiceError";
  }
}

/** A payment to record against a bill, in paise. */
export interface BillPaymentEntry {
  method: PaymentMethod;
  amountPaise: number;
  tenderedPaise?: number;
  reference?: string | null;
  idempotencyKey?: string;
}

/** A discount to apply to a bill. `value` is percent or paise by type. */
interface DiscountRequest {
  type: DiscountType;
  value: number;
  offerId?: string;
  couponCode?: string;
  reasonCode?: string;
  managerPin?: string;
}

/**
 * Formats a paise amount as a rupee string for messages.
 *
 * @param paise - The amount in paise.
 * @returns The amount, e.g. "₹125.50".
 */
function formatRupees(paise: number): string {
  return `₹${fromPaise(paise).toFixed(2)}`;
}

/**
 * Converts a financial year from the stored "26-27" form to "2026-27".
 *
 * @param financialYear - The stored financial year.
 * @returns The display financial year.
 */
function toDisplayFinancialYear(financialYear: string): string {
  return `20${financialYear}`;
}

/**
 * Returns up to `length` alphanumeric characters of the branch code, used
 * as the prefix of invoice and credit note numbers.
 *
 * @param code - The branch code, or null.
 * @param length - The maximum prefix length.
 * @returns The prefix, e.g. "SMB".
 */
function getNumberPrefix(code: string | null, length: number): string {
  return (code ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, length) || "INV";
}

/**
 * Formats a GST invoice number, e.g. "SMB/26-27/00001". It restarts every
 * financial year and stays within the 16-character GST limit.
 *
 * @param code - The branch code.
 * @param financialYear - The financial year (YY-YY).
 * @param sequence - The invoice's number in the year.
 * @returns The invoice number.
 */
function formatInvoiceNumber(code: string | null, financialYear: string, sequence: number): string {
  return `${getNumberPrefix(code, 4)}/${financialYear}/${String(sequence).padStart(5, "0")}`;
}

/**
 * Formats a credit note number, e.g. "CN/26-27/SMB0001". It restarts every
 * financial year and stays within the 16-character GST limit.
 *
 * @param code - The branch code.
 * @param financialYear - The financial year (YY-YY).
 * @param sequence - The credit note's number in the year.
 * @returns The credit note number.
 */
function formatCreditNoteNumber(
  code: string | null,
  financialYear: string,
  sequence: number,
): string {
  return `CN/${financialYear}/${getNumberPrefix(code, 3)}${String(sequence).padStart(4, "0")}`;
}

/**
 * Runs billing work in an interactive transaction. Numbering conflicts and
 * duplicate idempotency keys (two requests at once) are retried a few times.
 *
 * @param work - The transactional work.
 * @returns The work's result.
 */
async function runBillingTransaction<T>(
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, BILLING_TRANSACTION_OPTIONS);
    } catch (error: unknown) {
      if (attempt < MAX_NUMBERING_RETRIES && isPrismaUniqueConstraintError(error)) {
        continue;
      }

      throw error;
    }
  }
}

/**
 * Atomically increments and returns a named per-branch counter.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @param name - The counter name, e.g. "bill:2026-10-31".
 * @returns The new counter value.
 */
async function nextBranchCounter(
  tx: TransactionClient,
  branchId: string,
  name: string,
): Promise<number> {
  const counter = await tx.branchCounter.upsert({
    where: { branchId_name: { branchId, name } },
    create: { branchId, name, value: 1 },
    update: { value: { increment: 1 } },
    select: { value: true },
  });

  return counter.value;
}

/** Branch fields used for numbering, GST and discount rules. */
const billingBranchSelect = {
  id: true,
  code: true,
  gstin: true,
  timezone: true,
  businessDayCutoff: true,
  settings: true,
} as const;

/**
 * Loads an active branch of the organization.
 *
 * @param tx - The transaction client.
 * @param organizationId - The organization ID.
 * @param branchId - The branch ID.
 * @returns The branch's billing settings.
 * @throws BillingServiceError If the branch is not found.
 */
async function getBillingBranch(
  tx: TransactionClient,
  organizationId: string,
  branchId: string,
) {
  const branch = await tx.branch.findFirst({
    where: { id: branchId, organizationId, status: "active" },
    select: billingBranchSelect,
  });

  if (!branch) {
    throw new BillingServiceError(
      BillingServiceErrorCode.BRANCH_NOT_FOUND,
      "Active branch not found",
    );
  }

  return branch;
}

/**
 * Loads every billable line of a bill's orders. Each line's order-level
 * discount (set at the POS) is already allocated on the line.
 *
 * @param tx - The transaction client.
 * @param billId - The bill ID.
 * @returns The lines in paise.
 */
async function loadBillLines(tx: TransactionClient, billId: string) {
  const items = await tx.orderItem.findMany({
    where: { order: { billId }, status: { not: OrderItemStatus.VOID } },
    select: { id: true, lineSubtotal: true, discountAmount: true, gstRate: true },
  });

  return items.map((item) => {
    const grossPaise = toPaise(item.lineSubtotal);
    const orderDiscountPaise = toPaise(item.discountAmount);

    return {
      key: item.id,
      grossPaise,
      orderDiscountPaise,
      netPaise: grossPaise - orderDiscountPaise,
      gstRate: item.gstRate.toNumber(),
    };
  });
}

/**
 * Recalculates and stores a bill's totals: subtotal of all lines, order
 * discounts plus the bill discount (spread across lines), GST on each
 * line after discounts, and rounding to the nearest rupee.
 *
 * @param tx - The transaction client.
 * @param billId - The bill ID.
 * @returns The totals in paise and the GST breakdown by rate.
 */
async function recalculateBill(tx: TransactionClient, billId: string) {
  const bill = await tx.bill.findUniqueOrThrow({
    where: { id: billId },
    select: { discountAmountPaise: true },
  });

  const lines = await loadBillLines(tx, billId);
  const totals = calculateOrderTotals(
    lines.map((line) => ({ key: line.key, lineSubtotal: line.netPaise, gstRate: line.gstRate })),
    bill.discountAmountPaise,
  );

  const subtotalPaise = lines.reduce((sum, line) => sum + line.grossPaise, 0);
  const orderDiscountPaise = lines.reduce((sum, line) => sum + line.orderDiscountPaise, 0);
  const linesByKey = new Map(lines.map((line) => [line.key, line]));

  const breakdownByRate = new Map<number, { taxablePaise: number; taxPaise: number }>();

  for (const charge of totals.lines) {
    const line = linesByKey.get(charge.key);

    if (!line) {
      continue;
    }

    const entry = breakdownByRate.get(line.gstRate) ?? { taxablePaise: 0, taxPaise: 0 };
    entry.taxablePaise += line.netPaise - charge.discount;
    entry.taxPaise += charge.tax;
    breakdownByRate.set(line.gstRate, entry);
  }

  const taxBreakdown = [...breakdownByRate.entries()]
    .sort(([rateA], [rateB]) => rateA - rateB)
    .map(([rate, { taxablePaise, taxPaise }]) => {
      const cgstPaise = Math.round(taxPaise / 2);

      return { rate, taxablePaise, cgstPaise, sgstPaise: taxPaise - cgstPaise, taxPaise };
    });

  const result = {
    lineCount: lines.length,
    netSubtotalPaise: lines.reduce((sum, line) => sum + line.netPaise, 0),
    subtotalPaise,
    billDiscountPaise: totals.discount,
    discountPaise: orderDiscountPaise + totals.discount,
    taxPaise: totals.tax,
    roundOffPaise: totals.roundOff,
    totalPaise: totals.total,
    taxBreakdown,
  };

  await tx.bill.update({
    where: { id: billId },
    data: {
      subtotalPaise: result.subtotalPaise,
      discountPaise: result.discountPaise,
      discountAmountPaise: result.billDiscountPaise,
      taxPaise: result.taxPaise,
      roundOffPaise: result.roundOffPaise,
      totalPaise: result.totalPaise,
    },
  });

  return result;
}

/**
 * Finds the owner or manager of the organization whose approval PIN matches.
 *
 * @param tx - The transaction client.
 * @param organizationId - The organization ID.
 * @param pin - The PIN entered.
 * @returns The approver's user ID, or null if no PIN matches.
 */
async function findApproverByPin(
  tx: TransactionClient,
  organizationId: string,
  pin: string,
): Promise<string | null> {
  const approvers = await tx.membership.findMany({
    where: {
      organizationId,
      status: "active",
      pinHash: { not: null },
      user: { status: "active", role: { in: ["owner", "manager"] } },
    },
    select: { userId: true, pinHash: true },
  });

  for (const approver of approvers) {
    if (approver.pinHash && (await verifyPassword(pin, approver.pinHash))) {
      return approver.userId;
    }
  }

  return null;
}

/**
 * Applies the discount approval rules. Owners and managers approve their
 * own discounts. Other staff may give up to their limit — the membership's
 * discount ceiling, else the branch's `discountApprovalAbove` setting, else
 * 10% — and need a manager's PIN above it.
 *
 * @param tx - The transaction client.
 * @param actor - The user applying the discount.
 * @param branchSettings - The branch's settings JSON.
 * @param discountPercent - The discount as a percentage of the bill.
 * @param managerPin - The PIN entered, if any.
 * @returns The approving user's ID, or null when no approval was needed.
 * @throws BillingServiceError If approval is needed and the PIN is missing or wrong.
 */
async function resolveDiscountApproval(
  tx: TransactionClient,
  actor: BillingActor,
  branchSettings: unknown,
  discountPercent: number,
  managerPin: string | undefined,
): Promise<string | null> {
  if (BILLING_MANAGER_ROLES.includes(actor.role)) {
    return actor.userId;
  }

  const membership = await tx.membership.findUnique({
    where: {
      organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId },
    },
    select: { discountCeilingPct: true },
  });

  const branchLimit =
    typeof branchSettings === "object" &&
    branchSettings !== null &&
    "discountApprovalAbove" in branchSettings &&
    typeof branchSettings.discountApprovalAbove === "number"
      ? branchSettings.discountApprovalAbove
      : null;

  const limit = membership?.discountCeilingPct ?? branchLimit ?? DEFAULT_DISCOUNT_APPROVAL_PERCENT;

  if (discountPercent <= limit) {
    return null;
  }

  if (!managerPin) {
    throw new BillingServiceError(
      BillingServiceErrorCode.MANAGER_APPROVAL_REQUIRED,
      `Discounts above ${limit}% need a manager's PIN`,
    );
  }

  const approverId = await findApproverByPin(tx, actor.organizationId, managerPin);

  if (!approverId) {
    throw new BillingServiceError(
      BillingServiceErrorCode.INVALID_MANAGER_PIN,
      "Invalid manager PIN",
    );
  }

  return approverId;
}

/**
 * Sets (or replaces, or removes) the bill-level discount and recalculates
 * the bill. A discount can't exceed the bill or bring the total below what
 * was already paid.
 *
 * @param tx - The transaction client.
 * @param actor - The user applying the discount.
 * @param billId - The bill ID.
 * @param branchSettings - The branch's settings JSON (for approval limits).
 * @param discount - The discount request.
 * @throws BillingServiceError On an invalid discount or missing approval.
 */
async function applyDiscountInTx(
  tx: TransactionClient,
  actor: BillingActor,
  billId: string,
  branchSettings: unknown,
  discount: DiscountRequest,
): Promise<void> {
  const bill = await tx.bill.findUniqueOrThrow({
    where: { id: billId },
    select: { status: true, paidPaise: true },
  });

  if (bill.status !== BillStatus.OPEN) {
    throw new BillingServiceError(
      BillingServiceErrorCode.BILL_NOT_OPEN,
      "Discounts can only be applied to open bills",
    );
  }

  const lines = await loadBillLines(tx, billId);
  const netSubtotalPaise = lines.reduce((sum, line) => sum + line.netPaise, 0);

  const amountPaise =
    discount.value === 0
      ? 0
      : discount.type === DiscountType.FLAT
        ? discount.value
        : Math.round((netSubtotalPaise * discount.value) / 100);

  if (amountPaise > netSubtotalPaise) {
    throw new BillingServiceError(
      BillingServiceErrorCode.INVALID_DISCOUNT,
      `Discount can't be more than the bill amount of ${formatRupees(netSubtotalPaise)}`,
    );
  }

  const discountPercent = netSubtotalPaise === 0 ? 0 : (amountPaise * 100) / netSubtotalPaise;
  const approvedById =
    amountPaise > 0
      ? await resolveDiscountApproval(tx, actor, branchSettings, discountPercent, discount.managerPin)
      : null;
  const hasDiscount = amountPaise > 0;

  await tx.bill.update({
    where: { id: billId },
    data: {
      discountType: hasDiscount ? discount.type : null,
      discountValue: hasDiscount ? discount.value : null,
      discountAmountPaise: amountPaise,
      discountReasonCode: hasDiscount ? (discount.reasonCode ?? null) : null,
      offerId: hasDiscount ? (discount.offerId ?? null) : null,
      couponCode: hasDiscount ? (discount.couponCode ?? null) : null,
      discountAppliedById: hasDiscount ? actor.userId : null,
      discountApprovedById: approvedById,
    },
  });

  const totals = await recalculateBill(tx, billId);

  if (totals.totalPaise < bill.paidPaise) {
    throw new BillingServiceError(
      BillingServiceErrorCode.DISCOUNT_BELOW_PAID,
      `This discount would make the bill ${formatRupees(totals.totalPaise)}, less than the ${formatRupees(bill.paidPaise)} already paid`,
    );
  }
}

/**
 * Settles a fully paid bill and issues its GST invoice with the next
 * number of the financial year. The bill's orders are completed and get
 * the invoice number. Settling an already settled bill returns its invoice.
 *
 * @param tx - The transaction client.
 * @param billId - The bill ID.
 * @returns The invoice ID.
 * @throws BillingServiceError If the bill is cancelled or not fully paid.
 */
async function settleBillInTx(tx: TransactionClient, billId: string): Promise<string> {
  const bill = await tx.bill.findUniqueOrThrow({
    where: { id: billId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      paidPaise: true,
      branch: { select: billingBranchSelect },
      invoice: { select: { id: true } },
    },
  });

  if (bill.status === BillStatus.SETTLED && bill.invoice) {
    return bill.invoice.id;
  }

  if (bill.status !== BillStatus.OPEN) {
    throw new BillingServiceError(
      BillingServiceErrorCode.BILL_NOT_OPEN,
      "A cancelled bill can't be settled",
    );
  }

  const totals = await recalculateBill(tx, bill.id);

  if (bill.paidPaise < totals.totalPaise) {
    throw new BillingServiceError(
      BillingServiceErrorCode.BILL_NOT_FULLY_PAID,
      `${formatRupees(totals.totalPaise - bill.paidPaise)} is still due on this bill`,
    );
  }

  const { branch } = bill;
  const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);
  const financialYear = getFinancialYear(businessDate);

  const sequence = await tx.invoiceSequence.upsert({
    where: { branchId_financialYear: { branchId: branch.id, financialYear } },
    create: { branchId: branch.id, financialYear, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  const invoiceNumber = formatInvoiceNumber(branch.code, financialYear, sequence.lastNumber);
  const now = new Date();

  const invoice = await tx.invoice.create({
    data: {
      organizationId: bill.organizationId,
      branchId: branch.id,
      billId: bill.id,
      invoiceNumber,
      financialYear,
      businessDate,
      issuedAt: now,
      gstin: branch.gstin,
      subtotalPaise: totals.subtotalPaise,
      discountPaise: totals.discountPaise,
      taxPaise: totals.taxPaise,
      cgstPaise: totals.taxBreakdown.reduce((sum, entry) => sum + entry.cgstPaise, 0),
      sgstPaise: totals.taxBreakdown.reduce((sum, entry) => sum + entry.sgstPaise, 0),
      roundOffPaise: totals.roundOffPaise,
      totalPaise: totals.totalPaise,
      taxBreakdown: totals.taxBreakdown,
    },
    select: { id: true },
  });

  await tx.bill.update({
    where: { id: bill.id },
    data: { status: BillStatus.SETTLED, settledAt: now },
  });

  const orders = await tx.order.findMany({
    where: { billId: bill.id },
    select: { id: true, totalAmount: true },
  });

  for (const order of orders) {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.COMPLETED,
        paymentStatus: PaymentStatus.PAID,
        amountPaid: order.totalAmount,
        paidAt: now,
        invoiceNumber,
        financialYear,
      },
    });
  }

  return invoice.id;
}

/**
 * Creates a bill from one or more open orders of a branch, optionally with
 * a flat discount. The orders are marked billed and locked against edits.
 * A zero-value bill is settled at once.
 *
 * @param tx - The transaction client.
 * @param actor - The user creating the bill.
 * @param input - The branch, orders and optional table, guest, shift and discount.
 * @returns The bill ID.
 * @throws BillingServiceError If an order can't be billed or the table doesn't match.
 */
export async function createBillInTx(
  tx: TransactionClient,
  actor: BillingActor,
  input: CreateBillInput & { branchId: string },
): Promise<string> {
  const branch = await getBillingBranch(tx, actor.organizationId, input.branchId);

  const orders = await tx.order.findMany({
    where: {
      id: { in: input.orderIds },
      organizationId: actor.organizationId,
      branchId: branch.id,
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      billId: true,
      tableId: true,
      _count: { select: { items: { where: { status: { not: OrderItemStatus.VOID } } } } },
    },
  });

  if (orders.length !== input.orderIds.length) {
    throw new BillingServiceError(
      BillingServiceErrorCode.ORDER_NOT_FOUND,
      "One or more orders were not found in this branch",
    );
  }

  for (const order of orders) {
    if (order.status !== OrderStatus.OPEN || order.billId !== null) {
      throw new BillingServiceError(
        BillingServiceErrorCode.ORDER_NOT_BILLABLE,
        `Order ${order.orderNumber} is already billed or closed`,
      );
    }

    if (order._count.items === 0) {
      throw new BillingServiceError(
        BillingServiceErrorCode.EMPTY_ORDER,
        `Order ${order.orderNumber} has no items to bill`,
      );
    }
  }

  let tableId: string | null = null;

  if (input.tableId !== undefined) {
    const table = await tx.diningTable.findFirst({
      where: { id: input.tableId, branchId: branch.id },
      select: { id: true },
    });

    if (!table) {
      throw new BillingServiceError(
        BillingServiceErrorCode.TABLE_NOT_FOUND,
        "Table not found in this branch",
      );
    }

    const otherTableOrder = orders.find((order) => order.tableId !== table.id);

    if (otherTableOrder) {
      throw new BillingServiceError(
        BillingServiceErrorCode.ORDER_TABLE_MISMATCH,
        `Order ${otherTableOrder.orderNumber} is not on this table`,
      );
    }

    tableId = table.id;
  } else {
    const tableIds = new Set(orders.map((order) => order.tableId));
    const [onlyTableId] = [...tableIds];

    tableId = tableIds.size === 1 ? (onlyTableId ?? null) : null;
  }

  const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);
  const billNumber = await nextBranchCounter(tx, branch.id, `bill:${businessDate}`);

  const bill = await tx.bill.create({
    data: {
      organizationId: actor.organizationId,
      branchId: branch.id,
      billNumber,
      businessDate,
      tableId,
      guestId: input.guestId ?? null,
      shiftId: input.shiftId ?? null,
      createdById: actor.userId,
    },
    select: { id: true },
  });

  await tx.order.updateMany({
    where: { id: { in: input.orderIds } },
    data: { billId: bill.id, status: OrderStatus.BILLED, billedAt: new Date() },
  });

  if (input.discount) {
    await applyDiscountInTx(tx, actor, bill.id, branch.settings, {
      type: DiscountType.FLAT,
      value: input.discount.amountPaise,
      offerId: input.discount.offerId,
      couponCode: input.discount.couponCode,
      reasonCode: input.discount.reasonCode,
      managerPin: input.discount.managerPin,
    });
  } else {
    await recalculateBill(tx, bill.id);
  }

  const created = await tx.bill.findUniqueOrThrow({
    where: { id: bill.id },
    select: { totalPaise: true },
  });

  if (created.totalPaise === 0) {
    await settleBillInTx(tx, bill.id);
  }

  return bill.id;
}

/**
 * Records payments on an open bill. A payment whose idempotency key was
 * already used is not recorded again (the first one is returned). When the
 * bill is fully paid it is settled and its invoice issued.
 *
 * @param tx - The transaction client.
 * @param actor - The user receiving the payment.
 * @param billId - The bill ID.
 * @param payments - The payments, in paise.
 * @returns Each payment's ID and whether it was a replay.
 * @throws BillingServiceError If the bill is not open or the payments exceed the balance.
 */
export async function recordPaymentsInTx(
  tx: TransactionClient,
  actor: BillingActor,
  billId: string,
  payments: BillPaymentEntry[],
): Promise<Array<{ id: string; replayed: boolean }>> {
  const results: Array<{ id: string; replayed: boolean } | null> = [];
  const newPayments: BillPaymentEntry[] = [];

  // Replays are answered first, so a retry after settlement still succeeds.
  for (const payment of payments) {
    const existing = payment.idempotencyKey
      ? await tx.billPayment.findUnique({
          where: {
            billId_idempotencyKey: { billId, idempotencyKey: payment.idempotencyKey },
          },
          select: { id: true },
        })
      : null;

    if (existing) {
      results.push({ id: existing.id, replayed: true });
    } else {
      results.push(null);
      newPayments.push(payment);
    }
  }

  if (newPayments.length === 0) {
    return results.filter((result): result is { id: string; replayed: boolean } => result !== null);
  }

  const bill = await tx.bill.findUniqueOrThrow({
    where: { id: billId },
    select: { status: true, branchId: true, totalPaise: true, paidPaise: true },
  });

  if (bill.status !== BillStatus.OPEN) {
    throw new BillingServiceError(
      BillingServiceErrorCode.BILL_NOT_OPEN,
      bill.status === BillStatus.SETTLED
        ? "This bill is already settled"
        : "This bill is cancelled",
    );
  }

  const remainingPaise = bill.totalPaise - bill.paidPaise;
  const incomingPaise = newPayments.reduce((sum, payment) => sum + payment.amountPaise, 0);

  if (incomingPaise > remainingPaise) {
    throw new BillingServiceError(
      BillingServiceErrorCode.PAYMENT_EXCEEDS_BALANCE,
      `Payment of ${formatRupees(incomingPaise)} exceeds the balance due of ${formatRupees(remainingPaise)}`,
    );
  }

  let next = 0;

  for (const [index, result] of results.entries()) {
    if (result !== null) {
      continue;
    }

    const payment = newPayments[next];
    next += 1;

    const created = await tx.billPayment.create({
      data: {
        billId,
        branchId: bill.branchId,
        method: payment.method,
        amountPaise: payment.amountPaise,
        tenderedPaise: payment.tenderedPaise ?? null,
        reference: payment.reference ?? null,
        idempotencyKey: payment.idempotencyKey ?? null,
        receivedById: actor.userId,
      },
      select: { id: true },
    });

    results[index] = { id: created.id, replayed: false };
  }

  const paidPaise = bill.paidPaise + incomingPaise;

  await tx.bill.update({ where: { id: billId }, data: { paidPaise } });

  if (paidPaise >= bill.totalPaise) {
    await settleBillInTx(tx, billId);
  } else {
    // A one-order bill keeps the order's paid amount in step for the POS.
    const orders = await tx.order.findMany({ where: { billId }, select: { id: true } });

    await tx.order.updateMany({
      where: { billId },
      data: {
        paymentStatus: PaymentStatus.PARTIALLY_PAID,
        ...(orders.length === 1 && { amountPaid: fromPaise(paidPaise) }),
      },
    });
  }

  return results.filter((result): result is { id: string; replayed: boolean } => result !== null);
}

/** Fields returned for invoices. */
const invoiceSelect = {
  id: true,
  invoiceNumber: true,
  branchId: true,
  billId: true,
  financialYear: true,
  businessDate: true,
  issuedAt: true,
  gstin: true,
  subtotalPaise: true,
  discountPaise: true,
  taxPaise: true,
  cgstPaise: true,
  sgstPaise: true,
  roundOffPaise: true,
  totalPaise: true,
  creditedPaise: true,
  taxBreakdown: true,
  status: true,
} as const;

/**
 * Serializes an invoice.
 *
 * @param invoice - An invoice selected with {@link invoiceSelect}.
 * @returns The invoice as returned by the API.
 */
function serializeInvoice<T extends { financialYear: string; status: string }>(invoice: T) {
  return {
    ...invoice,
    financialYear: toDisplayFinancialYear(invoice.financialYear),
    status: invoice.status.toLowerCase(),
  };
}

/** Fields returned for a bill's full view. */
const billSelect = {
  id: true,
  organizationId: true,
  branchId: true,
  billNumber: true,
  businessDate: true,
  tableId: true,
  guestId: true,
  shiftId: true,
  status: true,
  subtotalPaise: true,
  discountPaise: true,
  taxPaise: true,
  roundOffPaise: true,
  totalPaise: true,
  paidPaise: true,
  discountType: true,
  discountValue: true,
  discountAmountPaise: true,
  discountReasonCode: true,
  offerId: true,
  couponCode: true,
  settledAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  table: { select: { name: true } },
  createdBy: { select: { id: true, name: true } },
  discountAppliedBy: { select: { id: true, name: true } },
  discountApprovedBy: { select: { id: true, name: true } },
  orders: {
    orderBy: { createdAt: "asc" },
    select: { id: true, orderNumber: true, status: true, totalAmount: true },
  },
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
  invoice: { select: invoiceSelect },
} as const;

/**
 * Loads a bill's full view: totals, discount, orders, payments and invoice.
 *
 * @param client - A Prisma client or transaction client.
 * @param billId - The bill ID.
 * @returns The bill as returned by the API.
 */
async function getBillView(client: TransactionClient, billId: string) {
  const bill = await client.bill.findUniqueOrThrow({
    where: { id: billId },
    select: billSelect,
  });

  const {
    table,
    orders,
    payments,
    invoice,
    discountType,
    discountValue,
    discountAmountPaise,
    discountReasonCode,
    offerId,
    couponCode,
    discountAppliedBy,
    discountApprovedBy,
    status,
    ...billData
  } = bill;

  return {
    ...billData,
    tableName: table?.name ?? null,
    status: status.toLowerCase(),
    remainingPaise: Math.max(bill.totalPaise - bill.paidPaise, 0),
    orderIds: orders.map((order) => order.id),
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status.toLowerCase(),
      totalPaise: toPaise(order.totalAmount),
    })),
    discount: discountType
      ? {
          type: discountType.toLowerCase(),
          value: discountValue?.toNumber() ?? 0,
          amountPaise: discountAmountPaise,
          offerId,
          couponCode,
          reasonCode: discountReasonCode,
          appliedBy: discountAppliedBy,
          approvedBy: discountApprovedBy,
        }
      : null,
    payments: payments.map((payment) => ({
      ...payment,
      method: payment.method.toLowerCase(),
      changePaise:
        payment.tenderedPaise !== null ? payment.tenderedPaise - payment.amountPaise : null,
    })),
    invoice: invoice ? serializeInvoice(invoice) : null,
  };
}

/**
 * Finds a bill of the branch and organization.
 *
 * @param organizationId - The organization ID.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @returns The bill ID, or null if not found.
 */
async function findBill(organizationId: string, branchId: string, billId: string) {
  return prisma.bill.findFirst({
    where: { id: billId, branchId, organizationId },
    select: { id: true },
  });
}

/**
 * Creates a bill from one or more open orders of a branch.
 *
 * @param actor - The user creating the bill.
 * @param branchId - The branch ID.
 * @param input - The validated bill request.
 * @returns The bill.
 * @throws BillingServiceError If an order can't be billed or the discount is invalid.
 */
export async function createBill(
  actor: BillingActor,
  branchId: string,
  input: CreateBillInput,
) {
  const billId = await runBillingTransaction((tx) =>
    createBillInTx(tx, actor, { ...input, branchId }),
  );

  return getBillView(prisma, billId);
}

/**
 * Lists a branch's bills, newest first.
 *
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @param query - Validated filters and pagination.
 * @returns The bills and pagination metadata.
 */
export async function listBills(
  actor: BillingActor,
  branchId: string,
  query: ListBillsQuery,
) {
  const where = {
    branchId,
    organizationId: actor.organizationId,
    ...(query.status !== undefined && { status: BILL_STATUS_FROM_API[query.status] }),
    ...(query.tableId !== undefined && { tableId: query.tableId }),
    ...(query.businessDate !== undefined && { businessDate: query.businessDate }),
  };

  const [bills, total] = await Promise.all([
    prisma.bill.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        billNumber: true,
        businessDate: true,
        tableId: true,
        status: true,
        totalPaise: true,
        paidPaise: true,
        createdAt: true,
        settledAt: true,
        table: { select: { name: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
        _count: { select: { orders: true } },
      },
    }),
    prisma.bill.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    bills: bills.map(({ table, _count, status, ...bill }) => ({
      ...bill,
      tableName: table?.name ?? null,
      status: status.toLowerCase(),
      remainingPaise: Math.max(bill.totalPaise - bill.paidPaise, 0),
      orderCount: _count.orders,
    })),
  };
}

/**
 * Retrieves a bill's full view.
 *
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @returns The bill, or null if not found.
 */
export async function getBill(actor: BillingActor, branchId: string, billId: string) {
  const bill = await findBill(actor.organizationId, branchId, billId);

  return bill ? getBillView(prisma, bill.id) : null;
}

/**
 * Applies (or replaces, or removes) the bill discount with approval rules.
 *
 * @param actor - The user applying the discount.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param input - The validated discount.
 * @returns The bill's discount and updated totals, or null if not found.
 * @throws BillingServiceError On an invalid discount or missing approval.
 */
export async function applyBillDiscount(
  actor: BillingActor,
  branchId: string,
  billId: string,
  input: ApplyBillDiscountInput,
) {
  const bill = await findBill(actor.organizationId, branchId, billId);

  if (!bill) {
    return null;
  }

  await runBillingTransaction(async (tx) => {
    const branch = await getBillingBranch(tx, actor.organizationId, branchId);

    await applyDiscountInTx(tx, actor, bill.id, branch.settings, {
      type: DISCOUNT_TYPE_FROM_API[input.type],
      value: input.value,
      offerId: input.offerId,
      couponCode: input.couponCode,
      reasonCode: input.reasonCode,
      managerPin: input.managerPin,
    });
  });

  const view = await getBillView(prisma, bill.id);

  return {
    id: view.id,
    branchId: view.branchId,
    discount: view.discount,
    bill: {
      subtotalPaise: view.subtotalPaise,
      discountPaise: view.discountPaise,
      taxPaise: view.taxPaise,
      roundOffPaise: view.roundOffPaise,
      totalPaise: view.totalPaise,
      paidPaise: view.paidPaise,
      remainingPaise: view.remainingPaise,
    },
  };
}

/**
 * Records one payment on a bill. Retrying with the same idempotency key
 * returns the original payment instead of charging twice. Paying the full
 * balance settles the bill and issues the invoice.
 *
 * @param actor - The user receiving the payment.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param input - The validated payment.
 * @returns The payment with the bill's updated balance, or null if not found.
 * @throws BillingServiceError If the bill is not open or the payment exceeds the balance.
 */
export async function recordBillPayment(
  actor: BillingActor,
  branchId: string,
  billId: string,
  input: RecordBillPaymentInput,
) {
  const bill = await findBill(actor.organizationId, branchId, billId);

  if (!bill) {
    return null;
  }

  const [result] = await runBillingTransaction((tx) =>
    recordPaymentsInTx(tx, actor, bill.id, [
      {
        method: PAYMENT_METHOD_FROM_API[input.method],
        amountPaise: input.amountPaise,
        tenderedPaise: input.tenderedPaise,
        reference: input.reference ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    ]),
  );

  const [payment, view] = await Promise.all([
    prisma.billPayment.findUniqueOrThrow({
      where: { id: result.id },
      select: {
        id: true,
        billId: true,
        branchId: true,
        amountPaise: true,
        method: true,
        tenderedPaise: true,
        reference: true,
        paidAt: true,
      },
    }),
    getBillView(prisma, bill.id),
  ]);

  return {
    ...payment,
    method: payment.method.toLowerCase(),
    changePaise:
      payment.tenderedPaise !== null ? payment.tenderedPaise - payment.amountPaise : null,
    replayed: result.replayed,
    bill: {
      status: view.status,
      totalPaise: view.totalPaise,
      paidPaise: view.paidPaise,
      remainingPaise: view.remainingPaise,
      settledAt: view.settledAt,
    },
    invoice: view.invoice,
  };
}

/**
 * Settles a fully paid bill and issues its GST invoice. When the cashier
 * sends the collected total, it must match the payments recorded.
 *
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param input - The optional collected total.
 * @returns The settled bill with its invoice, or null if not found.
 * @throws BillingServiceError If the bill is cancelled, not fully paid or the total doesn't match.
 */
export async function settleBill(
  actor: BillingActor,
  branchId: string,
  billId: string,
  input: SettleBillInput,
) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, branchId, organizationId: actor.organizationId },
    select: { id: true, paidPaise: true },
  });

  if (!bill) {
    return null;
  }

  if (input.totalPaymentPaise !== undefined && input.totalPaymentPaise !== bill.paidPaise) {
    throw new BillingServiceError(
      BillingServiceErrorCode.PAYMENT_MISMATCH,
      `Collected ${formatRupees(input.totalPaymentPaise)} but ${formatRupees(bill.paidPaise)} is recorded on this bill`,
    );
  }

  await runBillingTransaction((tx) => settleBillInTx(tx, bill.id));

  const view = await getBillView(prisma, bill.id);

  return {
    id: view.id,
    branchId: view.branchId,
    status: view.status,
    totalPaise: view.totalPaise,
    paidPaise: view.paidPaise,
    remainingPaise: view.remainingPaise,
    invoice: view.invoice,
    settledAt: view.settledAt,
  };
}

/**
 * Cancels an open bill without payments and releases its orders back to
 * open, so they can be edited or billed again. Owners and managers only.
 *
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @param billId - The bill ID.
 * @param input - The cancellation reason.
 * @returns The cancelled bill, or null if not found.
 * @throws BillingServiceError If not permitted, not open, or payments exist.
 */
export async function cancelBill(
  actor: BillingActor,
  branchId: string,
  billId: string,
  input: CancelBillInput,
) {
  if (!BILLING_MANAGER_ROLES.includes(actor.role)) {
    throw new BillingServiceError(
      BillingServiceErrorCode.FORBIDDEN,
      "Only an owner or manager can cancel bills",
    );
  }

  const bill = await findBill(actor.organizationId, branchId, billId);

  if (!bill) {
    return null;
  }

  await runBillingTransaction(async (tx) => {
    const current = await tx.bill.findUniqueOrThrow({
      where: { id: bill.id },
      select: { status: true, paidPaise: true },
    });

    if (current.status !== BillStatus.OPEN) {
      throw new BillingServiceError(
        BillingServiceErrorCode.BILL_NOT_OPEN,
        "Only open bills can be cancelled",
      );
    }

    if (current.paidPaise > 0) {
      throw new BillingServiceError(
        BillingServiceErrorCode.BILL_HAS_PAYMENTS,
        "This bill has payments and can't be cancelled",
      );
    }

    await tx.bill.update({
      where: { id: bill.id },
      data: {
        status: BillStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: actor.userId,
        cancelReason: input.reason,
      },
    });

    await tx.order.updateMany({
      where: { billId: bill.id },
      data: {
        billId: null,
        status: OrderStatus.OPEN,
        billedAt: null,
        paymentStatus: PaymentStatus.UNPAID,
      },
    });
  });

  return getBillView(prisma, bill.id);
}

/**
 * Issues a credit note against an invoice (refund or correction). The
 * acting owner/manager confirms with their own PIN. Credits can't exceed
 * the invoice total; the GST share is reversed proportionally.
 *
 * @param actor - The authenticated owner or manager.
 * @param branchId - The branch ID.
 * @param invoiceId - The invoice ID.
 * @param input - The validated credit note.
 * @returns The credit note, or null if the invoice is not found.
 * @throws BillingServiceError If the PIN is missing/wrong or the credit is too large.
 */
export async function createCreditNote(
  actor: BillingActor,
  branchId: string,
  invoiceId: string,
  input: CreateCreditNoteInput,
) {
  if (!BILLING_MANAGER_ROLES.includes(actor.role)) {
    throw new BillingServiceError(
      BillingServiceErrorCode.FORBIDDEN,
      "Only an owner or manager can issue credit notes",
    );
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, branchId, organizationId: actor.organizationId },
    select: { id: true },
  });

  if (!invoice) {
    return null;
  }

  const membership = await prisma.membership.findUnique({
    where: {
      organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId },
    },
    select: { pinHash: true },
  });

  if (!membership?.pinHash) {
    throw new BillingServiceError(
      BillingServiceErrorCode.PIN_NOT_SET,
      "Set your manager PIN first (POST /api/v1/auth/manager-pin)",
    );
  }

  if (!(await verifyPassword(input.managerPin, membership.pinHash))) {
    throw new BillingServiceError(
      BillingServiceErrorCode.INVALID_MANAGER_PIN,
      "Invalid manager PIN",
    );
  }

  const creditNoteId = await runBillingTransaction(async (tx) => {
    const current = await tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: {
        organizationId: true,
        totalPaise: true,
        taxPaise: true,
        creditedPaise: true,
        branch: { select: billingBranchSelect },
      },
    });

    const creditablePaise = current.totalPaise - current.creditedPaise;

    if (input.amountPaise > creditablePaise) {
      throw new BillingServiceError(
        BillingServiceErrorCode.CREDIT_EXCEEDS_INVOICE,
        `Only ${formatRupees(creditablePaise)} of this invoice can still be credited`,
      );
    }

    const { branch } = current;
    const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);
    const financialYear = getFinancialYear(businessDate);
    const sequence = await nextBranchCounter(tx, branch.id, `credit-note:${financialYear}`);
    const creditedPaise = current.creditedPaise + input.amountPaise;

    const creditNote = await tx.creditNote.create({
      data: {
        organizationId: current.organizationId,
        branchId: branch.id,
        invoiceId: invoice.id,
        creditNoteNumber: formatCreditNoteNumber(branch.code, financialYear, sequence),
        financialYear,
        businessDate,
        originalAmountPaise: current.totalPaise,
        creditAmountPaise: input.amountPaise,
        taxPaise:
          current.totalPaise === 0
            ? 0
            : Math.round((input.amountPaise * current.taxPaise) / current.totalPaise),
        reasonCode: input.reasonCode,
        createdById: actor.userId,
      },
      select: { id: true },
    });

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        creditedPaise,
        status:
          creditedPaise >= current.totalPaise
            ? InvoiceStatus.CREDITED
            : InvoiceStatus.PARTIALLY_CREDITED,
      },
    });

    return creditNote.id;
  });

  const creditNote = await prisma.creditNote.findUniqueOrThrow({
    where: { id: creditNoteId },
    select: {
      id: true,
      branchId: true,
      invoiceId: true,
      creditNoteNumber: true,
      financialYear: true,
      originalAmountPaise: true,
      creditAmountPaise: true,
      taxPaise: true,
      reasonCode: true,
      status: true,
      createdById: true,
      createdAt: true,
    },
  });

  const { createdById, ...creditNoteData } = creditNote;

  return {
    ...creditNoteData,
    financialYear: toDisplayFinancialYear(creditNote.financialYear),
    status: creditNote.status.toLowerCase(),
    createdBy: createdById,
  };
}

/**
 * Lists a branch's invoices, newest first, filtered by business day range,
 * status or bill.
 *
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @param query - Validated filters and pagination.
 * @returns The invoices and pagination metadata.
 */
export async function listInvoices(
  actor: BillingActor,
  branchId: string,
  query: ListInvoicesQuery,
) {
  const where = {
    branchId,
    organizationId: actor.organizationId,
    ...((query.from !== undefined || query.to !== undefined) && {
      businessDate: {
        ...(query.from !== undefined && { gte: query.from }),
        ...(query.to !== undefined && { lte: query.to }),
      },
    }),
    ...(query.status !== undefined && { status: INVOICE_STATUS_FROM_API[query.status] }),
    ...(query.billId !== undefined && { billId: query.billId }),
  };

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { issuedAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: invoiceSelect,
    }),
    prisma.invoice.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    invoices: invoices.map((invoice) => serializeInvoice(invoice)),
  };
}

/**
 * Retrieves an invoice with its credit notes.
 *
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @param invoiceId - The invoice ID.
 * @returns The invoice, or null if not found.
 */
export async function getInvoice(actor: BillingActor, branchId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, branchId, organizationId: actor.organizationId },
    select: {
      ...invoiceSelect,
      creditNotes: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          creditNoteNumber: true,
          creditAmountPaise: true,
          taxPaise: true,
          reasonCode: true,
          status: true,
          createdAt: true,
          createdBy: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!invoice) {
    return null;
  }

  const { creditNotes, ...invoiceData } = invoice;

  return {
    ...serializeInvoice(invoiceData),
    creditNotes: creditNotes.map((creditNote) => ({
      ...creditNote,
      status: creditNote.status.toLowerCase(),
    })),
  };
}

/**
 * Checks whether an unknown value matches a known billing service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value contains a recognized billing service error
 * code and a string message.
 */
export function isBillingServiceError(
  error: unknown,
): error is BillingServiceError {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("message" in error)
  ) {
    return false;
  }

  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    error instanceof BillingServiceError &&
    Object.values(BillingServiceErrorCode).includes(
      error.code as BillingServiceErrorCode,
    )
  );
}
