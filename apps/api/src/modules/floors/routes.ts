import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  createFloorController,
  listFloorsController,
  getFloorController,
  updateFloorController,
  deleteFloorController,
  uploadFloorBackgroundController,
  removeFloorBackgroundController,
  getFloorLayoutController,
  saveFloorLayoutController,
  createLayoutImportController,
  getLayoutImportController,
  applyLayoutImportController,
  discardLayoutImportController,
} from "./controller.js";

type FloorIdRoute = { Params: { id: string } };
type LayoutImportRoute = { Params: { importId: string } };

/**
 * Registers floor, floor map and photo-import API routes.
 *
 * @param app - Fastify application instance.
 */
export async function floorRoutes(app: FastifyInstance) {
  /**
   * Creates a new floor.
   * POST /api/v1/floors
   */
  app.post("/api/v1/floors", { preHandler: authenticate }, createFloorController);

  /**
   * Retrieves a branch's floors.
   * GET /api/v1/floors?branchId=&isActive=
   */
  app.get("/api/v1/floors", { preHandler: authenticate }, listFloorsController);

  /**
   * Retrieves a specific floor by its ID.
   * GET /api/v1/floors/:id
   */
  app.get<FloorIdRoute>("/api/v1/floors/:id", { preHandler: authenticate }, getFloorController);

  /**
   * Updates an existing floor by its ID.
   * PUT /api/v1/floors/:id
   */
  app.put<FloorIdRoute>("/api/v1/floors/:id", { preHandler: authenticate }, updateFloorController);

  /**
   * Deactivates a floor by its ID.
   * DELETE /api/v1/floors/:id
   */
  app.delete<FloorIdRoute>("/api/v1/floors/:id", { preHandler: authenticate }, deleteFloorController);

  /**
   * Uploads the floor's background photo (multipart/form-data).
   * POST /api/v1/floors/:id/background
   */
  app.post<FloorIdRoute>(
    "/api/v1/floors/:id/background",
    { preHandler: authenticate },
    uploadFloorBackgroundController,
  );

  /**
   * Removes the floor's background photo.
   * DELETE /api/v1/floors/:id/background
   */
  app.delete<FloorIdRoute>(
    "/api/v1/floors/:id/background",
    { preHandler: authenticate },
    removeFloorBackgroundController,
  );

  /**
   * Retrieves the floor map with live table status.
   * GET /api/v1/floors/:id/layout
   */
  app.get<FloorIdRoute>(
    "/api/v1/floors/:id/layout",
    { preHandler: authenticate },
    getFloorLayoutController,
  );

  /**
   * Saves the floor map editor.
   * PUT /api/v1/floors/:id/layout
   */
  app.put<FloorIdRoute>(
    "/api/v1/floors/:id/layout",
    { preHandler: authenticate },
    saveFloorLayoutController,
  );

  /**
   * Starts a photo → floor map import (multipart/form-data).
   * POST /api/v1/floors/:id/layout-imports
   */
  app.post<FloorIdRoute>(
    "/api/v1/floors/:id/layout-imports",
    { preHandler: authenticate },
    createLayoutImportController,
  );

  /**
   * Retrieves a photo import's status and proposed layout.
   * GET /api/v1/layout-imports/:importId
   */
  app.get<LayoutImportRoute>(
    "/api/v1/layout-imports/:importId",
    { preHandler: authenticate },
    getLayoutImportController,
  );

  /**
   * Applies a reviewed photo import to its floor.
   * POST /api/v1/layout-imports/:importId/apply
   */
  app.post<LayoutImportRoute>(
    "/api/v1/layout-imports/:importId/apply",
    { preHandler: authenticate },
    applyLayoutImportController,
  );

  /**
   * Discards a photo import.
   * DELETE /api/v1/layout-imports/:importId
   */
  app.delete<LayoutImportRoute>(
    "/api/v1/layout-imports/:importId",
    { preHandler: authenticate },
    discardLayoutImportController,
  );
}
