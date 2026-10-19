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
} from "./controller.js";

type MenuIdRoute = { Params: { id: string } };

/**
 * Registers all menu-related API routes (categories and cuisines).
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
}
