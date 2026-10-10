
import type { FastifyInstance } from "fastify";
import {
  createBranchController,
  getBranchController,
  listBranchesController,
  updateBranchController,
  deleteBranchController,
} from "./controller.js";

export async function branchRoutes(app: FastifyInstance) {
  app.post("/api/v1/branches", createBranchController);

  app.get("/api/v1/branches", listBranchesController);
  app.get("/api/v1/branches/:id", getBranchController);

  app.put("/api/v1/branches/:id", updateBranchController);
  app.delete("/api/v1/branches/:id", deleteBranchController);
}