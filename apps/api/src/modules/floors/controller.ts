import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  applyLayoutImportSchema,
  createFloorSchema,
  floorIdSchema,
  layoutImportIdSchema,
  listFloorsQuerySchema,
  saveFloorLayoutSchema,
  updateFloorSchema,
} from "@morfikos/validation";

import {
  applyLayoutImport,
  createFloor,
  createLayoutImport,
  deactivateFloor,
  discardLayoutImport,
  getFloor,
  getFloorLayout,
  getLayoutImport,
  isFloorServiceError,
  listFloors,
  removeFloorBackground,
  saveFloorLayout,
  setFloorBackground,
  updateFloor,
} from "./service.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { MAX_IMAGE_BYTES } from "../../utils/storage.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type FloorIdRequest = FastifyRequest<{
  Params: { id: string };
}>;

type LayoutImportRequest = FastifyRequest<{
  Params: { importId: string };
}>;

/** Roles allowed to create floors, edit the map and import photos. */
const FLOOR_MANAGER_ROLES: UserRole[] = ["owner", "manager"];

/** Roles allowed to view floors and the live floor map. */
const FLOOR_READER_ROLES: UserRole[] = ["owner", "manager", "waiter", "staff"];

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
 * Sends a response when the user cannot access the requested branch.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendBranchAccessDenied(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Access denied for this branch",
    ErrorCode.BRANCH_ACCESS_DENIED,
  );
}

/**
 * Sends a response when the floor does not exist or is not accessible.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendFloorNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Floor not found",
    ErrorCode.FLOOR_NOT_FOUND,
  );
}

/**
 * Sends a response when the photo import does not exist or is not accessible.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendImportNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Layout import not found",
    ErrorCode.IMPORT_NOT_FOUND,
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
 * manager by default), and has an organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The organization ID, or null after an error response was sent.
 */
function authorizeFloorRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = FLOOR_MANAGER_ROLES,
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
 * Returns the branches the authenticated user can access.
 *
 * @param request - The incoming request.
 * @returns The accessible branch IDs.
 */
function getBranchIds(request: FastifyRequest): string[] {
  return getAuthContext(request)?.branchIds ?? [];
}

/**
 * Reads the single image file from a multipart/form-data request.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns The file contents, or null after an error response was sent.
 */
async function readImageUpload(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Buffer | null> {
  if (!request.isMultipart()) {
    sendError(
      reply,
      400,
      "Upload the image as multipart/form-data",
      ErrorCode.INVALID_IMAGE,
    );
    return null;
  }

  try {
    const file = await request.file();

    if (!file) {
      sendError(
        reply,
        400,
        "An image file is required",
        ErrorCode.INVALID_IMAGE,
      );
      return null;
    }

    return await file.toBuffer();
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FST_REQ_FILE_TOO_LARGE"
    ) {
      sendError(
        reply,
        413,
        `Image must be at most ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`,
        ErrorCode.IMAGE_TOO_LARGE,
      );
      return null;
    }

    throw error;
  }
}

/**
 * Handles known floor service errors.
 *
 * @param error - The error thrown by the floor service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleFloorServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isFloorServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    case "FLOOR_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.FLOOR_NOT_FOUND);

    case "TABLE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.TABLE_NOT_FOUND);

    case "IMPORT_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.IMPORT_NOT_FOUND);

    case "INVALID_IMAGE":
      return sendError(reply, 400, error.message, ErrorCode.INVALID_IMAGE);

    case "FLOOR_NAME_CONFLICT":
      return sendError(reply, 409, error.message, ErrorCode.FLOOR_NAME_CONFLICT);

    case "TABLE_NAME_CONFLICT":
      return sendError(reply, 409, error.message, ErrorCode.TABLE_NAME_CONFLICT);

    case "FLOOR_HAS_OPEN_ORDERS":
      return sendError(reply, 409, error.message, ErrorCode.FLOOR_HAS_OPEN_ORDERS);

    case "IMPORT_NOT_READY":
      return sendError(reply, 409, error.message, ErrorCode.IMPORT_NOT_READY);

    case "IMPORT_LIMIT_REACHED":
      return sendError(reply, 429, error.message, ErrorCode.IMPORT_LIMIT_REACHED);

    case "AI_NOT_CONFIGURED":
      return sendError(reply, 503, error.message, ErrorCode.AI_NOT_CONFIGURED);

    default:
      return null;
  }
}

/**
 * Creates a floor in a branch the user can access.
 *
 * @param request - The incoming request containing floor details.
 * @param reply - The Fastify reply instance.
 * @returns The created floor or an error response.
 */
export async function createFloorController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = createFloorSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!getBranchIds(request).includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const floor = await createFloor(parsed.data, organizationId);

    return sendSuccess(
      reply,
      201,
      "Floor created successfully",
      floor,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create floor");
  }
}

/**
 * Lists a branch's floors.
 *
 * @param request - The incoming request containing query parameters.
 * @param reply - The Fastify reply instance.
 * @returns The floors or an error response.
 */
export async function listFloorsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply, FLOOR_READER_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = listFloorsQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!getBranchIds(request).includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const floors = await listFloors(organizationId, parsed.data);

    return sendSuccess(
      reply,
      200,
      "Floors retrieved successfully",
      floors,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list floors");
  }
}

/**
 * Retrieves a floor by its ID.
 *
 * @param request - The incoming request containing the floor ID.
 * @param reply - The Fastify reply instance.
 * @returns The floor or an error response.
 */
export async function getFloorController(
  request: FloorIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply, FLOOR_READER_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = floorIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const floor = await getFloor(parsed.data.id, organizationId, getBranchIds(request));

    if (!floor) {
      return sendFloorNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Floor retrieved successfully",
      floor,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get floor");
  }
}

/**
 * Updates an existing floor.
 *
 * @param request - The incoming request containing the floor ID and updates.
 * @param reply - The Fastify reply instance.
 * @returns The updated floor or an error response.
 */
export async function updateFloorController(
  request: FloorIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedId = floorIdSchema.safeParse(request.params);

  if (!parsedId.success) {
    return sendValidationError(reply, parsedId.error);
  }

  const parsedBody = updateFloorSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const floor = await updateFloor(
      parsedId.data.id,
      organizationId,
      getBranchIds(request),
      parsedBody.data,
    );

    if (!floor) {
      return sendFloorNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Floor updated successfully",
      floor,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update floor");
  }
}

/**
 * Deactivates a floor (soft delete).
 *
 * @param request - The incoming request containing the floor ID.
 * @param reply - The Fastify reply instance.
 * @returns The floor status or an error response.
 */
export async function deleteFloorController(
  request: FloorIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = floorIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const floor = await deactivateFloor(
      parsed.data.id,
      organizationId,
      getBranchIds(request),
    );

    if (!floor) {
      return sendFloorNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Floor deactivated successfully",
      floor,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to deactivate floor");
  }
}

/**
 * Uploads a floor's background photo (multipart field: any file field).
 *
 * @param request - The incoming multipart request containing the image.
 * @param reply - The Fastify reply instance.
 * @returns The updated floor or an error response.
 */
export async function uploadFloorBackgroundController(
  request: FloorIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = floorIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const image = await readImageUpload(request, reply);

    if (!image) {
      return reply;
    }

    const floor = await setFloorBackground(
      parsed.data.id,
      organizationId,
      getBranchIds(request),
      image,
    );

    if (!floor) {
      return sendFloorNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Floor background uploaded successfully",
      floor,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to upload floor background");
  }
}

/**
 * Removes a floor's background photo.
 *
 * @param request - The incoming request containing the floor ID.
 * @param reply - The Fastify reply instance.
 * @returns The updated floor or an error response.
 */
export async function removeFloorBackgroundController(
  request: FloorIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = floorIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const floor = await removeFloorBackground(
      parsed.data.id,
      organizationId,
      getBranchIds(request),
    );

    if (!floor) {
      return sendFloorNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Floor background removed successfully",
      floor,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to remove floor background");
  }
}

/**
 * Retrieves the floor map with table positions and live status.
 *
 * @param request - The incoming request containing the floor ID.
 * @param reply - The Fastify reply instance.
 * @returns The floor layout or an error response.
 */
export async function getFloorLayoutController(
  request: FloorIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply, FLOOR_READER_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = floorIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const layout = await getFloorLayout(
      parsed.data.id,
      organizationId,
      getBranchIds(request),
    );

    if (!layout) {
      return sendFloorNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Floor layout retrieved successfully",
      layout,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get floor layout");
  }
}

/**
 * Saves the floor map editor (table positions and floor objects).
 *
 * @param request - The incoming request containing the floor ID and layout.
 * @param reply - The Fastify reply instance.
 * @returns The saved floor layout or an error response.
 */
export async function saveFloorLayoutController(
  request: FloorIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedId = floorIdSchema.safeParse(request.params);

  if (!parsedId.success) {
    return sendValidationError(reply, parsedId.error);
  }

  const parsedBody = saveFloorLayoutSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const layout = await saveFloorLayout(
      parsedId.data.id,
      organizationId,
      getBranchIds(request),
      parsedBody.data,
    );

    if (!layout) {
      return sendFloorNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Floor layout saved successfully",
      layout,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to save floor layout");
  }
}

/**
 * Starts a photo → floor map import. Returns 202 right away; the AI runs in
 * the background and the client polls the import until it is ready.
 *
 * @param request - The incoming multipart request containing the photo.
 * @param reply - The Fastify reply instance.
 * @returns The pending import or an error response.
 */
export async function createLayoutImportController(
  request: FloorIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = floorIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  const context = getAuthContext(request);

  if (!context) {
    return sendUnauthenticated(reply);
  }

  try {
    const image = await readImageUpload(request, reply);

    if (!image) {
      return reply;
    }

    const layoutImport = await createLayoutImport(
      parsed.data.id,
      organizationId,
      context.branchIds,
      context.userId,
      image,
      request.log,
    );

    if (!layoutImport) {
      return sendFloorNotFound(reply);
    }

    return sendSuccess(
      reply,
      202,
      "Photo received. Detecting the floor layout...",
      layoutImport,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to start floor layout import");
  }
}

/**
 * Retrieves a photo import's status and proposed layout.
 *
 * @param request - The incoming request containing the import ID.
 * @param reply - The Fastify reply instance.
 * @returns The import or an error response.
 */
export async function getLayoutImportController(
  request: LayoutImportRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = layoutImportIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const layoutImport = await getLayoutImport(
      parsed.data.importId,
      organizationId,
      getBranchIds(request),
    );

    if (!layoutImport) {
      return sendImportNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Layout import retrieved successfully",
      layoutImport,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get layout import");
  }
}

/**
 * Applies a reviewed photo import to its floor.
 *
 * @param request - The incoming request containing the import ID and layout.
 * @param reply - The Fastify reply instance.
 * @returns The floor layout after applying or an error response.
 */
export async function applyLayoutImportController(
  request: LayoutImportRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedId = layoutImportIdSchema.safeParse(request.params);

  if (!parsedId.success) {
    return sendValidationError(reply, parsedId.error);
  }

  const parsedBody = applyLayoutImportSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const layout = await applyLayoutImport(
      parsedId.data.importId,
      organizationId,
      getBranchIds(request),
      parsedBody.data,
    );

    if (!layout) {
      return sendImportNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Floor layout applied successfully",
      layout,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to apply layout import");
  }
}

/**
 * Discards a photo import that was not applied.
 *
 * @param request - The incoming request containing the import ID.
 * @param reply - The Fastify reply instance.
 * @returns The import status or an error response.
 */
export async function discardLayoutImportController(
  request: LayoutImportRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeFloorRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = layoutImportIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const layoutImport = await discardLayoutImport(
      parsed.data.importId,
      organizationId,
      getBranchIds(request),
    );

    if (!layoutImport) {
      return sendImportNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Layout import discarded successfully",
      layoutImport,
    );
  } catch (error: unknown) {
    const handled = handleFloorServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to discard layout import");
  }
}
