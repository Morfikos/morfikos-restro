import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@morfikos/database";
import {
  ROLES,
  canManageBranches,
  canManageOrganization,
  canManageStaff,
  createAccessToken,
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  verifyPassword,
  type Role,
} from "@morfikos/auth";
import type {
  ChangePasswordInput,
  LoginInput,
  ResetPasswordInput,
  SetManagerPinInput,
  SignupInput,
  StaffSignupInput,
} from "@morfikos/validation";
import type { AuthContext } from "../../utils/auth-helpers.js";
import { HTTP_STATUS } from "../../utils/http-status.js";
import { sendPasswordResetEmail } from "../../utils/mailer.js";
import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import {
  ACCESS_TOKEN_EXPIRY_SECONDS,
  ASSIGNABLE_ROLES,
  AUTH_MESSAGES,
  AuthErrorCode,
  PASSWORD_RESET_TOKEN_EXPIRY_MINUTES,
  RecordStatus,
  REFRESH_TOKEN_EXPIRY_DAYS,
  REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS,
  UserStatus,
} from "./constants.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * Represents an expected, client-facing error raised by the auth service.
 */
export class AuthServiceError extends Error {
  /**
   * Creates an auth service error.
   *
   * @param code - The standardized error code.
   * @param message - A client-facing description of the error.
   * @param statusCode - The HTTP status code to respond with.
   */
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

/**
 * Checks whether an unknown value is an AuthServiceError.
 *
 * @param error - The value to check.
 * @returns True if the value is an AuthServiceError.
 */
export function isAuthServiceError(error: unknown): error is AuthServiceError {
  return error instanceof AuthServiceError;
}

type AccessContext = {
  organizationIds: string[];
  branchIds: string[];
  organizations: Array<{ id: string; name: string; role: string }>;
};

/**
 * Resolves a user's active organization memberships and branch access.
 *
 * A branch-role assignment with a null branchId applies to every active
 * branch in that organization. Branch-specific assignments grant access
 * only to the assigned active branch.
 *
 * @param userId - The user's ID.
 * @returns Organization IDs, branch IDs and per-organization roles.
 */
async function getAccessContext(userId: string): Promise<AccessContext> {
  const memberships = await prisma.membership.findMany({
    where: {
      userId,
      status: RecordStatus.ACTIVE,
      organization: { status: RecordStatus.ACTIVE },
    },
    // Stable order: the first organization is the user's default context.
    orderBy: { createdAt: "asc" },
    select: {
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          branches: {
            where: { status: RecordStatus.ACTIVE },
            select: { id: true },
          },
        },
      },
      branchRoles: {
        select: {
          branchId: true,
          role: { select: { name: true } },
          branch: {
            select: { id: true, status: true, organizationId: true },
          },
        },
      },
    },
  });

  const branchIds = new Set<string>();

  const organizations = memberships.map((membership) => {
    const validAssignments = membership.branchRoles.filter((assignment) => {
      // A null branchId means the role applies organization-wide.
      if (assignment.branchId === null) {
        return true;
      }

      // Ignore inactive branches and branches from another organization.
      return (
        assignment.branch !== null &&
        assignment.branch.status === RecordStatus.ACTIVE &&
        assignment.branch.organizationId === membership.organizationId
      );
    });

    const organizationWideAssignments = validAssignments.filter(
      (assignment) => assignment.branchId === null,
    );

    // Prefer an organization-wide role when one exists. Otherwise,
    // derive the organization-level role from branch assignments.
    const roleAssignments =
      organizationWideAssignments.length > 0
        ? organizationWideAssignments
        : validAssignments;

    const roleNames = [
      ...new Set(roleAssignments.map((assignment) => assignment.role.name)),
    ];

    const role =
      roleNames.length === 0
        ? "unassigned"
        : roleNames.length === 1
          ? roleNames[0]
          : "multiple";

    for (const assignment of validAssignments) {
      if (assignment.branchId === null) {
        for (const branch of membership.organization.branches) {
          branchIds.add(branch.id);
        }
      } else if (assignment.branch) {
        branchIds.add(assignment.branch.id);
      }
    }

    return {
      id: membership.organization.id,
      name: membership.organization.name,
      role,
    };
  });

  return {
    organizationIds: organizations.map((organization) => organization.id),
    branchIds: [...branchIds],
    organizations,
  };
}

/**
 * Signs an access token for a user with their current access context.
 *
 * @param user - The user's ID and role.
 * @param accessContext - The user's resolved organization and branch access.
 * @returns The signed JWT access token.
 */
function signAccessToken(
  user: { id: string; role: Role },
  accessContext: AccessContext,
): Promise<string> {
  return createAccessToken({
    sub: user.id,
    role: user.role,
    organizationIds: accessContext.organizationIds,
    branchIds: accessContext.branchIds,
  });
}

/**
 * Builds the frontend URL the user opens to reset their password.
 *
 * @param token - The plain-text reset token.
 * @returns The absolute reset URL.
 */
function buildPasswordResetUrl(token: string): string {
  const baseUrl = process.env.WEB_APP_URL ?? "http://localhost:5173";

  return `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Throws a conflict error if an account already exists for the email.
 *
 * @param email - The normalized email address.
 * @throws AuthServiceError When the email is already registered.
 */
async function assertEmailAvailable(email: string): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    throw new AuthServiceError(
      AuthErrorCode.EMAIL_ALREADY_EXISTS,
      AUTH_MESSAGES.EMAIL_ALREADY_EXISTS,
      HTTP_STATUS.CONFLICT,
    );
  }
}

/**
 * Converts a unique-constraint violation on user creation into a conflict
 * error. This covers the race where two signups use the same email at once.
 *
 * @param error - The error thrown by Prisma.
 * @throws AuthServiceError For unique-constraint violations; rethrows otherwise.
 */
function rethrowEmailConflict(error: unknown): never {
  if (isPrismaUniqueConstraintError(error)) {
    throw new AuthServiceError(
      AuthErrorCode.EMAIL_ALREADY_EXISTS,
      AUTH_MESSAGES.EMAIL_ALREADY_EXISTS,
      HTTP_STATUS.CONFLICT,
    );
  }

  throw error;
}

/**
 * Handles signup, login, token and password operations.
 */
export class AuthService {
  /**
   * Registers a new restaurant owner. Public signup always creates an
   * OWNER; staff accounts are created through {@link createStaff}.
   *
   * @param input - Validated signup details.
   * @returns The created user's public profile.
   * @throws AuthServiceError When the email is already registered.
   */
  async signup(input: SignupInput) {
    await assertEmailAvailable(input.email);

    const passwordHash = await hashPassword(input.password);

    try {
      return await prisma.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          role: ROLES.OWNER,
          status: UserStatus.ACTIVE,
        },
        select: { id: true, name: true, email: true, role: true },
      });
    } catch (error: unknown) {
      rethrowEmailConflict(error);
    }
  }

  /**
   * Creates a staff account (manager, waiter or staff) inside an
   * organization the actor belongs to, and assigns its role.
   *
   * Owners may assign manager/waiter/staff, organization-wide or for a
   * single branch. Managers may assign waiter/staff, and only to a branch
   * they have access to.
   *
   * @param actor - The authenticated user creating the account.
   * @param input - Validated staff details.
   * @returns The created user's public profile and role assignment.
   * @throws AuthServiceError When the actor lacks permission, the branch
   * is invalid, the system role is missing or the email is taken.
   */
  async createStaff(actor: AuthContext, input: StaffSignupInput) {
    if (!ASSIGNABLE_ROLES[actor.role].includes(input.role)) {
      throw new AuthServiceError(
        AuthErrorCode.ROLE_NOT_ASSIGNABLE,
        AUTH_MESSAGES.ROLE_NOT_ASSIGNABLE,
        HTTP_STATUS.FORBIDDEN,
      );
    }

    if (!actor.organizationIds.includes(input.organizationId)) {
      throw new AuthServiceError(
        AuthErrorCode.ORGANIZATION_ACCESS_DENIED,
        AUTH_MESSAGES.ORGANIZATION_ACCESS_DENIED,
        HTTP_STATUS.FORBIDDEN,
      );
    }

    // Managers may only staff the branches they themselves can access.
    if (
      actor.role === ROLES.MANAGER &&
      (!input.branchId || !actor.branchIds.includes(input.branchId))
    ) {
      throw new AuthServiceError(
        AuthErrorCode.BRANCH_ACCESS_DENIED,
        AUTH_MESSAGES.BRANCH_REQUIRED_FOR_MANAGER,
        HTTP_STATUS.FORBIDDEN,
      );
    }

    if (input.branchId) {
      const branch = await prisma.branch.findFirst({
        where: {
          id: input.branchId,
          organizationId: input.organizationId,
          status: RecordStatus.ACTIVE,
        },
        select: { id: true },
      });

      if (!branch) {
        throw new AuthServiceError(
          AuthErrorCode.BRANCH_NOT_FOUND,
          AUTH_MESSAGES.BRANCH_NOT_FOUND,
          HTTP_STATUS.NOT_FOUND,
        );
      }
    }

    // System roles are seeded globally (organizationId = null).
    const systemRole = await prisma.role.findFirst({
      where: { name: input.role, organizationId: null, isSystem: true },
      select: { id: true },
    });

    if (!systemRole) {
      throw new AuthServiceError(
        AuthErrorCode.ROLE_NOT_CONFIGURED,
        AUTH_MESSAGES.ROLE_NOT_CONFIGURED,
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
      );
    }

    await assertEmailAvailable(input.email);

    const passwordHash = await hashPassword(input.password);

    try {
      // Nested create keeps user, membership and role assignment atomic.
      const user = await prisma.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          role: input.role,
          status: UserStatus.ACTIVE,
          memberships: {
            create: {
              organizationId: input.organizationId,
              branchRoles: {
                create: {
                  branchId: input.branchId ?? null,
                  roleId: systemRole.id,
                },
              },
            },
          },
        },
        select: { id: true, name: true, email: true, role: true },
      });

      return {
        ...user,
        organizationId: input.organizationId,
        branchId: input.branchId ?? null,
      };
    } catch (error: unknown) {
      rethrowEmailConflict(error);
    }
  }

  /**
   * Authenticates a user and issues an access token and refresh token.
   *
   * @param input - Validated email, password and remember-me flag.
   * @returns Tokens and the user's organization and branch access.
   * @throws AuthServiceError When credentials are invalid or the user is inactive.
   */
  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError(
        AuthErrorCode.INVALID_CREDENTIALS,
        AUTH_MESSAGES.INVALID_CREDENTIALS,
        HTTP_STATUS.UNAUTHORIZED,
      );
    }

    const isPasswordValid = await verifyPassword(
      input.password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new AuthServiceError(
        AuthErrorCode.INVALID_CREDENTIALS,
        AUTH_MESSAGES.INVALID_CREDENTIALS,
        HTTP_STATUS.UNAUTHORIZED,
      );
    }

    const accessContext = await getAccessContext(user.id);
    const accessToken = await signAccessToken(user, accessContext);
    const refreshToken = generateRefreshToken();

    const refreshLifetimeDays = input.rememberMe
      ? REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS
      : REFRESH_TOKEN_EXPIRY_DAYS;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRefreshToken(refreshToken),
          expiresAt: new Date(Date.now() + refreshLifetimeDays * MS_PER_DAY),
        },
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        organizations: accessContext.organizations,
        branches: accessContext.branchIds,
      },
    };
  }

  /**
   * Rotates a refresh token and recalculates current access. The new
   * refresh token keeps the original lifetime, so remember-me sessions
   * stay long-lived.
   *
   * @param refreshToken - Existing opaque refresh token.
   * @returns A new token pair and access-token expiry.
   * @throws AuthServiceError When the token is invalid or the user is inactive.
   */
  async refresh(refreshToken: string) {
    const invalidToken = new AuthServiceError(
      AuthErrorCode.INVALID_REFRESH_TOKEN,
      AUTH_MESSAGES.INVALID_REFRESH_TOKEN,
      HTTP_STATUS.UNAUTHORIZED,
    );

    const storedToken = await prisma.refreshToken.findFirst({
      where: {
        tokenHash: hashRefreshToken(refreshToken),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!storedToken) {
      throw invalidToken;
    }

    const user = await prisma.user.findUnique({
      where: { id: storedToken.userId },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw invalidToken;
    }

    // Recalculate access so revoked memberships or branch assignments
    // are not carried forward into a newly issued access token.
    const accessContext = await getAccessContext(user.id);
    const accessToken = await signAccessToken(user, accessContext);
    const newRefreshToken = generateRefreshToken();

    const lifetimeMs =
      storedToken.expiresAt.getTime() - storedToken.createdAt.getTime();

    await prisma.$transaction(async (tx) => {
      const revokeResult = await tx.refreshToken.updateMany({
        where: {
          id: storedToken.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { revokedAt: new Date() },
      });

      if (revokeResult.count !== 1) {
        throw invalidToken;
      }

      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRefreshToken(newRefreshToken),
          expiresAt: new Date(Date.now() + lifetimeMs),
        },
      });
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    };
  }

  /**
   * Returns the authenticated user's profile: their current organization,
   * accessible branches, selected branch and role-based permissions.
   *
   * The current organization is the first one the user joined, matching
   * the organization context used by other APIs.
   *
   * @param userId - ID of the authenticated user.
   * @param requestedBranchId - Branch the client has selected, if any.
   * @returns The user profile wrapped in a `user` key.
   * @throws AuthServiceError When the user no longer exists or is inactive.
   */
  async getCurrentUser(userId: string, requestedBranchId?: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        lastLoginAt: true,
      },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError(
        AuthErrorCode.UNAUTHENTICATED,
        AUTH_MESSAGES.USER_INACTIVE,
        HTTP_STATUS.UNAUTHORIZED,
      );
    }

    const accessContext = await getAccessContext(user.id);
    const currentOrganization = accessContext.organizations[0];

    const [organization, branches] = await Promise.all([
      currentOrganization
        ? prisma.organization.findUnique({
            where: { id: currentOrganization.id },
            select: {
              id: true,
              name: true,
              businessType: true,
              city: true,
              state: true,
            },
          })
        : null,
      prisma.branch.findMany({
        where: { id: { in: accessContext.branchIds } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, code: true, city: true },
      }),
    ]);

    // Only honour the requested branch if the user can access it.
    const selectedBranch =
      branches.find((branch) => branch.id === requestedBranchId) ??
      branches[0] ??
      null;

    const isMenuManager =
      user.role === ROLES.OWNER || user.role === ROLES.MANAGER;

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isSuperAdmin: user.role === ROLES.ADMIN,
        lastLoginAt: user.lastLoginAt,
        organization:
          organization && currentOrganization
            ? { ...organization, role: currentOrganization.role }
            : null,
        organizations: accessContext.organizations,
        branches,
        selectedBranch: selectedBranch
          ? { id: selectedBranch.id, name: selectedBranch.name }
          : null,
        permissions: {
          manageOrganization: canManageOrganization(user.role),
          manageBranches: canManageBranches(user.role),
          manageStaff: canManageStaff(user.role),
          manageMenu: isMenuManager,
          viewCostPrice: isMenuManager,
        },
      },
    };
  }

  /**
   * Logs the user out. Revokes the given refresh token, or every active
   * refresh token of the user when none is provided.
   *
   * @param userId - ID of the authenticated user.
   * @param refreshToken - Optional refresh token for this session.
   */
  async logout(userId: string, refreshToken?: string) {
    await prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(refreshToken ? { tokenHash: hashRefreshToken(refreshToken) } : {}),
      },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Changes the authenticated user's password and revokes all of their
   * active refresh tokens.
   *
   * @param userId - ID of the authenticated user.
   * @param input - Validated old and new passwords.
   * @throws AuthServiceError If the user is inactive or the old password is wrong.
   */
  async changePassword(userId: string, input: ChangePasswordInput) {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError(
        AuthErrorCode.UNAUTHENTICATED,
        AUTH_MESSAGES.USER_INACTIVE,
        HTTP_STATUS.UNAUTHORIZED,
      );
    }

    const isPasswordValid = await verifyPassword(
      input.oldPassword,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new AuthServiceError(
        AuthErrorCode.INCORRECT_PASSWORD,
        AUTH_MESSAGES.INCORRECT_PASSWORD,
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    const passwordHash = await hashPassword(input.newPassword);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
      prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  /**
   * Sets the signed-in owner's or manager's approval PIN for their current
   * organization. The PIN approves large discounts and credit notes, and is
   * stored hashed. The account password confirms the change.
   *
   * @param actor - The authenticated user.
   * @param input - The new PIN and the account password.
   * @throws AuthServiceError If the role can't set a PIN, the password is
   * wrong or the user has no organization.
   */
  async setManagerPin(actor: AuthContext, input: SetManagerPinInput) {
    if (actor.role !== ROLES.OWNER && actor.role !== ROLES.MANAGER) {
      throw new AuthServiceError(
        AuthErrorCode.FORBIDDEN,
        AUTH_MESSAGES.PIN_NOT_ALLOWED,
        HTTP_STATUS.FORBIDDEN,
      );
    }

    if (!actor.organizationId) {
      throw new AuthServiceError(
        AuthErrorCode.ORGANIZATION_ACCESS_DENIED,
        AUTH_MESSAGES.NO_ORGANIZATION_MEMBERSHIP,
        HTTP_STATUS.FORBIDDEN,
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { passwordHash: true, status: true },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new AuthServiceError(
        AuthErrorCode.UNAUTHENTICATED,
        AUTH_MESSAGES.USER_INACTIVE,
        HTTP_STATUS.UNAUTHORIZED,
      );
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      throw new AuthServiceError(
        AuthErrorCode.INCORRECT_PASSWORD,
        AUTH_MESSAGES.INCORRECT_PASSWORD,
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    const updated = await prisma.membership.updateMany({
      where: { userId: actor.userId, organizationId: actor.organizationId },
      data: { pinHash: await hashPassword(input.pin) },
    });

    if (updated.count === 0) {
      throw new AuthServiceError(
        AuthErrorCode.ORGANIZATION_ACCESS_DENIED,
        AUTH_MESSAGES.NO_ORGANIZATION_MEMBERSHIP,
        HTTP_STATUS.FORBIDDEN,
      );
    }
  }

  /**
   * Starts the password reset flow. Creates a single-use reset token,
   * invalidates any earlier unused tokens and emails the reset link.
   *
   * Silently does nothing for unknown or inactive emails so the endpoint
   * cannot be used to discover registered accounts.
   *
   * @param email - The normalized email address.
   * @param logger - Logger passed to the mailer.
   * @returns The plain-text reset token, or null if no email was sent.
   */
  async forgotPassword(
    email: string,
    logger: FastifyBaseLogger,
  ): Promise<string | null> {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true, status: true },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      return null;
    }

    // Same random-token + SHA-256 scheme as refresh tokens.
    const resetToken = generateRefreshToken();
    const now = new Date();

    await prisma.$transaction([
      // Invalidate older unused links so only the newest one works.
      prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      }),
      prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRefreshToken(resetToken),
          expiresAt: new Date(
            now.getTime() + PASSWORD_RESET_TOKEN_EXPIRY_MINUTES * MS_PER_MINUTE,
          ),
        },
      }),
    ]);

    await sendPasswordResetEmail(logger, {
      to: user.email,
      name: user.name,
      resetUrl: buildPasswordResetUrl(resetToken),
      expiresInMinutes: PASSWORD_RESET_TOKEN_EXPIRY_MINUTES,
    });

    return resetToken;
  }

  /**
   * Completes the password reset flow. Consumes the reset token, sets the
   * new password and revokes all of the user's refresh tokens.
   *
   * @param input - Validated reset token and new password.
   * @throws AuthServiceError When the token is invalid, expired or already used.
   */
  async resetPassword(input: ResetPasswordInput) {
    const invalidToken = new AuthServiceError(
      AuthErrorCode.INVALID_RESET_TOKEN,
      AUTH_MESSAGES.INVALID_RESET_TOKEN,
      HTTP_STATUS.BAD_REQUEST,
    );

    const now = new Date();

    const storedToken = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash: hashRefreshToken(input.token),
        usedAt: null,
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        userId: true,
        user: { select: { status: true } },
      },
    });

    if (!storedToken || storedToken.user.status !== UserStatus.ACTIVE) {
      throw invalidToken;
    }

    const passwordHash = await hashPassword(input.newPassword);

    await prisma.$transaction(async (tx) => {
      // Guarded update ensures the token can only be consumed once.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: storedToken.id, usedAt: null },
        data: { usedAt: now },
      });

      if (consumed.count !== 1) {
        throw invalidToken;
      }

      await tx.user.update({
        where: { id: storedToken.userId },
        data: { passwordHash },
      });

      await tx.refreshToken.updateMany({
        where: { userId: storedToken.userId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  }
}

export const authService = new AuthService();
