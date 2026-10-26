import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  createCategoryController,
  listCategoriesController,
  updateCategoryController,
  deleteCategoryController,
  createCuisineController,
  listCuisinesController,
  updateCuisineController,
  deleteCuisineController,
  createMenuItemController,
  listMenuItemsController,
  getMenuItemController,
  updateMenuItemController,
  upsertBranchMenuItemController,
  getPublicMenuController,
} from "./controller.js";

type MenuIdRoute = { Params: { id: string } };
type BranchMenuItemRoute = { Params: { branchId: string; itemId: string } };
type PublicMenuRoute = { Params: { qrCode: string } };

/**
 * Registers all menu-related API routes (categories, cuisines, menu items
 * and the public QR menu).
 *
 * @param app - Fastify application instance.
 */
export async function menuRoutes(app: FastifyInstance) {
  /**
   * Creates a new menu category.
   * POST /api/v1/menu/categories
   */
  app.post("/api/v1/menu/categories", { preHandler: authenticate }, createCategoryController);

  /**
   * Retrieves a list of menu categories.
   * GET /api/v1/menu/categories
   */
  app.get("/api/v1/menu/categories", { preHandler: authenticate }, listCategoriesController);

  /**
   * Updates an existing menu category by its ID.
   * PUT /api/v1/menu/categories/:id
   */
  app.put<MenuIdRoute>("/api/v1/menu/categories/:id", { preHandler: authenticate }, updateCategoryController);

  /**
   * Deactivates a menu category by its ID.
   * DELETE /api/v1/menu/categories/:id
   */
  app.delete<MenuIdRoute>("/api/v1/menu/categories/:id", { preHandler: authenticate }, deleteCategoryController);

  /**
   * Creates a new cuisine.
   * POST /api/v1/menu/cuisines
   */
  app.post("/api/v1/menu/cuisines", { preHandler: authenticate }, createCuisineController);

  /**
   * Retrieves a list of cuisines.
   * GET /api/v1/menu/cuisines
   */
  app.get("/api/v1/menu/cuisines", { preHandler: authenticate }, listCuisinesController);

  /**
   * Updates an existing cuisine by its ID.
   * PUT /api/v1/menu/cuisines/:id
   */
  app.put<MenuIdRoute>("/api/v1/menu/cuisines/:id", { preHandler: authenticate }, updateCuisineController);

  /**
   * Deactivates a cuisine by its ID.
   * DELETE /api/v1/menu/cuisines/:id
   */
  app.delete<MenuIdRoute>("/api/v1/menu/cuisines/:id", { preHandler: authenticate }, deleteCuisineController);

  /**
   * Creates a new menu item.
   * POST /api/v1/menu/items
   */
  app.post("/api/v1/menu/items", { preHandler: authenticate }, createMenuItemController);

  /**
   * Retrieves a list of menu items, optionally with a branch's prices.
   * GET /api/v1/menu/items?branchId=&categoryId=&isActive=&limit=&offset=
   */
  app.get("/api/v1/menu/items", { preHandler: authenticate }, listMenuItemsController);

  /**
   * Retrieves a menu item with its branch prices.
   * GET /api/v1/menu/items/:id
   */
  app.get<MenuIdRoute>("/api/v1/menu/items/:id", { preHandler: authenticate }, getMenuItemController);

  /**
   * Updates an existing menu item by its ID.
   * PUT /api/v1/menu/items/:id
   */
  app.put<MenuIdRoute>("/api/v1/menu/items/:id", { preHandler: authenticate }, updateMenuItemController);

  /**
   * Sets a menu item's price and availability for a branch.
   * PUT /api/v1/branches/:branchId/menu-items/:itemId
   */
  app.put<BranchMenuItemRoute>(
    "/api/v1/branches/:branchId/menu-items/:itemId",
    { preHandler: authenticate },
    upsertBranchMenuItemController,
  );

  /**
   * Retrieves the guest menu for a table QR code. Public, no login.
   * GET /api/v1/public/t/:qrCode/menu
   */
  app.get<PublicMenuRoute>("/api/v1/public/t/:qrCode/menu", getPublicMenuController);
}
