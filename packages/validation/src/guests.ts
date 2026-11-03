import { z } from "zod";

/** Marketing channels a guest can opt in to. */
export const CONSENT_TYPES = [
  "promotional_whatsapp",
  "promotional_sms",
  "promotional_email",
] as const;

export const CONSENT_STATUSES = ["active", "revoked"] as const;

export const CONSENT_FREQUENCIES = ["daily", "weekly", "monthly"] as const;

/**
 * Guest segments: lapsed (no visit in 60+ days), regular (5+ visits),
 * returning (2–4 visits) and new (0–1 visit).
 */
export const GUEST_GROUPS = ["new", "returning", "regular", "lapsed"] as const;

/**
 * Normalizes a phone number to E.164 so one guest isn't stored twice in
 * different formats. Indian numbers without a country code get +91.
 *
 * @param raw - The phone as typed, e.g. "+91-98765 43210" or "09876543210".
 * @returns The normalized phone, e.g. "+919876543210".
 */
export function normalizePhone(raw: string): string {
  const compact = raw.replace(/[\s\-().]/g, "");

  if (/^\d{10}$/.test(compact)) {
    return `+91${compact}`;
  }

  if (/^0\d{10}$/.test(compact)) {
    return `+91${compact.slice(1)}`;
  }

  if (/^91\d{10}$/.test(compact)) {
    return `+${compact}`;
  }

  return compact;
}

/** A guest phone number, normalized to E.164. */
export const guestPhoneSchema = z
  .string()
  .trim()
  .min(1, "Phone number is required")
  .transform(normalizePhone)
  .pipe(z.string().regex(/^\+\d{8,15}$/, "Enter a valid phone number"));

const guestNameSchema = z.string().trim().min(1).max(100);
const guestEmailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address"));
const guestNotesSchema = z.string().trim().max(500);

/** The table QR code a guest scanned; required for public (no-login) calls. */
const qrCodeSchema = z.string().trim().min(1).max(100);

const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const guestIdParamsSchema = z.object({
  guestId: z.uuid(),
});

/**
 * Creates a guest, or finds the existing one with this phone. Staff send
 * their organization (or nothing); public QR-menu calls send the qrCode.
 */
export const createGuestSchema = z.object({
  organizationId: z.uuid().optional(),
  qrCode: qrCodeSchema.optional(),
  phone: guestPhoneSchema,
  name: guestNameSchema.optional(),
  email: guestEmailSchema.optional(),
  /** Staff-only notes, e.g. "prefers window seat". Ignored on public calls. */
  notes: guestNotesSchema.optional(),
});

export const updateGuestSchema = z
  .object({
    name: guestNameSchema.nullable().optional(),
    email: guestEmailSchema.nullable().optional(),
    notes: guestNotesSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const guestConsentSchema = z.object({
  /** Optional; must match the guest in the URL when sent. */
  guestId: z.uuid().optional(),
  /** Required for public (no-login) calls. */
  qrCode: qrCodeSchema.optional(),
  consentType: z.enum(CONSENT_TYPES),
  status: z.enum(CONSENT_STATUSES),
  frequency: z.enum(CONSENT_FREQUENCIES).optional(),
});

export const listGuestsQuerySchema = z
  .object({
    /** Defaults to the caller's organization. */
    organizationId: z.uuid().optional(),
    group: z.enum(GUEST_GROUPS).optional(),
    /** Last-visit date range, inclusive (YYYY-MM-DD). */
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
    /** Matches name, phone or email. */
    search: z.string().trim().min(1).max(50).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

/** Manual loyalty correction by a manager; negative points remove points. */
export const adjustLoyaltySchema = z.object({
  points: z
    .number()
    .int("Points must be a whole number")
    .min(-100_000)
    .max(100_000)
    .refine((points) => points !== 0, { message: "Points can't be 0" }),
  reason: z.string().trim().min(3).max(300),
});

export const listLoyaltyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ConsentTypeValue = (typeof CONSENT_TYPES)[number];
export type ConsentStatusValue = (typeof CONSENT_STATUSES)[number];
export type ConsentFrequencyValue = (typeof CONSENT_FREQUENCIES)[number];
export type GuestGroupValue = (typeof GUEST_GROUPS)[number];
export type CreateGuestInput = z.infer<typeof createGuestSchema>;
export type UpdateGuestInput = z.infer<typeof updateGuestSchema>;
export type GuestConsentInput = z.infer<typeof guestConsentSchema>;
export type ListGuestsQuery = z.infer<typeof listGuestsQuerySchema>;
export type AdjustLoyaltyInput = z.infer<typeof adjustLoyaltySchema>;
export type ListLoyaltyQuery = z.infer<typeof listLoyaltyQuerySchema>;
