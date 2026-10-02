import {
  signupController,
  getUsersController,
  loginController,
  changePasswordController,
  forgotPasswordController,
  resetPasswordController,
} from "./auth.controller.js";

export async function authRoutes(
  app: any
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

  app.post(
    "/auth/reset-password",
    resetPasswordController
);
}
