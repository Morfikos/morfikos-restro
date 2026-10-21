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
}
