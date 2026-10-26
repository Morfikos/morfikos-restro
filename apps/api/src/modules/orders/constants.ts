import type { UserRole } from "@morfikos/auth";

/**
 * How an order is served. Values match the Prisma `OrderType` enum.
 */
export enum OrderType {
  DINE_IN = "DINE_IN",
  TAKEAWAY = "TAKEAWAY",
  DELIVERY = "DELIVERY",
}

/**
 * Order lifecycle: OPEN (held / in progress) → BILLED (invoice generated)
 * → COMPLETED (fully paid). An OPEN or BILLED order can be CANCELLED.
 */
export enum OrderStatus {
  OPEN = "OPEN",
  BILLED = "BILLED",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
}

/**
 * How much of a billed order has been paid.
 */
export enum PaymentStatus {
  UNPAID = "UNPAID",
  PARTIALLY_PAID = "PARTIALLY_PAID",
  PAID = "PAID",
}

/**
 * Kitchen state of an order line: PENDING (not yet on a KOT), SENT (on a
 * KOT) or VOID (cancelled after being sent; kept for audit).
 */
export enum OrderItemStatus {
  PENDING = "PENDING",
  SENT = "SENT",
  VOID = "VOID",
}

/**
 * Kitchen ticket state. The kitchen module moves tickets forward; the
 * orders module only creates them and cancels them with the order.
 */
export enum KotStatus {
  PENDING = "PENDING",
  PREPARING = "PREPARING",
  READY = "READY",
  SERVED = "SERVED",
  CANCELLED = "CANCELLED",
}

/**
 * POS button actions applied when an order is created.
 */
export enum PosAction {
  HOLD = "HOLD",
  KOT = "KOT",
  BILL = "BILL",
  KOT_BILL = "KOT_BILL",
}

/**
 * Success messages used by the orders controller.
 */
export const ORDER_MESSAGES = {
  ORDER_CREATED: "Order created successfully",
  ORDERS_RETRIEVED: "Orders retrieved successfully",
  ORDER_RETRIEVED: "Order retrieved successfully",
  ORDER_UPDATED: "Order updated successfully",
  ITEMS_ADDED: "Items added successfully",
  ITEM_UPDATED: "Order item updated successfully",
  ITEM_REMOVED: "Order item removed successfully",
  KOT_SENT: "KOT sent to kitchen successfully",
  ORDER_BILLED: "Bill generated successfully",
  PAYMENT_RECORDED: "Payment recorded successfully",
  ORDER_CANCELLED: "Order cancelled successfully",
} as const;

/** Roles that can take orders, send KOTs, bill and collect payment. */
export const ORDER_STAFF_ROLES: UserRole[] = ["owner", "manager", "waiter", "staff"];

/** Roles that can cancel orders and void items already sent to the kitchen. */
export const ORDER_MANAGER_ROLES: UserRole[] = ["owner", "manager"];

/** Order statuses in which a table counts as occupied. */
export const ACTIVE_ORDER_STATUSES = [OrderStatus.OPEN, OrderStatus.BILLED];

/** Branch menu availability flag that applies to each order type. */
export const CHANNEL_AVAILABILITY_FIELD = {
  [OrderType.DINE_IN]: "dineInAvailable",
  [OrderType.TAKEAWAY]: "parcelAvailable",
  [OrderType.DELIVERY]: "deliveryAvailable",
} as const;

/** Human-readable order type labels for error messages. */
export const ORDER_TYPE_LABELS = {
  [OrderType.DINE_IN]: "dine-in",
  [OrderType.TAKEAWAY]: "takeaway",
  [OrderType.DELIVERY]: "delivery",
} as const;

/** Settings for the transactions that create or change orders. */
export const ORDER_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/** How often a transaction is retried after a numbering conflict. */
export const MAX_NUMBERING_RETRIES = 3;
