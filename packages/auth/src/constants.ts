export const ROLES = {
  ADMIN: "admin",
  OWNER: "owner",
  MANAGER: "manager",
  WAITER: "waiter",
  STAFF: "staff",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
/**
 * Defines standardized error codes for branch service operations.
 */
export enum BranchServiceErrorCode {
  ORGANIZATION_NOT_FOUND = "ORGANIZATION_NOT_FOUND",
  BRANCH_NOT_FOUND = "BRANCH_NOT_FOUND",
  BRANCH_CODE_CONFLICT = "BRANCH_CODE_CONFLICT",
}
/**
 * Matches all characters that are not uppercase letters (A–Z)
 * or digits (0–9), so they can be removed from a branch code.
 */
export const NON_ALPHANUMERIC_BRANCH_CODE_REGEX = /[^A-Z0-9]/g;
/**
 * Defines the possible branch status values.
 */
export enum BranchStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

/**
 * Defines standardized error codes for menu service operations.
 */
export enum MenuServiceErrorCode {
  ORGANIZATION_NOT_FOUND = "ORGANIZATION_NOT_FOUND",
  CATEGORY_NOT_FOUND = "CATEGORY_NOT_FOUND",
  CATEGORY_NAME_CONFLICT = "CATEGORY_NAME_CONFLICT",
  CUISINE_NOT_FOUND = "CUISINE_NOT_FOUND",
  CUISINE_NAME_CONFLICT = "CUISINE_NAME_CONFLICT",
  MENU_ITEM_NOT_FOUND = "MENU_ITEM_NOT_FOUND",
  MENU_ITEM_NAME_CONFLICT = "MENU_ITEM_NAME_CONFLICT",
  BRANCH_NOT_FOUND = "BRANCH_NOT_FOUND",
  TABLE_NOT_FOUND = "TABLE_NOT_FOUND",
  INVALID_ITEM_TIMING = "INVALID_ITEM_TIMING",
}

/**
 * Defines standardized error codes for order service operations.
 */
export enum OrderServiceErrorCode {
  FORBIDDEN = "FORBIDDEN",
  BRANCH_NOT_FOUND = "BRANCH_NOT_FOUND",
  BRANCH_ACCESS_DENIED = "BRANCH_ACCESS_DENIED",
  TABLE_NOT_FOUND = "TABLE_NOT_FOUND",
  TABLE_HAS_OPEN_ORDER = "TABLE_HAS_OPEN_ORDER",
  INVALID_TABLE = "INVALID_TABLE",
  MENU_ITEM_NOT_FOUND = "MENU_ITEM_NOT_FOUND",
  ITEM_UNAVAILABLE = "ITEM_UNAVAILABLE",
  INVALID_ITEM_OPTION = "INVALID_ITEM_OPTION",
  QUANTITY_LIMIT_EXCEEDED = "QUANTITY_LIMIT_EXCEEDED",
  INVALID_DISCOUNT = "INVALID_DISCOUNT",
  ORDER_NOT_FOUND = "ORDER_NOT_FOUND",
  ORDER_ITEM_NOT_FOUND = "ORDER_ITEM_NOT_FOUND",
  ORDER_NOT_EDITABLE = "ORDER_NOT_EDITABLE",
  ITEM_ALREADY_SENT = "ITEM_ALREADY_SENT",
  ITEM_ALREADY_VOID = "ITEM_ALREADY_VOID",
  VOID_REASON_REQUIRED = "VOID_REASON_REQUIRED",
  NO_ITEMS_TO_SEND = "NO_ITEMS_TO_SEND",
  EMPTY_ORDER = "EMPTY_ORDER",
  PAYMENT_NOT_ALLOWED = "PAYMENT_NOT_ALLOWED",
  PAYMENT_EXCEEDS_BALANCE = "PAYMENT_EXCEEDS_BALANCE",
  ORDER_HAS_PAYMENTS = "ORDER_HAS_PAYMENTS",
}

/**
 * Defines standardized error codes for table service operations.
 */
export enum TableServiceErrorCode {
  BRANCH_NOT_FOUND = "BRANCH_NOT_FOUND",
  TABLE_NOT_FOUND = "TABLE_NOT_FOUND",
  TABLE_NAME_CONFLICT = "TABLE_NAME_CONFLICT",
  TABLE_HAS_OPEN_ORDER = "TABLE_HAS_OPEN_ORDER",
  FLOOR_NOT_FOUND = "FLOOR_NOT_FOUND",
}

/**
 * Defines standardized error codes for floor and floor-map operations.
 */
export enum FloorServiceErrorCode {
  BRANCH_NOT_FOUND = "BRANCH_NOT_FOUND",
  FLOOR_NOT_FOUND = "FLOOR_NOT_FOUND",
  FLOOR_NAME_CONFLICT = "FLOOR_NAME_CONFLICT",
  FLOOR_HAS_OPEN_ORDERS = "FLOOR_HAS_OPEN_ORDERS",
  TABLE_NOT_FOUND = "TABLE_NOT_FOUND",
  TABLE_NAME_CONFLICT = "TABLE_NAME_CONFLICT",
  INVALID_IMAGE = "INVALID_IMAGE",
  IMPORT_NOT_FOUND = "IMPORT_NOT_FOUND",
  IMPORT_NOT_READY = "IMPORT_NOT_READY",
  IMPORT_LIMIT_REACHED = "IMPORT_LIMIT_REACHED",
  AI_NOT_CONFIGURED = "AI_NOT_CONFIGURED",
}

/**
 * Defines standardized error codes for kitchen display (KDS) operations.
 */
export enum KitchenServiceErrorCode {
  BRANCH_NOT_FOUND = "BRANCH_NOT_FOUND",
  TICKET_NOT_FOUND = "TICKET_NOT_FOUND",
  TICKET_CLOSED = "TICKET_CLOSED",
  INVALID_ITEM_INDEX = "INVALID_ITEM_INDEX",
}

/**
 * Defines the live status of a table, derived from its current order:
 * no open order, an open order being served, or a bill printed and
 * awaiting payment.
 */
export enum TableStatus {
  AVAILABLE = "available",
  OCCUPIED = "occupied",
  BILLED = "billed",
}
