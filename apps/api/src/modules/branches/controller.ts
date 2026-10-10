
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  branchIdSchema,
  createBranchSchema,
  listBranchesQuerySchema,
  updateBranchSchema,
} from "@morfikos/validation";
import {
  BranchServiceError,
  createBranch,
  deactivateBranch,
  getBranch,
  listBranches,
  updateBranch,
} from "./service.js";

type AuthContext = {
  organizationId?: string;
  role?: string;
};

function getAuthContext(request: FastifyRequest): AuthContext | null {
  const authenticatedRequest = request as FastifyRequest & {
    user?: AuthContext;
  };

  return authenticatedRequest.user ?? null;
}

function hasRole(
  context: AuthContext,
  allowedRoles: string[],
): boolean {
  return allowedRoles.includes(context.role?.toLowerCase() ?? "");
}

function sendValidationError(
  reply: FastifyReply,
  issues: unknown,
) {
  return reply.status(400).send({
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      issues,
    },
  });
}

function sendServiceError(
  reply: FastifyReply,
  error: BranchServiceError,
) {
  const statusCode =
    error.code === "ORGANIZATION_NOT_FOUND" ||
    error.code === "BRANCH_NOT_FOUND"
      ? 404
      : 409;

  return reply.status(statusCode).send({
    success: false,
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

function sendInternalError(reply: FastifyReply) {
  return reply.status(500).send({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
  });
}

function isBranchServiceError(
  error: unknown,
): error is BranchServiceError {
  return error instanceof BranchServiceError;
}

export async function createBranchController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = getAuthContext(request);

  if (!auth) {
    return reply.status(401).send({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Login required" },
    });
  }

  if (!hasRole(auth, ["owner"])) {
    return reply.status(403).send({
      success: false,
      error: { code: "FORBIDDEN", message: "Owner access required" },
    });
  }

  const parsed = createBranchSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error.issues);
  }

  if (
    !auth.organizationId ||
    auth.organizationId !== parsed.data.organizationId
  ) {
    return reply.status(403).send({
      success: false,
      error: {
        code: "ORGANIZATION_ACCESS_DENIED",
        message: "You cannot create a branch for this organization",
      },
    });
  }

  try {
    const branch = await createBranch(parsed.data);

    return reply.status(201).send({
      success: true,
      data: branch,
    });
  } catch (error: unknown) {
    if (isBranchServiceError(error)) {
      return sendServiceError(reply, error);
    }

    request.log.error({ err: error }, "Failed to create branch");
    return sendInternalError(reply);
  }
}

export async function getBranchController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = getAuthContext(request);

  if (!auth) {
    return reply.status(401).send({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Login required" },
    });
  }

  if (!auth.organizationId) {
    return reply.status(403).send({
      success: false,
      error: { code: "ORGANIZATION_REQUIRED", message: "Organization context required" },
    });
  }

  const parsed = branchIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error.issues);
  }

  try {
    const branch = await getBranch(parsed.data.id, auth.organizationId);

    if (!branch) {
      return reply.status(404).send({
        success: false,
        error: { code: "BRANCH_NOT_FOUND", message: "Branch not found" },
      });
    }

    return reply.status(200).send({
      success: true,
      data: branch,
    });
  } catch (error: unknown) {
    request.log.error({ err: error }, "Failed to get branch");
    return sendInternalError(reply);
  }
}

export async function listBranchesController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = getAuthContext(request);

  if (!auth) {
    return reply.status(401).send({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Login required" },
    });
  }

  if (!hasRole(auth, ["owner", "manager"])) {
    return reply.status(403).send({
      success: false,
      error: { code: "FORBIDDEN", message: "Owner or Manager access required" },
    });
  }

  if (!auth.organizationId) {
    return reply.status(403).send({
      success: false,
      error: { code: "ORGANIZATION_REQUIRED", message: "Organization context required" },
    });
  }

  const parsed = listBranchesQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error.issues);
  }

  try {
    const result = await listBranches(
      auth.organizationId,
      parsed.data.status,
      parsed.data.limit,
      parsed.data.offset,
    );

    return reply.status(200).send({
      success: true,
      data: result,
    });
  } catch (error: unknown) {
    request.log.error({ err: error }, "Failed to list branches");
    return sendInternalError(reply);
  }
}

export async function updateBranchController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = getAuthContext(request);

  if (!auth) {
    return reply.status(401).send({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Login required" },
    });
  }

  if (!hasRole(auth, ["owner"])) {
    return reply.status(403).send({
      success: false,
      error: { code: "FORBIDDEN", message: "Owner access required" },
    });
  }

  if (!auth.organizationId) {
    return reply.status(403).send({
      success: false,
      error: { code: "ORGANIZATION_REQUIRED", message: "Organization context required" },
    });
  }

  const params = branchIdSchema.safeParse(request.params);
  if (!params.success) {
    return sendValidationError(reply, params.error.issues);
  }

  const body = updateBranchSchema.safeParse(request.body);
  if (!body.success) {
    return sendValidationError(reply, body.error.issues);
  }

  try {
    const branch = await updateBranch(
      params.data.id,
      auth.organizationId,
      body.data,
    );

    if (!branch) {
      return reply.status(404).send({
        success: false,
        error: { code: "BRANCH_NOT_FOUND", message: "Branch not found" },
      });
    }

    return reply.status(200).send({
      success: true,
      data: branch,
    });
  } catch (error: unknown) {
    request.log.error({ err: error }, "Failed to update branch");
    return sendInternalError(reply);
  }
}

export async function deleteBranchController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = getAuthContext(request);

  if (!auth) {
    return reply.status(401).send({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Login required" },
    });
  }

  if (!hasRole(auth, ["owner"])) {
    return reply.status(403).send({
      success: false,
      error: { code: "FORBIDDEN", message: "Owner access required" },
    });
  }

  if (!auth.organizationId) {
    return reply.status(403).send({
      success: false,
      error: { code: "ORGANIZATION_REQUIRED", message: "Organization context required" },
    });
  }

  const parsed = branchIdSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error.issues);
  }

  try {
    const branch = await deactivateBranch(
      parsed.data.id,
      auth.organizationId,
    );

    if (!branch) {
      return reply.status(404).send({
        success: false,
        error: { code: "BRANCH_NOT_FOUND", message: "Branch not found" },
      });
    }

    return reply.status(200).send({
      success: true,
      data: {
        id: branch.id,
        status: branch.status,
        message: "Branch deactivated successfully",
      },
    });
  } catch (error: unknown) {
    request.log.error({ err: error }, "Failed to deactivate branch");
    return sendInternalError(reply);
  }
}