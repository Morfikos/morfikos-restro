import type { FastifyRequest } from "fastify";
import type { UserRole } from "@morfikos/auth";

export interface AuthContext {
  userId: string;
  role: UserRole;
  /** First organization the user belongs to (kept for existing controllers). */
  organizationId?: string;
  /** All organizations the user can access. */
  organizationIds: string[];
  /** All branches the user can access. */
  branchIds: string[];
}

/** Returns the authenticated user's context, or null if not logged in. */
export function getAuthContext(request: FastifyRequest): AuthContext | null {
  const user = (request as FastifyRequest & { user?: AuthContext }).user;
  return user ?? null;
}

/** Checks whether the user has one of the allowed roles. */
export function hasRole(context: AuthContext, roles: UserRole[]): boolean {
  return roles.includes(context.role);
}

/** Returns the organization ID of the authenticated user, if any. */
export function getOrganizationId(request: FastifyRequest): string | null {
  return getAuthContext(request)?.organizationId ?? null;
}
