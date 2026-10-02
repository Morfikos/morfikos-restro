export type UserRole =
  | "admin"
  | "owner"
  | "manager"
  | "waiter"
  | "staff"

export function canCreateOrganization(role: UserRole): boolean {
  return role === "admin"
}

export function canGetOrganization(role: UserRole): boolean {
  return role === "owner"
}
