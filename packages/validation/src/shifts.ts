import { z } from "zod";

/** Shift statuses as used by the shift API. */
export const SHIFT_STATUSES = ["open", "closed"] as const;

/** Cash put into (pay_in) or taken out of (pay_out) the drawer mid-shift. */
export const CASH_MOVEMENT_TYPES = ["pay_in", "pay_out"] as const;

/** Expense categories as used by the expense API. */
export const EXPENSE_CATEGORIES = [
  "supplies",
  "food_stock",
  "utilities",
  "maintenance",
  "staff_welfare",
  "transport",
  "marketing",
  "rent",
  "other",
] as const;

/** How an expense was paid. Only cash paid from a shift reduces its drawer. */
export const EXPENSE_PAYMENT_MODES = ["cash", "upi", "card", "bank_transfer"] as const;

/** Indian currency notes and coins a cashier counts at close, in rupees. */
export const CASH_DENOMINATIONS = ["2000", "500", "200", "100", "50", "20", "10", "5", "2", "1"] as const;

/** Largest amount accepted: ₹1 crore. */
const MAX_RUPEES = 10_000_000;

/** A rupee amount with at most 2 decimals (paise). */
const rupeesSchema = z
  .number()
  .min(0)
  .max(MAX_RUPEES)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: "Amount can have at most 2 decimal places",
  });

const positiveRupeesSchema = rupeesSchema.refine((value) => value > 0, {
  message: "Amount must be greater than 0",
});

const noteSchema = z.string().trim().min(1).max(300);

const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

/** A receipt photo sent inline as a data URL (data:image/png;base64,...). */
const receiptSchema = z
  .string()
  .regex(
    /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/,
    "Receipt must be a PNG, JPG or WebP image data URL",
  );

const expenseLineSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  amount: positiveRupeesSchema,
  reason: noteSchema,
});

export const shiftIdParamsSchema = z.object({
  shiftId: z.uuid(),
});

export const expenseIdParamsSchema = z.object({
  expenseId: z.uuid(),
});

export const openShiftSchema = z.object({
  branchId: z.uuid(),
  /** The cashier (user) this shift's drawer belongs to; defaults to the caller. */
  staffId: z.uuid().optional(),
  openingCash: rupeesSchema,
  note: noteSchema.optional(),
});

export const closeShiftSchema = z
  .object({
    /** Optional; must match the shift in the URL when sent. */
    shiftId: z.uuid().optional(),
    /** Cash counted in the drawer. Send this, denominations, or both. */
    countedCash: rupeesSchema.optional(),
    /** Count per note/coin, e.g. { "500": 10, "100": 25 }. */
    denominations: z
      .partialRecord(z.enum(CASH_DENOMINATIONS), z.number().int().min(0).max(100_000))
      .optional(),
    /** Last-minute cash expenses paid from this drawer. */
    expenses: z.array(expenseLineSchema).max(50).default([]),
    note: noteSchema.optional(),
  })
  .refine((data) => data.countedCash !== undefined || data.denominations !== undefined, {
    message: "Send countedCash or denominations",
    path: ["countedCash"],
  });

export const cashMovementSchema = z.object({
  type: z.enum(CASH_MOVEMENT_TYPES),
  amount: positiveRupeesSchema,
  reason: noteSchema,
});

export const listShiftsQuerySchema = z.object({
  branchId: z.uuid(),
  status: z.enum(SHIFT_STATUSES).optional(),
  staffId: z.uuid().optional(),
  businessDate: businessDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const currentShiftQuerySchema = z.object({
  branchId: z.uuid(),
});

export const createExpenseSchema = z.object({
  branchId: z.uuid(),
  /** Link to an open shift; cash expenses then come out of that drawer. */
  shiftId: z.uuid().optional(),
  category: z.enum(EXPENSE_CATEGORIES),
  amount: positiveRupeesSchema,
  description: noteSchema,
  paymentMode: z.enum(EXPENSE_PAYMENT_MODES).default("cash"),
  receipt: receiptSchema.optional(),
});

export const voidExpenseSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

export const listExpensesQuerySchema = z
  .object({
    branchId: z.uuid(),
    shiftId: z.uuid().optional(),
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    /** Business day range, inclusive (YYYY-MM-DD). */
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
    includeVoided: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default(false),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

export type ShiftStatusValue = (typeof SHIFT_STATUSES)[number];
export type CashMovementTypeValue = (typeof CASH_MOVEMENT_TYPES)[number];
export type ExpenseCategoryValue = (typeof EXPENSE_CATEGORIES)[number];
export type ExpensePaymentModeValue = (typeof EXPENSE_PAYMENT_MODES)[number];
export type OpenShiftInput = z.infer<typeof openShiftSchema>;
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;
export type CashMovementInput = z.infer<typeof cashMovementSchema>;
export type ListShiftsQuery = z.infer<typeof listShiftsQuerySchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type VoidExpenseInput = z.infer<typeof voidExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
