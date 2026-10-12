
import { prisma } from "@morfikos/database";
import {
  verifyPassword,
  createAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from "@morfikos/auth";

export class AuthService {
  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
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

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      id: user.id,
      name: user.name,
      email: user.email,
    };
  }

  async refresh(refreshToken: string) {
    // Refresh tokens are opaque strings, not JWTs.
    // Verify them against the hash stored in the database.
    const storedToken = await prisma.refreshToken.findFirst({
      where: {
        tokenHash: hashRefreshToken(refreshToken),
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

    const accessToken = await createAccessToken({
      sub: user.id,
      role: user.role,
      organizationIds: [],
      branchIds: [],
    });

    // Issue a new opaque refresh token.
    const newRefreshToken = generateRefreshToken();

    // Rotate refresh tokens: revoke the old one and store the new hash.
    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRefreshToken(newRefreshToken),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      }),
    ]);

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }
  
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
