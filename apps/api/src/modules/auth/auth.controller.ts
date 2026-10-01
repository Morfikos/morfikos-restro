import {
  signup,
  getUsers,
  login,
  changePassword,
  forgotPassword,
} from "./auth.service.js";

import {
  validateSignup,
  validateLogin,
  validateChangePassword,
  validateForgotPassword,
} from "./auth.validation.js";

export async function signupController(
  request: any,
  reply: any
) {
  const validation = validateSignup(
    request.body
  );

  if (!validation.valid) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.errors,
    });
  }

  const result = await signup(
    validation.data!
  );

  if (!result.success) {
    return reply.status(409).send(result);
  }

  return reply.status(201).send(result);
}

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

export async function loginController(
  request: any,
  reply: any
) {
  const validation = validateLogin(
    request.body
  );

  if (!validation.valid) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.errors,
    });
  }

  const result = await login({
    email: validation.email!,
    password: validation.password!,
  });

  if (!result.success) {
    return reply.status(401).send(result);
  }

  return reply.status(200).send(result);
}

export async function changePasswordController(
  request: any,
  reply: any
) {
  const validation =
    validateChangePassword(request.body);

  if (!validation.valid) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.errors,
    });
  }

  const result = await changePassword({
    email: validation.email!,
    currentPassword:
      validation.currentPassword!,
    newPassword:
      validation.newPassword!,
  });

  if (!result.success) {
    return reply.status(401).send(result);
  }

  return reply.status(200).send(result);
}

export async function forgotPasswordController(
  request: any,
  reply: any
) {
  const validation =
    validateForgotPassword(request.body);

  if (!validation.valid) {
    return reply.status(400).send({
      success: false,
      message: "Validation failed",
      errors: validation.errors,
    });
  }

  const result = await forgotPassword(
    validation.email!
  );

  if (!result.success) {
    return reply.status(404).send(result);
  }

  return reply.status(200).send(result);
}