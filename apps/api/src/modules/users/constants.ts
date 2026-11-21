import { ROLES, type UserRole } from "@morfikos/auth";

/**
 * A staff member's status in the organization. Values match the
 * `Membership.status` and `User.status` strings.
 */
export enum MembershipStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

/** Roles that can open the staff management APIs. */
export const USER_ADMIN_ROLES: UserRole[] = [ROLES.OWNER, ROLES.MANAGER];

/**
 * Roles each role may give to (and manage on) other staff. Owners manage
 * managers, waiters and staff; managers manage waiters and staff.
 */
export const MANAGEABLE_ROLES: Readonly<Record<UserRole, readonly UserRole[]>> = {
  [ROLES.ADMIN]: [],
  [ROLES.OWNER]: [ROLES.MANAGER, ROLES.WAITER, ROLES.STAFF],
  [ROLES.MANAGER]: [ROLES.WAITER, ROLES.STAFF],
  [ROLES.WAITER]: [],
  [ROLES.STAFF]: [],
};

/** Interactive transaction limits for staff changes. */
export const USER_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };
