import { db as prisma } from "../../plugins/db.js";
import type { UserRole } from "@morfikos/auth";

import { MANAGEABLE_ROLES, ORGANIZATION_ROLES, PERMISSIONS, ROLE_DETAILS } from "./constants.js";


/**
 * The authenticated user viewing roles.
 */
export interface RoleActor {
  userId: string;
  role: UserRole;
  organizationId: string;
}

/**
 * Builds one role's view: label, description, permissions, how many
 * active staff have it and whether the viewer can assign it.
 *
 * @param actor - The viewer.
 * @param role - The role.
 * @param staffCount - Active staff with this role.
 * @returns The role view.
 */
function serializeRole(actor: RoleActor, role: UserRole, staffCount: number) {
  const details = ROLE_DETAILS[role];

  return {
    role,
    label: details?.label ?? role,
    description: details?.description ?? null,
    staffCount,
    canAssign: MANAGEABLE_ROLES[actor.role].includes(role),
    permissions: PERMISSIONS.filter((permission) => permission.roles.includes(role)).map(
      ({ code, module, label }) => ({ code, module, label }),
    ),
  };
}

/**
 * Counts active staff of the organization per role.
 *
 * @param organizationId - The organization ID.
 * @returns Staff counts keyed by role.
 */
async function countStaffByRole(organizationId: string): Promise<Map<string, number>> {
  const rows = await prisma.user.groupBy({
    by: ["role"],
    where: { memberships: { some: { organizationId, status: "active" } } },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.role, row._count._all]));
}

/**
 * Lists the roles with their permissions, plus the full permission matrix
 * (which roles have each permission) and the caller's own role.
 *
 * @param actor - The viewer.
 * @returns The roles, permission matrix and the roles the viewer can assign.
 */
export async function listRoles(actor: RoleActor) {
  const counts = await countStaffByRole(actor.organizationId);

  return {
    yourRole: actor.role,
    assignableRoles: MANAGEABLE_ROLES[actor.role],
    roles: ORGANIZATION_ROLES.map((role) => serializeRole(actor, role, counts.get(role) ?? 0)),
    permissions: PERMISSIONS.map((permission) => ({
      code: permission.code,
      module: permission.module,
      label: permission.label,
      roles: ORGANIZATION_ROLES.filter((role) => permission.roles.includes(role)),
    })),
  };
}

/**
 * Retrieves one role with its permissions.
 *
 * @param actor - The viewer.
 * @param role - The role name.
 * @returns The role view, or null for an unknown role.
 */
export async function getRole(actor: RoleActor, role: string) {
  const known = ORGANIZATION_ROLES.find((entry) => entry === role);

  if (!known) {
    return null;
  }

  const counts = await countStaffByRole(actor.organizationId);

  return serializeRole(actor, known, counts.get(known) ?? 0);
}
