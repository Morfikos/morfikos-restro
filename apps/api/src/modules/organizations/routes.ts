
import type { FastifyInstance } from "fastify";

import {
  createOrganizationController,
  getOrganizationController,
} from "./controller.js";

/**
 * Registers organization API routes.
 *
 * @param app - Fastify application instance
 */
export async function organizationRoutes(
  app: FastifyInstance,
) {
  /**
   * Creates a new organization.
   *
   * POST /api/v1/organizations
   * Handles organization creation and request validation.
   */
  app.post(
    "/api/v1/organizations",
    createOrganizationController,
  );

  /**
   * Retrieves an organization by its ID.
   *
   * GET /api/v1/organizations/:id
   * Handles organization lookup and request validation.
   */
  app.get(
    "/api/v1/organizations/:id",
    getOrganizationController,
  );
}
