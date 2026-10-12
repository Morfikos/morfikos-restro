
export type UserRole =
  | "admin"
  | "owner"
  | "manager"
  | "waiter"
  | "staff";

export function canCreateOrganization(role: UserRole): boolean {
  return role === "admin";
}

export function canGetOrganization(role: UserRole): boolean {
  return role === "owner";
}

export function canManageOrganization(role: UserRole): boolean {
  return role === "owner";
}

export function canManageBranches(role: UserRole): boolean {
  return role === "owner";
}

export function canManageStaff(role: UserRole): boolean {
  return role === "owner" || role === "manager";
}

export function canAccessBranch(role: UserRole): boolean {
  return role === "owner" || role === "manager" ||
    role === "waiter" || role === "staff";
}
