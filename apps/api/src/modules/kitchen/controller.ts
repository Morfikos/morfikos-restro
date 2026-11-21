import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  bumpKitchenTicketSchema,
  kitchenBranchParamsSchema,
  kitchenTicketParamsSchema,
  listKitchenTicketsQuerySchema,
} from "@morfikos/validation";

import {
  assertKitchenBranch,
  bumpKitchenTicket,
  getKitchenTicket,
  isKitchenServiceError,
  listKitchenTickets,
  openKitchenStream,
} from "./service.js";

import {
  KITCHEN_STAFF_ROLES,
  KITCHEN_VIEW_ROLES,
  KitchenEventName,
  STREAM_HEARTBEAT_MS,
} from "./constants.js";

import type { KitchenEvent } from "./events.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type KitchenBranchRequest = FastifyRequest<{
  Params: { branchId: string };
}>;

type KitchenTicketRequest = FastifyRequest<{
  Params: { ticketId: string };
}>;

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
 * Sends a response when the user cannot access the requested branch.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendBranchAccessDenied(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Access denied for this branch",
    ErrorCode.BRANCH_ACCESS_DENIED,
  );
}

/**
 * Sends a response when the ticket does not exist or is not accessible.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendTicketNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Kitchen ticket not found",
    ErrorCode.KITCHEN_TICKET_NOT_FOUND,
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
 * Verifies the user is logged in, has one of the allowed roles (kitchen
 * staff by default), and has an organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The organization ID, or null after an error response was sent.
 */
function authorizeKitchenRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = KITCHEN_STAFF_ROLES,
): string | null {
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

  return organizationId;
}

/**
 * Returns the branches the authenticated user can access.
 *
 * @param request - The incoming request.
 * @returns The accessible branch IDs.
 */
function getBranchIds(request: FastifyRequest): string[] {
  return getAuthContext(request)?.branchIds ?? [];
}

/**
 * Handles known kitchen service errors.
 *
 * @param error - The error thrown by the kitchen service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleKitchenServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isKitchenServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "BRANCH_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.BRANCH_NOT_FOUND,
      );

    case "TICKET_NOT_FOUND":
      return sendError(
        reply,
        404,
        error.message,
        ErrorCode.KITCHEN_TICKET_NOT_FOUND,
      );

    case "INVALID_ITEM_INDEX":
      return sendError(
        reply,
        400,
        error.message,
        ErrorCode.INVALID_ITEM_INDEX,
      );

    case "TICKET_CLOSED":
      return sendError(
        reply,
        409,
        error.message,
        ErrorCode.KITCHEN_TICKET_CLOSED,
      );

    default:
      return null;
  }
}

/**
 * Formats one server-sent event.
 *
 * @param event - The kitchen event.
 * @returns The SSE wire format.
 */
function formatServerSentEvent(event: KitchenEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Lists a branch's kitchen tickets grouped by station.
 *
 * @param request - The incoming request containing the branch ID and filters.
 * @param reply - The Fastify reply instance.
 * @returns The tickets or an error response.
 */
export async function listKitchenTicketsController(
  request: KitchenBranchRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeKitchenRequest(request, reply, KITCHEN_VIEW_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsedParams = kitchenBranchParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listKitchenTicketsQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  if (!getBranchIds(request).includes(parsedParams.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const tickets = await listKitchenTickets(
      parsedParams.data.branchId,
      organizationId,
      parsedQuery.data,
    );

    return sendSuccess(
      reply,
      200,
      "Kitchen tickets retrieved successfully",
      tickets,
    );
  } catch (error: unknown) {
    const handled = handleKitchenServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list kitchen tickets");
  }
}

/**
 * Retrieves one kitchen ticket.
 *
 * @param request - The incoming request containing the ticket ID.
 * @param reply - The Fastify reply instance.
 * @returns The ticket or an error response.
 */
export async function getKitchenTicketController(
  request: KitchenTicketRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeKitchenRequest(request, reply, KITCHEN_VIEW_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = kitchenTicketParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const ticket = await getKitchenTicket(
      parsed.data.ticketId,
      organizationId,
      getBranchIds(request),
    );

    if (!ticket) {
      return sendTicketNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Kitchen ticket retrieved successfully",
      ticket,
    );
  } catch (error: unknown) {
    const handled = handleKitchenServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get kitchen ticket");
  }
}

/**
 * Bumps a kitchen ticket (or one of its items).
 *
 * @param request - The incoming request containing the ticket ID and item index.
 * @param reply - The Fastify reply instance.
 * @returns The updated ticket or an error response.
 */
export async function bumpKitchenTicketController(
  request: KitchenTicketRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeKitchenRequest(request, reply);

  if (!organizationId) {
    return reply;
  }

  const parsedParams = kitchenTicketParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = bumpKitchenTicketSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  if (
    parsedBody.data.ticketId !== undefined &&
    parsedBody.data.ticketId !== parsedParams.data.ticketId
  ) {
    return sendError(
      reply,
      400,
      "ticketId in the body does not match the URL",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const ticket = await bumpKitchenTicket(
      parsedParams.data.ticketId,
      organizationId,
      getBranchIds(request),
      parsedBody.data,
    );

    if (!ticket) {
      return sendTicketNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Kitchen ticket bumped successfully",
      ticket,
    );
  } catch (error: unknown) {
    const handled = handleKitchenServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to bump kitchen ticket");
  }
}

/**
 * Opens the live kitchen stream (Server-Sent Events) for a branch. Pushes
 * ticket_created, ticket_updated, ticket_status_changed and order_late,
 * with a keep-alive comment every few seconds.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns An error response, or nothing once the stream is open.
 */
export async function kitchenStreamController(
  request: KitchenBranchRequest,
  reply: FastifyReply,
) {
  const organizationId = authorizeKitchenRequest(request, reply, KITCHEN_VIEW_ROLES);

  if (!organizationId) {
    return reply;
  }

  const parsed = kitchenBranchParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  const { branchId } = parsed.data;

  if (!getBranchIds(request).includes(branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    await assertKitchenBranch(branchId, organizationId);
  } catch (error: unknown) {
    const handled = handleKitchenServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to open kitchen stream");
  }

  // From here Fastify hands the raw connection to us for streaming.
  reply.hijack();

  const stream = reply.raw;

  stream.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  stream.write(
    formatServerSentEvent({
      event: KitchenEventName.CONNECTED,
      data: { branchId, connectedAt: new Date().toISOString() },
    }),
  );

  const unsubscribe = openKitchenStream(branchId, (event) => {
    stream.write(formatServerSentEvent(event));
  });

  const heartbeat = setInterval(() => {
    stream.write(": ping\n\n");
  }, STREAM_HEARTBEAT_MS);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
