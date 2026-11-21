import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  branchQrParamsSchema,
  closeTableSessionSchema,
  createServiceRequestSchema,
  listQrOrdersQuerySchema,
  listServiceRequestsQuerySchema,
  listTableSessionsQuerySchema,
  placeQrOrderSchema,
  qrCodeParamsSchema,
  qrOrderIdParamsSchema,
  rejectQrOrderSchema,
  serviceRequestIdParamsSchema,
  sessionTokenParamsSchema,
  startTableSessionSchema,
  tableSessionIdParamsSchema,
  updateQrSettingsSchema,
} from "@morfikos/validation";

import {
  acceptQrOrder,
  closeTableSession,
  createServiceRequest,
  getGuestSession,
  getQrSettings,
  getTableSession,
  isQrServiceError,
  listQrOrders,
  listServiceRequests,
  listTableSessions,
  placeGuestOrder,
  rejectQrOrder,
  startTableSession,
  updateQrSettings,
  updateServiceRequest,
  type QrActor,
} from "./service.js";

import { QR_MANAGER_ROLES, QR_STAFF_ROLES } from "./constants.js";

import { handleOrderServiceError } from "../orders/controller.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type QrCodeRequest = FastifyRequest<{ Params: { qrCode: string } }>;
type TokenRequest = FastifyRequest<{ Params: { token: string } }>;
type BranchRequest = FastifyRequest<{ Params: { branchId: string } }>;
type SessionRequest = FastifyRequest<{ Params: { sessionId: string } }>;
type QrOrderRequest = FastifyRequest<{ Params: { qrOrderId: string } }>;
type ServiceRequestRequest = FastifyRequest<{ Params: { requestId: string } }>;

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
 * Verifies the user is logged in with one of the allowed roles (any
 * floor staff by default) and an organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The QR actor, or null after an error response was sent.
 */
function authorizeQrRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = QR_STAFF_ROLES,
): QrActor | null {
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
 * Handles known QR service errors.
 *
 * @param error - The error thrown by the QR service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleQrServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isQrServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "PHONE_REQUIRED":
      return sendError(reply, 400, error.message, ErrorCode.PHONE_REQUIRED);

    case "ORDERING_DISABLED":
      return sendError(reply, 403, error.message, ErrorCode.ORDERING_DISABLED);

    case "SERVICE_REQUESTS_DISABLED":
      return sendError(reply, 403, error.message, ErrorCode.SERVICE_REQUESTS_DISABLED);

    case "BRANCH_ACCESS_DENIED":
      return sendError(reply, 403, error.message, ErrorCode.BRANCH_ACCESS_DENIED);

    case "TABLE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.TABLE_NOT_FOUND);

    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    case "SESSION_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.SESSION_NOT_FOUND);

    case "QR_ORDER_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.QR_ORDER_NOT_FOUND);

    case "SERVICE_REQUEST_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.SERVICE_REQUEST_NOT_FOUND);

    case "ITEM_UNAVAILABLE":
      return sendError(reply, 409, error.message, ErrorCode.ITEM_UNAVAILABLE);

    case "QR_ORDER_ALREADY_DECIDED":
      return sendError(reply, 409, error.message, ErrorCode.QR_ORDER_ALREADY_DECIDED);

    case "SESSION_HAS_UNPAID_BILL":
      return sendError(reply, 409, error.message, ErrorCode.SESSION_HAS_UNPAID_BILL);

    case "SESSION_CLOSED":
      return sendError(reply, 410, error.message, ErrorCode.SESSION_CLOSED);

    case "TOO_MANY_PENDING_ORDERS":
      return sendError(reply, 429, error.message, ErrorCode.TOO_MANY_PENDING_ORDERS);

    default:
      return null;
  }
}

/**
 * Sends the response for a caught error: a QR error, an order error raised
 * while sending a round to the kitchen (unavailable item, quantity limit,
 * bill already printed, out of stock), or a 500.
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
  const handled = handleQrServiceError(error, reply) ?? handleOrderServiceError(error, reply);

  if (handled) {
    return handled;
  }

  return sendUnexpectedError(request, reply, error, logMessage);
}

// ─── Guest (public) ─────────────────────────────────────────────────────

/**
 * Joins or opens the table's live session (no login; the table QR code
 * identifies the restaurant and table).
 *
 * @param request - The incoming request containing the QR code and guest details.
 * @param reply - The Fastify reply instance.
 * @returns The session token and view (201 when opened, 200 when joined) or an error response.
 */
export async function startTableSessionController(
  request: QrCodeRequest,
  reply: FastifyReply,
) {
  const parsedParams = qrCodeParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = startTableSessionSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await startTableSession(parsedParams.data.qrCode, parsedBody.data);

    return sendSuccess(
      reply,
      result.joined ? 200 : 201,
      result.joined ? "Joined the table" : "Table session started",
      result,
    );
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to start table session");
  }
}

/**
 * Retrieves the guest's table status: rounds, dish status, bill and requests.
 *
 * @param request - The incoming request containing the session token.
 * @param reply - The Fastify reply instance.
 * @returns The session view or an error response.
 */
export async function getGuestSessionController(
  request: TokenRequest,
  reply: FastifyReply,
) {
  const parsed = sessionTokenParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const session = await getGuestSession(parsed.data.token);

    return sendSuccess(reply, 200, "Table status retrieved successfully", session);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get table status");
  }
}

/**
 * Places a round of items from the QR menu.
 *
 * @param request - The incoming request containing the session token and items.
 * @param reply - The Fastify reply instance.
 * @returns The round and updated session view or an error response.
 */
export async function placeGuestOrderController(
  request: TokenRequest,
  reply: FastifyReply,
) {
  const parsedParams = sessionTokenParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = placeQrOrderSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await placeGuestOrder(parsedParams.data.token, parsedBody.data);

    return sendSuccess(
      reply,
      201,
      result.sentToKitchen ? "Order sent to the kitchen" : "Order placed. Waiting for the staff to confirm.",
      result,
    );
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to place QR order");
  }
}

/**
 * Sends a request from the table (call waiter, water, bill…).
 *
 * @param request - The incoming request containing the session token and request type.
 * @param reply - The Fastify reply instance.
 * @returns The request (201 when new, 200 when already open) or an error response.
 */
export async function createServiceRequestController(
  request: TokenRequest,
  reply: FastifyReply,
) {
  const parsedParams = sessionTokenParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = createServiceRequestSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await createServiceRequest(parsedParams.data.token, parsedBody.data);

    return sendSuccess(
      reply,
      result.created ? 201 : 200,
      result.created ? "The staff has been notified" : "The staff has already been notified",
      result.request,
    );
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to create service request");
  }
}

// ─── Staff ──────────────────────────────────────────────────────────────

/**
 * Lists a branch's table sessions.
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The sessions or an error response.
 */
export async function listTableSessionsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchQrParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listTableSessionsQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const sessions = await listTableSessions(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Table sessions retrieved successfully", sessions);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list table sessions");
  }
}

/**
 * Retrieves a table session.
 *
 * @param request - The incoming request containing the session ID.
 * @param reply - The Fastify reply instance.
 * @returns The session or an error response.
 */
export async function getTableSessionController(
  request: SessionRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = tableSessionIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const session = await getTableSession(actor, parsed.data.sessionId);

    if (!session) {
      return sendError(reply, 404, "Table session not found", ErrorCode.SESSION_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Table session retrieved successfully", session);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get table session");
  }
}

/**
 * Closes a table session (blocked while its order is unpaid).
 *
 * @param request - The incoming request containing the session ID and reason.
 * @param reply - The Fastify reply instance.
 * @returns The closed session or an error response.
 */
export async function closeTableSessionController(
  request: SessionRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = tableSessionIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = closeTableSessionSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const session = await closeTableSession(actor, parsedParams.data.sessionId, parsedBody.data.reason);

    if (!session) {
      return sendError(reply, 404, "Table session not found", ErrorCode.SESSION_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Table session closed", session);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to close table session");
  }
}

/**
 * Lists a branch's QR rounds (waiting for acceptance by default).
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The rounds or an error response.
 */
export async function listQrOrdersController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchQrParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listQrOrdersQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const orders = await listQrOrders(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "QR orders retrieved successfully", orders);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list QR orders");
  }
}

/**
 * Accepts a waiting QR round and sends it to the kitchen.
 *
 * @param request - The incoming request containing the round ID.
 * @param reply - The Fastify reply instance.
 * @returns The accepted round or an error response.
 */
export async function acceptQrOrderController(
  request: QrOrderRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = qrOrderIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const order = await acceptQrOrder(actor, parsed.data.qrOrderId);

    if (!order) {
      return sendError(reply, 404, "QR order not found", ErrorCode.QR_ORDER_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Order accepted and sent to the kitchen", order);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to accept QR order");
  }
}

/**
 * Rejects a waiting QR round.
 *
 * @param request - The incoming request containing the round ID and reason.
 * @param reply - The Fastify reply instance.
 * @returns The rejected round or an error response.
 */
export async function rejectQrOrderController(
  request: QrOrderRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = qrOrderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = rejectQrOrderSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const order = await rejectQrOrder(actor, parsedParams.data.qrOrderId, parsedBody.data.reason);

    if (!order) {
      return sendError(reply, 404, "QR order not found", ErrorCode.QR_ORDER_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Order rejected", order);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to reject QR order");
  }
}

/**
 * Lists a branch's table requests (active by default).
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The requests or an error response.
 */
export async function listServiceRequestsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchQrParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listServiceRequestsQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const requests = await listServiceRequests(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Table requests retrieved successfully", requests);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to list table requests");
  }
}

/**
 * Builds a controller that acknowledges or resolves a table request.
 *
 * @param resolve - True to mark it done, false to acknowledge it.
 * @returns The controller.
 */
function updateServiceRequestController(resolve: boolean) {
  return async function (request: ServiceRequestRequest, reply: FastifyReply) {
    const actor = authorizeQrRequest(request, reply);

    if (!actor) {
      return reply;
    }

    const parsed = serviceRequestIdParamsSchema.safeParse(request.params);

    if (!parsed.success) {
      return sendValidationError(reply, parsed.error);
    }

    try {
      const updated = await updateServiceRequest(actor, parsed.data.requestId, resolve);

      if (!updated) {
        return sendError(reply, 404, "Table request not found", ErrorCode.SERVICE_REQUEST_NOT_FOUND);
      }

      return sendSuccess(reply, 200, resolve ? "Request marked as done" : "Request acknowledged", updated);
    } catch (error: unknown) {
      return sendCaughtError(request, reply, error, "Failed to update table request");
    }
  };
}

/**
 * Acknowledges a table request ("on my way").
 */
export const acknowledgeServiceRequestController = updateServiceRequestController(false);

/**
 * Marks a table request as done.
 */
export const resolveServiceRequestController = updateServiceRequestController(true);

/**
 * Retrieves a branch's QR ordering settings.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns The settings or an error response.
 */
export async function getQrSettingsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = branchQrParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const settings = await getQrSettings(actor, parsed.data.branchId);

    return sendSuccess(reply, 200, "QR settings retrieved successfully", settings);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to get QR settings");
  }
}

/**
 * Updates a branch's QR ordering settings (owner or manager).
 *
 * @param request - The incoming request containing the branch ID and settings.
 * @param reply - The Fastify reply instance.
 * @returns The updated settings or an error response.
 */
export async function updateQrSettingsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeQrRequest(request, reply, QR_MANAGER_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = branchQrParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateQrSettingsSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const settings = await updateQrSettings(actor, parsedParams.data.branchId, parsedBody.data);

    return sendSuccess(reply, 200, "QR settings updated successfully", settings);
  } catch (error: unknown) {
    return sendCaughtError(request, reply, error, "Failed to update QR settings");
  }
}
