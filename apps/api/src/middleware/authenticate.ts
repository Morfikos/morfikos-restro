import type { FastifyReply, FastifyRequest } from "fastify";
import { ROLES, verifyAccessToken, type UserRole } from "@morfikos/auth";
import type { AuthContext } from "../utils/auth-helpers.js";
import { ErrorCode } from "../utils/error-codes.js";
import { HTTP_STATUS } from "../utils/http-status.js";
import { sendError } from "../utils/response.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthContext;
  }
}

const BEARER_PREFIX = "Bearer ";
const VALID_ROLES = new Set<string>(Object.values(ROLES));

/**
 * Checks whether a value is an array of strings.
 *
 * @param value - The value to check.
 * @returns True if the value is a string array.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Extracts the bearer token from the Authorization header.
 *
 * @param request - The incoming request.
 * @returns The token, or null if the header is missing or malformed.
 */
function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;

  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }

  return header.slice(BEARER_PREFIX.length).trim() || null;
}

/**
 * Fastify preHandler that verifies the JWT access token and attaches
 * the authenticated user's context to `request.user`.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns An unauthorized response if the token is missing or invalid.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const token = extractBearerToken(request);

  if (!token) {
    return sendError(
      reply,
      HTTP_STATUS.UNAUTHORIZED,
      "Authentication token is missing",
      ErrorCode.UNAUTHENTICATED,
    );
  }

  try {
    const { sub, role, organizationIds, branchIds } =
      await verifyAccessToken(token);

    if (
      typeof sub !== "string" ||
      typeof role !== "string" ||
      !VALID_ROLES.has(role) ||
      !isStringArray(organizationIds) ||
      !isStringArray(branchIds)
    ) {
      return sendError(
        reply,
        HTTP_STATUS.UNAUTHORIZED,
        "Invalid authentication token",
        ErrorCode.UNAUTHENTICATED,
      );
    }

    request.user = {
      userId: sub,
      role: role as UserRole,
      organizationId: organizationIds[0],
      organizationIds,
      branchIds,
    };
  } catch (error: unknown) {
    request.log.debug({ err: error }, "Access token verification failed");

    return sendError(
      reply,
      HTTP_STATUS.UNAUTHORIZED,
      "Invalid or expired authentication token",
      ErrorCode.UNAUTHENTICATED,
    );
  }
}
