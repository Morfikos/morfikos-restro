import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  createInventoryItemController,
  listInventoryItemsController,
  getInventoryItemController,
  updateInventoryItemController,
  deleteInventoryItemController,
  updateBranchStockController,
  createSupplierController,
  listSuppliersController,
  updateSupplierController,
  createPurchaseController,
  listPurchasesController,
  getPurchaseController,
  recordWastageController,
  createStockCountController,
  listStockCountsController,
  getStockCountController,
  adjustStockController,
  listStockMovementsController,
  saveRecipeController,
  getRecipeController,
  deleteRecipeController,
  listRecipesController,
  getInventorySettingsController,
  updateInventorySettingsController,
  listAuto86Controller,
  listStockAlertsController,
  acknowledgeStockAlertController,
  foodCostReportController,
  varianceReportController,
  stockValuationController,
} from "./controller.js";

type ItemRoute = { Params: { itemId: string } };
type BranchRoute = { Params: { branchId: string } };
type BranchItemRoute = { Params: { branchId: string; itemId: string } };
type SupplierRoute = { Params: { supplierId: string } };
type PurchaseRoute = { Params: { branchId: string; purchaseId: string } };
type StockCountRoute = { Params: { branchId: string; countId: string } };
type RecipeRoute = { Params: { menuItemId: string } };
type AlertRoute = { Params: { alertId: string } };

const BRANCH_INVENTORY = "/api/v1/branches/:branchId/inventory";

/**
 * Registers the inventory, recipe, stock and inventory report API routes.
 *
 * @param app - Fastify application instance.
 */
export async function inventoryRoutes(app: FastifyInstance) {
  const auth = { preHandler: authenticate };

  // ─── Inventory items ──────────────────────────────────────────────────

  /**
   * Creates an ingredient with optional opening stock per branch.
   * POST /api/v1/inventory/items
   */
  app.post("/api/v1/inventory/items", auth, createInventoryItemController);

  /**
   * Lists ingredients with their stock at a branch.
   * GET /api/v1/inventory/items?branchId=&category=&status=&search=&includeInactive=&limit=&offset=
   */
  app.get("/api/v1/inventory/items", auth, listInventoryItemsController);

  /**
   * Retrieves an ingredient with stock, recipes and recent movements.
   * GET /api/v1/inventory/items/:itemId?branchId=
   */
  app.get<ItemRoute>("/api/v1/inventory/items/:itemId", auth, getInventoryItemController);

  /**
   * Updates an ingredient.
   * PUT /api/v1/inventory/items/:itemId
   */
  app.put<ItemRoute>("/api/v1/inventory/items/:itemId", auth, updateInventoryItemController);

  /**
   * Deactivates an ingredient.
   * DELETE /api/v1/inventory/items/:itemId?force=
   */
  app.delete<ItemRoute>("/api/v1/inventory/items/:itemId", auth, deleteInventoryItemController);

  /**
   * Sets an ingredient's low-stock level at a branch.
   * PUT /api/v1/branches/:branchId/inventory/items/:itemId
   */
  app.put<BranchItemRoute>(`${BRANCH_INVENTORY}/items/:itemId`, auth, updateBranchStockController);

  // ─── Suppliers ────────────────────────────────────────────────────────

  /**
   * Creates a supplier.
   * POST /api/v1/inventory/suppliers
   */
  app.post("/api/v1/inventory/suppliers", auth, createSupplierController);

  /**
   * Lists suppliers.
   * GET /api/v1/inventory/suppliers?search=&includeInactive=&limit=&offset=
   */
  app.get("/api/v1/inventory/suppliers", auth, listSuppliersController);

  /**
   * Updates (or deactivates) a supplier.
   * PUT /api/v1/inventory/suppliers/:supplierId
   */
  app.put<SupplierRoute>("/api/v1/inventory/suppliers/:supplierId", auth, updateSupplierController);

  // ─── Stock in and out ─────────────────────────────────────────────────

  /**
   * Records goods received.
   * POST /api/v1/branches/:branchId/inventory/purchases
   */
  app.post<BranchRoute>(`${BRANCH_INVENTORY}/purchases`, auth, createPurchaseController);

  /**
   * Lists purchases.
   * GET /api/v1/branches/:branchId/inventory/purchases?supplierId=&from=&to=&limit=&offset=
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/purchases`, auth, listPurchasesController);

  /**
   * Retrieves a purchase.
   * GET /api/v1/branches/:branchId/inventory/purchases/:purchaseId
   */
  app.get<PurchaseRoute>(`${BRANCH_INVENTORY}/purchases/:purchaseId`, auth, getPurchaseController);

  /**
   * Records wasted stock.
   * POST /api/v1/branches/:branchId/inventory/wastage
   */
  app.post<BranchRoute>(`${BRANCH_INVENTORY}/wastage`, auth, recordWastageController);

  /**
   * Saves a physical stock count.
   * POST /api/v1/branches/:branchId/inventory/stock-counts
   */
  app.post<BranchRoute>(`${BRANCH_INVENTORY}/stock-counts`, auth, createStockCountController);

  /**
   * Lists stock counts.
   * GET /api/v1/branches/:branchId/inventory/stock-counts?from=&to=&limit=&offset=
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/stock-counts`, auth, listStockCountsController);

  /**
   * Retrieves a stock count.
   * GET /api/v1/branches/:branchId/inventory/stock-counts/:countId
   */
  app.get<StockCountRoute>(`${BRANCH_INVENTORY}/stock-counts/:countId`, auth, getStockCountController);

  /**
   * Corrects one item's stock (manager PIN).
   * POST /api/v1/branches/:branchId/inventory/adjustments
   */
  app.post<BranchRoute>(`${BRANCH_INVENTORY}/adjustments`, auth, adjustStockController);

  /**
   * Lists the stock ledger.
   * GET /api/v1/branches/:branchId/inventory/movements?itemId=&type=&from=&to=&limit=&offset=
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/movements`, auth, listStockMovementsController);

  // ─── Recipes ──────────────────────────────────────────────────────────

  /**
   * Replaces a dish's recipe.
   * PUT /api/v1/menu/items/:menuItemId/recipe
   */
  app.put<RecipeRoute>("/api/v1/menu/items/:menuItemId/recipe", auth, saveRecipeController);

  /**
   * Retrieves a dish's recipe with costs.
   * GET /api/v1/menu/items/:menuItemId/recipe?branchId=
   */
  app.get<RecipeRoute>("/api/v1/menu/items/:menuItemId/recipe", auth, getRecipeController);

  /**
   * Removes a dish's recipe.
   * DELETE /api/v1/menu/items/:menuItemId/recipe
   */
  app.delete<RecipeRoute>("/api/v1/menu/items/:menuItemId/recipe", auth, deleteRecipeController);

  /**
   * Lists a branch's dishes with recipe status and food cost %.
   * GET /api/v1/branches/:branchId/inventory/recipes?missing=&search=&limit=&offset=
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/recipes`, auth, listRecipesController);

  // ─── Settings, auto-86 and alerts ─────────────────────────────────────

  /**
   * Retrieves inventory settings.
   * GET /api/v1/branches/:branchId/inventory/settings
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/settings`, auth, getInventorySettingsController);

  /**
   * Updates inventory settings.
   * PUT /api/v1/branches/:branchId/inventory/settings
   */
  app.put<BranchRoute>(`${BRANCH_INVENTORY}/settings`, auth, updateInventorySettingsController);

  /**
   * Lists dishes turned off by auto-86.
   * GET /api/v1/branches/:branchId/inventory/auto86
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/auto86`, auth, listAuto86Controller);

  /**
   * Lists stock alerts.
   * GET /api/v1/branches/:branchId/inventory/alerts?status=&limit=&offset=
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/alerts`, auth, listStockAlertsController);

  /**
   * Marks a stock alert as seen.
   * POST /api/v1/inventory/alerts/:alertId/acknowledge
   */
  app.post<AlertRoute>(
    "/api/v1/inventory/alerts/:alertId/acknowledge",
    auth,
    acknowledgeStockAlertController,
  );

  // ─── Reports ──────────────────────────────────────────────────────────

  /**
   * Food cost per dish sold.
   * GET /api/v1/branches/:branchId/inventory/reports/food-cost?from=&to=
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/reports/food-cost`, auth, foodCostReportController);

  /**
   * Stock variance (actual vs expected usage).
   * GET /api/v1/branches/:branchId/inventory/reports/variance?from=&to=
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/reports/variance`, auth, varianceReportController);

  /**
   * Current stock value.
   * GET /api/v1/branches/:branchId/inventory/reports/valuation
   */
  app.get<BranchRoute>(`${BRANCH_INVENTORY}/reports/valuation`, auth, stockValuationController);
}
