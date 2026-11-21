import { ROLES, type UserRole } from "@morfikos/auth";

import { BILLING_MANAGER_ROLES, BILLING_STAFF_ROLES, INVOICE_VIEW_ROLES } from "../billing/constants.js";
import { GUEST_MANAGER_ROLES, GUEST_STAFF_ROLES } from "../guests/constants.js";
import { INVENTORY_MANAGER_ROLES, INVENTORY_STAFF_ROLES } from "../inventory/constants.js";
import { KITCHEN_STAFF_ROLES, KITCHEN_VIEW_ROLES } from "../kitchen/constants.js";
import { ORDER_MANAGER_ROLES, ORDER_STAFF_ROLES } from "../orders/constants.js";
import { SHIFT_MANAGER_ROLES, SHIFT_VIEW_ROLES } from "../shifts/constants.js";
import { MANAGEABLE_ROLES, USER_ADMIN_ROLES } from "../users/constants.js";

/** Roles shown by the roles API (the platform admin is internal). */
export const ORGANIZATION_ROLES: UserRole[] = [ROLES.OWNER, ROLES.MANAGER, ROLES.WAITER, ROLES.STAFF];

/** Display name and purpose of each role. */
export const ROLE_DETAILS: Record<string, { label: string; description: string }> = {
  [ROLES.OWNER]: {
    label: "Owner",
    description: "Full access to every branch: settings, branches, staff, reports and approvals.",
  },
  [ROLES.MANAGER]: {
    label: "Manager",
    description: "Runs assigned branches: menu, tables, billing approvals, shifts, inventory and waiters/staff.",
  },
  [ROLES.WAITER]: {
    label: "Waiter / Captain",
    description: "Takes orders at tables, sends KOTs, registers guests and views the kitchen display.",
  },
  [ROLES.STAFF]: {
    label: "Cashier / Kitchen staff",
    description: "Billing counter and kitchen: bills and payments, kitchen tickets, stock receiving and wastage.",
  },
};

/** One capability and the roles that have it. */
export interface PermissionDefinition {
  code: string;
  module: string;
  label: string;
  roles: readonly UserRole[];
}

/**
 * What each role can do, built from the role lists the modules enforce,
 * so this stays in step with the real checks.
 */
export const PERMISSIONS: PermissionDefinition[] = [
  { code: "branches.manage", module: "branches", label: "Create, edit and close branches", roles: [ROLES.OWNER] },
  { code: "branches.update", module: "branches", label: "Edit branch details and settings", roles: [ROLES.OWNER, ROLES.MANAGER] },
  { code: "staff.manage", module: "staff", label: "Manage staff accounts, roles, branches and PINs", roles: USER_ADMIN_ROLES },
  { code: "menu.view", module: "menu", label: "View the menu", roles: [ROLES.OWNER, ROLES.MANAGER, ROLES.WAITER, ROLES.STAFF] },
  { code: "menu.manage", module: "menu", label: "Edit menu items, prices and availability", roles: [ROLES.OWNER, ROLES.MANAGER] },
  { code: "tables.view", module: "tables", label: "View tables and floor plans", roles: [ROLES.OWNER, ROLES.MANAGER, ROLES.WAITER, ROLES.STAFF] },
  { code: "tables.manage", module: "tables", label: "Edit tables, QR codes and floor plans", roles: [ROLES.OWNER, ROLES.MANAGER] },
  { code: "orders.take", module: "orders", label: "Take orders and send KOTs", roles: ORDER_STAFF_ROLES },
  { code: "orders.manage", module: "orders", label: "Cancel orders and void items sent to the kitchen", roles: ORDER_MANAGER_ROLES },
  { code: "kitchen.view", module: "kitchen", label: "View the kitchen display", roles: KITCHEN_VIEW_ROLES },
  { code: "kitchen.update", module: "kitchen", label: "Bump kitchen tickets", roles: KITCHEN_STAFF_ROLES },
  { code: "billing.bill", module: "billing", label: "Create bills and take payments", roles: BILLING_STAFF_ROLES },
  { code: "billing.invoices", module: "billing", label: "View GST invoices", roles: INVOICE_VIEW_ROLES },
  { code: "billing.manage", module: "billing", label: "Cancel bills, approve discounts and issue credit notes", roles: BILLING_MANAGER_ROLES },
  { code: "shifts.view", module: "shifts", label: "View shifts and the current cash drawer", roles: SHIFT_VIEW_ROLES },
  { code: "shifts.manage", module: "shifts", label: "Open and close shifts, cash in/out and expenses", roles: SHIFT_MANAGER_ROLES },
  { code: "guests.manage", module: "guests", label: "Register guests, record consent and view profiles", roles: GUEST_STAFF_ROLES },
  { code: "guests.admin", module: "guests", label: "List all guests and adjust loyalty points", roles: GUEST_MANAGER_ROLES },
  { code: "inventory.operate", module: "inventory", label: "View stock, receive purchases and record wastage", roles: INVENTORY_STAFF_ROLES },
  { code: "inventory.manage", module: "inventory", label: "Manage items, recipes, suppliers, stock counts and reports", roles: INVENTORY_MANAGER_ROLES },
];

/** Roles each role can assign to other staff. */
export { MANAGEABLE_ROLES };
