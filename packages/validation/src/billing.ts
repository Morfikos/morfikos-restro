import { z } from "zod";

/** Bill lifecycle as used by the billing API. */
export const BILL_STATUSES = ["open", "settled", "cancelled"] as const;

/** Payment methods as used by the billing API. */
export const BILL_PAYMENT_METHODS = ["cash", "upi", "card"] as const;

/** How a bill discount is expressed: a percentage of the bill or a flat amount in paise. */
export const DISCOUNT_TYPES = ["percentage", "flat"] as const;

/** Invoice statuses as used by the billing API. */
export const INVOICE_STATUSES = ["issued", "partially_credited", "credited"] as const;

/** Largest amount accepted anywhere in billing: ₹1 crore, in paise. */
const MAX_PAISE = 1_000_000_000;

const paiseSchema = z.number().int().min(0).max(MAX_PAISE);
const positivePaiseSchema = z.number().int().min(1).max(MAX_PAISE);
const reasonCodeSchema = z.string().trim().min(2).max(50);
const referenceIdSchema = z.string().trim().min(1).max(64);
const couponCodeSchema = z.string().trim().min(1).max(40).toUpperCase();

/** A manager's 4–6 digit approval PIN. */
export const managerPinSchema = z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits");

const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const billingBranchParamsSchema = z.object({
  branchId: z.uuid(),
});

export const billParamsSchema = z.object({
  branchId: z.uuid(),
  billId: z.uuid(),
});

export const invoiceParamsSchema = z.object({
  branchId: z.uuid(),
  invoiceId: z.uuid(),
});

export const createBillSchema = z.object({
  /** Optional; when omitted it is taken from the orders if they share a table. */
  tableId: z.uuid().optional(),
  /** The guest the bill belongs to; they earn loyalty points when it is settled. */
  guestId: z.uuid().optional(),
  /** An open shift of the branch; when omitted, the cashier's open shift is used. */
  shiftId: z.uuid().optional(),
  orderIds: z
    .array(z.uuid())
    .min(1, "Select at least one order")
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "An order can only be added once",
    }),
  /** Optional flat discount applied when the bill is created. */
  discount: z
    .object({
      amountPaise: positivePaiseSchema,
      reasonCode: reasonCodeSchema,
      offerId: referenceIdSchema.optional(),
      couponCode: couponCodeSchema.optional(),
      managerPin: managerPinSchema.optional(),
    })
    .optional(),
});

/**
 * Sets (or replaces) the bill-level discount. `value` is a percentage for
 * type "percentage" and paise for type "flat". A value of 0 removes it.
 */
export const applyBillDiscountSchema = z
  .object({
    type: z.enum(DISCOUNT_TYPES),
    value: z.number().min(0).max(MAX_PAISE),
    offerId: referenceIdSchema.optional(),
    couponCode: couponCodeSchema.optional(),
    reasonCode: reasonCodeSchema.optional(),
    managerPin: managerPinSchema.optional(),
  })
  .refine((data) => data.type !== "percentage" || data.value <= 100, {
    message: "A percentage discount can't be more than 100",
    path: ["value"],
  })
  .refine((data) => data.type !== "flat" || Number.isInteger(data.value), {
    message: "A flat discount must be a whole number of paise",
    path: ["value"],
  })
  .refine((data) => data.value === 0 || data.reasonCode !== undefined, {
    message: "A reason code is required for a discount",
    path: ["reasonCode"],
  });

export const recordBillPaymentSchema = z
  .object({
    amountPaise: positivePaiseSchema,
    method: z.enum(BILL_PAYMENT_METHODS),
    /** UPI/card transaction reference. */
    reference: z.string().trim().max(100).nullable().optional(),
    /** Cash handed over by the guest; the response includes the change due. */
    tenderedPaise: paiseSchema.optional(),
    /** Retrying with the same key returns the first payment instead of charging twice. */
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  })
  .refine((data) => data.tenderedPaise === undefined || data.method === "cash", {
    message: "tenderedPaise is only allowed for cash payments",
    path: ["tenderedPaise"],
  })
  .refine(
    (data) => data.tenderedPaise === undefined || data.tenderedPaise >= data.amountPaise,
    { message: "tenderedPaise must be at least the payment amount", path: ["tenderedPaise"] },
  );

export const settleBillSchema = z.object({
  /** Optional cross-check: the total the cashier collected. */
  totalPaymentPaise: paiseSchema.optional(),
});

export const cancelBillSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

export const createCreditNoteSchema = z.object({
  amountPaise: positivePaiseSchema,
  reasonCode: reasonCodeSchema,
  managerPin: managerPinSchema,
});

export const listBillsQuerySchema = z.object({
  status: z.enum(BILL_STATUSES).optional(),
  tableId: z.uuid().optional(),
  businessDate: businessDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listInvoicesQuerySchema = z
  .object({
    /** Business day range, inclusive (YYYY-MM-DD). */
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
    billId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

/** Sets the signed-in owner's or manager's approval PIN. */
export const setManagerPinSchema = z.object({
  pin: managerPinSchema,
  /** Current account password, to confirm it's really the manager. */
  password: z.string().min(1, "Password is required"),
});

export type BillStatusValue = (typeof BILL_STATUSES)[number];
export type BillPaymentMethodValue = (typeof BILL_PAYMENT_METHODS)[number];
export type DiscountTypeValue = (typeof DISCOUNT_TYPES)[number];
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];
export type CreateBillInput = z.infer<typeof createBillSchema>;
export type ApplyBillDiscountInput = z.infer<typeof applyBillDiscountSchema>;
export type RecordBillPaymentInput = z.infer<typeof recordBillPaymentSchema>;
export type SettleBillInput = z.infer<typeof settleBillSchema>;
export type CancelBillInput = z.infer<typeof cancelBillSchema>;
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;
export type ListBillsQuery = z.infer<typeof listBillsQuerySchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
export type SetManagerPinInput = z.infer<typeof setManagerPinSchema>;
