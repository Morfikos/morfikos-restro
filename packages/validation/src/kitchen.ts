import { z } from "zod";

import { KITCHEN_STATIONS } from "./menu.js";

/** Kitchen ticket statuses as used by the KDS API. */
export const KITCHEN_TICKET_STATUSES = ["open", "in_progress", "ready", "served"] as const;

export const kitchenBranchParamsSchema = z.object({
  branchId: z.uuid(),
});

export const kitchenTicketParamsSchema = z.object({
  ticketId: z.uuid(),
});

export const listKitchenTicketsQuerySchema = z.object({
  /** Omit to get every ticket still on the board (open, in progress, ready). */
  status: z.enum(KITCHEN_TICKET_STATUSES).optional(),
  station: z.enum(KITCHEN_STATIONS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Bumps a ticket. With `itemIndex`, marks that one item ready (the ticket
 * turns ready when all items are). Without it, moves the whole ticket to its
 * next status: open → in progress → ready → served.
 */
export const bumpKitchenTicketSchema = z.object({
  /** Optional; must match the ticket in the URL when sent. */
  ticketId: z.uuid().optional(),
  itemIndex: z.number().int().min(0).max(500).optional(),
});

/** EventSource cannot send headers, so the stream also accepts ?accessToken=. */
export const kitchenStreamQuerySchema = z.object({
  accessToken: z.string().min(1).optional(),
});

export type KitchenTicketStatusValue = (typeof KITCHEN_TICKET_STATUSES)[number];
export type ListKitchenTicketsQuery = z.infer<typeof listKitchenTicketsQuerySchema>;
export type BumpKitchenTicketInput = z.infer<typeof bumpKitchenTicketSchema>;
