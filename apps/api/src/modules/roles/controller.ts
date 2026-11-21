import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import { roleParamsSchema } from "@morfikos/validation";

import { getRole, listRoles, type RoleActor } from "./service.js";

import { ORGANIZATION_ROLES } from "./constants.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type RoleRequest = FastifyRequest<{
  Params: { role: string };
}>;

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
 * Verifies the user is logged in to an organization. Every organization
 * role may view roles (so the POS can show what a user is allowed to do).
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns The role actor, or null after an error response was sent.
 */
function authorizeRoleRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): RoleActor | null {
  const context = getAuthContext(request);

  if (!context) {
    sendUnauthenticated(reply);
    return null;
  }

  if (!hasRole(context, ORGANIZATION_ROLES)) {
    sendForbidden(reply);
    return null;
  }

  const organizationId = getOrganizationId(request);

  if (!organizationId) {
    sendMissingOrganization(reply);
    return null;
  }

  return { userId: context.userId, role: context.role, organizationId };
}

/**
 * Lists roles with their permissions and the permission matrix.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns The roles or an error response.
 */
export async function listRolesController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeRoleRequest(request, reply);

  if (!actor) {
    return reply;
  }

  try {
    const roles = await listRoles(actor);

    return sendSuccess(reply, 200, "Roles retrieved successfully", roles);
  } catch (error: unknown) {
    return sendUnexpectedError(request, reply, error, "Failed to list roles");
  }
}

/**
 * Retrieves one role with its permissions.
 *
 * @param request - The incoming request containing the role name.
 * @param reply - The Fastify reply instance.
 * @returns The role or an error response.
 */
export async function getRoleController(
  request: RoleRequest,
  reply: FastifyReply,
) {
  const actor = authorizeRoleRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = roleParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const role = await getRole(actor, parsed.data.role);

    if (!role) {
      return sendError(reply, 404, "Role not found", ErrorCode.VALIDATION_ERROR);
    }

    return sendSuccess(reply, 200, "Role retrieved successfully", role);
  } catch (error: unknown) {
    return sendUnexpectedError(request, reply, error, "Failed to get role");
  }
}
