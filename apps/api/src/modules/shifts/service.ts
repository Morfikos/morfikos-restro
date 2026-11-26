import { db as prisma } from "../../plugins/db.js";
import { ShiftServiceErrorCode, type UserRole } from "@morfikos/auth";
import type {
  CashMovementInput,
  CloseShiftInput,
  CreateExpenseInput,
  ListExpensesQuery,
  ListShiftsQuery,
  OpenShiftInput,
} from "@morfikos/validation";

import { getBusinessDate } from "../../utils/branch-time.js";
import { MAX_IMAGE_BYTES, detectImageType, saveUpload } from "../../utils/storage.js";
import { fromPaise, toPaise } from "../orders/pricing.js";
import {
  CASH_MOVEMENT_TYPE_FROM_API,
  CashMovementType,
  EXPENSE_CATEGORY_FROM_API,
  EXPENSE_PAYMENT_MODE_FROM_API,
  ExpensePaymentMode,
  RECEIPT_FOLDER,
  SHIFT_MANAGER_ROLES,
  SHIFT_STATUS_FROM_API,
  SHIFT_TRANSACTION_OPTIONS,
  ShiftStatus,
} from "./constants.js";


/** The Prisma client available inside an interactive transaction. */
type TransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/**
 * The authenticated user performing a shift or expense operation.
 */
export interface ShiftActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

/**
 * Represents errors that can occur during shift and expense operations.
 */
export class ShiftServiceError extends Error {
  /**
   * Creates a shift service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: ShiftServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ShiftServiceError";
  }
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
 * Checks whether the actor manages shifts (owner or manager).
 *
 * @param actor - The authenticated user.
 * @returns True for owners and managers.
 */
function isShiftManager(actor: ShiftActor): boolean {
  return SHIFT_MANAGER_ROLES.includes(actor.role);
}

/**
 * Atomically increments and returns a named per-branch counter.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @param name - The counter name, e.g. "shift:2026-11-03".
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

/**
 * Loads an active branch of the organization.
 *
 * @param organizationId - The organization ID.
 * @param branchId - The branch ID.
 * @returns The branch's clock settings.
 * @throws ShiftServiceError If the branch is not found.
 */
async function getActiveBranch(organizationId: string, branchId: string) {
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, organizationId, status: "active" },
    select: { id: true, timezone: true, businessDayCutoff: true },
  });

  if (!branch) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.BRANCH_NOT_FOUND,
      "Active branch not found",
    );
  }

  return branch;
}

/**
 * Calculates a shift's drawer position from its payments, cash movements
 * and expenses. Expected cash = opening cash + cash sales + pay-ins −
 * pay-outs − cash expenses paid from the drawer.
 *
 * @param client - A Prisma client or transaction client.
 * @param shiftId - The shift ID.
 * @param openingCashPaise - The shift's opening cash, in paise.
 * @returns The cash position in paise.
 */
async function calculateShiftCash(
  client: TransactionClient,
  shiftId: string,
  openingCashPaise: number,
) {
  const [payments, movements, expenses, settledBills] = await Promise.all([
    client.billPayment.groupBy({
      by: ["method"],
      where: { shiftId },
      _sum: { amountPaise: true },
      _count: { _all: true },
    }),
    client.cashMovement.groupBy({
      by: ["type"],
      where: { shiftId },
      _sum: { amountPaise: true },
    }),
    client.expense.groupBy({
      by: ["paymentMode"],
      where: { shiftId, voidedAt: null },
      _sum: { amountPaise: true },
    }),
    client.bill.count({ where: { shiftId, status: "SETTLED" } }),
  ]);

  const paidBy = (method: string) =>
    payments.find((entry) => entry.method === method)?._sum.amountPaise ?? 0;
  const moved = (type: CashMovementType) =>
    movements.find((entry) => entry.type === type)?._sum.amountPaise ?? 0;

  const cashSalesPaise = paidBy("CASH");
  const upiSalesPaise = paidBy("UPI");
  const cardSalesPaise = paidBy("CARD");
  const payInsPaise = moved(CashMovementType.PAY_IN);
  const payOutsPaise = moved(CashMovementType.PAY_OUT);
  const cashExpensesPaise =
    expenses.find((entry) => entry.paymentMode === ExpensePaymentMode.CASH)?._sum
      .amountPaise ?? 0;
  const otherExpensesPaise =
    expenses.reduce((sum, entry) => sum + (entry._sum.amountPaise ?? 0), 0) -
    cashExpensesPaise;

  return {
    openingCashPaise,
    cashSalesPaise,
    upiSalesPaise,
    cardSalesPaise,
    totalSalesPaise: cashSalesPaise + upiSalesPaise + cardSalesPaise,
    paymentsCount: payments.reduce((sum, entry) => sum + entry._count._all, 0),
    settledBills,
    payInsPaise,
    payOutsPaise,
    cashExpensesPaise,
    otherExpensesPaise,
    expectedCashPaise:
      openingCashPaise + cashSalesPaise + payInsPaise - payOutsPaise - cashExpensesPaise,
  };
}

/** A shift's drawer position in paise, as calculated by {@link calculateShiftCash}. */
type ShiftCash = Awaited<ReturnType<typeof calculateShiftCash>>;

/**
 * Converts a drawer position to rupees for the API.
 *
 * @param cash - The drawer position in paise.
 * @returns The drawer position in rupees.
 */
function serializeShiftCash(cash: ShiftCash) {
  return {
    openingCash: fromPaise(cash.openingCashPaise),
    cashSales: fromPaise(cash.cashSalesPaise),
    upiSales: fromPaise(cash.upiSalesPaise),
    cardSales: fromPaise(cash.cardSalesPaise),
    totalSales: fromPaise(cash.totalSalesPaise),
    paymentsCount: cash.paymentsCount,
    settledBills: cash.settledBills,
    payIns: fromPaise(cash.payInsPaise),
    payOuts: fromPaise(cash.payOutsPaise),
    cashExpenses: fromPaise(cash.cashExpensesPaise),
    otherExpenses: fromPaise(cash.otherExpensesPaise),
    expectedCash: fromPaise(cash.expectedCashPaise),
  };
}

/** Fields returned for a shift's full view. */
const shiftSelect = {
  id: true,
  branchId: true,
  shiftNumber: true,
  businessDate: true,
  status: true,
  openedAt: true,
  openingCashPaise: true,
  openingNote: true,
  closedAt: true,
  countedCashPaise: true,
  expectedCashPaise: true,
  variancePaise: true,
  denominations: true,
  closingNote: true,
  summary: true,
  staff: { select: { id: true, name: true } },
  openedBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
  cashMovements: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      type: true,
      amountPaise: true,
      reason: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
    },
  },
  expenses: {
    where: { voidedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      category: true,
      amountPaise: true,
      description: true,
      paymentMode: true,
      receiptUrl: true,
      createdAt: true,
    },
  },
} as const;

/**
 * Loads a shift's full view. An open shift's summary is calculated live; a
 * closed shift returns the summary frozen at close.
 *
 * @param shiftId - The shift ID.
 * @returns The shift as returned by the API.
 */
async function getShiftView(shiftId: string) {
  const shift = await prisma.shift.findUniqueOrThrow({
    where: { id: shiftId },
    select: shiftSelect,
  });

  const {
    openingCashPaise,
    countedCashPaise,
    expectedCashPaise,
    variancePaise,
    summary,
    status,
    cashMovements,
    expenses,
    ...shiftData
  } = shift;

  const cashSummary =
    status === ShiftStatus.CLOSED && summary
      ? (summary as Record<string, unknown>)
      : serializeShiftCash(await calculateShiftCash(prisma, shift.id, openingCashPaise));

  return {
    ...shiftData,
    status: status.toLowerCase(),
    openingCash: fromPaise(openingCashPaise),
    countedCash: countedCashPaise !== null ? fromPaise(countedCashPaise) : null,
    expectedCash:
      expectedCashPaise !== null
        ? fromPaise(expectedCashPaise)
        : (cashSummary.expectedCash ?? null),
    variance: variancePaise !== null ? fromPaise(variancePaise) : null,
    summary: cashSummary,
    cashMovements: cashMovements.map(({ amountPaise, type, ...movement }) => ({
      ...movement,
      type: type.toLowerCase(),
      amount: fromPaise(amountPaise),
    })),
    expenses: expenses.map(({ amountPaise, category, paymentMode, ...expense }) => ({
      ...expense,
      category: category.toLowerCase(),
      paymentMode: paymentMode.toLowerCase(),
      amount: fromPaise(amountPaise),
    })),
  };
}

/**
 * Finds a shift the actor may see: managers see any shift of their
 * branches; cashiers only their own.
 *
 * @param actor - The authenticated user.
 * @param shiftId - The shift ID.
 * @returns The shift's state, or null if not found or not visible.
 */
async function findVisibleShift(actor: ShiftActor, shiftId: string) {
  const shift = await prisma.shift.findFirst({
    where: {
      id: shiftId,
      organizationId: actor.organizationId,
      branchId: { in: actor.branchIds },
    },
    select: {
      id: true,
      branchId: true,
      staffId: true,
      status: true,
      openingCashPaise: true,
    },
  });

  if (!shift || (!isShiftManager(actor) && shift.staffId !== actor.userId)) {
    return null;
  }

  return shift;
}

/**
 * Throws unless the shift is open.
 *
 * @param shift - The shift's status.
 * @throws ShiftServiceError If the shift is closed.
 */
function assertShiftOpen(shift: { status: string }): void {
  if (shift.status !== ShiftStatus.OPEN) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.SHIFT_CLOSED,
      "This shift is already closed",
    );
  }
}

/**
 * Opens a cash drawer shift for a cashier with the opening float counted
 * into the drawer. A cashier can have only one open shift per branch.
 *
 * @param actor - The owner or manager opening the shift.
 * @param input - The branch, cashier and opening cash.
 * @returns The opened shift.
 * @throws ShiftServiceError If the branch or cashier is invalid, or the
 * cashier already has an open shift.
 */
export async function openShift(actor: ShiftActor, input: OpenShiftInput) {
  const branch = await getActiveBranch(actor.organizationId, input.branchId);
  const staffId = input.staffId ?? actor.userId;

  const membership = await prisma.membership.findFirst({
    where: {
      organizationId: actor.organizationId,
      userId: staffId,
      status: "active",
      user: { status: "active" },
    },
    select: {
      user: { select: { role: true } },
      branchRoles: { select: { branchId: true } },
    },
  });

  // Owners cover every branch; others need an org-wide or this-branch role.
  const worksAtBranch =
    membership !== null &&
    (membership.user.role === "owner" ||
      membership.branchRoles.some(
        (assignment) => assignment.branchId === null || assignment.branchId === branch.id,
      ));

  if (!worksAtBranch) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.STAFF_NOT_FOUND,
      "This staff member doesn't work at this branch",
    );
  }

  const openShiftForStaff = await prisma.shift.findFirst({
    where: { branchId: branch.id, staffId, status: ShiftStatus.OPEN },
    select: { shiftNumber: true, businessDate: true },
  });

  if (openShiftForStaff) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.SHIFT_ALREADY_OPEN,
      `This cashier already has shift #${openShiftForStaff.shiftNumber} (${openShiftForStaff.businessDate}) open. Close it first.`,
    );
  }

  const shiftId = await prisma.$transaction(async (tx) => {
    const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);
    const shiftNumber = await nextBranchCounter(tx, branch.id, `shift:${businessDate}`);

    const shift = await tx.shift.create({
      data: {
        organizationId: actor.organizationId,
        branchId: branch.id,
        shiftNumber,
        businessDate,
        staffId,
        openedById: actor.userId,
        openingCashPaise: toPaise(input.openingCash),
        openingNote: input.note ?? null,
      },
      select: { id: true },
    });

    return shift.id;
  }, SHIFT_TRANSACTION_OPTIONS);

  return getShiftView(shiftId);
}

/**
 * Closes a shift and reconciles the drawer: records any last cash expenses,
 * counts the cash (directly or from denominations), and compares it with the
 * expected cash. The summary is frozen on the shift.
 *
 * @param actor - The owner or manager closing the shift.
 * @param shiftId - The shift ID.
 * @param input - The counted cash, denominations, expenses and note.
 * @returns The closed shift with expected cash, counted cash and variance,
 * or null if not found.
 * @throws ShiftServiceError If the shift is closed or the count doesn't add up.
 */
export async function closeShift(
  actor: ShiftActor,
  shiftId: string,
  input: CloseShiftInput,
) {
  const shift = await findVisibleShift(actor, shiftId);

  if (!shift) {
    return null;
  }

  assertShiftOpen(shift);

  const denominationsPaise =
    input.denominations !== undefined
      ? Object.entries(input.denominations).reduce(
          (sum, [note, count]) => sum + Number(note) * 100 * (count ?? 0),
          0,
        )
      : null;
  const countedFromInput =
    input.countedCash !== undefined ? toPaise(input.countedCash) : null;

  if (
    countedFromInput !== null &&
    denominationsPaise !== null &&
    countedFromInput !== denominationsPaise
  ) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.CASH_COUNT_MISMATCH,
      `countedCash ${formatRupees(countedFromInput)} doesn't match the denominations total ${formatRupees(denominationsPaise)}`,
    );
  }

  const countedCashPaise = countedFromInput ?? denominationsPaise ?? 0;
  const branch = await getActiveBranch(actor.organizationId, shift.branchId);

  await prisma.$transaction(async (tx) => {
    if (input.expenses.length > 0) {
      const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);

      await tx.expense.createMany({
        data: input.expenses.map((expense) => ({
          organizationId: actor.organizationId,
          branchId: shift.branchId,
          shiftId: shift.id,
          businessDate,
          category: EXPENSE_CATEGORY_FROM_API[expense.category],
          amountPaise: toPaise(expense.amount),
          description: expense.reason,
          paymentMode: ExpensePaymentMode.CASH,
          createdById: actor.userId,
        })),
      });
    }

    const cash = await calculateShiftCash(tx, shift.id, shift.openingCashPaise);
    const summary = serializeShiftCash(cash);

    // Guarded by status so a double close can't overwrite the reconciliation.
    const closed = await tx.shift.updateMany({
      where: { id: shift.id, status: ShiftStatus.OPEN },
      data: {
        status: ShiftStatus.CLOSED,
        closedById: actor.userId,
        closedAt: new Date(),
        countedCashPaise,
        expectedCashPaise: cash.expectedCashPaise,
        variancePaise: countedCashPaise - cash.expectedCashPaise,
        denominations: input.denominations ?? undefined,
        closingNote: input.note ?? null,
        summary,
      },
    });

    if (closed.count !== 1) {
      throw new ShiftServiceError(
        ShiftServiceErrorCode.SHIFT_CLOSED,
        "This shift is already closed",
      );
    }
  }, SHIFT_TRANSACTION_OPTIONS);

  return getShiftView(shift.id);
}

/**
 * Records cash put into (pay-in) or taken out of (pay-out) an open
 * shift's drawer. A pay-out can't exceed the cash expected in the drawer.
 *
 * @param actor - The owner or manager.
 * @param shiftId - The shift ID.
 * @param input - The movement type, amount and reason.
 * @returns The movement and the drawer's new expected cash, or null if not found.
 * @throws ShiftServiceError If the shift is closed or the drawer is short.
 */
export async function addCashMovement(
  actor: ShiftActor,
  shiftId: string,
  input: CashMovementInput,
) {
  const shift = await findVisibleShift(actor, shiftId);

  if (!shift) {
    return null;
  }

  assertShiftOpen(shift);

  const type = CASH_MOVEMENT_TYPE_FROM_API[input.type];
  const amountPaise = toPaise(input.amount);

  const movement = await prisma.$transaction(async (tx) => {
    if (type === CashMovementType.PAY_OUT) {
      const cash = await calculateShiftCash(tx, shift.id, shift.openingCashPaise);

      if (amountPaise > cash.expectedCashPaise) {
        throw new ShiftServiceError(
          ShiftServiceErrorCode.INSUFFICIENT_CASH,
          `Only ${formatRupees(cash.expectedCashPaise)} is expected in the drawer`,
        );
      }
    }

    return tx.cashMovement.create({
      data: {
        shiftId: shift.id,
        branchId: shift.branchId,
        type,
        amountPaise,
        reason: input.reason,
        createdById: actor.userId,
      },
      select: { id: true, type: true, amountPaise: true, reason: true, createdAt: true },
    });
  }, SHIFT_TRANSACTION_OPTIONS);

  const cash = await calculateShiftCash(prisma, shift.id, shift.openingCashPaise);

  return {
    id: movement.id,
    shiftId: shift.id,
    type: movement.type.toLowerCase(),
    amount: fromPaise(movement.amountPaise),
    reason: movement.reason,
    createdAt: movement.createdAt,
    expectedCash: fromPaise(cash.expectedCashPaise),
  };
}

/**
 * Retrieves a shift with its live (or, once closed, frozen) cash summary.
 *
 * @param actor - The authenticated user.
 * @param shiftId - The shift ID.
 * @returns The shift, or null if not found or not visible.
 */
export async function getShift(actor: ShiftActor, shiftId: string) {
  const shift = await findVisibleShift(actor, shiftId);

  return shift ? getShiftView(shift.id) : null;
}

/**
 * Retrieves the caller's open shift at a branch (what a cashier's POS shows).
 *
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @returns The open shift, or null if the caller has none.
 */
export async function getCurrentShift(actor: ShiftActor, branchId: string) {
  const shift = await prisma.shift.findFirst({
    where: {
      organizationId: actor.organizationId,
      branchId,
      staffId: actor.userId,
      status: ShiftStatus.OPEN,
    },
    select: { id: true },
  });

  return shift ? getShiftView(shift.id) : null;
}

/**
 * Lists a branch's shifts, newest first. Cashiers only see their own.
 *
 * @param actor - The authenticated user.
 * @param query - Validated filters and pagination.
 * @returns The shifts and pagination metadata.
 */
export async function listShifts(actor: ShiftActor, query: ListShiftsQuery) {
  const where = {
    organizationId: actor.organizationId,
    branchId: query.branchId,
    ...(query.status !== undefined && { status: SHIFT_STATUS_FROM_API[query.status] }),
    ...(query.businessDate !== undefined && { businessDate: query.businessDate }),
    // Cashiers are limited to their own shifts whatever filter they send.
    ...(isShiftManager(actor)
      ? query.staffId !== undefined && { staffId: query.staffId }
      : { staffId: actor.userId }),
  };

  const [shifts, total] = await Promise.all([
    prisma.shift.findMany({
      where,
      orderBy: { openedAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        shiftNumber: true,
        businessDate: true,
        status: true,
        openedAt: true,
        closedAt: true,
        openingCashPaise: true,
        countedCashPaise: true,
        expectedCashPaise: true,
        variancePaise: true,
        staff: { select: { id: true, name: true } },
      },
    }),
    prisma.shift.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    shifts: shifts.map(
      ({ status, openingCashPaise, countedCashPaise, expectedCashPaise, variancePaise, ...shift }) => ({
        ...shift,
        status: status.toLowerCase(),
        openingCash: fromPaise(openingCashPaise),
        countedCash: countedCashPaise !== null ? fromPaise(countedCashPaise) : null,
        expectedCash: expectedCashPaise !== null ? fromPaise(expectedCashPaise) : null,
        variance: variancePaise !== null ? fromPaise(variancePaise) : null,
      }),
    ),
  };
}

/**
 * Decodes a receipt photo sent as a data URL and saves it.
 *
 * @param receipt - The data URL (data:image/png;base64,...).
 * @returns The saved receipt's URL.
 * @throws ShiftServiceError If it is not a real JPG/PNG/WebP image or is too large.
 */
async function saveReceipt(receipt: string): Promise<string> {
  const base64 = receipt.slice(receipt.indexOf(",") + 1).replace(/\s/g, "");
  const image = Buffer.from(base64, "base64");

  if (image.length > MAX_IMAGE_BYTES) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.INVALID_RECEIPT,
      `Receipt image must be at most ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`,
    );
  }

  const imageType = detectImageType(image);

  if (!imageType) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.INVALID_RECEIPT,
      "Receipt must be a JPG, PNG or WebP image",
    );
  }

  return saveUpload(image, RECEIPT_FOLDER, imageType.extension);
}

/** Fields returned for expenses. */
const expenseSelect = {
  id: true,
  branchId: true,
  shiftId: true,
  businessDate: true,
  category: true,
  amountPaise: true,
  description: true,
  paymentMode: true,
  receiptUrl: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/**
 * Serializes an expense for the API.
 *
 * @param expense - An expense selected with {@link expenseSelect}.
 * @returns The expense with rupee amounts and lowercase enums.
 */
function serializeExpense<
  T extends { amountPaise: number; category: string; paymentMode: string },
>(expense: T) {
  const { amountPaise, category, paymentMode, ...expenseData } = expense;

  return {
    ...expenseData,
    category: category.toLowerCase(),
    paymentMode: paymentMode.toLowerCase(),
    amount: fromPaise(amountPaise),
  };
}

/**
 * Records a branch expense, optionally against an open shift and with a
 * receipt photo. A cash expense on a shift is paid from its drawer, so it
 * can't exceed the cash expected there.
 *
 * @param actor - The owner or manager.
 * @param input - The validated expense.
 * @returns The created expense.
 * @throws ShiftServiceError If the branch/shift is invalid, the drawer is
 * short or the receipt is not a valid image.
 */
export async function createExpense(actor: ShiftActor, input: CreateExpenseInput) {
  const branch = await getActiveBranch(actor.organizationId, input.branchId);
  const paymentMode = EXPENSE_PAYMENT_MODE_FROM_API[input.paymentMode];
  const amountPaise = toPaise(input.amount);

  if (input.shiftId !== undefined) {
    const shift = await prisma.shift.findFirst({
      where: { id: input.shiftId, branchId: branch.id },
      select: { id: true, status: true, openingCashPaise: true },
    });

    if (!shift) {
      throw new ShiftServiceError(
        ShiftServiceErrorCode.SHIFT_NOT_FOUND,
        "Shift not found in this branch",
      );
    }

    assertShiftOpen(shift);

    if (paymentMode === ExpensePaymentMode.CASH) {
      const cash = await calculateShiftCash(prisma, shift.id, shift.openingCashPaise);

      if (amountPaise > cash.expectedCashPaise) {
        throw new ShiftServiceError(
          ShiftServiceErrorCode.INSUFFICIENT_CASH,
          `Only ${formatRupees(cash.expectedCashPaise)} is expected in the drawer`,
        );
      }
    }
  }

  const receiptUrl = input.receipt ? await saveReceipt(input.receipt) : null;

  const expense = await prisma.expense.create({
    data: {
      organizationId: actor.organizationId,
      branchId: branch.id,
      shiftId: input.shiftId ?? null,
      businessDate: getBusinessDate(branch.timezone, branch.businessDayCutoff),
      category: EXPENSE_CATEGORY_FROM_API[input.category],
      amountPaise,
      description: input.description,
      paymentMode,
      receiptUrl,
      createdById: actor.userId,
    },
    select: expenseSelect,
  });

  return serializeExpense(expense);
}

/**
 * Lists a branch's expenses, newest first, with the total of the matching
 * (not voided) expenses.
 *
 * @param actor - The authenticated user.
 * @param query - Validated filters and pagination.
 * @returns The expenses, their total and pagination metadata.
 */
export async function listExpenses(actor: ShiftActor, query: ListExpensesQuery) {
  const where = {
    organizationId: actor.organizationId,
    branchId: query.branchId,
    ...(query.shiftId !== undefined && { shiftId: query.shiftId }),
    ...(query.category !== undefined && {
      category: EXPENSE_CATEGORY_FROM_API[query.category],
    }),
    ...((query.from !== undefined || query.to !== undefined) && {
      businessDate: {
        ...(query.from !== undefined && { gte: query.from }),
        ...(query.to !== undefined && { lte: query.to }),
      },
    }),
    ...(!query.includeVoided && { voidedAt: null }),
  };

  const [expenses, total, sum] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: expenseSelect,
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({
      where: { ...where, voidedAt: null },
      _sum: { amountPaise: true },
    }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    totalAmount: fromPaise(sum._sum.amountPaise ?? 0),
    expenses: expenses.map((expense) => serializeExpense(expense)),
  };
}

/**
 * Voids an expense entered by mistake (kept for audit). An expense on a
 * closed shift can't be voided because that drawer is already reconciled.
 *
 * @param actor - The owner or manager.
 * @param expenseId - The expense ID.
 * @param reason - Why it is voided.
 * @returns The voided expense, or null if not found.
 * @throws ShiftServiceError If already void or its shift is closed.
 */
export async function voidExpense(actor: ShiftActor, expenseId: string, reason: string) {
  const expense = await prisma.expense.findFirst({
    where: {
      id: expenseId,
      organizationId: actor.organizationId,
      branchId: { in: actor.branchIds },
    },
    select: { id: true, voidedAt: true, shift: { select: { status: true } } },
  });

  if (!expense) {
    return null;
  }

  if (expense.voidedAt) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.EXPENSE_ALREADY_VOID,
      "This expense is already void",
    );
  }

  if (expense.shift && expense.shift.status !== ShiftStatus.OPEN) {
    throw new ShiftServiceError(
      ShiftServiceErrorCode.SHIFT_CLOSED,
      "This expense belongs to a closed shift and can't be changed",
    );
  }

  const voided = await prisma.expense.update({
    where: { id: expense.id },
    data: { voidedAt: new Date(), voidedById: actor.userId, voidReason: reason },
    select: expenseSelect,
  });

  return serializeExpense(voided);
}

/**
 * Checks whether an unknown value is a shift service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value is a ShiftServiceError with a known code.
 */
export function isShiftServiceError(error: unknown): error is ShiftServiceError {
  return (
    error instanceof ShiftServiceError &&
    Object.values(ShiftServiceErrorCode).includes(error.code)
  );
}
