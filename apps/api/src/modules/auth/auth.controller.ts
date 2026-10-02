import {
  signup,
  getUsers,
  login,
  changePassword,
  forgotPassword,
  resetPassword,
} from "./auth.service.js";

import {
  signupSchema,
  loginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "@morfikos/validation";

/**
 * Signup
 */
export async function signupController(
  request: any,
  reply: any
) {
  const validation =
    signupSchema.safeParse(request.body);

  if (!validation.success) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.error.issues,
    });
  }

  const result = await signup(
    validation.data
  );

  if (!result.success) {
    return reply.status(409).send(result);
  }

  return reply.status(201).send(result);
}

/**
 * Get Users
 */
export async function getUsersController(
  request: any,
  reply: any
) {
  const users = await getUsers();

  return reply.status(200).send({
    success: true,
    users,
  });
}

/**
 * Login
 */
export async function loginController(
  request: any,
  reply: any
) {
  const validation =
    loginSchema.safeParse(request.body);

  if (!validation.success) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.error.issues,
    });
  }

  const result = await login(
    validation.data
  );

  if (!result.success) {
    return reply.status(401).send(result);
  }

  return reply.status(200).send(result);
}

/**
 * Change Password
 */
export async function changePasswordController(
  request: any,
  reply: any
) {
  const validation =
    changePasswordSchema.safeParse(
      request.body
    );

  if (!validation.success) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.error.issues,
    });
  }

  const result = await changePassword(
    validation.data
  );

  if (!result.success) {
    return reply.status(401).send(result);
  }

  return reply.status(200).send(result);
}

/**
 * Forgot Password
 */
export async function forgotPasswordController(
  request: any,
  reply: any
) {
  const validation =
    forgotPasswordSchema.safeParse(
      request.body
    );

  if (!validation.success) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.error.issues,
    });
  }

  const result = await forgotPassword(
    validation.data.email
  );

  if (!result.success) {
    return reply.status(404).send(result);
  }

  return reply.status(200).send(result);
}

/**
 * Reset Password
 */
export async function resetPasswordController(
  request: any,
  reply: any
) {
  const validation =
    resetPasswordSchema.safeParse(request.body);

  if (!validation.success) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.error.issues,
    });
  }

  const result = await resetPassword(
    validation.data.token,
    validation.data.newPassword
  );

  if (!result.success) {
    return reply.status(400).send(result);
  }

  return reply.status(200).send(result);
}