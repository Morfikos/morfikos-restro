import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  adjustLoyaltySchema,
  createGuestSchema,
  guestConsentSchema,
  guestIdParamsSchema,
  listGuestsQuerySchema,
  listLoyaltyQuerySchema,
  updateGuestSchema,
} from "@morfikos/validation";

import {
  adjustLoyaltyPoints,
  createOrFindGuest,
  getGuest,
  isGuestServiceError,
  listGuests,
  listLoyaltyTransactions,
  saveGuestConsent,
  updateGuest,
  type GuestActor,
} from "./service.js";

import { GUEST_MANAGER_ROLES, GUEST_STAFF_ROLES } from "./constants.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type GuestRequest = FastifyRequest<{
  Params: { guestId: string };
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
 * Sends a response when the guest does not exist or is not visible.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendGuestNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Guest not found",
    ErrorCode.GUEST_NOT_FOUND,
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
 * Verifies the user is logged in, has one of the allowed roles (any guest
 * staff role by default) and has an organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The guest actor, or null after an error response was sent.
 */
function authorizeGuestRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = GUEST_STAFF_ROLES,
): GuestActor | null {
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
 * Resolves the caller of a route that also works without login (QR menu).
 * Logged-in callers are authorized as staff; anonymous callers continue
 * as public requests.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns The staff actor, null for a public caller, or undefined after an error response was sent.
 */
function authorizeOptionalGuestRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): GuestActor | null | undefined {
  if (!getAuthContext(request)) {
    return null;
  }

  return authorizeGuestRequest(request, reply) ?? undefined;
}

/**
 * Handles known guest service errors.
 *
 * @param error - The error thrown by the guest service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleGuestServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isGuestServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "QR_CODE_REQUIRED":
      return sendError(reply, 401, error.message, ErrorCode.QR_CODE_REQUIRED);

    case "ORGANIZATION_ACCESS_DENIED":
      return sendError(reply, 403, error.message, ErrorCode.ORGANIZATION_ACCESS_DENIED);

    case "TABLE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.TABLE_NOT_FOUND);

    case "GUEST_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.GUEST_NOT_FOUND);

    case "INSUFFICIENT_POINTS":
      return sendError(reply, 409, error.message, ErrorCode.INSUFFICIENT_POINTS);

    default:
      return null;
  }
}

/**
 * Creates a guest, or finds the existing one with this phone. Works for
 * logged-in staff and for guests on the table QR menu (limited data).
 *
 * @param request - The incoming request containing the phone and details.
 * @param reply - The Fastify reply instance.
 * @returns The guest (201 when created, 200 when found) or an error response.
 */
export async function createGuestController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOptionalGuestRequest(request, reply);

  if (actor === undefined) {
    return reply;
  }

  const parsed = createGuestSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const { created, guest } = await createOrFindGuest(actor, parsed.data);

    return sendSuccess(
      reply,
      created ? 201 : 200,
      created ? "Guest created successfully" : "Guest found",
      guest,
    );
  } catch (error: unknown) {
    const handled = handleGuestServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create guest");
  }
}

/**
 * Records a guest's marketing consent for one channel. Works for logged-in
 * staff and for guests on the table QR menu.
 *
 * @param request - The incoming request containing the guest ID and consent.
 * @param reply - The Fastify reply instance.
 * @returns The saved consent or an error response.
 */
export async function saveGuestConsentController(
  request: GuestRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOptionalGuestRequest(request, reply);

  if (actor === undefined) {
    return reply;
  }

  const parsedParams = guestIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = guestConsentSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  if (
    parsedBody.data.guestId !== undefined &&
    parsedBody.data.guestId !== parsedParams.data.guestId
  ) {
    return sendError(
      reply,
      400,
      "guestId in the body does not match the URL",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const consent = await saveGuestConsent(actor, parsedParams.data.guestId, parsedBody.data);

    return sendSuccess(
      reply,
      200,
      "Consent saved successfully",
      consent,
    );
  } catch (error: unknown) {
    const handled = handleGuestServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to save guest consent");
  }
}

/**
 * Retrieves a guest's profile with consents, visit history and recent
 * loyalty activity.
 *
 * @param request - The incoming request containing the guest ID.
 * @param reply - The Fastify reply instance.
 * @returns The guest profile or an error response.
 */
export async function getGuestController(
  request: GuestRequest,
  reply: FastifyReply,
) {
  const actor = authorizeGuestRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = guestIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const guest = await getGuest(actor, parsed.data.guestId);

    if (!guest) {
      return sendGuestNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Guest retrieved successfully",
      guest,
    );
  } catch (error: unknown) {
    const handled = handleGuestServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get guest");
  }
}

/**
 * Lists the organization's guests with segment and date filters.
 * Owners and managers only.
 *
 * @param request - The incoming request containing filters.
 * @param reply - The Fastify reply instance.
 * @returns The guests or an error response.
 */
export async function listGuestsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeGuestRequest(request, reply, GUEST_MANAGER_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = listGuestsQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const guests = await listGuests(actor, parsed.data);

    return sendSuccess(
      reply,
      200,
      "Guests retrieved successfully",
      guests,
    );
  } catch (error: unknown) {
    const handled = handleGuestServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list guests");
  }
}

/**
 * Updates a guest's name, email or notes.
 *
 * @param request - The incoming request containing the guest ID and changes.
 * @param reply - The Fastify reply instance.
 * @returns The updated guest or an error response.
 */
export async function updateGuestController(
  request: GuestRequest,
  reply: FastifyReply,
) {
  const actor = authorizeGuestRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = guestIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateGuestSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const guest = await updateGuest(actor, parsedParams.data.guestId, parsedBody.data);

    if (!guest) {
      return sendGuestNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Guest updated successfully",
      guest,
    );
  } catch (error: unknown) {
    const handled = handleGuestServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update guest");
  }
}

/**
 * Lists a guest's loyalty points ledger.
 *
 * @param request - The incoming request containing the guest ID and pagination.
 * @param reply - The Fastify reply instance.
 * @returns The ledger or an error response.
 */
export async function listLoyaltyController(
  request: GuestRequest,
  reply: FastifyReply,
) {
  const actor = authorizeGuestRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = guestIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listLoyaltyQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const ledger = await listLoyaltyTransactions(
      actor,
      parsedParams.data.guestId,
      parsedQuery.data,
    );

    if (!ledger) {
      return sendGuestNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Loyalty history retrieved successfully",
      ledger,
    );
  } catch (error: unknown) {
    const handled = handleGuestServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list loyalty history");
  }
}

/**
 * Adds or removes a guest's loyalty points by hand. Owners and managers only.
 *
 * @param request - The incoming request containing the guest ID, points and reason.
 * @param reply - The Fastify reply instance.
 * @returns The new balance or an error response.
 */
export async function adjustLoyaltyController(
  request: GuestRequest,
  reply: FastifyReply,
) {
  const actor = authorizeGuestRequest(request, reply, GUEST_MANAGER_ROLES);

  if (!actor) {
    return reply;
  }

  const parsedParams = guestIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = adjustLoyaltySchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await adjustLoyaltyPoints(actor, parsedParams.data.guestId, parsedBody.data);

    if (!result) {
      return sendGuestNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Loyalty points adjusted successfully",
      result,
    );
  } catch (error: unknown) {
    const handled = handleGuestServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to adjust loyalty points");
  }
}
