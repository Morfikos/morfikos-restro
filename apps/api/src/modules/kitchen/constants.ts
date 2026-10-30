import type { UserRole } from "@morfikos/auth";
import type { KitchenTicketStatusValue } from "@morfikos/validation";

/**
 * Kitchen ticket lifecycle. Values match the Prisma `KitchenTicketStatus`
 * enum: OPEN (new) → IN_PROGRESS (being cooked) → READY (plated) →
 * SERVED (bumped off the screen). CANCELLED when the order or all its
 * items on the ticket are cancelled.
 */
export enum KitchenTicketStatus {
  OPEN = "OPEN",
  IN_PROGRESS = "IN_PROGRESS",
  READY = "READY",
  SERVED = "SERVED",
  CANCELLED = "CANCELLED",
}

/**
 * Server-sent event names pushed on the live kitchen stream.
 */
export enum KitchenEventName {
  CONNECTED = "connected",
  TICKET_CREATED = "ticket_created",
  TICKET_UPDATED = "ticket_updated",
  TICKET_STATUS_CHANGED = "ticket_status_changed",
  ORDER_LATE = "order_late",
}

/** Station used for items that have no kitchen station (custom items). */
export const DEFAULT_KITCHEN_STATION = "hot_kitchen";

/** Display names for kitchen stations. */
export const KITCHEN_STATION_LABELS: Record<string, string> = {
  hot_kitchen: "Hot Kitchen",
  cold_kitchen: "Cold Kitchen",
  tandoor: "Tandoor",
  bar: "Bar",
  bakery: "Bakery",
  dessert: "Dessert",
};

/** Ticket statuses that are still on the kitchen board. */
export const ACTIVE_TICKET_STATUSES = [
  KitchenTicketStatus.OPEN,
  KitchenTicketStatus.IN_PROGRESS,
  KitchenTicketStatus.READY,
];

/** Ticket statuses that can turn late (food not ready yet). */
export const COOKING_TICKET_STATUSES = [
  KitchenTicketStatus.OPEN,
  KitchenTicketStatus.IN_PROGRESS,
];

/** API status value → stored ticket status. */
export const TICKET_STATUS_FROM_API: Record<KitchenTicketStatusValue, KitchenTicketStatus> = {
  open: KitchenTicketStatus.OPEN,
  in_progress: KitchenTicketStatus.IN_PROGRESS,
  ready: KitchenTicketStatus.READY,
  served: KitchenTicketStatus.SERVED,
};

/** Prep time used when none of a ticket's items has one, in minutes. */
export const DEFAULT_PREP_MINUTES = 15;

/** How often open tickets are checked for lateness while a KDS is connected. */
export const LATE_CHECK_INTERVAL_MS = 30_000;

/** Keep-alive comment interval on the live stream (stops proxies closing it). */
export const STREAM_HEARTBEAT_MS = 25_000;

/** Roles that can bump tickets (staff is the kitchen role). */
export const KITCHEN_STAFF_ROLES: UserRole[] = ["owner", "manager", "staff"];

/** Roles that can view the kitchen board (waiters see what's ready to serve). */
export const KITCHEN_VIEW_ROLES: UserRole[] = ["owner", "manager", "staff", "waiter"];
