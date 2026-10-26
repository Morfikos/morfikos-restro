import type { FastifyReply, FastifyRequest } from "fastify";

import type { UserRole } from "@morfikos/auth";

import {
  branchMenuItemParamsSchema,
  createCategorySchema,
  createCuisineSchema,
  createMenuItemSchema,
  listMenuItemsQuerySchema,
  listMenuQuerySchema,
  menuIdSchema,
  qrCodeParamsSchema,
  updateCategorySchema,
  updateCuisineSchema,
  updateMenuItemSchema,
  upsertBranchMenuItemSchema,
} from "@morfikos/validation";

import {
  createCategory,
  createCuisine,
  createMenuItem,
  deactivateCategory,
  deactivateCuisine,
  getMenuItem,
  getPublicMenu,
  isMenuServiceError,
  listCategories,
  listCuisines,
  listMenuItems,
  updateCategory,
  updateCuisine,
  updateMenuItem,
  upsertBranchMenuItem,
} from "./service.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type MenuIdRequest = FastifyRequest<{
  Params: { id: string };
}>;

type BranchMenuItemRequest = FastifyRequest<{
  Params: { branchId: string; itemId: string };
}>;

type PublicMenuRequest = FastifyRequest<{
  Params: { qrCode: string };
}>;

/** Roles allowed to create and change menu data. */
const MENU_MANAGER_ROLES: UserRole[] = ["owner", "manager"];

/** Roles allowed to read menu data inside the organization. */
const MENU_READER_ROLES: UserRole[] = ["owner", "manager", "waiter", "staff"];

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
 * manager by default), and has an organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The organization ID, or null after an error response was sent.
 */
function authorizeMenuRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = MENU_MANAGER_ROLES,
): string | null {
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

  return organizationId;
}

/**
 * Handles known menu service errors.
 *
 * @param error - The error thrown by the menu service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleMenuServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isMenuServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "ORGANIZATION_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.ORGANIZATION_NOT_FOUND,
      );

    case "CATEGORY_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.CATEGORY_NOT_FOUND,
      );

    case "CATEGORY_NAME_CONFLICT":
      return sendError(
        reply,
        409,
        error.message,
        ErrorCode.CATEGORY_NAME_CONFLICT,
      );

    case "CUISINE_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.CUISINE_NOT_FOUND,
      );

    case "CUISINE_NAME_CONFLICT":
      return sendError(
        reply,
        409,
        error.message,
        ErrorCode.CUISINE_NAME_CONFLICT,
      );

    case "MENU_ITEM_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.MENU_ITEM_NOT_FOUND,
      );

    case "MENU_ITEM_NAME_CONFLICT":
      return sendError(
        reply,
        409,
        error.message,
        ErrorCode.MENU_ITEM_NAME_CONFLICT,
      );

    case "BRANCH_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.BRANCH_NOT_FOUND,
      );

    case "TABLE_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.TABLE_NOT_FOUND,
      );

    case "INVALID_ITEM_TIMING":
      return sendError(
        reply,
        400,
        error.message,
        ErrorCode.VALIDATION_ERROR,
      );

    default:
      return null;
  }
}

/**
 * Creates a menu category for the authenticated organization.
 *
 * @param request - The incoming request containing category details.
 * @param reply - The Fastify reply instance.
 * @returns The created category or an error response.
 */
export async function createCategoryController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = createCategorySchema.safeParse(request.body);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (parsed.data.organizationId !== organizationId) {
    return sendError(
      reply,
      403,
      "Access denied for this organization",
      ErrorCode.FORBIDDEN,
    );
  }

  try {
    const category = await createCategory(parsed.data);

    return sendSuccess(
      reply,
      201,
      "Category created successfully",
      category,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create category");
  }
}

/**
 * Lists menu categories belonging to the authenticated organization.
 *
 * @param request - The incoming request containing query parameters.
 * @param reply - The Fastify reply instance.
 * @returns The matching categories or an error response.
 */
export async function listCategoriesController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = listMenuQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid category query parameters",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const categories = await listCategories(
      organizationId,
      parsed.data.isActive,
      parsed.data.limit,
      parsed.data.offset,
    );

    return sendSuccess(
      reply,
      200,
      "Categories retrieved successfully",
      categories,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list categories");
  }
}

/**
 * Updates an existing menu category within the authenticated organization.
 *
 * @param request - The incoming request containing the category ID and updates.
 * @param reply - The Fastify reply instance.
 * @returns The updated category or an error response.
 */
export async function updateCategoryController(
  request: MenuIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedId = menuIdSchema.safeParse(request.params);

  if (!parsedId.success) {
    return sendError(
      reply,
      400,
      "Invalid category ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const parsedBody = updateCategorySchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const category = await updateCategory(
      parsedId.data.id,
      organizationId,
      parsedBody.data,
    );

    if (!category) {
      return sendError(
        reply,
        404,
        "Category not found",
        ErrorCode.CATEGORY_NOT_FOUND,
      );
    }

    return sendSuccess(
      reply,
      200,
      "Category updated successfully",
      category,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update category");
  }
}

/**
 * Deactivates a menu category belonging to the authenticated organization.
 *
 * @param request - The incoming request containing the category ID.
 * @param reply - The Fastify reply instance.
 * @returns The category status or an error response.
 */
export async function deleteCategoryController(
  request: MenuIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = menuIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid category ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const category = await deactivateCategory(
      parsed.data.id,
      organizationId,
    );

    if (!category) {
      return sendError(
        reply,
        404,
        "Category not found",
        ErrorCode.CATEGORY_NOT_FOUND,
      );
    }

    return sendSuccess(
      reply,
      200,
      "Category deactivated successfully",
      category,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to deactivate category");
  }
}

/**
 * Creates a cuisine for the authenticated organization.
 *
 * @param request - The incoming request containing cuisine details.
 * @param reply - The Fastify reply instance.
 * @returns The created cuisine or an error response.
 */
export async function createCuisineController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = createCuisineSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (parsed.data.organizationId !== organizationId) {
    return sendError(
      reply,
      403,
      "Access denied for this organization",
      ErrorCode.FORBIDDEN,
    );
  }

  try {
    const cuisine = await createCuisine(parsed.data);

    return sendSuccess(
      reply,
      201,
      "Cuisine created successfully",
      cuisine,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create cuisine");
  }
}

/**
 * Lists cuisines belonging to the authenticated organization.
 *
 * @param request - The incoming request containing query parameters.
 * @param reply - The Fastify reply instance.
 * @returns The matching cuisines or an error response.
 */
export async function listCuisinesController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = listMenuQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid cuisine query parameters",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const cuisines = await listCuisines(
      organizationId,
      parsed.data.isActive,
      parsed.data.limit,
      parsed.data.offset,
    );

    return sendSuccess(
      reply,
      200,
      "Cuisines retrieved successfully",
      cuisines,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list cuisines");
  }
}

/**
 * Updates an existing cuisine within the authenticated organization.
 *
 * @param request - The incoming request containing the cuisine ID and updates.
 * @param reply - The Fastify reply instance.
 * @returns The updated cuisine or an error response.
 */
export async function updateCuisineController(
  request: MenuIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedId = menuIdSchema.safeParse(request.params);

  if (!parsedId.success) {
    return sendError(
      reply,
      400,
      "Invalid cuisine ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const parsedBody = updateCuisineSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const cuisine = await updateCuisine(
      parsedId.data.id,
      organizationId,
      parsedBody.data,
    );

    if (!cuisine) {
      return sendError(
        reply,
        404,
        "Cuisine not found",
        ErrorCode.CUISINE_NOT_FOUND,
      );
    }

    return sendSuccess(
      reply,
      200,
      "Cuisine updated successfully",
      cuisine,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update cuisine");
  }
}

/**
 * Deactivates a cuisine belonging to the authenticated organization.
 *
 * @param request - The incoming request containing the cuisine ID.
 * @param reply - The Fastify reply instance.
 * @returns The cuisine status or an error response.
 */
export async function deleteCuisineController(
  request: MenuIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = menuIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid cuisine ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const cuisine = await deactivateCuisine(
      parsed.data.id,
      organizationId,
    );

    if (!cuisine) {
      return sendError(
        reply,
        404,
        "Cuisine not found",
        ErrorCode.CUISINE_NOT_FOUND,
      );
    }

    return sendSuccess(
      reply,
      200,
      "Cuisine deactivated successfully",
      cuisine,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to deactivate cuisine");
  }
}

/**
 * Creates a menu item for the authenticated organization.
 *
 * @param request - The incoming request containing menu item details.
 * @param reply - The Fastify reply instance.
 * @returns The created menu item or an error response.
 */
export async function createMenuItemController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = createMenuItemSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (parsed.data.organizationId !== organizationId) {
    return sendError(
      reply,
      403,
      "Access denied for this organization",
      ErrorCode.FORBIDDEN,
    );
  }

  try {
    const item = await createMenuItem(parsed.data);

    return sendSuccess(
      reply,
      201,
      "Menu item created successfully",
      item,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create menu item");
  }
}

/**
 * Lists menu items of the authenticated organization. When `branchId` is
 * given, each item includes that branch's price and availability; the user
 * must have access to the branch. Any member of the organization may read
 * the list; cost prices are shown to owners and managers only.
 *
 * @param request - The incoming request containing query parameters.
 * @param reply - The Fastify reply instance.
 * @returns The matching menu items or an error response.
 */
export async function listMenuItemsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply, MENU_READER_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = listMenuItemsQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid menu item query parameters",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const context = getAuthContext(request);

  if (
    parsed.data.branchId !== undefined &&
    !(context?.branchIds ?? []).includes(parsed.data.branchId)
  ) {
    return sendError(
      reply,
      403,
      "Access denied for this branch",
      ErrorCode.FORBIDDEN,
    );
  }

  const canViewCostPrice =
    context !== null && hasRole(context, MENU_MANAGER_ROLES);

  try {
    const items = await listMenuItems(
      organizationId,
      parsed.data,
      canViewCostPrice,
    );

    return sendSuccess(
      reply,
      200,
      "Menu items retrieved successfully",
      items,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list menu items");
  }
}

/**
 * Updates an existing menu item within the authenticated organization.
 *
 * @param request - The incoming request containing the menu item ID and updates.
 * @param reply - The Fastify reply instance.
 * @returns The updated menu item or an error response.
 */
export async function updateMenuItemController(
  request: MenuIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedId = menuIdSchema.safeParse(request.params);

  if (!parsedId.success) {
    return sendError(
      reply,
      400,
      "Invalid menu item ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const parsedBody = updateMenuItemSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const item = await updateMenuItem(
      parsedId.data.id,
      organizationId,
      parsedBody.data,
    );

    if (!item) {
      return sendError(
        reply,
        404,
        "Menu item not found",
        ErrorCode.MENU_ITEM_NOT_FOUND,
      );
    }

    return sendSuccess(
      reply,
      200,
      "Menu item updated successfully",
      item,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update menu item");
  }
}

/**
 * Retrieves a menu item with its branch prices. Any member of the
 * organization may read it; cost prices are shown to owners and managers only.
 *
 * @param request - The incoming request containing the menu item ID.
 * @param reply - The Fastify reply instance.
 * @returns The menu item or an error response.
 */
export async function getMenuItemController(
  request: MenuIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply, MENU_READER_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = menuIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid menu item ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const context = getAuthContext(request);
  const canViewCostPrice =
    context !== null && hasRole(context, MENU_MANAGER_ROLES);

  try {
    const item = await getMenuItem(
      parsed.data.id,
      organizationId,
      canViewCostPrice,
    );

    if (!item) {
      return sendError(
        reply,
        404,
        "Menu item not found",
        ErrorCode.MENU_ITEM_NOT_FOUND,
      );
    }

    return sendSuccess(
      reply,
      200,
      "Menu item retrieved successfully",
      item,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get menu item");
  }
}

/**
 * Sets the branch-specific price and availability of a menu item.
 * The user must have access to the branch.
 *
 * @param request - The incoming request containing branch/item IDs and pricing.
 * @param reply - The Fastify reply instance.
 * @returns The branch menu item or an error response.
 */
export async function upsertBranchMenuItemController(
  request: BranchMenuItemRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeMenuRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedParams = branchMenuItemParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendError(
      reply,
      400,
      "Invalid branch or menu item ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const branchIds = getAuthContext(request)?.branchIds ?? [];

  if (!branchIds.includes(parsedParams.data.branchId)) {
    return sendError(
      reply,
      403,
      "Access denied for this branch",
      ErrorCode.FORBIDDEN,
    );
  }

  const parsedBody = upsertBranchMenuItemSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const branchItem = await upsertBranchMenuItem(
      parsedParams.data.branchId,
      parsedParams.data.itemId,
      organizationId,
      parsedBody.data,
    );

    return sendSuccess(
      reply,
      200,
      "Branch menu item updated successfully",
      branchItem,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update branch menu item");
  }
}

/**
 * Returns the guest-facing branch menu for a table QR code. Public route.
 *
 * @param request - The incoming request containing the QR code.
 * @param reply - The Fastify reply instance.
 * @returns The branch menu or an error response.
 */
export async function getPublicMenuController(
  request: PublicMenuRequest,
  reply: FastifyReply,
) {
  const parsed = qrCodeParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid QR code",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const menu = await getPublicMenu(parsed.data.qrCode);

    return sendSuccess(
      reply,
      200,
      "Menu retrieved successfully",
      menu,
    );
  } catch (error: unknown) {
    const handled = handleMenuServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get public menu");
  }
}
