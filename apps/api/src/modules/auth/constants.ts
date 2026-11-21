import { ROLES, type Role } from "@morfikos/auth";

/** Access-token lifetime in seconds. Must match the "15m" expiry in createAccessToken. */
export const ACCESS_TOKEN_EXPIRY_SECONDS = 15 * 60;

/** Refresh-token lifetime for a normal login. */
export const REFRESH_TOKEN_EXPIRY_DAYS = 7;

/** Refresh-token lifetime when the user selects "remember me". */
export const REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS = 30;

/** Password-reset token lifetime. */
export const PASSWORD_RESET_TOKEN_EXPIRY_MINUTES = 15;

/** Optional request header the client uses to indicate its selected branch. */
export const BRANCH_ID_HEADER = "x-branch-id";

/**
 * Lifecycle status of a user account.
 */
export enum UserStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

/**
 * Lifecycle status shared by memberships, organizations and branches.
 */
export enum RecordStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

/**
 * Standardized error codes returned by the auth module.
 */
export enum AuthErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  UNAUTHENTICATED = "UNAUTHENTICATED",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  INVALID_REFRESH_TOKEN = "INVALID_REFRESH_TOKEN",
  INVALID_RESET_TOKEN = "INVALID_RESET_TOKEN",
  INCORRECT_PASSWORD = "INCORRECT_PASSWORD",
  EMAIL_ALREADY_EXISTS = "EMAIL_ALREADY_EXISTS",
  ROLE_NOT_ASSIGNABLE = "ROLE_NOT_ASSIGNABLE",
  ORGANIZATION_ACCESS_DENIED = "ORGANIZATION_ACCESS_DENIED",
  BRANCH_ACCESS_DENIED = "BRANCH_ACCESS_DENIED",
  BRANCH_NOT_FOUND = "BRANCH_NOT_FOUND",
  ROLE_NOT_CONFIGURED = "ROLE_NOT_CONFIGURED",
  FORBIDDEN = "FORBIDDEN",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
}

/**
 * Client-facing messages used by the auth module.
 */
export const AUTH_MESSAGES = {
  INVALID_BODY: "Invalid request body",
  LOGIN_REQUIRED: "Login required",
  INTERNAL_ERROR: "An unexpected error occurred",
  SIGNUP_SUCCESS: "Account created successfully. Please log in.",
  STAFF_CREATED: "Staff account created successfully",
  LOGIN_SUCCESS: "Login successful",
  REFRESH_SUCCESS: "Token refreshed successfully",
  ME_SUCCESS: "User profile retrieved successfully",
  LOGOUT_SUCCESS: "Logged out successfully",
  PASSWORD_CHANGED: "Password changed successfully. Please log in again.",
  RESET_LINK_SENT: "If an account exists for this email, a password reset link has been sent.",
  PASSWORD_RESET: "Password reset successfully. Please log in.",
  INVALID_CREDENTIALS: "Invalid email or password",
  INVALID_REFRESH_TOKEN: "Invalid or expired refresh token",
  INVALID_RESET_TOKEN: "Invalid or expired password reset token",
  INCORRECT_PASSWORD: "Current password is incorrect",
  USER_INACTIVE: "User not found or inactive",
  EMAIL_ALREADY_EXISTS: "An account with this email already exists",
  ROLE_NOT_ASSIGNABLE: "You are not allowed to assign this role",
  ORGANIZATION_ACCESS_DENIED: "You do not have access to this organization",
  BRANCH_REQUIRED_FOR_MANAGER: "Managers must assign staff to one of their branches",
  BRANCH_NOT_FOUND: "Active branch not found in this organization",
  ROLE_NOT_CONFIGURED: "System role is not configured. Run the database seed.",
  MANAGER_PIN_SET: "Manager PIN set successfully",
  PIN_NOT_ALLOWED: "Only owners and managers can set an approval PIN",
  NO_ORGANIZATION_MEMBERSHIP: "You are not a member of an organization yet",
} as const;

/**
 * Roles each role is allowed to assign when creating staff accounts.
 * Admin and owner accounts can never be created through staff signup.
 */
export const ASSIGNABLE_ROLES: Readonly<Record<Role, readonly Role[]>> = {
  [ROLES.ADMIN]: [],
  [ROLES.OWNER]: [ROLES.MANAGER, ROLES.WAITER, ROLES.STAFF],
  [ROLES.MANAGER]: [ROLES.WAITER, ROLES.STAFF],
  [ROLES.WAITER]: [],
  [ROLES.STAFF]: [],
};
