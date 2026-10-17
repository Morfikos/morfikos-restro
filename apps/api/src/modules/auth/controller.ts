import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  signupSchema,
  staffSignupSchema,
} from "@morfikos/validation";
import { authService, isAuthServiceError } from "./service.js";
import { AUTH_MESSAGES, AuthErrorCode, BRANCH_ID_HEADER } from "./constants.js";
import { getAuthContext } from "../../utils/auth-helpers.js";
import { HTTP_STATUS } from "../../utils/http-status.js";
import { sendError, sendSuccess } from "../../utils/response.js";

/**
 * Sends a validation error using the first validation issue as the message.
 *
 * @param reply - The Fastify reply instance.
 * @param error - The Zod validation error.
 * @returns A bad-request response.
 */
function sendValidationFailed(
  reply: FastifyReply,
  error: Pick<ZodError, "issues">,
) {
  return sendError(
    reply,
    HTTP_STATUS.BAD_REQUEST,
    error.issues[0]?.message ?? AUTH_MESSAGES.INVALID_BODY,
    AuthErrorCode.VALIDATION_ERROR,
  );
}

/**
 * Sends an authentication error when the user is not logged in.
 *
 * @param reply - The Fastify reply instance.
 * @returns An unauthorized response.
 */
function sendUnauthenticated(reply: FastifyReply) {
  return sendError(
    reply,
    HTTP_STATUS.UNAUTHORIZED,
    AUTH_MESSAGES.LOGIN_REQUIRED,
    AuthErrorCode.UNAUTHENTICATED,
  );
}

/**
 * Maps known auth service errors to their responses and logs anything
 * unexpected as an internal server error.
 *
 * @param request - The incoming request (used for logging).
 * @param reply - The Fastify reply instance.
 * @param error - The caught error.
 * @param logMessage - Message logged for unexpected errors.
 * @returns The error response.
 */
function handleAuthError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
) {
  if (isAuthServiceError(error)) {
    return sendError(reply, error.statusCode, error.message, error.code);
  }

  request.log.error({ err: error }, logMessage);

  return sendError(
    reply,
    HTTP_STATUS.INTERNAL_SERVER_ERROR,
    AUTH_MESSAGES.INTERNAL_ERROR,
    AuthErrorCode.INTERNAL_SERVER_ERROR,
  );
}

/**
 * Registers a new restaurant owner.
 *
 * @param request - The request containing name, email and password.
 * @param reply - The Fastify reply instance.
 * @returns The created user or an error response.
 */
export async function signupController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = signupSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationFailed(reply, parsed.error);
  }

  try {
    const user = await authService.signup(parsed.data);

    return sendSuccess(reply, HTTP_STATUS.CREATED, AUTH_MESSAGES.SIGNUP_SUCCESS, user);
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to sign up user");
  }
}

/**
 * Creates a manager, waiter or staff account for the caller's organization.
 *
 * @param request - The request containing staff details and role.
 * @param reply - The Fastify reply instance.
 * @returns The created staff user or an error response.
 */
export async function staffSignupController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = getAuthContext(request);

  if (!actor) {
    return sendUnauthenticated(reply);
  }

  const parsed = staffSignupSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationFailed(reply, parsed.error);
  }

  try {
    const staff = await authService.createStaff(actor, parsed.data);

    return sendSuccess(reply, HTTP_STATUS.CREATED, AUTH_MESSAGES.STAFF_CREATED, staff);
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to create staff user");
  }
}

/**
 * Logs a user in with email and password.
 *
 * @param request - The request containing credentials and remember-me flag.
 * @param reply - The Fastify reply instance.
 * @returns Tokens and user access details, or an error response.
 */
export async function loginController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = loginSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationFailed(reply, parsed.error);
  }

  try {
    const result = await authService.login(parsed.data);

    return sendSuccess(reply, HTTP_STATUS.OK, AUTH_MESSAGES.LOGIN_SUCCESS, result);
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to log in user");
  }
}

/**
 * Issues a new access token using a refresh token.
 *
 * @param request - The request containing the refresh token.
 * @param reply - The Fastify reply instance.
 * @returns A new token pair or an error response.
 */
export async function refreshController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = refreshTokenSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationFailed(reply, parsed.error);
  }

  try {
    const tokens = await authService.refresh(parsed.data.refreshToken);

    return sendSuccess(reply, HTTP_STATUS.OK, AUTH_MESSAGES.REFRESH_SUCCESS, tokens);
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to refresh token");
  }
}

/**
 * Returns the logged-in user's profile. The client may send its selected
 * branch in the `x-branch-id` header.
 *
 * @param request - The authenticated request.
 * @param reply - The Fastify reply instance.
 * @returns The user profile or an error response.
 */
export async function getCurrentUserController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = getAuthContext(request);

  if (!user) {
    return sendUnauthenticated(reply);
  }

  const branchHeader = request.headers[BRANCH_ID_HEADER];
  const requestedBranchId =
    typeof branchHeader === "string" ? branchHeader : undefined;

  try {
    const profile = await authService.getCurrentUser(user.userId, requestedBranchId);

    return sendSuccess(reply, HTTP_STATUS.OK, AUTH_MESSAGES.ME_SUCCESS, profile);
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to get current user");
  }
}

/**
 * Logs the user out by revoking their refresh token(s).
 *
 * @param request - The authenticated request, optionally with a refresh token.
 * @param reply - The Fastify reply instance.
 * @returns A success response or an error response.
 */
export async function logoutController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = getAuthContext(request);

  if (!user) {
    return sendUnauthenticated(reply);
  }

  const parsed = logoutSchema.safeParse(request.body ?? {});

  if (!parsed.success) {
    return sendValidationFailed(reply, parsed.error);
  }

  try {
    await authService.logout(user.userId, parsed.data.refreshToken);

    return sendSuccess(reply, HTTP_STATUS.OK, AUTH_MESSAGES.LOGOUT_SUCCESS, null);
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to log out user");
  }
}

/**
 * Changes the logged-in user's password.
 *
 * @param request - The authenticated request with old and new passwords.
 * @param reply - The Fastify reply instance.
 * @returns A success response or an error response.
 */
export async function changePasswordController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = getAuthContext(request);

  if (!user) {
    return sendUnauthenticated(reply);
  }

  const parsed = changePasswordSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationFailed(reply, parsed.error);
  }

  try {
    await authService.changePassword(user.userId, parsed.data);

    return sendSuccess(reply, HTTP_STATUS.OK, AUTH_MESSAGES.PASSWORD_CHANGED, null);
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to change password");
  }
}

/**
 * Sends a password reset link. Always responds with the same message so
 * the endpoint cannot be used to discover registered emails. Outside
 * production, the reset token is included in the response for testing.
 *
 * @param request - The request containing the email address.
 * @param reply - The Fastify reply instance.
 * @returns A generic success response or an error response.
 */
export async function forgotPasswordController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = forgotPasswordSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationFailed(reply, parsed.error);
  }

  try {
    const resetToken = await authService.forgotPassword(parsed.data.email, request.log);
    const exposeToken = process.env.NODE_ENV !== "production" && resetToken;

    return sendSuccess(
      reply,
      HTTP_STATUS.OK,
      AUTH_MESSAGES.RESET_LINK_SENT,
      exposeToken ? { resetToken } : null,
    );
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to start password reset");
  }
}

/**
 * Resets a password using a valid reset token.
 *
 * @param request - The request containing the token and new password.
 * @param reply - The Fastify reply instance.
 * @returns A success response or an error response.
 */
export async function resetPasswordController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = resetPasswordSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationFailed(reply, parsed.error);
  }

  try {
    await authService.resetPassword(parsed.data);

    return sendSuccess(reply, HTTP_STATUS.OK, AUTH_MESSAGES.PASSWORD_RESET, null);
  } catch (error: unknown) {
    return handleAuthError(request, reply, error, "Failed to reset password");
  }
}
