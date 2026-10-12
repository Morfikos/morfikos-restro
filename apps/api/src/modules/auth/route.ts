import type { FastifyInstance } from "fastify";
import { loginController } from "./controller.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/login", loginController);
}