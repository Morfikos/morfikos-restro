import type { UserRole } from "@morfikos/auth";

/** Roles that can open reports and the dashboard. */
export const REPORT_ROLES: UserRole[] = ["owner", "manager"];

/** Top dishes shown on the dashboard. */
export const DASHBOARD_TOP_ITEMS = 5;

/** Discounted bills listed in the discount report. */
export const DISCOUNT_BILLS_LIMIT = 50;

/** Voided items / cancelled orders and bills listed in the void report. */
export const VOID_LIST_LIMIT = 100;

/** Label for orders placed by guests from the table QR menu (no staff creator). */
export const QR_MENU_STAFF_LABEL = "QR menu";

/** Longest range a report can cover, in days. */
export const MAX_REPORT_DAYS = 366;

/** Day names for ISO weekday numbers (1 = Monday). */
export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
