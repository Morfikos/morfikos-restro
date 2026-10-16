import type { FastifyReply } from "fastify";

/**
 * Sends a standardized API error response.
 *
 * @param reply - The Fastify reply instance.
 * @param statusCode - HTTP status code.
 * @param message - Error message for the client.
 * @param code - Application-specific error code.
 * @returns The Fastify response.
 */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  code: string,
) {
  return reply.status(statusCode).send({
    success: false,
    message,
    code,
  });
}

/**
 * Sends a standardized successful API response.
 *
 * @param reply - The Fastify reply instance.
 * @param statusCode - HTTP status code.
 * @param message - Success message for the client.
 * @param data - Response payload.
 * @returns The Fastify response.
 */
export function sendSuccess(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  data: unknown,
) {
  return reply.status(statusCode).send({
    success: true,
    message,
    data,
  });
}

// Backward-compatible alias for existing branch controllers.
export const sendSucess = sendSuccess;