
import type {
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  createOrganizationSchema,
  organizationIdSchema,
} from "@morfikos/validation";

import {
  createOrganization,
  getOrganization,
} from "./service.js";

import {
  ORGANIZATION_MESSAGES,
} from "./constants.js";

import {
  HTTP_STATUS,
} from "../../utils/http-status.js";

import {
  sendValidationError,
  sendInternalServerError,
} from "../../utils/http-errors.js";

import {
  isPrismaUniqueConstraintError,
} from "../../utils/prisma-errors.js";

/**
 * Creates an organization after validating the request body.
 */
export async function createOrganizationController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = createOrganizationSchema.safeParse(
    request.body,
  );

  if (!result.success) {
    return sendValidationError(
      reply,
      ORGANIZATION_MESSAGES.INVALID_BODY,
      result.error,
    );
  }

  try {
    const organization = await createOrganization(result.data);

    return reply.status(HTTP_STATUS.CREATED).send({
      id: organization.id,
      name: organization.name,
      createdAt: organization.createdAt.toISOString(),
      status: organization.status,
    });
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      // Verify the violated unique field before returning a GSTIN-specific message.
      return reply.status(HTTP_STATUS.CONFLICT).send({
        message: ORGANIZATION_MESSAGES.GSTIN_CONFLICT,
      });
    }

    return sendInternalServerError(
      request,
      reply,
      ORGANIZATION_MESSAGES.CREATE_FAILED,
      error,
    );
  }
}

/**
 * Retrieves an organization by its ID.
 */
export async function getOrganizationController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = organizationIdSchema.safeParse(
    request.params,
  );

  if (!result.success) {
    return sendValidationError(
      reply,
      ORGANIZATION_MESSAGES.INVALID_ID,
      result.error,
    );
  }

  try {
    const organization = await getOrganization(result.data.id);

    if (!organization) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({
        message: ORGANIZATION_MESSAGES.NOT_FOUND,
      });
    }

    return reply.status(HTTP_STATUS.OK).send(organization);
  } catch (error: unknown) {
    return sendInternalServerError(
      request,
      reply,
      ORGANIZATION_MESSAGES.GET_FAILED,
      error,
    );
  }
}
