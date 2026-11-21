import { z } from "zod";

import { guestPhoneSchema } from "./guests.js";

/** Requests a guest can send from the table. */
export const SERVICE_REQUEST_TYPES = [
  "call_waiter",
  "water",
  "napkins",
  "cutlery",
  "bill",
  "cleaning",
  "other",
] as const;

export const TABLE_SESSION_STATUSES = ["open", "closed"] as const;

export const QR_ORDER_STATUSES = ["pending", "accepted", "rejected"] as const;

/** `active` = open and acknowledged (not yet resolved). */
export const SERVICE_REQUEST_FILTERS = ["active", "open", "acknowledged", "resolved"] as const;

/** Most lines in one QR round. */
const MAX_QR_LINES = 30;

const noteSchema = z.string().trim().min(1).max(300);

const paginationShape = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

// ─── Public (guest) ─────────────────────────────────────────────────────

// The table QR code param reuses `qrCodeParamsSchema` from ./menu.js.

/** The session token the guest's phone received when it joined the table. */
export const sessionTokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, "Invalid session"),
});

/** Joins (or opens) the table's live session. Name and phone are optional unless the branch requires a phone. */
export const startTableSessionSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phone: guestPhoneSchema.optional(),
});

const qrOrderLineSchema = z.object({
  menuItemId: z.uuid(),
  variantId: z.uuid().optional(),
  addonIds: z
    .array(z.uuid())
    .max(20)
    .transform((ids) => [...new Set(ids)])
    .default([]),
  quantity: z.number().int().min(1, "Quantity must be at least 1").max(50, "Quantity can be at most 50"),
  /** e.g. "less spicy", "no onion". */
  note: z.string().trim().min(1).max(200).optional(),
});

export const placeQrOrderSchema = z.object({
  items: z
    .array(qrOrderLineSchema)
    .min(1, "Add at least one item")
    .max(MAX_QR_LINES, `You can order at most ${MAX_QR_LINES} items at a time`),
  note: noteSchema.optional(),
  allergyNote: noteSchema.optional(),
});

export const createServiceRequestSchema = z.object({
  type: z.enum(SERVICE_REQUEST_TYPES),
  note: z.string().trim().min(1).max(200).optional(),
});

// ─── Staff ──────────────────────────────────────────────────────────────

export const branchQrParamsSchema = z.object({
  branchId: z.uuid(),
});

export const tableSessionIdParamsSchema = z.object({
  sessionId: z.uuid(),
});

export const qrOrderIdParamsSchema = z.object({
  qrOrderId: z.uuid(),
});

export const serviceRequestIdParamsSchema = z.object({
  requestId: z.uuid(),
});

export const listTableSessionsQuerySchema = z.object({
  status: z.enum(TABLE_SESSION_STATUSES).default("open"),
  ...paginationShape,
});

export const listQrOrdersQuerySchema = z.object({
  status: z.enum(QR_ORDER_STATUSES).default("pending"),
  ...paginationShape,
});

export const listServiceRequestsQuerySchema = z.object({
  status: z.enum(SERVICE_REQUEST_FILTERS).default("active"),
  ...paginationShape,
});

export const rejectQrOrderSchema = z.object({
  reason: noteSchema,
});

export const closeTableSessionSchema = z.object({
  reason: noteSchema.optional(),
});

export const updateQrSettingsSchema = z
  .object({
    orderingEnabled: z.boolean().optional(),
    autoAcceptOrders: z.boolean().optional(),
    requireGuestPhone: z.boolean().optional(),
    serviceRequestsEnabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one setting must be provided",
  });

export type ServiceRequestTypeValue = (typeof SERVICE_REQUEST_TYPES)[number];
export type QrOrderStatusValue = (typeof QR_ORDER_STATUSES)[number];
export type ServiceRequestFilterValue = (typeof SERVICE_REQUEST_FILTERS)[number];
export type StartTableSessionInput = z.infer<typeof startTableSessionSchema>;
export type PlaceQrOrderInput = z.infer<typeof placeQrOrderSchema>;
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;
export type ListTableSessionsQuery = z.infer<typeof listTableSessionsQuerySchema>;
export type ListQrOrdersQuery = z.infer<typeof listQrOrdersQuerySchema>;
export type ListServiceRequestsQuery = z.infer<typeof listServiceRequestsQuerySchema>;
export type UpdateQrSettingsInput = z.infer<typeof updateQrSettingsSchema>;
