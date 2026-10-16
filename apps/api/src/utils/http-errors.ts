import { z } from "zod";
import type { FastifyReply,FastifyRequest} from "fastify";
import { HTTP_STATUS } from "./http-status.js";

/** Sends a standardized validation error response. */
export function sendValidationError(
  reply: FastifyReply,
  message: string,
  error: z.ZodError,
) {
  return reply.status(HTTP_STATUS.BAD_REQUEST).send({
    message,
    errors: z.treeifyError(error),
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
