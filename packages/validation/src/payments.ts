import { z } from "zod";

/** UPI payment request lifecycle, as used by the API. */
export const PAYMENT_REQUEST_STATUSES = [
  "pending",
  "submitted",
  "confirmed",
  "rejected",
  "expired",
  "cancelled",
] as const;

/** Largest amount accepted: ₹1 crore, in paise. */
const MAX_PAISE = 1_000_000_000;

/** A UPI ID (VPA), e.g. cafe@okhdfcbank. */
const vpaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,64}$/, "Enter a valid UPI ID, e.g. cafe@okhdfcbank");

/** UPI transaction reference (UTR / RRN) shown in the payer's app. */
const utrSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6,30}$/, "Enter the UPI transaction ID (UTR) from your payment app");

export const paymentBranchParamsSchema = z.object({
  branchId: z.uuid(),
});

export const paymentBillParamsSchema = z.object({
  branchId: z.uuid(),
  billId: z.uuid(),
});

export const paymentRequestIdParamsSchema = z.object({
  requestId: z.uuid(),
});

export const guestPaymentParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, "Invalid session"),
  requestId: z.uuid(),
});

export const updatePaymentSettingsSchema = z
  .object({
    upiEnabled: z.boolean().optional(),
    upiVpa: vpaSchema.nullable().optional(),
    payeeName: z.string().trim().min(1).max(50).nullable().optional(),
    /** Only for merchant (business) UPI IDs; leave empty for a personal UPI ID. */
    merchantCode: z.string().trim().regex(/^\d{4}$/, "Merchant code must be 4 digits").nullable().optional(),
    guestPaymentsEnabled: z.boolean().optional(),
    requestExpiryMinutes: z.number().int().min(2).max(120).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one setting must be provided",
  });

/**
 * Creates a dynamic UPI QR for a bill. For a split bill pick the part;
 * the amount defaults to what's due.
 */
export const createPaymentRequestSchema = z.object({
  partNumber: z.number().int().min(1).max(20).optional(),
  amountPaise: z.number().int().min(100, "Minimum UPI amount is ₹1").max(MAX_PAISE).optional(),
});

/** Staff confirm the money arrived (after checking their UPI app or bank). */
export const confirmPaymentRequestSchema = z.object({
  utr: utrSchema.optional(),
  /** Amount actually received, if different from the request. */
  amountPaise: z.number().int().min(1).max(MAX_PAISE).optional(),
});

export const rejectPaymentRequestSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

export const listPaymentRequestsQuerySchema = z.object({
  status: z.enum(PAYMENT_REQUEST_STATUSES).optional(),
  billId: z.uuid().optional(),
  /** `true` lists only requests waiting for staff (pending and submitted). */
  open: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** A guest asks to pay from the table QR session. */
export const createGuestPaymentSchema = z.object({
  /** Their part, when the bill is split. */
  partNumber: z.number().int().min(1).max(20).optional(),
});

/** A guest says they paid and gives the UPI transaction ID for staff to match. */
export const submitGuestPaymentSchema = z.object({
  utr: utrSchema,
  payerName: z.string().trim().min(1).max(100).optional(),
});

export type PaymentRequestStatusValue = (typeof PAYMENT_REQUEST_STATUSES)[number];
export type UpdatePaymentSettingsInput = z.infer<typeof updatePaymentSettingsSchema>;
export type CreatePaymentRequestInput = z.infer<typeof createPaymentRequestSchema>;
export type ConfirmPaymentRequestInput = z.infer<typeof confirmPaymentRequestSchema>;
export type ListPaymentRequestsQuery = z.infer<typeof listPaymentRequestsQuerySchema>;
export type CreateGuestPaymentInput = z.infer<typeof createGuestPaymentSchema>;
export type SubmitGuestPaymentInput = z.infer<typeof submitGuestPaymentSchema>;
