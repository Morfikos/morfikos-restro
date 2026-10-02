import { z } from "zod";

export const signupSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .trim(),

  email: z
    .string()
    .email("Invalid email format")
    .trim()
    .toLowerCase(),

  password: z
    .string()
    .min(6, "Password must be at least 6 characters"),
});

// export const loginSchema = z.object({
//   email: z
//     .string()
//     .email("Invalid email format")
//     .trim()
//     .toLowerCase(),

//   password: z
//     .string()
//     .min(1, "Password is required"),
// });
export const loginSchema = z.object({
  email: z
    .string()
    .email("Invalid email format")
    .trim()
    .toLowerCase(),

  password: z
    .string()
    .min(1, "Password is required"),

  device: z
    .string()
    .trim()
    .optional(),
});
// export const changePasswordSchema = z.object({
//   currentPassword: z
//     .string()
//     .min(1, "Current password is required"),

//   newPassword: z
//     .string()
//     .min(6, "New password must be at least 6 characters"),
// });

export const changePasswordSchema = z.object({
  email: z
    .string()
    .email("Invalid email format")
    .trim()
    .toLowerCase(),

  currentPassword: z
    .string()
    .min(1, "Current password is required"),

  newPassword: z
    .string()
    .min(6, "New password must be at least 6 characters"),
});

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .email("Invalid email format")
    .trim()
    .toLowerCase(),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<
  typeof changePasswordSchema
>;
export type ForgotPasswordInput = z.infer<
  typeof forgotPasswordSchema
>;

export const resetPasswordSchema = z.object({
  token: z
    .string()
    .min(1, "Reset token is required"),

  newPassword: z
    .string()
    .min(6, "New password must be at least 6 characters"),
});

export type ResetPasswordInput =
  z.infer<typeof resetPasswordSchema>;