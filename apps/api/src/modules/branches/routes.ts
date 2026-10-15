
import type { FastifyInstance } from "fastify";
import {
  createBranchController,
  getBranchController,
  listBranchesController,
  updateBranchController,
  deleteBranchController,
} from "./controller.js";

/**
 * Registers all branch-related API routes.
 *
 * @param app - Fastify application instance.
 */
export async function branchRoutes(app: FastifyInstance) {
  /**
   * Creates a new branch.
   * POST /api/v1/branches
   */
  app.post("/api/v1/branches", createBranchController);

  /**
   * Retrieves a list of branches.
   * GET /api/v1/branches
   */
  app.get("/api/v1/branches", listBranchesController);

  /**
   * Retrieves a specific branch by its ID.
   * GET /api/v1/branches/:id
   */
  app.get("/api/v1/branches/:id", getBranchController);

  /**
   * Updates an existing branch by its ID.
   * PUT /api/v1/branches/:id
   */
  app.put("/api/v1/branches/:id", updateBranchController);

  /**
   * Deletes a branch by its ID.
   * DELETE /api/v1/branches/:id
   */
  app.delete("/api/v1/branches/:id", deleteBranchController);
}