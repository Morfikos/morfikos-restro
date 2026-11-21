import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  getPaymentSettingsController,
  updatePaymentSettingsController,
  createPaymentRequestController,
  listPaymentRequestsController,
  getPaymentRequestController,
  confirmPaymentRequestController,
  rejectPaymentRequestController,
  cancelPaymentRequestController,
  getGuestBillController,
  createGuestPaymentController,
  getGuestPaymentController,
  submitGuestPaymentController,
} from "./controller.js";

type BranchRoute = { Params: { branchId: string } };
type BillRoute = { Params: { branchId: string; billId: string } };
type PaymentRequestRoute = { Params: { requestId: string } };
type TokenRoute = { Params: { token: string } };
type GuestPaymentRoute = { Params: { token: string; requestId: string } };

/**
 * Registers the UPI payment routes: branch UPI settings, dynamic UPI QRs
 * for bills and split parts, staff confirmation, and guest payment from
 * the table QR session (public, identified by the session token).
 *
 * @param app - Fastify application instance.
 */
export async function paymentRoutes(app: FastifyInstance) {
  const auth = { preHandler: authenticate };

  // ─── Settings ─────────────────────────────────────────────────────────

  /**
   * Branch UPI settings.
   * GET /api/v1/branches/:branchId/payment-settings
   */
  app.get<BranchRoute>("/api/v1/branches/:branchId/payment-settings", auth, getPaymentSettingsController);

  /**
   * Updates the branch's UPI ID and options (owner or manager).
   * PUT /api/v1/branches/:branchId/payment-settings
   */
  app.put<BranchRoute>("/api/v1/branches/:branchId/payment-settings", auth, updatePaymentSettingsController);

  // ─── Staff ────────────────────────────────────────────────────────────

  /**
   * Creates a dynamic UPI QR for a bill or split part.
   * POST /api/v1/branches/:branchId/bills/:billId/upi-requests
   */
  app.post<BillRoute>("/api/v1/branches/:branchId/bills/:billId/upi-requests", auth, createPaymentRequestController);

  /**
   * Lists UPI payment requests.
   * GET /api/v1/branches/:branchId/payment-requests?status=&billId=&open=&limit=&offset=
   */
  app.get<BranchRoute>("/api/v1/branches/:branchId/payment-requests", auth, listPaymentRequestsController);

  /**
   * One payment request with its QR (poll for status).
   * GET /api/v1/payment-requests/:requestId
   */
  app.get<PaymentRequestRoute>("/api/v1/payment-requests/:requestId", auth, getPaymentRequestController);

  /**
   * Confirms the money arrived and records the payment.
   * POST /api/v1/payment-requests/:requestId/confirm
   */
  app.post<PaymentRequestRoute>("/api/v1/payment-requests/:requestId/confirm", auth, confirmPaymentRequestController);

  /**
   * Rejects a payment (UTR doesn't match money received).
   * POST /api/v1/payment-requests/:requestId/reject
   */
  app.post<PaymentRequestRoute>("/api/v1/payment-requests/:requestId/reject", auth, rejectPaymentRequestController);

  /**
   * Cancels a waiting QR.
   * POST /api/v1/payment-requests/:requestId/cancel
   */
  app.post<PaymentRequestRoute>("/api/v1/payment-requests/:requestId/cancel", auth, cancelPaymentRequestController);

  // ─── Guest (public) ───────────────────────────────────────────────────

  /**
   * The guest's bill, split parts and payments.
   * GET /api/v1/public/sessions/:token/bill
   */
  app.get<TokenRoute>("/api/v1/public/sessions/:token/bill", getGuestBillController);

  /**
   * Starts a UPI payment from the table.
   * POST /api/v1/public/sessions/:token/payments
   */
  app.post<TokenRoute>("/api/v1/public/sessions/:token/payments", createGuestPaymentController);

  /**
   * Payment status.
   * GET /api/v1/public/sessions/:token/payments/:requestId
   */
  app.get<GuestPaymentRoute>("/api/v1/public/sessions/:token/payments/:requestId", getGuestPaymentController);

  /**
   * "I've paid": submits the UTR for staff to confirm.
   * POST /api/v1/public/sessions/:token/payments/:requestId/submit
   */
  app.post<GuestPaymentRoute>(
    "/api/v1/public/sessions/:token/payments/:requestId/submit",
    submitGuestPaymentController,
  );
}
