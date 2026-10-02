import { createHash, randomBytes } from "crypto";

import { createPrismaClient } from "@morfikos/database";

import {
  hashPassword,
  verifyPassword,
  createAccessToken,
  generateRefreshToken,
} from "@morfikos/auth";

import type {
  SignupRequest,
  LoginRequest,
  ChangePasswordRequest,
} from "@morfikos/types";

const prisma = createPrismaClient();

/**
 * Signup
 */
export async function signup(
  data: SignupRequest
) {
  const email = data.email
    .toLowerCase()
    .trim();

  const name = data.name.trim();

  // Check whether user already exists
  const existingUser =
    await prisma.user.findUnique({
      where: {
        email,
      },
    });

  if (existingUser) {
    return {
      success: false,
      message:
        "User with this email already exists",
    };
  }

  // Hash password using Argon2id
  const passwordHash =
    await hashPassword(data.password);

  // Create user in PostgreSQL
  const newUser =
    await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        role: "USER",
      },
    });

  return {
    success: true,
    message:
      "User registered successfully",

    user: {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      createdAt:
        newUser.createdAt.toISOString(),
      updatedAt:
        newUser.updatedAt.toISOString(),
    },
  };
}

/**
 * Get Users
 */
export async function getUsers() {
  const users =
    await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

  return users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt:
      user.createdAt.toISOString(),
    updatedAt:
      user.updatedAt.toISOString(),
  }));
}

/**
 * Login
 */
export async function login(
  data: LoginRequest
) {
  const email = data.email
    .toLowerCase()
    .trim();

  // Find user in PostgreSQL
  const user =
    await prisma.user.findUnique({
      where: {
        email,
      },
    });

  if (!user) {
    return {
      success: false,
      message:
        "Invalid email or password",
    };
  }

  // Verify password using Argon2id
  const passwordValid =
    await verifyPassword(
      data.password,
      user.passwordHash
    );

  if (!passwordValid) {
    return {
      success: false,
      message:
        "Invalid email or password",
    };
  }

  // Create short-lived access token
  const accessToken =
    await createAccessToken({
      userId: user.id,
      role: user.role,
    });

  // Generate refresh token
  const refreshToken =
    generateRefreshToken();

  // Store only the hash of refresh token
  const refreshTokenHash =
    createHash("sha256")
      .update(refreshToken)
      .digest("hex");

  // Refresh token expires in 7 days
  const refreshTokenExpiresAt =
    new Date(
      Date.now() +
        7 * 24 * 60 * 60 * 1000
    );

  // Save refresh token in PostgreSQL
  await prisma.refreshToken.create({
    data: {
      tokenHash: refreshTokenHash,
      userId: user.id,
      expiresAt: refreshTokenExpiresAt,
    },
  });

  // Create database session
  const sessionExpiresAt =
    new Date(
      Date.now() +
        7 * 24 * 60 * 60 * 1000
    );

  await prisma.session.create({
    data: {
      userId: user.id,
      device: data.device ?? null,
      expiresAt: sessionExpiresAt,
    },
  });

  return {
    success: true,
    message: "Login successful",

    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },

    accessToken,
    refreshToken,
  };
}

/**
 * Change Password
 */
export async function changePassword(
  data: ChangePasswordRequest
) {
  const email = data.email
    .toLowerCase()
    .trim();

  // Find user
  const user =
    await prisma.user.findUnique({
      where: {
        email,
      },
    });

  if (!user) {
    return {
      success: false,
      message: "User not found",
    };
  }

  // Verify current password
  const currentPasswordValid =
    await verifyPassword(
      data.currentPassword,
      user.passwordHash
    );

  if (!currentPasswordValid) {
    return {
      success: false,
      message:
        "Current password is incorrect",
    };
  }

  // Hash new password
  const newPasswordHash =
    await hashPassword(
      data.newPassword
    );

  // Update password in PostgreSQL
  await prisma.user.update({
    where: {
      id: user.id,
    },
    data: {
      passwordHash:
        newPasswordHash,
    },
  });

  return {
    success: true,
    message:
      "Password changed successfully",
  };
}

/**
 * Forgot Password
 *
 * Creates a password reset token,
 * stores only its hash in PostgreSQL,
 * and returns the raw token temporarily
 * for API testing.
 */
export async function forgotPassword(
  email: string
) {
  const normalizedEmail =
    email.toLowerCase().trim();

  // Find user
  const user =
    await prisma.user.findUnique({
      where: {
        email: normalizedEmail,
      },
    });

  if (!user) {
    return {
      success: false,
      message: "User not found",
    };
  }

  // Generate secure random token
  const resetToken =
    randomBytes(32).toString("hex");

  // Hash token before storing it
  const tokenHash =
    createHash("sha256")
      .update(resetToken)
      .digest("hex");

  // Password reset token expires in 15 minutes
  const expiresAt =
    new Date(
      Date.now() + 15 * 60 * 1000
    );

  // Store hashed token in PostgreSQL
  await prisma.passwordResetToken.create({
    data: {
      tokenHash,
      userId: user.id,
      expiresAt,
    },
  });

  return {
    success: true,
    message:
      "Password reset token generated successfully",

    // Temporary for Bruno/API testing.
    // Later this should be sent through email
    // instead of being returned in the API response.
    resetToken,
  };
}

/**
 * Reset Password
 */
export async function resetPassword(
  token: string,
  newPassword: string
) {
  // Hash the token received from the client
  const tokenHash =
    createHash("sha256")
      .update(token)
      .digest("hex");

  // Find the reset token in PostgreSQL
  const resetToken =
    await prisma.passwordResetToken.findUnique({
      where: {
        tokenHash,
      },
    });

  if (!resetToken) {
    return {
      success: false,
      message: "Invalid reset token",
    };
  }

  // Check whether token has already been used
  if (resetToken.usedAt) {
    return {
      success: false,
      message: "Reset token has already been used",
    };
  }

  // Check whether token has expired
  if (resetToken.expiresAt < new Date()) {
    return {
      success: false,
      message: "Reset token has expired",
    };
  }

  // Hash the new password using Argon2id
  const passwordHash =
    await hashPassword(newPassword);

  // Update password and mark token as used
  await prisma.$transaction([
    prisma.user.update({
      where: {
        id: resetToken.userId,
      },
      data: {
        passwordHash,
      },
    }),

    prisma.passwordResetToken.update({
      where: {
        id: resetToken.id,
      },
      data: {
        usedAt: new Date(),
      },
    }),
  ]);

  return {
    success: true,
    message: "Password reset successfully",
  };
}