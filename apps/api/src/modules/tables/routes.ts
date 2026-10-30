import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  createTableController,
  listTablesController,
  getTableController,
  updateTableController,
  deleteTableController,
  regenerateTableQrController,
} from "./controller.js";

type TableIdRoute = { Params: { id: string } };

/**
 * Registers all table-related API routes.
 *
 * @param app - Fastify application instance.
 */
export async function tableRoutes(app: FastifyInstance) {
  /**
   * Creates a new table.
   * POST /api/v1/tables
   */
  app.post("/api/v1/tables", { preHandler: authenticate }, createTableController);

  /**
   * Retrieves a branch's tables with their live status.
   * GET /api/v1/tables?branchId=&status=&floorId=&isActive=&limit=&offset=
   */
  app.get("/api/v1/tables", { preHandler: authenticate }, listTablesController);

  /**
   * Retrieves a specific table by its ID.
   * GET /api/v1/tables/:id
   */
  app.get<TableIdRoute>("/api/v1/tables/:id", { preHandler: authenticate }, getTableController);

  /**
   * Updates an existing table by its ID.
   * PUT /api/v1/tables/:id
   */
  app.put<TableIdRoute>("/api/v1/tables/:id", { preHandler: authenticate }, updateTableController);

  /**
   * Deactivates a table by its ID.
   * DELETE /api/v1/tables/:id
   */
  app.delete<TableIdRoute>("/api/v1/tables/:id", { preHandler: authenticate }, deleteTableController);

  /**
   * Regenerates a table's QR code.
   * POST /api/v1/tables/:id/regenerate-qr
   */
  app.post<TableIdRoute>(
    "/api/v1/tables/:id/regenerate-qr",
    { preHandler: authenticate },
    regenerateTableQrController,
  );
}
