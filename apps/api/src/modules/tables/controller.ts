import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  createTableSchema,
  listTablesQuerySchema,
  tableIdSchema,
  updateTableSchema,
} from "@morfikos/validation";

import {
  createTable,
  deactivateTable,
  getTable,
  isTableServiceError,
  listTables,
  regenerateTableQr,
  updateTable,
} from "./service.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type TableIdRequest = FastifyRequest<{
  Params: { id: string };
}>;

/** Roles allowed to create, change and deactivate tables. */
const TABLE_MANAGER_ROLES: UserRole[] = ["owner", "manager"];

/** Roles allowed to view tables (floor staff need the live table map). */
const TABLE_READER_ROLES: UserRole[] = ["owner", "manager", "waiter", "staff"];

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
 * Sends a response when the table does not exist or is not accessible.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendTableNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Table not found",
    ErrorCode.TABLE_NOT_FOUND,
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
function authorizeTableRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = TABLE_MANAGER_ROLES,
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
 * Handles known table service errors.
 *
 * @param error - The error thrown by the table service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleTableServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isTableServiceError(error)) {
    return null;
  }

  switch (error.code) {
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

    case "TABLE_NAME_CONFLICT":
      return sendError(
        reply,
        409,
        error.message,
        ErrorCode.TABLE_NAME_CONFLICT,
      );

    case "TABLE_HAS_OPEN_ORDER":
      return sendError(
        reply,
        409,
        error.message,
        ErrorCode.TABLE_HAS_OPEN_ORDER,
      );

    case "FLOOR_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.FLOOR_NOT_FOUND,
      );

    default:
      return null;
  }
}

/**
 * Creates a table in a branch the user can access.
 *
 * @param request - The incoming request containing table details.
 * @param reply - The Fastify reply instance.
 * @returns The created table or an error response.
 */
export async function createTableController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeTableRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = createTableSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!getBranchIds(request).includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const table = await createTable(parsed.data, organizationId);

    return sendSuccess(
      reply,
      201,
      "Table created successfully",
      table,
    );
  } catch (error: unknown) {
    const handled = handleTableServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create table");
  }
}

/**
 * Lists a branch's tables with their live status.
 *
 * @param request - The incoming request containing query parameters.
 * @param reply - The Fastify reply instance.
 * @returns The matching tables or an error response.
 */
export async function listTablesController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeTableRequest(request, reply, TABLE_READER_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = listTablesQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!getBranchIds(request).includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const tables = await listTables(organizationId, parsed.data);

    return sendSuccess(
      reply,
      200,
      "Tables retrieved successfully",
      tables,
    );
  } catch (error: unknown) {
    const handled = handleTableServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list tables");
  }
}

/**
 * Retrieves a table with its live status.
 *
 * @param request - The incoming request containing the table ID.
 * @param reply - The Fastify reply instance.
 * @returns The table or an error response.
 */
export async function getTableController(
  request: TableIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeTableRequest(request, reply, TABLE_READER_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = tableIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const table = await getTable(
      parsed.data.id,
      organizationId,
      getBranchIds(request),
    );

    if (!table) {
      return sendTableNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Table retrieved successfully",
      table,
    );
  } catch (error: unknown) {
    const handled = handleTableServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get table");
  }
}

/**
 * Updates an existing table.
 *
 * @param request - The incoming request containing the table ID and updates.
 * @param reply - The Fastify reply instance.
 * @returns The updated table or an error response.
 */
export async function updateTableController(
  request: TableIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeTableRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedId = tableIdSchema.safeParse(request.params);

  if (!parsedId.success) {
    return sendValidationError(reply, parsedId.error);
  }

  const parsedBody = updateTableSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const table = await updateTable(
      parsedId.data.id,
      organizationId,
      getBranchIds(request),
      parsedBody.data,
    );

    if (!table) {
      return sendTableNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Table updated successfully",
      table,
    );
  } catch (error: unknown) {
    const handled = handleTableServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update table");
  }
}

/**
 * Deactivates a table (soft delete).
 *
 * @param request - The incoming request containing the table ID.
 * @param reply - The Fastify reply instance.
 * @returns The table status or an error response.
 */
export async function deleteTableController(
  request: TableIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeTableRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = tableIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const table = await deactivateTable(
      parsed.data.id,
      organizationId,
      getBranchIds(request),
    );

    if (!table) {
      return sendTableNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Table deactivated successfully",
      table,
    );
  } catch (error: unknown) {
    const handled = handleTableServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to deactivate table");
  }
}

/**
 * Replaces a table's QR code so old printed codes stop working.
 *
 * @param request - The incoming request containing the table ID.
 * @param reply - The Fastify reply instance.
 * @returns The table with its new QR code or an error response.
 */
export async function regenerateTableQrController(
  request: TableIdRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeTableRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsed = tableIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const table = await regenerateTableQr(
      parsed.data.id,
      organizationId,
      getBranchIds(request),
    );

    if (!table) {
      return sendTableNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Table QR code regenerated successfully",
      table,
    );
  } catch (error: unknown) {
    const handled = handleTableServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to regenerate table QR code");
  }
}
