import type { FastifyInstance } from "fastify";

import {
  signupController,
  getUsersController,
  loginController,
  changePasswordController,
  forgotPasswordController,
} from "./auth.controller.js";

export async function authRoutes(
  app: FastifyInstance
) {
  app.post(
    "/auth/signup",
    signupController
  );

  app.get(
    "/auth/users",
    getUsersController
  );

  app.post(
    "/auth/login",
    loginController
  );

  app.post(
    "/auth/change-password",
    changePasswordController
  );

  app.post(
    "/auth/forgot-password",
    forgotPasswordController
  );
}