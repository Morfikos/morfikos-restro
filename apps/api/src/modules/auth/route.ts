import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  changePasswordController,
  forgotPasswordController,
  getCurrentUserController,
  loginController,
  logoutController,
  refreshController,
  resetPasswordController,
  signupController,
  staffSignupController,
} from "./controller.js";

/**
 * Registers all auth routes. Mounted under /api/v1/auth in app.ts.
 *
 * @param app - Fastify application instance.
 */
export async function authRoutes(app: FastifyInstance) {
  /** POST /api/v1/auth/signup: register a restaurant owner. */
  app.post("/signup", signupController);

  /** POST /api/v1/auth/signup/staff: owner/manager creates a staff account. */
  app.post("/signup/staff", { preHandler: authenticate }, staffSignupController);

  /** POST /api/v1/auth/login: log in with email and password. */
  app.post("/login", loginController);

  /** POST /api/v1/auth/refresh: rotate the refresh token. */
  app.post("/refresh", refreshController);

  /** POST /api/v1/auth/forgot-password: email a password reset link. */
  app.post("/forgot-password", forgotPasswordController);

  /** POST /api/v1/auth/reset-password: set a new password with a reset token. */
  app.post("/reset-password", resetPasswordController);

  /** GET /api/v1/auth/me: current user profile. */
  app.get("/me", { preHandler: authenticate }, getCurrentUserController);

  /** POST /api/v1/auth/logout: revoke the session. */
  app.post("/logout", { preHandler: authenticate }, logoutController);

  /** POST /api/v1/auth/change-password: change the account password. */
  app.post("/change-password", { preHandler: authenticate }, changePasswordController);
}
