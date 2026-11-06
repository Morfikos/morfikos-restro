import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  listUsersController,
  createUserController,
  getUserController,
  updateUserController,
  updateUserRoleController,
  updateUserBranchesController,
  deactivateUserController,
  activateUserController,
  resetUserPasswordController,
  setUserPinController,
  clearUserPinController,
} from "./controller.js";

type UserRoute = { Params: { userId: string } };

/**
 * Registers the staff (user) management API routes. Owners and managers only.
 *
 * @param app - Fastify application instance.
 */
export async function userRoutes(app: FastifyInstance) {
  const auth = { preHandler: authenticate };

  /**
   * Lists staff.
   * GET /api/v1/users?branchId=&role=&status=&search=&limit=&offset=
   */
  app.get("/api/v1/users", auth, listUsersController);

  /**
   * Creates a staff account.
   * POST /api/v1/users
   */
  app.post("/api/v1/users", auth, createUserController);

  /**
   * Retrieves a staff member.
   * GET /api/v1/users/:userId
   */
  app.get<UserRoute>("/api/v1/users/:userId", auth, getUserController);

  /**
   * Edits name, email, phone, staff code or discount limit.
   * PUT /api/v1/users/:userId
   */
  app.put<UserRoute>("/api/v1/users/:userId", auth, updateUserController);

  /**
   * Changes the role.
   * PUT /api/v1/users/:userId/role
   */
  app.put<UserRoute>("/api/v1/users/:userId/role", auth, updateUserRoleController);

  /**
   * Replaces branch access.
   * PUT /api/v1/users/:userId/branches
   */
  app.put<UserRoute>("/api/v1/users/:userId/branches", auth, updateUserBranchesController);

  /**
   * Deactivates a staff member.
   * POST /api/v1/users/:userId/deactivate
   */
  app.post<UserRoute>("/api/v1/users/:userId/deactivate", auth, deactivateUserController);

  /**
   * Reactivates a staff member.
   * POST /api/v1/users/:userId/activate
   */
  app.post<UserRoute>("/api/v1/users/:userId/activate", auth, activateUserController);

  /**
   * Sets a new password and signs the staff member out.
   * POST /api/v1/users/:userId/reset-password
   */
  app.post<UserRoute>("/api/v1/users/:userId/reset-password", auth, resetUserPasswordController);

  /**
   * Sets the staff member's PIN.
   * PUT /api/v1/users/:userId/pin
   */
  app.put<UserRoute>("/api/v1/users/:userId/pin", auth, setUserPinController);

  /**
   * Removes the staff member's PIN.
   * DELETE /api/v1/users/:userId/pin
   */
  app.delete<UserRoute>("/api/v1/users/:userId/pin", auth, clearUserPinController);
}
