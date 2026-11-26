import fp from "fastify-plugin";
import { ZodError, z } from "zod";
import type { ErrorCode } from "../utils/error-codes.js";

/** Throw this anywhere. The error handler turns it into the standard error body. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errorsPlugin = fp(async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        message: error.message,
        code: error.code,
        ...(error.details && { details: error.details }),
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        message: "Invalid request",
        code: "VALIDATION_ERROR",
        details: z.treeifyError(error),
      });
    }

    // Rate-limit and other Fastify errors carry a statusCode.
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : undefined;

    if (statusCode === 429) {
      return reply.status(429).send({
        success: false,
        message: "Too many requests",
        code: "RATE_LIMITED",
      });
    }

    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({
      success: false,
      message: "An unexpected error occurred",
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});
