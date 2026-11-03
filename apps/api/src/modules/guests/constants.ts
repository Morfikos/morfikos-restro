import type { UserRole } from "@morfikos/auth";
import type {
  ConsentFrequencyValue,
  ConsentStatusValue,
  ConsentTypeValue,
} from "@morfikos/validation";

/**
 * Marketing channels. Values match the Prisma `ConsentType` enum.
 */
export enum ConsentType {
  PROMOTIONAL_WHATSAPP = "PROMOTIONAL_WHATSAPP",
  PROMOTIONAL_SMS = "PROMOTIONAL_SMS",
  PROMOTIONAL_EMAIL = "PROMOTIONAL_EMAIL",
}

/**
 * Whether a guest currently agrees to a channel.
 */
export enum ConsentStatus {
  ACTIVE = "ACTIVE",
  REVOKED = "REVOKED",
}

/**
 * How often a guest agreed to be messaged.
 */
export enum ConsentFrequency {
  DAILY = "DAILY",
  WEEKLY = "WEEKLY",
  MONTHLY = "MONTHLY",
}

/**
 * Where the consent was captured: by staff at the POS, or by the guest
 * from the table QR menu.
 */
export enum ConsentSource {
  STAFF = "STAFF",
  QR = "QR",
}

/**
 * Loyalty ledger entries: points earned on a settled bill, reversed by a
 * credit note, or adjusted by a manager.
 */
export enum LoyaltyTransactionType {
  EARN = "EARN",
  REVERSE = "REVERSE",
  ADJUST = "ADJUST",
}

/**
 * Guest segments, computed from visits and the last visit date.
 */
export enum GuestGroup {
  NEW = "new",
  RETURNING = "returning",
  REGULAR = "regular",
  LAPSED = "lapsed",
}

/** API consent type → stored consent type. */
export const CONSENT_TYPE_FROM_API: Record<ConsentTypeValue, ConsentType> = {
  promotional_whatsapp: ConsentType.PROMOTIONAL_WHATSAPP,
  promotional_sms: ConsentType.PROMOTIONAL_SMS,
  promotional_email: ConsentType.PROMOTIONAL_EMAIL,
};

/** API consent status → stored consent status. */
export const CONSENT_STATUS_FROM_API: Record<ConsentStatusValue, ConsentStatus> = {
  active: ConsentStatus.ACTIVE,
  revoked: ConsentStatus.REVOKED,
};

/** API consent frequency → stored consent frequency. */
export const CONSENT_FREQUENCY_FROM_API: Record<ConsentFrequencyValue, ConsentFrequency> = {
  daily: ConsentFrequency.DAILY,
  weekly: ConsentFrequency.WEEKLY,
  monthly: ConsentFrequency.MONTHLY,
};

/** Spend that earns one loyalty point: ₹10, in paise. */
export const PAISE_PER_LOYALTY_POINT = 10 * 100;

/** A guest with no visit for this many days is "lapsed". */
export const LAPSED_AFTER_DAYS = 60;

/** Visits needed to be a "regular". */
export const REGULAR_MIN_VISITS = 5;

/** Visits needed to be "returning". */
export const RETURNING_MIN_VISITS = 2;

/** How many recent visits a guest profile shows. */
export const VISIT_HISTORY_LIMIT = 20;

/** Roles that can register guests, record consent and view profiles. */
export const GUEST_STAFF_ROLES: UserRole[] = ["owner", "manager", "staff", "waiter"];

/** Roles that can list all guests and adjust loyalty points. */
export const GUEST_MANAGER_ROLES: UserRole[] = ["owner", "manager"];
