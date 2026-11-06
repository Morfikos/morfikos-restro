import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import { listRolesController, getRoleController } from "./controller.js";

type RoleRoute = { Params: { role: string } };

/**
 * Registers the role and permission API routes.
 *
 * @param app - Fastify application instance.
 */
export async function roleRoutes(app: FastifyInstance) {
  /**
   * Lists roles, their permissions and the permission matrix.
   * GET /api/v1/roles
   */
  app.get("/api/v1/roles", { preHandler: authenticate }, listRolesController);

  /**
   * Retrieves one role (owner, manager, waiter or staff).
   * GET /api/v1/roles/:role
   */
  app.get<RoleRoute>("/api/v1/roles/:role", { preHandler: authenticate }, getRoleController);
}
