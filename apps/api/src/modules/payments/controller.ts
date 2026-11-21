import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  confirmPaymentRequestSchema,
  createGuestPaymentSchema,
  createPaymentRequestSchema,
  guestPaymentParamsSchema,
  listPaymentRequestsQuerySchema,
  paymentBillParamsSchema,
  paymentBranchParamsSchema,
  paymentRequestIdParamsSchema,
  rejectPaymentRequestSchema,
  sessionTokenParamsSchema,
  submitGuestPaymentSchema,
  updatePaymentSettingsSchema,
} from "@morfikos/validation";

import {
  cancelPaymentRequest,
  confirmPaymentRequest,
  createGuestPayment,
  createPaymentRequest,
  getGuestBill,
  getGuestPayment,
  getPaymentRequest,
  getPaymentSettings,
  isPaymentServiceError,
  listPaymentRequests,
  rejectPaymentRequest,
  submitGuestPayment,
  updatePaymentSettings,
  type PaymentActor,
} from "./service.js";

import { PAYMENT_CASHIER_ROLES, PAYMENT_MANAGER_ROLES, PAYMENT_STAFF_ROLES } from "./constants.js";

import { handleBillingServiceError } from "../billing/controller.js";

import { handleQrServiceError } from "../qr/controller.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type BranchRequest = FastifyRequest<{ Params: { branchId: string } }>;
type BillRequest = FastifyRequest<{ Params: { branchId: string; billId: string } }>;
type PaymentRequestRequest = FastifyRequest<{ Params: { requestId: string } }>;
type TokenRequest = FastifyRequest<{ Params: { token: string } }>;
type GuestPaymentRequest = FastifyRequest<{ Params: { token: string; requestId: string } }>;

/**
 * Sends an authentication error when the user is not logged in.
 *
 * @param reply - The Fastify reply instance.
 * @returns An unauthorized response.
 */
function sendUnauthenticated(reply: FastifyReply) {
  return sendError(
    reply,
    401,
    "Login required",
    ErrorCode.UNAUTHENTICATED,
  );
}

/**
 * Sends an authorization error when the user lacks permission.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendForbidden(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Access denied",
    ErrorCode.FORBIDDEN,
  );
}

/**
 * Sends a response when the organization context is missing.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendMissingOrganization(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Organization context is missing",
    ErrorCode.FORBIDDEN,
  );
}

/**
 * Sends a response when the payment request does not exist.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendRequestNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Payment request not found",
    ErrorCode.PAYMENT_REQUEST_NOT_FOUND,
  );
}

/**
 * Sends a validation error using the first validation issue as the message.
 *
 * @param reply - The Fastify reply instance.
 * @param error - The Zod validation error.
 * @returns A bad-request response.
 */
function sendValidationError(
  reply: FastifyReply,
  error: Pick<ZodError, "issues">,
) {
  return sendError(
    reply,
    400,
    error.issues[0]?.message ?? "Request validation failed",
    ErrorCode.VALIDATION_ERROR,
  );
}

/**
 * Sends a generic server error after logging the underlying error.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param error - The unexpected error.
 * @param logMessage - The message to log alongside the error.
 * @returns An internal server error response.
 */
function sendUnexpectedError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
) {
  request.log.error(
    { err: error },
    logMessage,
  );

  return sendError(
    reply,
    500,
    "An unexpected error occurred",
    ErrorCode.INTERNAL_SERVER_ERROR,
  );
}

/**
 * Verifies the user is logged in with one of the allowed roles and an
 * organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The payment actor, or null after an error response was sent.
 */
function authorizePaymentRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = PAYMENT_STAFF_ROLES,
): PaymentActor | null {
  const context = getAuthContext(request);

  if (!context) {
    sendUnauthenticated(reply);
    return null;
  }

  if (!hasRole(context, allowedRoles)) {
    sendForbidden(reply);
    return null;
  }

  const organizationId = getOrganizationId(request);

  if (!organizationId) {
    sendMissingOrganization(reply);
    return null;
  }

  return {
    userId: context.userId,
    role: context.role,
    organizationId,
    branchIds: context.branchIds,
  };
}

/**
 * Handles known payment service errors.
 *
 * @param error - The error thrown by the payment service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handlePaymentServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isPaymentServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "SPLIT_PART_REQUIRED":
      return sendError(reply, 400, error.message, ErrorCode.SPLIT_PART_REQUIRED);

    case "AMOUNT_EXCEEDS_DUE":
      return sendError(reply, 400, error.message, ErrorCode.AMOUNT_EXCEEDS_DUE);

    case "BRANCH_ACCESS_DENIED":
      return sendError(reply, 403, error.message, ErrorCode.BRANCH_ACCESS_DENIED);

    case "GUEST_PAYMENTS_DISABLED":
      return sendError(reply, 403, error.message, ErrorCode.GUEST_PAYMENTS_DISABLED);

    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    case "BILL_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BILL_NOT_FOUND);

    case "SPLIT_PART_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.SPLIT_PART_NOT_FOUND);

    case "PAYMENT_REQUEST_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.PAYMENT_REQUEST_NOT_FOUND);

    case "BILL_NOT_OPEN":
      return sendError(reply, 409, error.message, ErrorCode.BILL_NOT_OPEN);

    case "BILL_NOT_READY":
      return sendError(reply, 409, error.message, ErrorCode.BILL_NOT_READY);

    case "UPI_NOT_CONFIGURED":
      return sendError(reply, 409, error.message, ErrorCode.UPI_NOT_CONFIGURED);

    case "NOTHING_DUE":
      return sendError(reply, 409, error.message, ErrorCode.NOTHING_DUE);

    case "PAYMENT_REQUEST_CLOSED":
      return sendError(reply, 409, error.message, ErrorCode.PAYMENT_REQUEST_CLOSED);

    case "DUPLICATE_UTR":
      return sendError(reply, 409, error.message, ErrorCode.DUPLICATE_UTR);

    default:
      return null;
  }
}

/**
 * Sends the response for a caught error: a payment error, a billing error
 * raised while recording the payment, a QR session error, or a 500.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param error - The caught error.
 * @param logMessage - The message to log for unexpected errors.
 * @returns The error response.
 */
function sendCaughtError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
) {
  const handled =
    handlePaymentServiceError(error, reply) ??
    handleBillingServiceError(error, reply) ??
    handleQrServiceError(error, reply);

  if (handled) {
    return handled;
  }

  return sendUnexpectedError(request, reply, error, logMessage);
}

// ─── Settings ───────────────────────────────────────────────────────────

/**
 * Retrieves a branch's UPI payment settings.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns The settings or an error response.
 */
export async function getPaymentSettingsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizePaymentRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = paymentBranchParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const settings = await getPaymentSettings(actor, parsed.data.branchId);

    return sendSuccess(reply, 200, "Payment settings retrieved successfully", settings);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get payment settings");
  }
}

/**
 * Updates a branch's UPI payment settings (owner or manager).
 *
 * @param request - The incoming request containing the branch ID and settings.
 * @param reply - The Fastify reply instance.
 * @returns The updated settings or an error response.
 */
export async function updatePaymentSettingsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizePaymentRequest(request, reply, PAYMENT_MANAGER_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = paymentBranchParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updatePaymentSettingsSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const settings = await updatePaymentSettings(actor, parsedParams.data.branchId, parsedBody.data);

    return sendSuccess(reply, 200, "Payment settings updated successfully", settings);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update payment settings");
  }
}

// ─── Staff ──────────────────────────────────────────────────────────────

/**
 * Creates a dynamic UPI QR for a bill or split part.
 *
 * @param request - The incoming request containing the bill and options.
 * @param reply - The Fastify reply instance.
 * @returns The request with its QR (201 new, 200 reused) or an error response.
 */
export async function createPaymentRequestController(
  request: BillRequest,
  reply: FastifyReply,
) {
  const actor = authorizePaymentRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = paymentBillParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = createPaymentRequestSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await createPaymentRequest(
      actor,
      parsedParams.data.branchId,
      parsedParams.data.billId,
      parsedBody.data,
    );

    return sendSuccess(
      reply,
      result.created ? 201 : 200,
      result.created ? "UPI QR created" : "This UPI QR is still valid",
      result.request,
    );
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to create UPI payment request");
  }
}

/**
 * Lists a branch's UPI payment requests.
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The requests or an error response.
 */
export async function listPaymentRequestsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizePaymentRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = paymentBranchParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listPaymentRequestsQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const requests = await listPaymentRequests(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Payment requests retrieved successfully", requests);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list payment requests");
  }
}

/**
 * Retrieves a payment request with its QR.
 *
 * @param request - The incoming request containing the request ID.
 * @param reply - The Fastify reply instance.
 * @returns The request or an error response.
 */
export async function getPaymentRequestController(
  request: PaymentRequestRequest,
  reply: FastifyReply,
) {
  const actor = authorizePaymentRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = paymentRequestIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const payment = await getPaymentRequest(actor, parsed.data.requestId);

    if (!payment) {
      return sendRequestNotFound(reply);
    }

    return sendSuccess(reply, 200, "Payment request retrieved successfully", payment);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get payment request");
  }
}

/**
 * Confirms the money arrived and records the UPI payment (cashier roles).
 *
 * @param request - The incoming request containing the request ID, UTR and amount.
 * @param reply - The Fastify reply instance.
 * @returns The confirmed request and bill status, or an error response.
 */
export async function confirmPaymentRequestController(
  request: PaymentRequestRequest,
  reply: FastifyReply,
) {
  const actor = authorizePaymentRequest(request, reply, PAYMENT_CASHIER_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = paymentRequestIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = confirmPaymentRequestSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await confirmPaymentRequest(actor, parsedParams.data.requestId, parsedBody.data);

    if (!result) {
      return sendRequestNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      result.bill.status === "settled" ? "Payment confirmed. The bill is settled." : "Payment confirmed",
      result,
    );
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to confirm payment");
  }
}

/**
 * Rejects a payment request (cashier roles).
 *
 * @param request - The incoming request containing the request ID and reason.
 * @param reply - The Fastify reply instance.
 * @returns The request or an error response.
 */
export async function rejectPaymentRequestController(
  request: PaymentRequestRequest,
  reply: FastifyReply,
) {
  const actor = authorizePaymentRequest(request, reply, PAYMENT_CASHIER_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = paymentRequestIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = rejectPaymentRequestSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const payment = await rejectPaymentRequest(actor, parsedParams.data.requestId, parsedBody.data.reason);

    if (!payment) {
      return sendRequestNotFound(reply);
    }

    return sendSuccess(reply, 200, "Payment request rejected", payment);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to reject payment request");
  }
}

/**
 * Cancels a waiting UPI QR.
 *
 * @param request - The incoming request containing the request ID.
 * @param reply - The Fastify reply instance.
 * @returns The request or an error response.
 */
export async function cancelPaymentRequestController(
  request: PaymentRequestRequest,
  reply: FastifyReply,
) {
  const actor = authorizePaymentRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = paymentRequestIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const payment = await cancelPaymentRequest(actor, parsed.data.requestId);

    if (!payment) {
      return sendRequestNotFound(reply);
    }

    return sendSuccess(reply, 200, "Payment request cancelled", payment);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to cancel payment request");
  }
}

// ─── Guest (public, table QR session) ───────────────────────────────────

/**
 * The guest's bill, split parts and payments.
 *
 * @param request - The incoming request containing the session token.
 * @param reply - The Fastify reply instance.
 * @returns The bill view or an error response.
 */
export async function getGuestBillController(
  request: TokenRequest,
  reply: FastifyReply,
) {
  const parsed = sessionTokenParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const bill = await getGuestBill(parsed.data.token);

    return sendSuccess(reply, 200, "Bill retrieved successfully", bill);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get guest bill");
  }
}

/**
 * A guest starts a UPI payment from the table.
 *
 * @param request - The incoming request containing the session token and part.
 * @param reply - The Fastify reply instance.
 * @returns The payment with its UPI link and QR, or an error response.
 */
export async function createGuestPaymentController(
  request: TokenRequest,
  reply: FastifyReply,
) {
  const parsedParams = sessionTokenParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = createGuestPaymentSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const payment = await createGuestPayment(parsedParams.data.token, parsedBody.data);

    return sendSuccess(reply, 201, "Tap the link or scan the QR to pay with any UPI app", payment);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to start guest payment");
  }
}

/**
 * Status of a guest's payment.
 *
 * @param request - The incoming request containing the session token and request ID.
 * @param reply - The Fastify reply instance.
 * @returns The payment or an error response.
 */
export async function getGuestPaymentController(
  request: GuestPaymentRequest,
  reply: FastifyReply,
) {
  const parsed = guestPaymentParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const payment = await getGuestPayment(parsed.data.token, parsed.data.requestId);

    return sendSuccess(reply, 200, "Payment status retrieved successfully", payment);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get guest payment");
  }
}

/**
 * The guest submits the UTR after paying.
 *
 * @param request - The incoming request containing the session token, request ID and UTR.
 * @param reply - The Fastify reply instance.
 * @returns The payment (waiting for staff) or an error response.
 */
export async function submitGuestPaymentController(
  request: GuestPaymentRequest,
  reply: FastifyReply,
) {
  const parsedParams = guestPaymentParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = submitGuestPaymentSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const payment = await submitGuestPayment(parsedParams.data.token, parsedParams.data.requestId, parsedBody.data);

    return sendSuccess(reply, 200, "Thanks! The staff will confirm your payment shortly.", payment);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to submit guest payment");
  }
}
