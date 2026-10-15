
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
  isPrismaUniqueConstraintError,
} from "../../utils/prisma-errors.js";
import { sendError, sendSucess } from "../../utils/response.js";


/**
 * Create an Organization
 *
 * @export
 * @async
 * @param {FastifyRequest} request 
 * @param {FastifyReply} reply 
 * @returns {unknown} 
 */
export async function createOrganizationController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = createOrganizationSchema.safeParse(
    request.body,
  );

  if (!result.success) {
    return sendError(
      reply,
      400,
      ORGANIZATION_MESSAGES.INVALID_BODY,
      result.error,
    );
  }

  try {
    const organization = await createOrganization(result.data);

    return sendSucess(
      reply,
      201,
      "Organization created successfully!",
      {
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt.toISOString(),
        status: organization.status,
      }
    );
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      // Verify the violated unique field before returning a GSTIN-specific message.
      return sendError(
        reply,
        409,
        ORGANIZATION_MESSAGES.GSTIN_CONFLICT,
        error
      )
    }

    request.log.error(
      { err: error },
      "Internal server error",
    );

    return sendError(
      reply,
      500,
      ORGANIZATION_MESSAGES.CREATE_FAILED,
      error,
    );
  }
}

/**
 * Get organization
 *
 * @export
 * @async
 * @param {FastifyRequest} request 
 * @param {FastifyReply} reply 
 * @returns {unknown} 
 */
export async function getOrganizationController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = organizationIdSchema.safeParse(
    request.params,
  );

  if (!result.success) {
    return sendError(
      reply,
      400,
      ORGANIZATION_MESSAGES.INVALID_ID,
      result.error
    );
  }

  try {
    const organization = await getOrganization(result.data.id);

    if (!organization) {
      return sendError(
        reply,
        404,
        ORGANIZATION_MESSAGES.NOT_FOUND,
        new Error(
          "Organization doesn't exist"
        )
      )
    }

    return sendSucess(
      reply,
      200,
      "Organization fetched sucessfully",
      organization
    )
  }

  catch (error: unknown) {
    request.log.error(
      { err: error },
      "Internal server error",
    );

    return sendError(
      reply,
      500,
      ORGANIZATION_MESSAGES.GET_FAILED,
      error
    )
  }
}
