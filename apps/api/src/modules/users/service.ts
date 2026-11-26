import { db as prisma } from "../../plugins/db.js";
import { ROLES, UserServiceErrorCode, hashPassword, type UserRole } from "@morfikos/auth";
import type {
  CreateUserInput,
  DeactivateUserInput,
  ListUsersQuery,
  ResetUserPasswordInput,
  SetUserPinInput,
  UpdateUserBranchesInput,
  UpdateUserInput,
  UpdateUserRoleInput,
} from "@morfikos/validation";

import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import {
  MANAGEABLE_ROLES,
  MembershipStatus,
  USER_TRANSACTION_OPTIONS,
} from "./constants.js";


/** The Prisma client available inside an interactive transaction. */
type TransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/**
 * The authenticated owner or manager managing staff.
 */
export interface UserActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

/**
 * Represents errors that can occur during staff management.
 */
export class UserServiceError extends Error {
  /**
   * Creates a user service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: UserServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UserServiceError";
  }
}

// ─── Loading and serializing staff ──────────────────────────────────────

/** Membership fields needed to show and manage a staff member. */
const memberSelect = {
  id: true,
  userId: true,
  status: true,
  phone: true,
  employeeCode: true,
  discountCeilingPct: true,
  pinHash: true,
  deactivatedAt: true,
  deactivationReason: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      lastLoginAt: true,
      createdAt: true,
    },
  },
  branchRoles: {
    select: {
      branchId: true,
      branch: { select: { id: true, name: true, status: true } },
    },
  },
} as const;

type Member = {
  id: string;
  userId: string;
  status: string;
  phone: string | null;
  employeeCode: string | null;
  discountCeilingPct: number | null;
  pinHash: string | null;
  deactivatedAt: Date | null;
  deactivationReason: string | null;
  createdAt: Date;
  user: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
    status: string;
    lastLoginAt: Date | null;
    createdAt: Date;
  };
  branchRoles: {
    branchId: string | null;
    branch: { id: string; name: string; status: string } | null;
  }[];
};

/**
 * Checks whether a staff member has access to every branch.
 *
 * @param member - The staff member.
 * @returns True for an organization-wide assignment.
 */
function hasAllBranches(member: Pick<Member, "branchRoles">): boolean {
  return member.branchRoles.some((assignment) => assignment.branchId === null);
}

/**
 * Checks whether the actor may manage a staff member: their role must be
 * one the actor manages, and a manager may only manage staff whose
 * branches are all among the manager's own.
 *
 * @param actor - The owner or manager.
 * @param member - The staff member.
 * @returns True if the actor can manage them.
 */
function canManage(actor: UserActor, member: Pick<Member, "userId" | "user" | "branchRoles">): boolean {
  if (member.userId === actor.userId || !MANAGEABLE_ROLES[actor.role].includes(member.user.role)) {
    return false;
  }

  if (actor.role === ROLES.MANAGER) {
    return (
      !hasAllBranches(member) &&
      member.branchRoles.every(
        (assignment) => assignment.branchId !== null && actor.branchIds.includes(assignment.branchId),
      )
    );
  }

  return true;
}

/**
 * Serializes a staff member for the API (never includes the PIN hash).
 *
 * @param actor - The viewer, to work out `canManage`.
 * @param member - The staff member.
 * @returns The staff view.
 */
function serializeMember(actor: UserActor, member: Member) {
  return {
    userId: member.user.id,
    name: member.user.name,
    email: member.user.email,
    phone: member.phone,
    employeeCode: member.employeeCode,
    role: member.user.role,
    status: member.status,
    allBranches: hasAllBranches(member),
    branches: member.branchRoles
      .flatMap((assignment) => (assignment.branch ? [assignment.branch] : []))
      .map((branch) => ({ id: branch.id, name: branch.name, isActive: branch.status === "active" })),
    hasPin: member.pinHash !== null,
    discountCeilingPct: member.discountCeilingPct,
    lastLoginAt: member.user.lastLoginAt,
    joinedAt: member.createdAt,
    deactivatedAt: member.deactivatedAt,
    deactivationReason: member.deactivationReason,
    isYou: member.userId === actor.userId,
    canManage: canManage(actor, member),
  };
}

/**
 * Builds the filter for staff a viewer may see. Owners see everyone in the
 * organization; managers see staff of their branches plus organization-wide
 * staff (such as owners).
 *
 * @param actor - The viewer.
 * @returns The Prisma where clause for memberships.
 */
function getVisibilityFilter(actor: UserActor) {
  return {
    organizationId: actor.organizationId,
    ...(actor.role === ROLES.MANAGER && {
      branchRoles: {
        some: { OR: [{ branchId: null }, { branchId: { in: actor.branchIds } }] },
      },
    }),
  };
}

/**
 * Loads a staff member of the actor's organization that the actor can see.
 *
 * @param client - The Prisma client or transaction client.
 * @param actor - The viewer.
 * @param userId - The staff member's user ID.
 * @returns The member, or null if not found.
 */
async function findMember(
  client: TransactionClient,
  actor: UserActor,
  userId: string,
): Promise<Member | null> {
  return client.membership.findFirst({
    where: { ...getVisibilityFilter(actor), userId },
    select: memberSelect,
  });
}

/**
 * Loads a staff member the actor may change.
 *
 * @param client - The Prisma client or transaction client.
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @returns The member, or null if not found.
 * @throws UserServiceError If the target is the actor or outside what the actor manages.
 */
async function findManageableMember(
  client: TransactionClient,
  actor: UserActor,
  userId: string,
): Promise<Member | null> {
  const member = await findMember(client, actor, userId);

  if (!member) {
    return null;
  }

  if (member.userId === actor.userId) {
    throw new UserServiceError(
      UserServiceErrorCode.CANNOT_MANAGE_SELF,
      "You can't change your own role, branches, status, password or PIN here",
    );
  }

  if (!canManage(actor, member)) {
    throw new UserServiceError(
      UserServiceErrorCode.CANNOT_MANAGE_USER,
      actor.role === ROLES.MANAGER
        ? "Managers can only manage waiters and staff of their own branches"
        : "Owners can't be managed by other users",
    );
  }

  return member;
}

// ─── Shared rules ───────────────────────────────────────────────────────

/**
 * Throws unless the actor may give this role.
 *
 * @param actor - The owner or manager.
 * @param role - The role to give.
 * @throws UserServiceError If the role can't be assigned by the actor.
 */
function assertAssignableRole(actor: UserActor, role: UserRole): void {
  if (!MANAGEABLE_ROLES[actor.role].includes(role)) {
    throw new UserServiceError(
      UserServiceErrorCode.ROLE_NOT_ASSIGNABLE,
      actor.role === ROLES.MANAGER
        ? "Managers can only assign the waiter or staff role"
        : "You are not allowed to assign this role",
    );
  }
}

/**
 * Validates requested branch access. Only owners can give access to all
 * branches; managers can only give access to their own branches.
 *
 * @param client - The Prisma client or transaction client.
 * @param actor - The owner or manager.
 * @param input - All branches, or a list of branch IDs.
 * @returns The branch IDs to assign, with `null` meaning all branches.
 * @throws UserServiceError If a branch is not accessible or not found.
 */
async function resolveBranchAccess(
  client: TransactionClient,
  actor: UserActor,
  input: { allBranches: boolean; branchIds: string[] },
): Promise<(string | null)[]> {
  if (input.allBranches) {
    if (actor.role !== ROLES.OWNER) {
      throw new UserServiceError(
        UserServiceErrorCode.BRANCH_ACCESS_DENIED,
        "Only an owner can give access to all branches",
      );
    }

    return [null];
  }

  if (input.branchIds.some((branchId) => !actor.branchIds.includes(branchId))) {
    throw new UserServiceError(
      UserServiceErrorCode.BRANCH_ACCESS_DENIED,
      "You can only assign staff to branches you have access to",
    );
  }

  const branches = await client.branch.findMany({
    where: { id: { in: input.branchIds }, organizationId: actor.organizationId, status: "active" },
    select: { id: true },
  });

  if (branches.length !== input.branchIds.length) {
    throw new UserServiceError(
      UserServiceErrorCode.BRANCH_NOT_FOUND,
      "One or more branches were not found or are inactive",
    );
  }

  return input.branchIds;
}

/**
 * Finds the global system role row for a role name.
 *
 * @param client - The Prisma client or transaction client.
 * @param role - The role name.
 * @returns The role's ID.
 * @throws UserServiceError If the database seed hasn't created it.
 */
async function getSystemRoleId(client: TransactionClient, role: UserRole): Promise<string> {
  const systemRole = await client.role.findFirst({
    where: { name: role, organizationId: null, isSystem: true },
    select: { id: true },
  });

  if (!systemRole) {
    throw new UserServiceError(
      UserServiceErrorCode.ROLE_NOT_CONFIGURED,
      "System role is not configured. Run the database seed.",
    );
  }

  return systemRole.id;
}

/**
 * Throws if an email belongs to another account.
 *
 * @param client - The Prisma client or transaction client.
 * @param email - The email.
 * @param exceptUserId - The user allowed to already have it.
 * @throws UserServiceError If the email is taken.
 */
async function assertEmailAvailable(
  client: TransactionClient,
  email: string,
  exceptUserId?: string,
): Promise<void> {
  const existing = await client.user.findUnique({ where: { email }, select: { id: true } });

  if (existing && existing.id !== exceptUserId) {
    throw new UserServiceError(
      UserServiceErrorCode.EMAIL_ALREADY_EXISTS,
      "An account with this email already exists",
    );
  }
}

/**
 * Throws if a staff code is used by someone else in the organization.
 *
 * @param client - The Prisma client or transaction client.
 * @param organizationId - The organization ID.
 * @param employeeCode - The staff code.
 * @param exceptMembershipId - The membership allowed to already have it.
 * @throws UserServiceError If the code is taken.
 */
async function assertEmployeeCodeAvailable(
  client: TransactionClient,
  organizationId: string,
  employeeCode: string,
  exceptMembershipId?: string,
): Promise<void> {
  const existing = await client.membership.findUnique({
    where: { organizationId_employeeCode: { organizationId, employeeCode } },
    select: { id: true },
  });

  if (existing && existing.id !== exceptMembershipId) {
    throw new UserServiceError(
      UserServiceErrorCode.EMPLOYEE_CODE_EXISTS,
      `Staff code ${employeeCode} is already used by someone else`,
    );
  }
}

/**
 * Signs a user out everywhere by revoking their refresh tokens. Their
 * current access token still works until it expires (15 minutes).
 *
 * @param client - The Prisma client or transaction client.
 * @param userId - The user ID.
 */
async function revokeSessions(client: TransactionClient, userId: string): Promise<void> {
  await client.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Turns a unique-constraint race into a friendly error.
 *
 * @param error - The caught error.
 * @throws UserServiceError For a duplicate email or staff code, otherwise the original error.
 */
function rethrowConflict(error: unknown): never {
  if (isPrismaUniqueConstraintError(error)) {
    const target = (error as { meta?: { target?: unknown } }).meta?.target;
    const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");

    throw fields.includes("employeeCode")
      ? new UserServiceError(UserServiceErrorCode.EMPLOYEE_CODE_EXISTS, "This staff code is already used")
      : new UserServiceError(UserServiceErrorCode.EMAIL_ALREADY_EXISTS, "An account with this email already exists");
  }

  throw error;
}

/**
 * Reloads a staff member and serializes them.
 *
 * @param actor - The viewer.
 * @param userId - The staff member's user ID.
 * @returns The staff view.
 */
async function getMemberView(actor: UserActor, userId: string) {
  const member = await prisma.membership.findFirstOrThrow({
    where: { organizationId: actor.organizationId, userId },
    select: memberSelect,
  });

  return serializeMember(actor, member);
}

// ─── Staff APIs ─────────────────────────────────────────────────────────

/**
 * Lists the organization's staff, most senior role first, with counts per
 * role and status.
 *
 * @param actor - The owner or manager.
 * @param query - Branch, role, status, search and pagination.
 * @returns The staff, a summary and pagination metadata.
 * @throws UserServiceError If a manager filters by a branch they can't access.
 */
export async function listUsers(actor: UserActor, query: ListUsersQuery) {
  if (query.branchId !== undefined && !actor.branchIds.includes(query.branchId)) {
    throw new UserServiceError(
      UserServiceErrorCode.BRANCH_ACCESS_DENIED,
      "Access denied for this branch",
    );
  }

  const visible = getVisibilityFilter(actor);

  const where = {
    AND: [
      visible,
      ...(query.status !== "all" ? [{ status: query.status }] : []),
      ...(query.role !== undefined ? [{ user: { role: query.role } }] : []),
      ...(query.branchId !== undefined
        ? [{ branchRoles: { some: { OR: [{ branchId: null }, { branchId: query.branchId }] } } }]
        : []),
      ...(query.search !== undefined
        ? [
            {
              OR: [
                { user: { name: { contains: query.search, mode: "insensitive" as const } } },
                { user: { email: { contains: query.search, mode: "insensitive" as const } } },
                { phone: { contains: query.search } },
                { employeeCode: { contains: query.search, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
  };

  const [members, total, byRole, byStatus] = await Promise.all([
    prisma.membership.findMany({
      where,
      // Role enum order: owner, manager, waiter, staff.
      orderBy: [{ user: { role: "asc" } }, { user: { name: "asc" } }],
      take: query.limit,
      skip: query.offset,
      select: memberSelect,
    }),
    prisma.membership.count({ where }),
    prisma.user.groupBy({
      by: ["role"],
      where: { memberships: { some: { ...visible, status: MembershipStatus.ACTIVE } } },
      _count: { _all: true },
    }),
    prisma.membership.groupBy({
      by: ["status"],
      where: visible,
      _count: { _all: true },
    }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    summary: {
      active: byStatus.find((row) => row.status === MembershipStatus.ACTIVE)?._count._all ?? 0,
      inactive: byStatus.find((row) => row.status === MembershipStatus.INACTIVE)?._count._all ?? 0,
      byRole: Object.fromEntries(byRole.map((row) => [row.role, row._count._all])),
    },
    users: members.map((member) => serializeMember(actor, member)),
  };
}

/**
 * Retrieves one staff member's profile, access and status.
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @returns The staff view, or null if not found.
 */
export async function getUser(actor: UserActor, userId: string) {
  const member = await findMember(prisma, actor, userId);

  return member ? serializeMember(actor, member) : null;
}

/**
 * Creates a staff account in the actor's organization with a role, branch
 * access and optional phone, staff code, PIN and discount limit.
 *
 * @param actor - The owner or manager.
 * @param input - The staff details.
 * @returns The created staff member.
 * @throws UserServiceError If the role or branches aren't allowed, or the email/code is taken.
 */
export async function createUser(actor: UserActor, input: CreateUserInput) {
  assertAssignableRole(actor, input.role);

  const [passwordHash, pinHash] = await Promise.all([
    hashPassword(input.password),
    input.pin !== undefined ? hashPassword(input.pin) : Promise.resolve(null),
  ]);

  try {
    const userId = await prisma.$transaction(async (tx) => {
      const branchIds = await resolveBranchAccess(tx, actor, input);
      const roleId = await getSystemRoleId(tx, input.role);

      await assertEmailAvailable(tx, input.email);

      if (input.employeeCode !== undefined) {
        await assertEmployeeCodeAvailable(tx, actor.organizationId, input.employeeCode);
      }

      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          role: input.role,
          status: MembershipStatus.ACTIVE,
          memberships: {
            create: {
              organizationId: actor.organizationId,
              phone: input.phone ?? null,
              employeeCode: input.employeeCode ?? null,
              pinHash,
              discountCeilingPct: input.discountCeilingPct ?? null,
              branchRoles: {
                create: branchIds.map((branchId) => ({ branchId, roleId })),
              },
            },
          },
        },
        select: { id: true },
      });

      return user.id;
    }, USER_TRANSACTION_OPTIONS);

    return getMemberView(actor, userId);
  } catch (error: unknown) {
    return rethrowConflict(error);
  }
}

/**
 * Edits a staff member's name, email, phone, staff code or discount limit.
 * Owners and managers may also edit their own details here.
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @param input - The changes (`null` clears a field).
 * @returns The updated staff member, or null if not found.
 * @throws UserServiceError If the actor can't manage them, or the email/code is taken.
 */
export async function updateUser(actor: UserActor, userId: string, input: UpdateUserInput) {
  const member = await findMember(prisma, actor, userId);

  if (!member) {
    return null;
  }

  const isSelf = member.userId === actor.userId;

  if (!isSelf && !canManage(actor, member)) {
    throw new UserServiceError(
      UserServiceErrorCode.CANNOT_MANAGE_USER,
      "You can't edit this staff member",
    );
  }

  if (isSelf && input.discountCeilingPct !== undefined) {
    throw new UserServiceError(
      UserServiceErrorCode.CANNOT_MANAGE_SELF,
      "You can't change your own discount limit",
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (input.email !== undefined) {
        await assertEmailAvailable(tx, input.email, member.userId);
      }

      if (input.employeeCode) {
        await assertEmployeeCodeAvailable(tx, actor.organizationId, input.employeeCode, member.id);
      }

      if (input.name !== undefined || input.email !== undefined) {
        await tx.user.update({
          where: { id: member.userId },
          data: {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.email !== undefined && { email: input.email }),
          },
        });
      }

      await tx.membership.update({
        where: { id: member.id },
        data: {
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.employeeCode !== undefined && { employeeCode: input.employeeCode }),
          ...(input.discountCeilingPct !== undefined && { discountCeilingPct: input.discountCeilingPct }),
        },
      });
    }, USER_TRANSACTION_OPTIONS);
  } catch (error: unknown) {
    return rethrowConflict(error);
  }

  return getMemberView(actor, member.userId);
}

/**
 * Changes a staff member's role (e.g. staff → manager). Takes effect when
 * their access token next refreshes (within 15 minutes).
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @param input - The new role.
 * @returns The updated staff member, or null if not found.
 * @throws UserServiceError If the actor can't manage them or give that role.
 */
export async function updateUserRole(actor: UserActor, userId: string, input: UpdateUserRoleInput) {
  assertAssignableRole(actor, input.role);

  const changed = await prisma.$transaction(async (tx) => {
    const member = await findManageableMember(tx, actor, userId);

    if (!member) {
      return false;
    }

    if (member.user.role !== input.role) {
      const roleId = await getSystemRoleId(tx, input.role);

      await tx.user.update({ where: { id: member.userId }, data: { role: input.role } });
      await tx.membershipBranchRole.updateMany({
        where: { membershipId: member.id },
        data: { roleId },
      });
    }

    return true;
  }, USER_TRANSACTION_OPTIONS);

  return changed ? getMemberView(actor, userId) : null;
}

/**
 * Replaces a staff member's branch access: all branches (owners only) or a
 * list of branches. Takes effect when their access token next refreshes.
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @param input - All branches, or a list of branch IDs.
 * @returns The updated staff member, or null if not found.
 * @throws UserServiceError If the actor can't manage them or give that access.
 */
export async function updateUserBranches(
  actor: UserActor,
  userId: string,
  input: UpdateUserBranchesInput,
) {
  const changed = await prisma.$transaction(async (tx) => {
    const member = await findManageableMember(tx, actor, userId);

    if (!member) {
      return false;
    }

    const branchIds = await resolveBranchAccess(tx, actor, input);
    const roleId = await getSystemRoleId(tx, member.user.role);

    await tx.membershipBranchRole.deleteMany({ where: { membershipId: member.id } });
    await tx.membershipBranchRole.createMany({
      data: branchIds.map((branchId) => ({ membershipId: member.id, branchId, roleId })),
    });

    return true;
  }, USER_TRANSACTION_OPTIONS);

  return changed ? getMemberView(actor, userId) : null;
}

/**
 * Deactivates a staff member: they can't log in to this organization, are
 * signed out everywhere, and their PIN stops approving anything. Their
 * history (orders, bills, shifts) is kept.
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @param input - Optional reason.
 * @returns The updated staff member and any open shift they still have, or null if not found.
 * @throws UserServiceError If the actor can't manage them or they're already inactive.
 */
export async function deactivateUser(actor: UserActor, userId: string, input: DeactivateUserInput) {
  const result = await prisma.$transaction(async (tx) => {
    const member = await findManageableMember(tx, actor, userId);

    if (!member) {
      return null;
    }

    if (member.status === MembershipStatus.INACTIVE) {
      throw new UserServiceError(
        UserServiceErrorCode.USER_ALREADY_INACTIVE,
        "This staff member is already inactive",
      );
    }

    await tx.membership.update({
      where: { id: member.id },
      data: {
        status: MembershipStatus.INACTIVE,
        deactivatedAt: new Date(),
        deactivationReason: input.reason ?? null,
      },
    });

    // An account with no other active organization can't log in at all.
    const otherActive = await tx.membership.count({
      where: { userId: member.userId, status: MembershipStatus.ACTIVE, id: { not: member.id } },
    });

    if (otherActive === 0) {
      await tx.user.update({ where: { id: member.userId }, data: { status: MembershipStatus.INACTIVE } });
    }

    await revokeSessions(tx, member.userId);

    const openShift = await tx.shift.findFirst({
      where: { staffId: member.userId, organizationId: actor.organizationId, status: "OPEN" },
      select: { id: true, shiftNumber: true, branchId: true, businessDate: true },
    });

    return { openShift };
  }, USER_TRANSACTION_OPTIONS);

  if (!result) {
    return null;
  }

  return { ...(await getMemberView(actor, userId)), openShift: result.openShift };
}

/**
 * Reactivates a staff member with their previous role and branches.
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @returns The updated staff member, or null if not found.
 * @throws UserServiceError If the actor can't manage them or they're already active.
 */
export async function activateUser(actor: UserActor, userId: string) {
  const changed = await prisma.$transaction(async (tx) => {
    const member = await findManageableMember(tx, actor, userId);

    if (!member) {
      return false;
    }

    if (member.status === MembershipStatus.ACTIVE) {
      throw new UserServiceError(
        UserServiceErrorCode.USER_ALREADY_ACTIVE,
        "This staff member is already active",
      );
    }

    await tx.membership.update({
      where: { id: member.id },
      data: { status: MembershipStatus.ACTIVE, deactivatedAt: null, deactivationReason: null },
    });
    await tx.user.update({ where: { id: member.userId }, data: { status: MembershipStatus.ACTIVE } });

    return true;
  }, USER_TRANSACTION_OPTIONS);

  return changed ? getMemberView(actor, userId) : null;
}

/**
 * Sets a new password for a staff member (e.g. they forgot it at the
 * counter) and signs them out everywhere.
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @param input - The new password.
 * @returns A confirmation, or null if not found.
 * @throws UserServiceError If the actor can't manage them.
 */
export async function resetUserPassword(
  actor: UserActor,
  userId: string,
  input: ResetUserPasswordInput,
) {
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const member = await findManageableMember(tx, actor, userId);

    if (!member) {
      return null;
    }

    await tx.user.update({ where: { id: member.userId }, data: { passwordHash } });
    await tx.passwordResetToken.updateMany({
      where: { userId: member.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await revokeSessions(tx, member.userId);

    return { userId: member.userId, passwordReset: true, sessionsRevoked: true };
  }, USER_TRANSACTION_OPTIONS);
}

/**
 * Sets a staff member's PIN. A manager's PIN approves discounts, voids and
 * credit notes; owners and managers set their own via `/auth/manager-pin`.
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @param input - The new PIN.
 * @returns A confirmation, or null if not found.
 * @throws UserServiceError If the actor can't manage them.
 */
export async function setUserPin(actor: UserActor, userId: string, input: SetUserPinInput) {
  const pinHash = await hashPassword(input.pin);
  const member = await findManageableMember(prisma, actor, userId);

  if (!member) {
    return null;
  }

  await prisma.membership.update({ where: { id: member.id }, data: { pinHash } });

  return { userId: member.userId, hasPin: true };
}

/**
 * Removes a staff member's PIN.
 *
 * @param actor - The owner or manager.
 * @param userId - The staff member's user ID.
 * @returns A confirmation, or null if not found.
 * @throws UserServiceError If the actor can't manage them.
 */
export async function clearUserPin(actor: UserActor, userId: string) {
  const member = await findManageableMember(prisma, actor, userId);

  if (!member) {
    return null;
  }

  await prisma.membership.update({ where: { id: member.id }, data: { pinHash: null } });

  return { userId: member.userId, hasPin: false };
}

/**
 * Checks whether an unknown value is a user service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value is a UserServiceError with a known code.
 */
export function isUserServiceError(error: unknown): error is UserServiceError {
  return (
    error instanceof UserServiceError &&
    Object.values(UserServiceErrorCode).includes(error.code)
  );
}
