import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  createUserSchema,
  deactivateUserSchema,
  listUsersQuerySchema,
  resetUserPasswordSchema,
  setUserPinSchema,
  updateUserBranchesSchema,
  updateUserRoleSchema,
  updateUserSchema,
  userIdParamsSchema,
} from "@morfikos/validation";

import {
  activateUser,
  clearUserPin,
  createUser,
  deactivateUser,
  getUser,
  isUserServiceError,
  listUsers,
  resetUserPassword,
  setUserPin,
  updateUser,
  updateUserBranches,
  updateUserRole,
  type UserActor,
} from "./service.js";

import { USER_ADMIN_ROLES } from "./constants.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type UserRequest = FastifyRequest<{
  Params: { userId: string };
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
 * Sends a response when the staff member does not exist or is not visible.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendUserNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Staff member not found",
    ErrorCode.USER_NOT_FOUND,
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
 * Verifies the user is logged in as an owner or manager with an
 * organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The user actor, or null after an error response was sent.
 */
function authorizeUserRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = USER_ADMIN_ROLES,
): UserActor | null {
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
 * Handles known user service errors.
 *
 * @param error - The error thrown by the user service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleUserServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isUserServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "ROLE_NOT_ASSIGNABLE":
      return sendError(reply, 403, error.message, ErrorCode.ROLE_NOT_ASSIGNABLE);

    case "BRANCH_ACCESS_DENIED":
      return sendError(reply, 403, error.message, ErrorCode.BRANCH_ACCESS_DENIED);

    case "CANNOT_MANAGE_USER":
      return sendError(reply, 403, error.message, ErrorCode.CANNOT_MANAGE_USER);

    case "CANNOT_MANAGE_SELF":
      return sendError(reply, 403, error.message, ErrorCode.CANNOT_MANAGE_SELF);

    case "USER_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.USER_NOT_FOUND);

    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    case "EMAIL_ALREADY_EXISTS":
      return sendError(reply, 409, error.message, ErrorCode.EMAIL_ALREADY_EXISTS);

    case "EMPLOYEE_CODE_EXISTS":
      return sendError(reply, 409, error.message, ErrorCode.EMPLOYEE_CODE_EXISTS);

    case "USER_ALREADY_ACTIVE":
      return sendError(reply, 409, error.message, ErrorCode.USER_ALREADY_ACTIVE);

    case "USER_ALREADY_INACTIVE":
      return sendError(reply, 409, error.message, ErrorCode.USER_ALREADY_INACTIVE);

    case "ROLE_NOT_CONFIGURED":
      return sendError(reply, 500, error.message, ErrorCode.ROLE_NOT_CONFIGURED);

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
  const handled = handleUserServiceError(error, reply);

  if (handled) {
    return handled;
  }

  return sendUnexpectedError(request, reply, error, logMessage);
}

/**
 * Lists the organization's staff.
 *
 * @param request - The incoming request containing filters.
 * @param reply - The Fastify reply instance.
 * @returns The staff or an error response.
 */
export async function listUsersController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = listUsersQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const users = await listUsers(actor, parsed.data);

    return sendSuccess(reply, 200, "Staff retrieved successfully", users);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list staff");
  }
}

/**
 * Creates a staff account.
 *
 * @param request - The incoming request containing the staff details.
 * @param reply - The Fastify reply instance.
 * @returns The created staff member or an error response.
 */
export async function createUserController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = createUserSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const user = await createUser(actor, parsed.data);

    return sendSuccess(reply, 201, "Staff member created successfully", user);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to create staff member");
  }
}

/**
 * Retrieves a staff member.
 *
 * @param request - The incoming request containing the user ID.
 * @param reply - The Fastify reply instance.
 * @returns The staff member or an error response.
 */
export async function getUserController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = userIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const user = await getUser(actor, parsed.data.userId);

    if (!user) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "Staff member retrieved successfully", user);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get staff member");
  }
}

/**
 * Edits a staff member's details.
 *
 * @param request - The incoming request containing the user ID and changes.
 * @param reply - The Fastify reply instance.
 * @returns The updated staff member or an error response.
 */
export async function updateUserController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = userIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateUserSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const user = await updateUser(actor, parsedParams.data.userId, parsedBody.data);

    if (!user) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "Staff member updated successfully", user);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update staff member");
  }
}

/**
 * Changes a staff member's role.
 *
 * @param request - The incoming request containing the user ID and role.
 * @param reply - The Fastify reply instance.
 * @returns The updated staff member or an error response.
 */
export async function updateUserRoleController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = userIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateUserRoleSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const user = await updateUserRole(actor, parsedParams.data.userId, parsedBody.data);

    if (!user) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "Role updated successfully", user);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update role");
  }
}

/**
 * Replaces a staff member's branch access.
 *
 * @param request - The incoming request containing the user ID and branches.
 * @param reply - The Fastify reply instance.
 * @returns The updated staff member or an error response.
 */
export async function updateUserBranchesController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = userIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateUserBranchesSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const user = await updateUserBranches(actor, parsedParams.data.userId, parsedBody.data);

    if (!user) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "Branch access updated successfully", user);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update branch access");
  }
}

/**
 * Deactivates a staff member.
 *
 * @param request - The incoming request containing the user ID and reason.
 * @param reply - The Fastify reply instance.
 * @returns The updated staff member or an error response.
 */
export async function deactivateUserController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = userIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = deactivateUserSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const user = await deactivateUser(actor, parsedParams.data.userId, parsedBody.data);

    if (!user) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "Staff member deactivated successfully", user);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to deactivate staff member");
  }
}

/**
 * Reactivates a staff member.
 *
 * @param request - The incoming request containing the user ID.
 * @param reply - The Fastify reply instance.
 * @returns The updated staff member or an error response.
 */
export async function activateUserController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = userIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const user = await activateUser(actor, parsed.data.userId);

    if (!user) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "Staff member activated successfully", user);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to activate staff member");
  }
}

/**
 * Sets a new password for a staff member.
 *
 * @param request - The incoming request containing the user ID and password.
 * @param reply - The Fastify reply instance.
 * @returns A confirmation or an error response.
 */
export async function resetUserPasswordController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = userIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = resetUserPasswordSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await resetUserPassword(actor, parsedParams.data.userId, parsedBody.data);

    if (!result) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "Password reset successfully. The staff member was signed out.", result);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to reset password");
  }
}

/**
 * Sets a staff member's PIN.
 *
 * @param request - The incoming request containing the user ID and PIN.
 * @param reply - The Fastify reply instance.
 * @returns A confirmation or an error response.
 */
export async function setUserPinController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = userIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = setUserPinSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await setUserPin(actor, parsedParams.data.userId, parsedBody.data);

    if (!result) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "PIN set successfully", result);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to set PIN");
  }
}

/**
 * Removes a staff member's PIN.
 *
 * @param request - The incoming request containing the user ID.
 * @param reply - The Fastify reply instance.
 * @returns A confirmation or an error response.
 */
export async function clearUserPinController(
  request: UserRequest,
  reply: FastifyReply,
) {
  const actor = authorizeUserRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = userIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const result = await clearUserPin(actor, parsed.data.userId);

    if (!result) {
      return sendUserNotFound(reply);
    }

    return sendSuccess(reply, 200, "PIN removed successfully", result);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to remove PIN");
  }
}
