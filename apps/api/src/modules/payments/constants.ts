import type { UserRole } from "@morfikos/auth";
import type { PaymentRequestStatusValue } from "@morfikos/validation";

/**
 * A UPI payment request's state. Values match the Prisma
 * `PaymentRequestStatus` enum:
 * PENDING (QR shown) → SUBMITTED (guest says paid, gave UTR) →
 * CONFIRMED (staff saw the money; bill payment recorded),
 * or REJECTED / EXPIRED / CANCELLED.
 */
export enum PaymentRequestStatus {
  PENDING = "PENDING",
  SUBMITTED = "SUBMITTED",
  CONFIRMED = "CONFIRMED",
  REJECTED = "REJECTED",
  EXPIRED = "EXPIRED",
  CANCELLED = "CANCELLED",
}

/**
 * Who created the request. Values match the Prisma `PaymentRequestSource` enum.
 */
export enum PaymentRequestSource {
  STAFF = "STAFF",
  QR = "QR",
}

/**
 * Live payment events pushed to the branch's POS screens.
 */
export enum PaymentEventName {
  REQUESTED = "payment.requested",
  SUBMITTED = "payment.submitted",
  CONFIRMED = "payment.confirmed",
  REJECTED = "payment.rejected",
}

/** API status → stored status. */
export const PAYMENT_STATUS_FROM_API: Record<PaymentRequestStatusValue, PaymentRequestStatus> = {
  pending: PaymentRequestStatus.PENDING,
  submitted: PaymentRequestStatus.SUBMITTED,
  confirmed: PaymentRequestStatus.CONFIRMED,
  rejected: PaymentRequestStatus.REJECTED,
  expired: PaymentRequestStatus.EXPIRED,
  cancelled: PaymentRequestStatus.CANCELLED,
};

/** Requests still waiting for the money or for staff to check it. */
export const OPEN_PAYMENT_STATUSES = [PaymentRequestStatus.PENDING, PaymentRequestStatus.SUBMITTED];

/** Requests staff may still confirm (money can arrive after the QR expired). */
export const CONFIRMABLE_PAYMENT_STATUSES = [
  PaymentRequestStatus.PENDING,
  PaymentRequestStatus.SUBMITTED,
  PaymentRequestStatus.EXPIRED,
];

/** Defaults for a branch without saved payment settings. */
export const DEFAULT_PAYMENT_SETTINGS = {
  upiEnabled: false,
  upiVpa: null,
  payeeName: null,
  merchantCode: null,
  guestPaymentsEnabled: true,
  requestExpiryMinutes: 15,
} as const;

/** Characters for payment references (no 0/O or 1/I, easy to read aloud). */
export const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Random characters at the end of a payment reference. */
export const REFERENCE_SUFFIX_LENGTH = 4;

/** Roles that show UPI QRs at the table or counter. */
export const PAYMENT_STAFF_ROLES: UserRole[] = ["owner", "manager", "staff", "waiter"];

/** Roles that confirm or reject that money arrived (cashier roles). */
export const PAYMENT_CASHIER_ROLES: UserRole[] = ["owner", "manager", "staff"];

/** Roles that set the branch's UPI ID. */
export const PAYMENT_MANAGER_ROLES: UserRole[] = ["owner", "manager"];
