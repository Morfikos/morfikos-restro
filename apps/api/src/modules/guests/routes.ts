import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  createGuestController,
  saveGuestConsentController,
  getGuestController,
  listGuestsController,
  updateGuestController,
  listLoyaltyController,
  adjustLoyaltyController,
} from "./controller.js";

type GuestRoute = { Params: { guestId: string } };

/**
 * PreHandler for routes open to both staff and table QR guests: verifies
 * the token when an Authorization header is sent, and otherwise lets the
 * request through as a public (QR) call.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns An unauthorized response if a sent token is invalid.
 */
async function optionalAuthenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.headers.authorization) {
    return;
  }

  return authenticate(request, reply);
}

/**
 * Registers the guest and loyalty API routes.
 *
 * @param app - Fastify application instance.
 */
export async function guestRoutes(app: FastifyInstance) {
  /**
   * Creates a guest or finds one by phone (staff, or public with qrCode).
   * POST /api/v1/guests
   */
  app.post("/api/v1/guests", { preHandler: optionalAuthenticate }, createGuestController);

  /**
   * Lists guests with segment and last-visit filters (owner/manager).
   * GET /api/v1/guests?group=&from=&to=&search=&limit=&offset=
   */
  app.get("/api/v1/guests", { preHandler: authenticate }, listGuestsController);

  /**
   * Retrieves a guest's profile and visit history.
   * GET /api/v1/guests/:guestId
   */
  app.get<GuestRoute>("/api/v1/guests/:guestId", { preHandler: authenticate }, getGuestController);

  /**
   * Updates a guest's name, email or notes.
   * PUT /api/v1/guests/:guestId
   */
  app.put<GuestRoute>("/api/v1/guests/:guestId", { preHandler: authenticate }, updateGuestController);

  /**
   * Records a guest's marketing consent (staff, or public with qrCode).
   * POST /api/v1/guests/:guestId/consents
   */
  app.post<GuestRoute>(
    "/api/v1/guests/:guestId/consents",
    { preHandler: optionalAuthenticate },
    saveGuestConsentController,
  );

  /**
   * Lists a guest's loyalty points ledger.
   * GET /api/v1/guests/:guestId/loyalty?limit=&offset=
   */
  app.get<GuestRoute>(
    "/api/v1/guests/:guestId/loyalty",
    { preHandler: authenticate },
    listLoyaltyController,
  );

  /**
   * Adds or removes loyalty points by hand (owner/manager).
   * POST /api/v1/guests/:guestId/loyalty/adjust
   */
  app.post<GuestRoute>(
    "/api/v1/guests/:guestId/loyalty/adjust",
    { preHandler: authenticate },
    adjustLoyaltyController,
  );
}
