import type { UserRole } from "@morfikos/auth";
import type {
  CashMovementTypeValue,
  ExpenseCategoryValue,
  ExpensePaymentModeValue,
  ShiftStatusValue,
} from "@morfikos/validation";

/**
 * Cash drawer shift lifecycle. Values match the Prisma `ShiftStatus` enum.
 */
export enum ShiftStatus {
  OPEN = "OPEN",
  CLOSED = "CLOSED",
}

/**
 * Cash added to (PAY_IN) or removed from (PAY_OUT) the drawer mid-shift,
 * e.g. change float top-up or a cash drop to the safe.
 */
export enum CashMovementType {
  PAY_IN = "PAY_IN",
  PAY_OUT = "PAY_OUT",
}

/**
 * Expense categories. Values match the Prisma `ExpenseCategory` enum.
 */
export enum ExpenseCategory {
  SUPPLIES = "SUPPLIES",
  FOOD_STOCK = "FOOD_STOCK",
  UTILITIES = "UTILITIES",
  MAINTENANCE = "MAINTENANCE",
  STAFF_WELFARE = "STAFF_WELFARE",
  TRANSPORT = "TRANSPORT",
  MARKETING = "MARKETING",
  RENT = "RENT",
  OTHER = "OTHER",
}

/**
 * How an expense was paid. Only CASH linked to a shift reduces its drawer.
 */
export enum ExpensePaymentMode {
  CASH = "CASH",
  UPI = "UPI",
  CARD = "CARD",
  BANK_TRANSFER = "BANK_TRANSFER",
}

/** API shift status → stored shift status. */
export const SHIFT_STATUS_FROM_API: Record<ShiftStatusValue, ShiftStatus> = {
  open: ShiftStatus.OPEN,
  closed: ShiftStatus.CLOSED,
};

/** API cash movement type → stored type. */
export const CASH_MOVEMENT_TYPE_FROM_API: Record<CashMovementTypeValue, CashMovementType> = {
  pay_in: CashMovementType.PAY_IN,
  pay_out: CashMovementType.PAY_OUT,
};

/** API expense category → stored category. */
export const EXPENSE_CATEGORY_FROM_API: Record<ExpenseCategoryValue, ExpenseCategory> = {
  supplies: ExpenseCategory.SUPPLIES,
  food_stock: ExpenseCategory.FOOD_STOCK,
  utilities: ExpenseCategory.UTILITIES,
  maintenance: ExpenseCategory.MAINTENANCE,
  staff_welfare: ExpenseCategory.STAFF_WELFARE,
  transport: ExpenseCategory.TRANSPORT,
  marketing: ExpenseCategory.MARKETING,
  rent: ExpenseCategory.RENT,
  other: ExpenseCategory.OTHER,
};

/** API expense payment mode → stored payment mode. */
export const EXPENSE_PAYMENT_MODE_FROM_API: Record<ExpensePaymentModeValue, ExpensePaymentMode> = {
  cash: ExpensePaymentMode.CASH,
  upi: ExpensePaymentMode.UPI,
  card: ExpensePaymentMode.CARD,
  bank_transfer: ExpensePaymentMode.BANK_TRANSFER,
};

/** Roles that open/close shifts, record expenses and move cash. */
export const SHIFT_MANAGER_ROLES: UserRole[] = ["owner", "manager"];

/** Roles that can view shifts (cashiers see only their own). */
export const SHIFT_VIEW_ROLES: UserRole[] = ["owner", "manager", "staff", "waiter"];

/** Upload folder for expense receipt photos. */
export const RECEIPT_FOLDER = "expense-receipts";

/**
 * Request body limit for creating an expense: a 10 MB receipt grows by a
 * third when base64-encoded in a data URL.
 */
export const EXPENSE_BODY_LIMIT_BYTES = 15 * 1024 * 1024;

/** Settings for the transactions that change shifts. */
export const SHIFT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };
