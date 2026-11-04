import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  branchInventoryItemParamsSchema,
  branchInventoryParamsSchema,
  createInventoryItemSchema,
  createPurchaseSchema,
  createStockCountSchema,
  createSupplierSchema,
  deleteInventoryItemQuerySchema,
  inventoryItemIdParamsSchema,
  inventoryItemQuerySchema,
  inventoryReportQuerySchema,
  listInventoryItemsQuerySchema,
  listPurchasesQuerySchema,
  listRecipesQuerySchema,
  listStockAlertsQuerySchema,
  listStockCountsQuerySchema,
  listStockMovementsQuerySchema,
  listSuppliersQuerySchema,
  purchaseParamsSchema,
  recipeParamsSchema,
  recipeQuerySchema,
  recordWastageSchema,
  saveRecipeSchema,
  stockAdjustmentSchema,
  stockAlertParamsSchema,
  stockCountParamsSchema,
  supplierIdParamsSchema,
  updateBranchStockSchema,
  updateInventoryItemSchema,
  updateInventorySettingsSchema,
  updateSupplierSchema,
} from "@morfikos/validation";

import {
  acknowledgeStockAlert,
  adjustStock,
  createInventoryItem,
  createPurchase,
  createStockCount,
  createSupplier,
  deleteInventoryItem,
  deleteRecipe,
  getFoodCostReport,
  getInventoryItem,
  getInventorySettings,
  getPurchase,
  getRecipe,
  getStockCount,
  getStockValuation,
  getVarianceReport,
  isInventoryServiceError,
  listAuto86Dishes,
  listInventoryItems,
  listPurchases,
  listRecipes,
  listStockAlerts,
  listStockCounts,
  listStockMovements,
  listSuppliers,
  recordWastage,
  saveRecipe,
  updateBranchStock,
  updateInventoryItem,
  updateInventorySettings,
  updateSupplier,
  type InventoryActor,
} from "./service.js";

import { INVENTORY_MANAGER_ROLES, INVENTORY_STAFF_ROLES } from "./constants.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type ItemRequest = FastifyRequest<{ Params: { itemId: string } }>;
type BranchRequest = FastifyRequest<{ Params: { branchId: string } }>;
type BranchItemRequest = FastifyRequest<{ Params: { branchId: string; itemId: string } }>;
type SupplierRequest = FastifyRequest<{ Params: { supplierId: string } }>;
type PurchaseRequest = FastifyRequest<{ Params: { branchId: string; purchaseId: string } }>;
type StockCountRequest = FastifyRequest<{ Params: { branchId: string; countId: string } }>;
type RecipeRequest = FastifyRequest<{ Params: { menuItemId: string } }>;
type AlertRequest = FastifyRequest<{ Params: { alertId: string } }>;

/**
 * Sends an authentication error when the user is not logged in.
 *
 * @param reply - The Fastify reply instance.
 * @returns An unauthorized response.
 */
function sendUnauthenticated(reply: FastifyReply) {
  return sendError(
    reply,
    401,
    "Login required",
    ErrorCode.UNAUTHENTICATED,
  );
}

/**
 * Sends an authorization error when the user lacks permission.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendForbidden(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Access denied",
    ErrorCode.FORBIDDEN,
  );
}

/**
 * Sends a response when the organization context is missing.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendMissingOrganization(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Organization context is missing",
    ErrorCode.FORBIDDEN,
  );
}

/**
 * Sends a validation error using the first validation issue as the message.
 *
 * @param reply - The Fastify reply instance.
 * @param error - The Zod validation error.
 * @returns A bad-request response.
 */
function sendValidationError(
  reply: FastifyReply,
  error: Pick<ZodError, "issues">,
) {
  return sendError(
    reply,
    400,
    error.issues[0]?.message ?? "Request validation failed",
    ErrorCode.VALIDATION_ERROR,
  );
}

/**
 * Sends a generic server error after logging the underlying error.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param error - The unexpected error.
 * @param logMessage - The message to log alongside the error.
 * @returns An internal server error response.
 */
function sendUnexpectedError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
) {
  request.log.error(
    { err: error },
    logMessage,
  );

  return sendError(
    reply,
    500,
    "An unexpected error occurred",
    ErrorCode.INTERNAL_SERVER_ERROR,
  );
}

/**
 * Verifies the user is logged in, has one of the allowed roles (owner or
 * manager by default) and has an organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The inventory actor, or null after an error response was sent.
 */
function authorizeInventoryRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = INVENTORY_MANAGER_ROLES,
): InventoryActor | null {
  const context = getAuthContext(request);

  if (!context) {
    sendUnauthenticated(reply);
    return null;
  }

  if (!hasRole(context, allowedRoles)) {
    sendForbidden(reply);
    return null;
  }

  const organizationId = getOrganizationId(request);

  if (!organizationId) {
    sendMissingOrganization(reply);
    return null;
  }

  return {
    userId: context.userId,
    role: context.role,
    organizationId,
    branchIds: context.branchIds,
  };
}

/**
 * Handles known inventory service errors.
 *
 * @param error - The error thrown by the inventory service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
export function handleInventoryServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isInventoryServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "INCOMPATIBLE_UNIT":
      return sendError(reply, 400, error.message, ErrorCode.INCOMPATIBLE_UNIT);

    case "INVALID_RECIPE":
      return sendError(reply, 400, error.message, ErrorCode.INVALID_RECIPE);

    case "PIN_NOT_SET":
      return sendError(reply, 400, error.message, ErrorCode.PIN_NOT_SET);

    case "INVALID_MANAGER_PIN":
      return sendError(reply, 403, error.message, ErrorCode.INVALID_MANAGER_PIN);

    case "BRANCH_ACCESS_DENIED":
      return sendError(reply, 403, error.message, ErrorCode.BRANCH_ACCESS_DENIED);

    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    case "INVENTORY_ITEM_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.INVENTORY_ITEM_NOT_FOUND);

    case "SUPPLIER_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.SUPPLIER_NOT_FOUND);

    case "PURCHASE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.PURCHASE_NOT_FOUND);

    case "STOCK_COUNT_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.STOCK_COUNT_NOT_FOUND);

    case "MENU_ITEM_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.MENU_ITEM_NOT_FOUND);

    case "RECIPE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.RECIPE_NOT_FOUND);

    case "ALERT_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.ALERT_NOT_FOUND);

    case "INVENTORY_ITEM_EXISTS":
      return sendError(reply, 409, error.message, ErrorCode.INVENTORY_ITEM_EXISTS);

    case "SUPPLIER_EXISTS":
      return sendError(reply, 409, error.message, ErrorCode.SUPPLIER_EXISTS);

    case "ITEM_IN_RECIPES":
      return sendError(reply, 409, error.message, ErrorCode.ITEM_IN_RECIPES);

    case "INSUFFICIENT_STOCK":
      return sendError(reply, 409, error.message, ErrorCode.INSUFFICIENT_STOCK);

    default:
      return null;
  }
}

/**
 * Sends the response for a caught error: a known service error, or a 500.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param error - The caught error.
 * @param logMessage - The message to log for unexpected errors.
 * @returns The error response.
 */
function sendCaughtError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
) {
  const handled = handleInventoryServiceError(error, reply);

  if (handled) {
    return handled;
  }

  return sendUnexpectedError(request, reply, error, logMessage);
}

// ─── Inventory items ────────────────────────────────────────────────────

/**
 * Creates an ingredient with optional opening stock per branch.
 *
 * @param request - The incoming request containing the item.
 * @param reply - The Fastify reply instance.
 * @returns The created item or an error response.
 */
export async function createInventoryItemController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = createInventoryItemSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const item = await createInventoryItem(actor, parsed.data);

    return sendSuccess(reply, 201, "Inventory item created successfully", item);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to create inventory item");
  }
}

/**
 * Lists ingredients with their stock at a branch.
 *
 * @param request - The incoming request containing filters.
 * @param reply - The Fastify reply instance.
 * @returns The items or an error response.
 */
export async function listInventoryItemsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = listInventoryItemsQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const items = await listInventoryItems(actor, parsed.data);

    return sendSuccess(reply, 200, "Inventory items retrieved successfully", items);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list inventory items");
  }
}

/**
 * Retrieves an ingredient with its stock, recipes and recent movements.
 *
 * @param request - The incoming request containing the item ID.
 * @param reply - The Fastify reply instance.
 * @returns The item or an error response.
 */
export async function getInventoryItemController(
  request: ItemRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = inventoryItemIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = inventoryItemQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const item = await getInventoryItem(actor, parsedParams.data.itemId, parsedQuery.data);

    if (!item) {
      return sendError(reply, 404, "Inventory item not found", ErrorCode.INVENTORY_ITEM_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Inventory item retrieved successfully", item);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get inventory item");
  }
}

/**
 * Updates an ingredient.
 *
 * @param request - The incoming request containing the item ID and changes.
 * @param reply - The Fastify reply instance.
 * @returns The updated item or an error response.
 */
export async function updateInventoryItemController(
  request: ItemRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = inventoryItemIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateInventoryItemSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const item = await updateInventoryItem(actor, parsedParams.data.itemId, parsedBody.data);

    if (!item) {
      return sendError(reply, 404, "Inventory item not found", ErrorCode.INVENTORY_ITEM_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Inventory item updated successfully", item);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update inventory item");
  }
}

/**
 * Deactivates an ingredient (`?force=true` also removes it from recipes).
 *
 * @param request - The incoming request containing the item ID.
 * @param reply - The Fastify reply instance.
 * @returns The result or an error response.
 */
export async function deleteInventoryItemController(
  request: ItemRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = inventoryItemIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = deleteInventoryItemQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const result = await deleteInventoryItem(actor, parsedParams.data.itemId, parsedQuery.data.force);

    if (!result) {
      return sendError(reply, 404, "Inventory item not found", ErrorCode.INVENTORY_ITEM_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Inventory item deactivated successfully", result);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to delete inventory item");
  }
}

/**
 * Sets an ingredient's low-stock level at a branch.
 *
 * @param request - The incoming request containing the branch, item and level.
 * @param reply - The Fastify reply instance.
 * @returns The branch stock or an error response.
 */
export async function updateBranchStockController(
  request: BranchItemRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryItemParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateBranchStockSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const stock = await updateBranchStock(
      actor,
      parsedParams.data.branchId,
      parsedParams.data.itemId,
      parsedBody.data.lowStockLevel,
    );

    if (!stock) {
      return sendError(reply, 404, "Inventory item not found", ErrorCode.INVENTORY_ITEM_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Stock level updated successfully", stock);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update branch stock");
  }
}

// ─── Suppliers ──────────────────────────────────────────────────────────

/**
 * Creates a supplier.
 *
 * @param request - The incoming request containing the supplier.
 * @param reply - The Fastify reply instance.
 * @returns The created supplier or an error response.
 */
export async function createSupplierController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = createSupplierSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const supplier = await createSupplier(actor, parsed.data);

    return sendSuccess(reply, 201, "Supplier created successfully", supplier);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to create supplier");
  }
}

/**
 * Lists suppliers.
 *
 * @param request - The incoming request containing filters.
 * @param reply - The Fastify reply instance.
 * @returns The suppliers or an error response.
 */
export async function listSuppliersController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = listSuppliersQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const suppliers = await listSuppliers(actor, parsed.data);

    return sendSuccess(reply, 200, "Suppliers retrieved successfully", suppliers);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list suppliers");
  }
}

/**
 * Updates a supplier.
 *
 * @param request - The incoming request containing the supplier ID and changes.
 * @param reply - The Fastify reply instance.
 * @returns The updated supplier or an error response.
 */
export async function updateSupplierController(
  request: SupplierRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = supplierIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateSupplierSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const supplier = await updateSupplier(actor, parsedParams.data.supplierId, parsedBody.data);

    if (!supplier) {
      return sendError(reply, 404, "Supplier not found", ErrorCode.SUPPLIER_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Supplier updated successfully", supplier);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update supplier");
  }
}

// ─── Purchases ──────────────────────────────────────────────────────────

/**
 * Records goods received at a branch.
 *
 * @param request - The incoming request containing the branch and purchase.
 * @param reply - The Fastify reply instance.
 * @returns The purchase or an error response.
 */
export async function createPurchaseController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = createPurchaseSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const purchase = await createPurchase(actor, parsedParams.data.branchId, parsedBody.data);

    return sendSuccess(reply, 201, "Purchase recorded successfully", purchase);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to record purchase");
  }
}

/**
 * Lists a branch's purchases.
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The purchases or an error response.
 */
export async function listPurchasesController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listPurchasesQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const purchases = await listPurchases(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Purchases retrieved successfully", purchases);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list purchases");
  }
}

/**
 * Retrieves a purchase with its lines.
 *
 * @param request - The incoming request containing the branch and purchase ID.
 * @param reply - The Fastify reply instance.
 * @returns The purchase or an error response.
 */
export async function getPurchaseController(
  request: PurchaseRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = purchaseParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const purchase = await getPurchase(actor, parsed.data.branchId, parsed.data.purchaseId);

    if (!purchase) {
      return sendError(reply, 404, "Purchase not found", ErrorCode.PURCHASE_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Purchase retrieved successfully", purchase);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get purchase");
  }
}

// ─── Wastage, counts, adjustments and movements ─────────────────────────

/**
 * Records wasted stock at a branch.
 *
 * @param request - The incoming request containing the branch and wasted items.
 * @param reply - The Fastify reply instance.
 * @returns The wastage summary or an error response.
 */
export async function recordWastageController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = recordWastageSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const wastage = await recordWastage(actor, parsedParams.data.branchId, parsedBody.data);

    return sendSuccess(reply, 201, "Wastage recorded successfully", wastage);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to record wastage");
  }
}

/**
 * Saves a physical stock count.
 *
 * @param request - The incoming request containing the branch and counts.
 * @param reply - The Fastify reply instance.
 * @returns The count with variances or an error response.
 */
export async function createStockCountController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = createStockCountSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const count = await createStockCount(actor, parsedParams.data.branchId, parsedBody.data);

    return sendSuccess(reply, 201, "Stock count saved successfully", count);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to save stock count");
  }
}

/**
 * Lists a branch's stock counts.
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The counts or an error response.
 */
export async function listStockCountsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listStockCountsQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const counts = await listStockCounts(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Stock counts retrieved successfully", counts);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list stock counts");
  }
}

/**
 * Retrieves a stock count with its variances.
 *
 * @param request - The incoming request containing the branch and count ID.
 * @param reply - The Fastify reply instance.
 * @returns The count or an error response.
 */
export async function getStockCountController(
  request: StockCountRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = stockCountParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const count = await getStockCount(actor, parsed.data.branchId, parsed.data.countId);

    if (!count) {
      return sendError(reply, 404, "Stock count not found", ErrorCode.STOCK_COUNT_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Stock count retrieved successfully", count);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get stock count");
  }
}

/**
 * Corrects one item's stock by hand (manager PIN required).
 *
 * @param request - The incoming request containing the branch and adjustment.
 * @param reply - The Fastify reply instance.
 * @returns The adjustment or an error response.
 */
export async function adjustStockController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = stockAdjustmentSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const adjustment = await adjustStock(actor, parsedParams.data.branchId, parsedBody.data);

    return sendSuccess(reply, 201, "Stock adjusted successfully", adjustment);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to adjust stock");
  }
}

/**
 * Lists a branch's stock ledger.
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The movements or an error response.
 */
export async function listStockMovementsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listStockMovementsQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const movements = await listStockMovements(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Stock movements retrieved successfully", movements);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list stock movements");
  }
}

// ─── Recipes ────────────────────────────────────────────────────────────

/**
 * Replaces a dish's recipe.
 *
 * @param request - The incoming request containing the menu item ID and recipe.
 * @param reply - The Fastify reply instance.
 * @returns The saved recipe with costs or an error response.
 */
export async function saveRecipeController(
  request: RecipeRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = recipeParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = saveRecipeSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const recipe = await saveRecipe(actor, parsedParams.data.menuItemId, parsedBody.data);

    if (!recipe) {
      return sendError(reply, 404, "Menu item not found", ErrorCode.MENU_ITEM_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Recipe saved successfully", recipe);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to save recipe");
  }
}

/**
 * Retrieves a dish's recipe with costs.
 *
 * @param request - The incoming request containing the menu item ID.
 * @param reply - The Fastify reply instance.
 * @returns The recipe or an error response.
 */
export async function getRecipeController(
  request: RecipeRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = recipeParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = recipeQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const recipe = await getRecipe(actor, parsedParams.data.menuItemId, parsedQuery.data);

    if (!recipe) {
      return sendError(reply, 404, "Menu item not found", ErrorCode.MENU_ITEM_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Recipe retrieved successfully", recipe);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get recipe");
  }
}

/**
 * Removes a dish's recipe.
 *
 * @param request - The incoming request containing the menu item ID.
 * @param reply - The Fastify reply instance.
 * @returns The result or an error response.
 */
export async function deleteRecipeController(
  request: RecipeRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = recipeParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const result = await deleteRecipe(actor, parsed.data.menuItemId);

    if (!result) {
      return sendError(reply, 404, "Recipe not found", ErrorCode.RECIPE_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Recipe deleted successfully", result);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to delete recipe");
  }
}

/**
 * Lists a branch's dishes with recipe status and food cost %.
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The dishes or an error response.
 */
export async function listRecipesController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listRecipesQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const recipes = await listRecipes(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Recipes retrieved successfully", recipes);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list recipes");
  }
}

// ─── Settings, auto-86 and alerts ───────────────────────────────────────

/**
 * Retrieves a branch's inventory settings.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns The settings or an error response.
 */
export async function getInventorySettingsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const settings = await getInventorySettings(actor, parsed.data.branchId);

    return sendSuccess(reply, 200, "Inventory settings retrieved successfully", settings);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get inventory settings");
  }
}

/**
 * Updates a branch's inventory settings.
 *
 * @param request - The incoming request containing the branch ID and settings.
 * @param reply - The Fastify reply instance.
 * @returns The updated settings or an error response.
 */
export async function updateInventorySettingsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateInventorySettingsSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const settings = await updateInventorySettings(actor, parsedParams.data.branchId, parsedBody.data);

    return sendSuccess(reply, 200, "Inventory settings updated successfully", settings);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update inventory settings");
  }
}

/**
 * Lists dishes auto-86 has turned off at a branch.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns The dishes or an error response.
 */
export async function listAuto86Controller(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const dishes = await listAuto86Dishes(actor, parsed.data.branchId);

    return sendSuccess(reply, 200, "Out-of-stock dishes retrieved successfully", dishes);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list out-of-stock dishes");
  }
}

/**
 * Lists a branch's stock alerts.
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The alerts or an error response.
 */
export async function listStockAlertsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listStockAlertsQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const alerts = await listStockAlerts(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Stock alerts retrieved successfully", alerts);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list stock alerts");
  }
}

/**
 * Marks a stock alert as seen.
 *
 * @param request - The incoming request containing the alert ID.
 * @param reply - The Fastify reply instance.
 * @returns The alert or an error response.
 */
export async function acknowledgeStockAlertController(
  request: AlertRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply, INVENTORY_STAFF_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = stockAlertParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const alert = await acknowledgeStockAlert(actor, parsed.data.alertId);

    if (!alert) {
      return sendError(reply, 404, "Stock alert not found", ErrorCode.ALERT_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Stock alert acknowledged", alert);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to acknowledge stock alert");
  }
}

// ─── Reports ────────────────────────────────────────────────────────────

/**
 * Food cost per dish sold in a date range.
 *
 * @param request - The incoming request containing the branch and dates.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export async function foodCostReportController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = inventoryReportQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const report = await getFoodCostReport(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Food cost report generated successfully", report);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to generate food cost report");
  }
}

/**
 * Stock variance (actual vs expected usage) for a date range.
 *
 * @param request - The incoming request containing the branch and dates.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export async function varianceReportController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = inventoryReportQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const report = await getVarianceReport(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Variance report generated successfully", report);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to generate variance report");
  }
}

/**
 * Current stock value at a branch.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns The valuation or an error response.
 */
export async function stockValuationController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeInventoryRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = branchInventoryParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const valuation = await getStockValuation(actor, parsed.data.branchId);

    return sendSuccess(reply, 200, "Stock valuation generated successfully", valuation);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to generate stock valuation");
  }
}
