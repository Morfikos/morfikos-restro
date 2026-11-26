/**
 * Every permission the system checks. Naming: `<module>.<action>`.
 * Browser-safe: contains only plain data (no Node/Argon2 imports).
 */
export const PERMISSIONS = {
  "organization.manage": { module: "organization", label: "Edit organization details and plan" },
  "branches.manage": { module: "branches", label: "Create, edit and close branches" },
  "branches.update": { module: "branches", label: "Edit branch details and settings" },
  "staff.manage": { module: "staff", label: "Manage staff accounts, roles, branches and PINs" },
  "roles.manage": { module: "staff", label: "Create and edit custom roles" },
  "devices.manage": { module: "staff", label: "Register and revoke POS devices" },
  "menu.view": { module: "menu", label: "View the menu" },
  "menu.manage": { module: "menu", label: "Edit menu items, prices and availability" },
  "tables.view": { module: "tables", label: "View tables and floor plans" },
  "tables.manage": { module: "tables", label: "Edit tables, QR codes and floor plans" },
  "orders.take": { module: "orders", label: "Take orders and send KOTs" },
  "orders.manage": { module: "orders", label: "Cancel orders and void items sent to the kitchen" },
  "kitchen.view": { module: "kitchen", label: "View the kitchen display" },
  "kitchen.update": { module: "kitchen", label: "Bump kitchen tickets" },
  "billing.bill": { module: "billing", label: "Create bills and take payments" },
  "billing.invoices": { module: "billing", label: "View GST invoices" },
  "billing.manage": { module: "billing", label: "Cancel bills, approve discounts and issue credit notes" },
  "payments.request": { module: "payments", label: "Create UPI payment requests" },
  "payments.confirm": { module: "payments", label: "Confirm received UPI payments" },
  "payments.manage": { module: "payments", label: "Edit UPI settings" },
  "shifts.view": { module: "shifts", label: "View shifts and the current cash drawer" },
  "shifts.manage": { module: "shifts", label: "Open and close shifts, cash in/out and expenses" },
  "guests.manage": { module: "guests", label: "Register guests, record consent and view profiles" },
  "guests.admin": { module: "guests", label: "List all guests and adjust loyalty points" },
  "inventory.operate": { module: "inventory", label: "View stock, receive purchases and record wastage" },
  "inventory.manage": { module: "inventory", label: "Manage items, recipes, suppliers and stock counts" },
  "qr.operate": { module: "qr", label: "Accept QR orders and answer table requests" },
  "qr.manage": { module: "qr", label: "Edit QR ordering settings" },
  "reports.view": { module: "reports", label: "View reports" },
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;
export const PERMISSION_CODES = Object.keys(PERMISSIONS) as PermissionCode[];

export function isPermissionCode(value: string): value is PermissionCode {
  return value in PERMISSIONS;
}
