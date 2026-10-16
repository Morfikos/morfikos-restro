// import { prisma } from "@morfikos/database";
// import {
//   verifyPassword,
//   createAccessToken,
//   generateRefreshToken,
//   hashRefreshToken,
// } from "@morfikos/auth";

// const REFRESH_TOKEN_EXPIRY_DAYS = 7;

// export class AuthService {
//   /**
//    * Authenticates a user using their email and password.
//    * Updates the user's last login time and issues access
//    * and refresh tokens.
//    *
//    * @param email - User's email address.
//    * @param password - User's plain-text password.
//    * @returns User details and authentication tokens.
//    * @throws Error when credentials are invalid or the user is inactive.
//    */
//   async login(email: string, password: string) {
//     const normalizedEmail = email.trim().toLowerCase();

//     const user = await prisma.user.findUnique({
//       where: { email: normalizedEmail },
//     });

//     if (!user || user.status !== "active") {
//       throw new Error("Invalid email or password");
//     }

//     const isPasswordValid = await verifyPassword(
//       password,
//       user.passwordHash,
//     );

//     if (!isPasswordValid) {
//       throw new Error("Invalid email or password");
//     }

//     const accessToken = await createAccessToken({
//       sub: user.id,
//       role: user.role,
//       organizationIds: [],
//       branchIds: [],
//     });

//     const refreshToken = generateRefreshToken();

//     const expiresAt = new Date(
//       Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
//     );

//     await prisma.$transaction([
//       prisma.user.update({
//         where: { id: user.id },
//         data: { lastLoginAt: new Date() },
//       }),
//       prisma.refreshToken.create({
//         data: {
//           userId: user.id,
//           tokenHash: hashRefreshToken(refreshToken),
//           expiresAt,
//         },
//       }),
//     ]);

//     return {
//       user: {
//         id: user.id,
//         name: user.name,
//         email: user.email,
//       },
//       accessToken,
//       refreshToken,
//     };
//   }

//   /**
//    * Validates and rotates a refresh token.
//    * Revokes the old token and issues a new token pair.
//    *
//    * @param refreshToken - Existing opaque refresh token.
//    * @returns A new access token and refresh token.
//    * @throws Error when the token is invalid or the user is inactive.
//    */
//   async refresh(refreshToken: string) {
//     const tokenHash = hashRefreshToken(refreshToken);

//     const storedToken = await prisma.refreshToken.findFirst({
//       where: {
//         tokenHash,
//         revokedAt: null,
//         expiresAt: { gt: new Date() },
//       },
//     });

//     if (!storedToken) {
//       throw new Error("Invalid refresh token");
//     }

//     const user = await prisma.user.findUnique({
//       where: { id: storedToken.userId },
//     });

//     if (!user || user.status !== "active") {
//       throw new Error("Invalid refresh token");
//     }

//     const accessToken = await createAccessToken({
//       sub: user.id,
//       role: user.role,
//       organizationIds: [],
//       branchIds: [],
//     });

//     const newRefreshToken = generateRefreshToken();

//     const expiresAt = new Date(
//       Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
//     );

//     await prisma.$transaction(async (tx) => {
//       const revokeResult = await tx.refreshToken.updateMany({
//         where: {
//           id: storedToken.id,
//           revokedAt: null,
//           expiresAt: { gt: new Date() },
//         },
//         data: { revokedAt: new Date() },
//       });

//       if (revokeResult.count !== 1) {
//         throw new Error("Invalid refresh token");
//       }

//       await tx.refreshToken.create({
//         data: {
//           userId: user.id,
//           tokenHash: hashRefreshToken(newRefreshToken),
//           expiresAt,
//         },
//       });
//     });

//     return {
//       accessToken,
//       refreshToken: newRefreshToken,
//     };
//   }

//   /**
//    * Revokes an active refresh token to log out the user.
//    *
//    * @param refreshToken - Refresh token to revoke.
//    * @returns A success status.
//    */
//   async logout(refreshToken: string) {
//     const tokenHash = hashRefreshToken(refreshToken);

//     await prisma.refreshToken.updateMany({
//       where: {
//         tokenHash,
//         revokedAt: null,
//       },
//       data: {
//         revokedAt: new Date(),
//       },
//     });

//     return { success: true };
//   }
// }

// export const authService = new AuthService();


import { prisma } from "@morfikos/database";
import {
  verifyPassword,
  createAccessToken,
  generateRefreshToken,
  hashRefreshToken,
    hashPassword,
} from "@morfikos/auth";

const ACCESS_TOKEN_EXPIRY_SECONDS = 3600;
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

type AccessContext = {
  organizationIds: string[];
  branchIds: string[];
  organizations: Array<{
    id: string;
    name: string;
    role: string;
  }>;
};

/**
 * Resolves a user's active organization memberships and branch access.
 *
 * A branch-role assignment with a null branchId applies to every active
 * branch in that organization. Branch-specific assignments grant access
 * only to the assigned active branch.
 */
async function getAccessContext(
  userId: string,
): Promise<AccessContext> {
  const memberships = await prisma.membership.findMany({
    where: {
      userId,
      status: "active",
      organization: {
        status: "active",
      },
    },
    select: {
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          branches: {
            where: {
              status: "active",
            },
            select: {
              id: true,
            },
          },
        },
      },
      branchRoles: {
        select: {
          branchId: true,
          role: {
            select: {
              name: true,
            },
          },
          branch: {
            select: {
              id: true,
              status: true,
              organizationId: true,
            },
          },
        },
      },
    },
  });

  const branchIds = new Set<string>();

  const organizations = memberships.map((membership) => {
    const validAssignments = membership.branchRoles.filter(
      (assignment) => {
        // A null branchId means the role applies organization-wide.
        if (assignment.branchId === null) {
          return true;
        }

        // Ignore inactive branches and branches from another organization.
        return (
          assignment.branch !== null &&
          assignment.branch.status === "active" &&
          assignment.branch.organizationId === membership.organizationId
        );
      },
    );

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
 * Authenticates a user and issues an access token and refresh token.
 *
 * @param email - User's email address.
 * @param password - User's plain-text password.
 * @returns Tokens and the user's organization and branch access.
 * @throws Error when credentials are invalid or the user is inactive.
 */
export class AuthService {
  async login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || user.status !== "active") {
      throw new Error("Invalid email or password");
    }

    const isPasswordValid = await verifyPassword(
      password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new Error("Invalid email or password");
    }

    const accessContext = await getAccessContext(user.id);

    const accessToken = await createAccessToken({
      sub: user.id,
      // Retain the existing user role claim for compatibility.
      role: user.role,
      organizationIds: accessContext.organizationIds,
      branchIds: accessContext.branchIds,
    });

    const refreshToken = generateRefreshToken();

    const refreshExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRefreshToken(refreshToken),
          expiresAt: refreshExpiresAt,
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
   * Rotates a refresh token and recalculates current access.
   *
   * @param refreshToken - Existing opaque refresh token.
   * @returns A new token pair and access-token expiry.
   * @throws Error when the token is invalid or the user is inactive.
   */
  async refresh(refreshToken: string) {
    const tokenHash = hashRefreshToken(refreshToken);

    const storedToken = await prisma.refreshToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!storedToken) {
      throw new Error("Invalid refresh token");
    }

    const user = await prisma.user.findUnique({
      where: { id: storedToken.userId },
    });

    if (!user || user.status !== "active") {
      throw new Error("Invalid refresh token");
    }

    // Recalculate access so revoked memberships or branch assignments
    // are not carried forward into a newly issued access token.
    const accessContext = await getAccessContext(user.id);

    const accessToken = await createAccessToken({
      sub: user.id,
      role: user.role,
      organizationIds: accessContext.organizationIds,
      branchIds: accessContext.branchIds,
    });

    const newRefreshToken = generateRefreshToken();

    const refreshExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

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
        throw new Error("Invalid refresh token");
      }

      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRefreshToken(newRefreshToken),
          expiresAt: refreshExpiresAt,
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
   * Changes the authenticated user's password and revokes their
   * active refresh tokens.
   *
   * @param userId - ID of the authenticated user.
   * @param currentPassword - The user's current password.
   * @param newPassword - The requested new password.
   * @returns A confirmation message.
   * @throws Error if the user is inactive or the current password is invalid.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.status !== "active") {
      throw new Error("User not found or inactive");
    }

    const isPasswordValid = await verifyPassword(
      currentPassword,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new Error("Current password is incorrect");
    }

    if (currentPassword === newPassword) {
      throw new Error(
        "New password must be different from the current password",
      );
    }

    const passwordHash = await hashPassword(newPassword);
    const now = new Date();

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
      prisma.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      }),
    ]);

    return {
      success: true,
      message: "Password changed successfully. Please log in again.",
    };
  }


  /**
   * Revokes an active refresh token.
   *
   * @param refreshToken - Refresh token to revoke.
   * @returns A success status.
   */
  async logout(refreshToken: string) {
    const tokenHash = hashRefreshToken(refreshToken);

    await prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return { success: true };
  }
}

export const authService = new AuthService();
