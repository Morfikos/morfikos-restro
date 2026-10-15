
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  branchIdSchema,
  createBranchSchema,
  listBranchesQuerySchema,
  updateBranchSchema,
} from "@morfikos/validation";

import {
  isBranchServiceError,
  BranchServiceError,
  createBranch,
  deactivateBranch,
  getBranch,
  listBranches,
  updateBranch,
} from "./service.js";


import {
  sendError,
  sendSucess,
} from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext,getOrganizationId,hasRole } from "../../utils/auth-helpers.js";


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
 * Handles known branch service errors.
 *
 * @param error - The error thrown by the branch service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleBranchServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isBranchServiceError(error)) {
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

    case "BRANCH_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.BRANCH_NOT_FOUND,
      );

    case "BRANCH_CODE_CONFLICT":
      return sendError(
        reply,
        409,
        error.message,
        ErrorCode.BRANCH_CODE_CONFLICT,
      );

    default:
      return null;
  }
}

/**
 * Creates a new branch for an organization.
 *
 * @param request - The incoming request containing branch details.
 * @param reply - The Fastify reply instance.
 * @returns The created branch or an error response.
 */
export async function createBranchController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const context = getAuthContext(request);

  if (!context) {
    return sendUnauthenticated(reply);
  }

  if (!hasRole(context, ["owner"])) {
    return sendError(
      reply,
      403,
      "Owner access required",
      ErrorCode.FORBIDDEN,
    );
  }

  const parsed = createBranchSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const branch = await createBranch(parsed.data);

    return sendSucess(
      reply,
      201,
      "Branch created successfully",
      branch,
    );
  } catch (error: unknown) {
    const handled = handleBranchServiceError(error, reply);

    if (handled) {
      return handled;
    }

   request.log.error(
  { err: error },
  "Failed to create branch",
);

return sendError(
  reply,
  500,
  "An unexpected error occurred",
  ErrorCode.INTERNAL_SERVER_ERROR,
);
  }
}

/**
 * Retrieves a branch by its ID within the authenticated organization.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns The requested branch or an error response.
 */
export async function getBranchController(
  request: FastifyRequest<{
    Params: { id: string };
  }>,
  reply: FastifyReply,
) {
  const context = getAuthContext(request);

  if (!context) {
    return sendUnauthenticated(reply);
  }

  if (!hasRole(context, ["owner", "manager"])) {
    return sendForbidden(reply);
  }

  const organizationId = getOrganizationId(request);

  if (!organizationId) {
    return sendMissingOrganization(reply);
  }

  const parsed = branchIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid branch ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const branch = await getBranch(
      parsed.data.id,
      organizationId,
    );

    if (!branch) {
      return sendError(
        reply,
        404,
        "Branch not found",
        ErrorCode.BRANCH_NOT_FOUND,
      );
    }

    return sendSucess(
      reply,
      200,
      "Branch retrieved successfully",
      branch,
    );
  } catch (error: unknown) {
    const handled = handleBranchServiceError(error, reply);

    if (handled) {
      return handled;
    }

   request.log.error(
  { err: error },
  "Failed to create branch",
);

return sendError(
  reply,
  500,
  "An unexpected error occurred",
  ErrorCode.INTERNAL_SERVER_ERROR,
);
  }
}

/**
 * Lists branches belonging to the authenticated organization.
 *
 * @param request - The incoming request containing query parameters.
 * @param reply - The Fastify reply instance.
 * @returns The matching branches or an error response.
 */
export async function listBranchesController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const context = getAuthContext(request);

  if (!context) {
    return sendUnauthenticated(reply);
  }

  if (!hasRole(context, ["owner", "manager"])) {
    return sendForbidden(reply);
  }

  const organizationId = getOrganizationId(request);

  if (!organizationId) {
    return sendMissingOrganization(reply);
  }

  const parsed = listBranchesQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid branch query parameters",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const branches = await listBranches(
      organizationId,
      parsed.data.status,
      parsed.data.limit,
      parsed.data.offset,
    );

    return sendSucess(
      reply,
      200,
      "Branches retrieved successfully",
      branches,
    );
  } catch (error: unknown) {
    const handled = handleBranchServiceError(error, reply);

    if (handled) {
      return handled;
    }

   request.log.error(
  { err: error },
  "Failed to create branch",
);

return sendError(
  reply,
  500,
  "An unexpected error occurred",
  ErrorCode.INTERNAL_SERVER_ERROR,
);
  }
}

/**
 * Updates an existing branch within the authenticated organization.
 *
 * @param request - The incoming request containing the branch ID and updates.
 * @param reply - The Fastify reply instance.
 * @returns The updated branch or an error response.
 */
export async function updateBranchController(
  request: FastifyRequest<{
    Params: { id: string };
  }>,
  reply: FastifyReply,
) {
  const context = getAuthContext(request);

  if (!context) {
    return sendUnauthenticated(reply);
  }

  if (!hasRole(context, ["owner"])) {
    return sendError(
      reply,
      403,
      "Owner access required",
      ErrorCode.FORBIDDEN,
    );
  }

  const organizationId = getOrganizationId(request);

  if (!organizationId) {
    return sendMissingOrganization(reply);
  }

  const parsedId = branchIdSchema.safeParse(request.params);

  if (!parsedId.success) {
    return sendError(
      reply,
      400,
      "Invalid branch ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const parsedBody = updateBranchSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendError(
      reply,
      400,
      "Request validation failed",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const branch = await updateBranch(
      parsedId.data.id,
      organizationId,
      parsedBody.data,
    );

    if (!branch) {
      return sendError(
        reply,
        404,
        "Branch not found",
        ErrorCode.BRANCH_NOT_FOUND,
      );
    }

    return sendSucess(
      reply,
      200,
      "Branch updated successfully",
      branch,
    );
  } catch (error: unknown) {
    const handled = handleBranchServiceError(error, reply);

    if (handled) {
      return handled;
    }

   request.log.error(
  { err: error },
  "Failed to create branch",
);

return sendError(
  reply,
  500,
  "An unexpected error occurred",
  ErrorCode.INTERNAL_SERVER_ERROR,
);
  }
}

/**
 * Deactivates a branch belonging to the authenticated organization.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns A success response or an error response.
 */
export async function deleteBranchController(
  request: FastifyRequest<{
    Params: { id: string };
  }>,
  reply: FastifyReply,
) {
  const context = getAuthContext(request);

  if (!context) {
    return sendUnauthenticated(reply);
  }

  if (!hasRole(context, ["owner"])) {
    return sendError(
      reply,
      403,
      "Owner access required",
      ErrorCode.FORBIDDEN,
    );
  }

  const organizationId = getOrganizationId(request);

  if (!organizationId) {
    return sendMissingOrganization(reply);
  }

  const parsed = branchIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "Invalid branch ID",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const branch = await deactivateBranch(
      parsed.data.id,
      organizationId,
    );

    if (!branch) {
      return sendError(
        reply,
        404,
        "Branch not found",
        ErrorCode.BRANCH_NOT_FOUND,
      );
    }

    return sendSucess(
      reply,
      200,
      "Branch deactivated successfully",
      branch,
    );
  } catch (error: unknown) {
    const handled = handleBranchServiceError(error, reply);

    if (handled) {
      return handled;
    }

   request.log.error(
  { err: error },
  "Failed to create branch",
);

return sendError(
  reply,
  500,
  "An unexpected error occurred",
  ErrorCode.INTERNAL_SERVER_ERROR,
);
  }
}
