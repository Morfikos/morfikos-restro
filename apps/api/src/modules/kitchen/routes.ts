import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { kitchenStreamQuerySchema } from "@morfikos/validation";
import { authenticate } from "../../middleware/authenticate.js";
import {
  listKitchenTicketsController,
  getKitchenTicketController,
  bumpKitchenTicketController,
  kitchenStreamController,
} from "./controller.js";

type KitchenBranchRoute = { Params: { branchId: string } };
type KitchenTicketRoute = { Params: { ticketId: string } };

/**
 * Authenticates the live stream. Browsers' EventSource cannot send an
 * Authorization header, so the access token may also come as ?accessToken=.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns An unauthorized response if the token is missing or invalid.
 */
async function authenticateStream(request: FastifyRequest, reply: FastifyReply) {
  const parsed = kitchenStreamQuerySchema.safeParse(request.query);

  if (!request.headers.authorization && parsed.success && parsed.data.accessToken) {
    request.headers.authorization = `Bearer ${parsed.data.accessToken}`;
  }

  return authenticate(request, reply);
}

/**
 * Registers the Kitchen Display System (KDS) API routes.
 *
 * @param app - Fastify application instance.
 */
export async function kitchenRoutes(app: FastifyInstance) {
  /**
   * Lists a branch's kitchen tickets grouped by station.
   * GET /api/v1/branches/:branchId/kitchen/tickets?status=&station=&limit=&offset=
   */
  app.get<KitchenBranchRoute>(
    "/api/v1/branches/:branchId/kitchen/tickets",
    { preHandler: authenticate },
    listKitchenTicketsController,
  );

  /**
   * Live kitchen stream (Server-Sent Events).
   * GET /api/v1/branches/:branchId/kitchen/stream
   */
  app.get<KitchenBranchRoute>(
    "/api/v1/branches/:branchId/kitchen/stream",
    { preHandler: authenticateStream },
    kitchenStreamController,
  );

  /**
   * Retrieves one kitchen ticket.
   * GET /api/v1/kitchen/tickets/:ticketId
   */
  app.get<KitchenTicketRoute>(
    "/api/v1/kitchen/tickets/:ticketId",
    { preHandler: authenticate },
    getKitchenTicketController,
  );

  /**
   * Bumps a ticket (or one item) to its next status.
   * POST /api/v1/kitchen/tickets/:ticketId/bump
   */
  app.post<KitchenTicketRoute>(
    "/api/v1/kitchen/tickets/:ticketId/bump",
    { preHandler: authenticate },
    bumpKitchenTicketController,
  );
}
