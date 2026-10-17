import type { FastifyBaseLogger } from "fastify";

/**
 * Details required to send a password reset email.
 */
export interface PasswordResetEmail {
  to: string;
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}

/**
 * Sends a password reset email.
 *
 * Stub implementation: no email provider is configured yet, so the reset
 * link is written to the server log outside production. Replace this body
 * with a real provider (SES, SendGrid, Resend, etc.).
 *
 * @param logger - Logger used to record the delivery.
 * @param email - Recipient and reset-link details.
 */
export async function sendPasswordResetEmail(
  logger: FastifyBaseLogger,
  email: PasswordResetEmail,
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    logger.warn(
      { to: email.to },
      "Password reset requested but no email provider is configured",
    );
    return;
  }

  logger.info(
    { to: email.to, resetUrl: email.resetUrl, expiresInMinutes: email.expiresInMinutes },
    "Password reset email (stub)",
  );
}
