import type {
  FastifyReply,
  FastifyRequest,
} from "fastify"

import {
  createOrganizationSchema,
  organizationIdSchema,
} from "@morfikos/validation"

import {
  createOrganization,
  getOrganization,
} from "./service.js"

export async function createOrganizationController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = createOrganizationSchema.safeParse(
    request.body,
  )

  if (!result.success) {
    return reply.status(400).send({
      message: "Invalid request body",
      errors: result.error.flatten(),
    })
  }

  try {
    const organization = await createOrganization(
      result.data,
    )

    return reply.status(201).send({
      id: organization.id,
      name: organization.name,
      createdAt: organization.createdAt.toISOString(),
      status: organization.status,
    })
  } catch (error: any) {
    request.log.error(error)

    if (error?.code === "P2002") {
      return reply.status(409).send({
        message: "Organization with this GSTIN already exists",
      })
    }

    return reply.status(500).send({
      message: "Failed to create organization",
    })
  }
}

export async function getOrganizationController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const result = organizationIdSchema.safeParse(
    request.params,
  )

  if (!result.success) {
    return reply.status(400).send({
      message: "Invalid organization ID",
      errors: result.error.flatten(),
    })
  }

  try {
    const organization = await getOrganization(
      result.data.id,
    )

    if (!organization) {
      return reply.status(404).send({
        message: "Organization not found",
      })
    }

    return reply.status(200).send(organization)
  } catch (error) {
    request.log.error(error)

    return reply.status(500).send({
      message: "Failed to get organization",
    })
  }
}