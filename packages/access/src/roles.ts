import type { PermissionCode } from "./permissions.js";

export const SYSTEM_ROLES = ["owner", "manager", "waiter", "staff"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

const EVERYONE: PermissionCode[] = [
  "menu.view",
  "tables.view",
  "orders.take",
  "kitchen.view",
  "billing.bill",
  "payments.request",
  "shifts.view",
  "guests.manage",
  "qr.operate",
];

const MANAGER: PermissionCode[] = [
  ...EVERYONE,
  "branches.update",
  "staff.manage",
  "devices.manage",
  "menu.manage",
  "tables.manage",
  "orders.manage",
  "kitchen.update",
  "billing.invoices",
  "billing.manage",
  "payments.confirm",
  "payments.manage",
  "shifts.manage",
  "guests.admin",
  "inventory.operate",
  "inventory.manage",
  "qr.manage",
  "reports.view",
];

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRole, PermissionCode[]> = {
  owner: [...MANAGER, "organization.manage", "branches.manage", "roles.manage"],
  manager: MANAGER,
  waiter: EVERYONE,
  staff: [
    ...EVERYONE,
    "kitchen.update",
    "billing.invoices",
    "payments.confirm",
    "inventory.operate",
  ],
};
