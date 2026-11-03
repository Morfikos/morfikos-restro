import type { UserRole } from "@morfikos/auth";
import type {
  BillPaymentMethodValue,
  BillStatusValue,
  DiscountTypeValue,
  InvoiceStatusValue,
} from "@morfikos/validation";

/**
 * Bill lifecycle. Values match the Prisma `BillStatus` enum: OPEN (printed,
 * taking payments) → SETTLED (fully paid, invoice issued), or CANCELLED.
 */
export enum BillStatus {
  OPEN = "OPEN",
  SETTLED = "SETTLED",
  CANCELLED = "CANCELLED",
}

/**
 * How a bill discount is expressed. Values match the Prisma enum.
 */
export enum DiscountType {
  PERCENTAGE = "PERCENTAGE",
  FLAT = "FLAT",
}

/**
 * GST invoice status after credit notes. Values match the Prisma enum.
 */
export enum InvoiceStatus {
  ISSUED = "ISSUED",
  PARTIALLY_CREDITED = "PARTIALLY_CREDITED",
  CREDITED = "CREDITED",
}

/**
 * Payment methods. Values match the Prisma `PaymentMethod` enum.
 */
export enum PaymentMethod {
  CASH = "CASH",
  UPI = "UPI",
  CARD = "CARD",
}

/** API payment method → stored payment method. */
export const PAYMENT_METHOD_FROM_API: Record<BillPaymentMethodValue, PaymentMethod> = {
  cash: PaymentMethod.CASH,
  upi: PaymentMethod.UPI,
  card: PaymentMethod.CARD,
};

/** API discount type → stored discount type. */
export const DISCOUNT_TYPE_FROM_API: Record<DiscountTypeValue, DiscountType> = {
  percentage: DiscountType.PERCENTAGE,
  flat: DiscountType.FLAT,
};

/** API bill status → stored bill status. */
export const BILL_STATUS_FROM_API: Record<BillStatusValue, BillStatus> = {
  open: BillStatus.OPEN,
  settled: BillStatus.SETTLED,
  cancelled: BillStatus.CANCELLED,
};

/** API invoice status → stored invoice status. */
export const INVOICE_STATUS_FROM_API: Record<InvoiceStatusValue, InvoiceStatus> = {
  issued: InvoiceStatus.ISSUED,
  partially_credited: InvoiceStatus.PARTIALLY_CREDITED,
  credited: InvoiceStatus.CREDITED,
};

/**
 * Discount percentage staff may give without a manager PIN when neither
 * their membership nor the branch settings set a limit.
 */
export const DEFAULT_DISCOUNT_APPROVAL_PERCENT = 10;

/** Roles that can create bills, apply discounts and take payments (cashiers). */
export const BILLING_STAFF_ROLES: UserRole[] = ["owner", "manager", "staff", "waiter"];

/** Roles that can view invoices. */
export const INVOICE_VIEW_ROLES: UserRole[] = ["owner", "manager", "staff"];

/** Roles that can cancel bills, approve discounts and issue credit notes. */
export const BILLING_MANAGER_ROLES: UserRole[] = ["owner", "manager"];

/** Settings for the transactions that change bills. */
export const BILLING_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** How often a transaction is retried after a numbering conflict. */
export const MAX_NUMBERING_RETRIES = 3;
