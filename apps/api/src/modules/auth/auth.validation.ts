import type { SignupRequest } from "./auth.types.js";

interface ValidationResult {
  valid: boolean;
  errors: string[];
  data?: SignupRequest;
}

export function validateSignup(
  data: unknown
): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Request body is required"],
    };
  }

  const body = data as Record<string, unknown>;

  if (
    !body.name ||
    typeof body.name !== "string"
  ) {
    errors.push("Name is required");
  }

  if (
    !body.email ||
    typeof body.email !== "string"
  ) {
    errors.push("Email is required");
  }

  if (
    typeof body.email === "string" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      body.email
    )
  ) {
    errors.push("Invalid email format");
  }

  if (
    !body.password ||
    typeof body.password !== "string"
  ) {
    errors.push("Password is required");
  }

  if (
    typeof body.password === "string" &&
    body.password.length < 6
  ) {
    errors.push(
      "Password must be at least 6 characters"
    );
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
    };
  }

  return {
    valid: true,
    errors: [],
    data: {
      name: body.name as string,
      email: (body.email as string)
        .toLowerCase()
        .trim(),
      password: body.password as string,
    },
  };
}

export function validateLogin(
  data: unknown
): {
  valid: boolean;
  errors: string[];
  email?: string;
  password?: string;
} {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Request body is required"],
    };
  }

  const body = data as Record<string, unknown>;

  if (
    !body.email ||
    typeof body.email !== "string"
  ) {
    errors.push("Email is required");
  }

  if (
    !body.password ||
    typeof body.password !== "string"
  ) {
    errors.push("Password is required");
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
    };
  }

  return {
    valid: true,
    errors: [],
    email: (body.email as string)
      .toLowerCase()
      .trim(),
    password: body.password as string,
  };
}

export function validateChangePassword(
  data: unknown
): {
  valid: boolean;
  errors: string[];
  email?: string;
  currentPassword?: string;
  newPassword?: string;
} {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Request body is required"],
    };
  }

  const body = data as Record<string, unknown>;

  if (
    !body.email ||
    typeof body.email !== "string"
  ) {
    errors.push("Email is required");
  }

  if (
    !body.currentPassword ||
    typeof body.currentPassword !== "string"
  ) {
    errors.push("Current password is required");
  }

  if (
    !body.newPassword ||
    typeof body.newPassword !== "string"
  ) {
    errors.push("New password is required");
  }

  if (
    typeof body.newPassword === "string" &&
    body.newPassword.length < 6
  ) {
    errors.push(
      "New password must be at least 6 characters"
    );
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
    };
  }

  return {
    valid: true,
    errors: [],
    email: (body.email as string)
      .toLowerCase()
      .trim(),
    currentPassword:
      body.currentPassword as string,
    newPassword:
      body.newPassword as string,
  };
}

export function validateForgotPassword(
  data: unknown
): {
  valid: boolean;
  errors: string[];
  email?: string;
} {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Request body is required"],
    };
  }

  const body = data as Record<string, unknown>;

  if (
    !body.email ||
    typeof body.email !== "string"
  ) {
    errors.push("Email is required");
  }

  if (
    typeof body.email === "string" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      body.email
    )
  ) {
    errors.push("Invalid email format");
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
    };
  }

  return {
    valid: true,
    errors: [],
    email: (body.email as string)
      .toLowerCase()
      .trim(),
  };
}