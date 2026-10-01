import {
  randomBytes,
  randomUUID,
  scryptSync,
} from "crypto";

import type {
  SignupRequest,
  SignupResponse,
  User,
  LoginRequest,
  LoginResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  ForgotPasswordResponse,
} from "./auth.types.js";

const users: User[] = [];

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");

  const hash = scryptSync(
    password,
    salt,
    64
  ).toString("hex");

  return `${salt}:${hash}`;
}

export async function signup(
  data: SignupRequest
): Promise<SignupResponse> {
  const existingUser = users.find(
    (user) =>
      user.email ===
      data.email.toLowerCase().trim()
  );

  if (existingUser) {
    return {
      success: false,
      message: "User with this email already exists",
    };
  }

  const newUser: User = {
    id: randomUUID(),
    name: data.name.trim(),
    email: data.email.toLowerCase().trim(),
    password: hashPassword(data.password),
    createdAt: new Date(),
  };

  users.push(newUser);

  return {
    success: true,
    message: "User registered successfully",
    user: {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      createdAt: newUser.createdAt,
    },
  };
}

export async function getUsers() {
  return users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  }));
}

export async function login(
  data: LoginRequest
): Promise<LoginResponse> {
  const user = users.find(
    (user) =>
      user.email ===
      data.email.toLowerCase().trim()
  );

  if (!user) {
    return {
      success: false,
      message: "Invalid email or password",
    };
  }

  const [salt, storedHash] =
    user.password.split(":");

  const hash = scryptSync(
    data.password,
    salt,
    64
  ).toString("hex");

  if (hash !== storedHash) {
    return {
      success: false,
      message: "Invalid email or password",
    };
  }

  return {
    success: true,
    message: "Login successful",
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
  };
}

export async function changePassword(
  data: ChangePasswordRequest
): Promise<ChangePasswordResponse> {
  const email = data.email
    .toLowerCase()
    .trim();

  const user = users.find(
    (user) =>
      user.email.toLowerCase().trim() === email
  );

  if (!user) {
    return {
      success: false,
      message: "User not found",
    };
  }

  const [salt, storedHash] =
    user.password.split(":");

  const currentHash = scryptSync(
    data.currentPassword,
    salt,
    64
  ).toString("hex");

  if (currentHash !== storedHash) {
    return {
      success: false,
      message: "Current password is incorrect",
    };
  }

  user.password = hashPassword(
    data.newPassword
  );

  return {
    success: true,
    message: "Password changed successfully",
  };
}

export async function forgotPassword(
  email: string
): Promise<ForgotPasswordResponse> {
  const normalizedEmail = email
    .toLowerCase()
    .trim();

  const user = users.find(
    (user) =>
      user.email.toLowerCase().trim() ===
      normalizedEmail
  );

  if (!user) {
    return {
      success: false,
      message: "User not found",
    };
  }

  const resetToken = randomBytes(32).toString(
    "hex"
  );

  return {
    success: true,
    message:
      "Password reset token generated successfully",
    resetToken,
  };
}