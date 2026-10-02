import type { FastifyInstance } from "fastify"

import {
  createOrganizationController,
  getOrganizationController,
} from "./controller.js"

export async function organizationRoutes(
  app: FastifyInstance,
) {
  app.post(
    "/api/v1/organizations",
    createOrganizationController,
  )

  app.get(
    "/api/v1/organizations/:id",
    getOrganizationController,
  )
}