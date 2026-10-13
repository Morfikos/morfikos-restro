
import type {
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodError } from "zod";

import { HTTP_STATUS } from "./http-status.js";

/**
 * Sends a standardized Zod validation error response.
 */
export function sendValidationError(
  reply: FastifyReply,
  message: string,
  error: ZodError,
) {
  return reply.status(HTTP_STATUS.BAD_REQUEST).send({
    message,
    errors: error.flatten(),
  });
}

/**
 * Logs an unexpected error and sends a generic server error response.
 */
export function sendInternalServerError(
  request: FastifyRequest,
  reply: FastifyReply,
  message: string,
  error: unknown,
) {
  request.log.error(
    { err: error },
    "Internal server error",
  );

  return reply
    .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
    .send({ message });
}
