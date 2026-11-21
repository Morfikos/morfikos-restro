import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  startTableSessionController,
  getGuestSessionController,
  placeGuestOrderController,
  createServiceRequestController,
  listTableSessionsController,
  getTableSessionController,
  closeTableSessionController,
  listQrOrdersController,
  acceptQrOrderController,
  rejectQrOrderController,
  listServiceRequestsController,
  acknowledgeServiceRequestController,
  resolveServiceRequestController,
  getQrSettingsController,
  updateQrSettingsController,
} from "./controller.js";

type QrCodeRoute = { Params: { qrCode: string } };
type TokenRoute = { Params: { token: string } };
type BranchRoute = { Params: { branchId: string } };
type SessionRoute = { Params: { sessionId: string } };
type QrOrderRoute = { Params: { qrOrderId: string } };
type ServiceRequestRoute = { Params: { requestId: string } };

const BRANCH_QR = "/api/v1/branches/:branchId/qr";

/**
 * Registers the QR table ordering routes: public guest routes (no login,
 * identified by the table QR code and session token) and staff routes.
 * The menu itself is served by GET /api/v1/public/t/:qrCode/menu.
 *
 * @param app - Fastify application instance.
 */
export async function qrRoutes(app: FastifyInstance) {
  const auth = { preHandler: authenticate };

  // ─── Guest (public) ───────────────────────────────────────────────────

  /**
   * Joins or opens the table's live session.
   * POST /api/v1/public/t/:qrCode/session
   */
  app.post<QrCodeRoute>("/api/v1/public/t/:qrCode/session", startTableSessionController);

  /**
   * Table status: rounds, dish status, bill and requests.
   * GET /api/v1/public/sessions/:token
   */
  app.get<TokenRoute>("/api/v1/public/sessions/:token", getGuestSessionController);

  /**
   * Places a round of items.
   * POST /api/v1/public/sessions/:token/orders
   */
  app.post<TokenRoute>("/api/v1/public/sessions/:token/orders", placeGuestOrderController);

  /**
   * Call waiter, water, napkins, cutlery, bill, cleaning or other.
   * POST /api/v1/public/sessions/:token/requests
   */
  app.post<TokenRoute>("/api/v1/public/sessions/:token/requests", createServiceRequestController);

  // ─── Staff ────────────────────────────────────────────────────────────

  /**
   * Lists live (or closed) table sessions.
   * GET /api/v1/branches/:branchId/qr/sessions?status=open|closed&limit=&offset=
   */
  app.get<BranchRoute>(`${BRANCH_QR}/sessions`, auth, listTableSessionsController);

  /**
   * Retrieves a table session.
   * GET /api/v1/qr/sessions/:sessionId
   */
  app.get<SessionRoute>("/api/v1/qr/sessions/:sessionId", auth, getTableSessionController);

  /**
   * Closes a table session (blocked while its order is unpaid).
   * POST /api/v1/qr/sessions/:sessionId/close
   */
  app.post<SessionRoute>("/api/v1/qr/sessions/:sessionId/close", auth, closeTableSessionController);

  /**
   * Lists QR rounds.
   * GET /api/v1/branches/:branchId/qr/orders?status=pending|accepted|rejected&limit=&offset=
   */
  app.get<BranchRoute>(`${BRANCH_QR}/orders`, auth, listQrOrdersController);

  /**
   * Accepts a waiting round and sends it to the kitchen.
   * POST /api/v1/qr/orders/:qrOrderId/accept
   */
  app.post<QrOrderRoute>("/api/v1/qr/orders/:qrOrderId/accept", auth, acceptQrOrderController);

  /**
   * Rejects a waiting round.
   * POST /api/v1/qr/orders/:qrOrderId/reject
   */
  app.post<QrOrderRoute>("/api/v1/qr/orders/:qrOrderId/reject", auth, rejectQrOrderController);

  /**
   * Lists table requests.
   * GET /api/v1/branches/:branchId/qr/requests?status=active|open|acknowledged|resolved&limit=&offset=
   */
  app.get<BranchRoute>(`${BRANCH_QR}/requests`, auth, listServiceRequestsController);

  /**
   * Acknowledges a table request.
   * POST /api/v1/qr/requests/:requestId/acknowledge
   */
  app.post<ServiceRequestRoute>(
    "/api/v1/qr/requests/:requestId/acknowledge",
    auth,
    acknowledgeServiceRequestController,
  );

  /**
   * Marks a table request as done.
   * POST /api/v1/qr/requests/:requestId/resolve
   */
  app.post<ServiceRequestRoute>(
    "/api/v1/qr/requests/:requestId/resolve",
    auth,
    resolveServiceRequestController,
  );

  /**
   * Retrieves QR ordering settings.
   * GET /api/v1/branches/:branchId/qr/settings
   */
  app.get<BranchRoute>(`${BRANCH_QR}/settings`, auth, getQrSettingsController);

  /**
   * Updates QR ordering settings (owner or manager).
   * PUT /api/v1/branches/:branchId/qr/settings
   */
  app.put<BranchRoute>(`${BRANCH_QR}/settings`, auth, updateQrSettingsController);
}
