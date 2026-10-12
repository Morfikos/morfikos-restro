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