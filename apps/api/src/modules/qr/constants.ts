import type { UserRole } from "@morfikos/auth";
import type {
  QrOrderStatusValue,
  ServiceRequestTypeValue,
} from "@morfikos/validation";

/**
 * A table session's state. Values match the Prisma `TableSessionStatus` enum.
 */
export enum TableSessionStatus {
  OPEN = "OPEN",
  CLOSED = "CLOSED",
}

/**
 * A QR round's state. Values match the Prisma `QrOrderStatus` enum.
 */
export enum QrOrderStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  REJECTED = "REJECTED",
}

/**
 * What a guest asked for. Values match the Prisma `ServiceRequestType` enum.
 */
export enum ServiceRequestType {
  CALL_WAITER = "CALL_WAITER",
  WATER = "WATER",
  NAPKINS = "NAPKINS",
  CUTLERY = "CUTLERY",
  BILL = "BILL",
  CLEANING = "CLEANING",
  OTHER = "OTHER",
}

/**
 * A service request's state. Values match the Prisma `ServiceRequestStatus` enum.
 */
export enum ServiceRequestStatus {
  OPEN = "OPEN",
  ACKNOWLEDGED = "ACKNOWLEDGED",
  RESOLVED = "RESOLVED",
}

/**
 * What the guest sees for each dish (menutap: Order Received → Cooking →
 * Ready / Served).
 */
export enum GuestItemStatus {
  AWAITING_CONFIRMATION = "awaiting_confirmation",
  RECEIVED = "received",
  COOKING = "cooking",
  READY = "ready",
  SERVED = "served",
  CANCELLED = "cancelled",
  REJECTED = "rejected",
}

/**
 * Live events pushed to the branch's POS and kitchen screens.
 */
export enum QrEventName {
  SESSION_OPENED = "qr.session_opened",
  ORDER_PLACED = "qr.order_placed",
  ORDER_PENDING = "qr.order_pending",
  SERVICE_REQUEST = "qr.service_request",
  SESSION_CLOSED = "qr.session_closed",
}

/** API service request type → stored type. */
export const SERVICE_REQUEST_TYPE_FROM_API: Record<ServiceRequestTypeValue, ServiceRequestType> = {
  call_waiter: ServiceRequestType.CALL_WAITER,
  water: ServiceRequestType.WATER,
  napkins: ServiceRequestType.NAPKINS,
  cutlery: ServiceRequestType.CUTLERY,
  bill: ServiceRequestType.BILL,
  cleaning: ServiceRequestType.CLEANING,
  other: ServiceRequestType.OTHER,
};

/** Staff-facing label for each request type. */
export const SERVICE_REQUEST_LABELS: Record<ServiceRequestType, string> = {
  [ServiceRequestType.CALL_WAITER]: "Call waiter",
  [ServiceRequestType.WATER]: "Water",
  [ServiceRequestType.NAPKINS]: "Napkins",
  [ServiceRequestType.CUTLERY]: "Cutlery",
  [ServiceRequestType.BILL]: "Bill requested",
  [ServiceRequestType.CLEANING]: "Clean the table",
  [ServiceRequestType.OTHER]: "Other request",
};

/** API QR order status → stored status. */
export const QR_ORDER_STATUS_FROM_API: Record<QrOrderStatusValue, QrOrderStatus> = {
  pending: QrOrderStatus.PENDING,
  accepted: QrOrderStatus.ACCEPTED,
  rejected: QrOrderStatus.REJECTED,
};

/** Kitchen ticket status → what the guest sees. */
export const GUEST_STATUS_FROM_TICKET: Record<string, GuestItemStatus> = {
  OPEN: GuestItemStatus.RECEIVED,
  IN_PROGRESS: GuestItemStatus.COOKING,
  READY: GuestItemStatus.READY,
  SERVED: GuestItemStatus.SERVED,
  CANCELLED: GuestItemStatus.CANCELLED,
};

/** Defaults for a branch without saved QR settings (menutap: straight to KOT). */
export const DEFAULT_QR_SETTINGS = {
  orderingEnabled: true,
  autoAcceptOrders: true,
  requireGuestPhone: false,
  serviceRequestsEnabled: true,
} as const;

/** A session with no order and no activity for this long is closed. */
export const SESSION_IDLE_HOURS = 4;

/** Rounds a session may have waiting for staff at once. */
export const MAX_PENDING_QR_ORDERS = 3;

/** Bytes of randomness in a session token. */
export const SESSION_TOKEN_BYTES = 24;

/** Roles that see QR sessions, accept orders and handle requests. */
export const QR_STAFF_ROLES: UserRole[] = ["owner", "manager", "waiter", "staff"];

/** Roles that change QR ordering settings. */
export const QR_MANAGER_ROLES: UserRole[] = ["owner", "manager"];
