
import type { FastifyReply, FastifyRequest } from "fastify";
import { authService } from "./service.js";
import { loginSchema } from "@morfikos/validation";

export async function loginController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const parsed = loginSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.status(400).send({
      message: "Invalid request body",
      errors: parsed.error.flatten(),
    });
  }

  try {
    const user = await authService.login(
      parsed.data.email,
      parsed.data.password,
    );

    return reply.status(200).send({
      message: "Login successful",
      user,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Login failed";

    if (message === "Invalid email or password") {
      return reply.status(401).send({
        message: "Invalid email or password",
      });
    }

    request.log.error(error);

    return reply.status(500).send({
      message: "Internal server error",
    });
  }
}

export async function refreshController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as
    | { refreshToken?: unknown }
    | undefined;

  const refreshToken = body?.refreshToken;

  if (
    typeof refreshToken !== "string" ||
    !refreshToken.trim()
  ) {
    return reply.status(400).send({
      message: "Refresh token is required",
    });
  }

  try {
    const tokens = await authService.refresh(refreshToken);

    return reply.status(200).send({
      message: "Token refreshed successfully",
      ...tokens,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Token refresh failed";

    if (
      message === "Invalid refresh token" ||
      message === "Refresh token expired"
    ) {
      return reply.status(401).send({
        message: "Invalid or expired refresh token",
      });
    }

    request.log.error(error);

    return reply.status(500).send({
      message: "Internal server error",
    });
  }
}

export async function logoutController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as
    | { refreshToken?: unknown }
    | undefined;

  const refreshToken = body?.refreshToken;

  if (
    typeof refreshToken !== "string" ||
    !refreshToken.trim()
  ) {
    return reply.status(400).send({
      message: "Refresh token is required",
    });
  }

  try {
    await authService.logout(refreshToken);

    return reply.status(200).send({
      message: "Logout successful",
    });
  } catch (error) {
    request.log.error(error);

    return reply.status(500).send({
      message: "Internal server error",
    });
  }
}
