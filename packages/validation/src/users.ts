import { z } from "zod";

import { ASSIGNABLE_STAFF_ROLES } from "./auth.js";
import { normalizePhone } from "./guests.js";

/** Staff account statuses as used by the user API. */
export const USER_STATUSES = ["active", "inactive"] as const;

/** Status filter for listing staff. */
export const USER_STATUS_FILTERS = ["active", "inactive", "all"] as const;

/** Roles shown in the staff list filter (owners included). */
export const USER_ROLE_FILTERS = ["owner", "manager", "waiter", "staff"] as const;

const nameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name must be at most 100 characters");

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Please enter a valid email address"));

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/\d/, "Password must contain a number");

/** A staff phone number, normalized to E.164 (+91 added to 10-digit numbers). */
const phoneSchema = z
  .string()
  .trim()
  .min(1, "Phone number is required")
  .transform(normalizePhone)
  .pipe(z.string().regex(/^\+\d{8,15}$/, "Enter a valid phone number"));

/** The restaurant's own staff code, e.g. "W-07". Unique in the organization. */
const employeeCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, "Staff code can use letters, numbers and dashes (max 20)");

/** A 4–6 digit PIN for approvals and quick POS login. */
const pinSchema = z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits");

/** Highest discount % this person may give without a manager's PIN. */
const discountCeilingSchema = z.number().min(0).max(100);

const PASSWORD_MISMATCH = {
  message: "Passwords do not match",
  path: ["confirmPassword"],
};

/** Branch access: every branch of the organization, or a list of branches. */
const branchAccessShape = {
  allBranches: z.boolean().default(false),
  branchIds: z
    .array(z.uuid("Invalid branch ID"))
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Each branch can appear only once",
    })
    .default([]),
};

const BRANCH_ACCESS_RULE = {
  check: (data: { allBranches: boolean; branchIds: string[] }) =>
    data.allBranches !== data.branchIds.length > 0,
  message: {
    message: "Send allBranches: true, or a list of branchIds (not both)",
    path: ["branchIds"],
  },
};

export const userIdParamsSchema = z.object({
  userId: z.uuid(),
});

export const roleParamsSchema = z.object({
  role: z.enum(USER_ROLE_FILTERS),
});

export const listUsersQuerySchema = z.object({
  branchId: z.uuid().optional(),
  role: z.enum(USER_ROLE_FILTERS).optional(),
  status: z.enum(USER_STATUS_FILTERS).default("active"),
  /** Matches name, email, phone or staff code. */
  search: z.string().trim().min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createUserSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    role: z.enum(ASSIGNABLE_STAFF_ROLES),
    ...branchAccessShape,
    phone: phoneSchema.optional(),
    employeeCode: employeeCodeSchema.optional(),
    pin: pinSchema.optional(),
    discountCeilingPct: discountCeilingSchema.optional(),
  })
  .refine((data) => data.password === data.confirmPassword, PASSWORD_MISMATCH)
  .refine(BRANCH_ACCESS_RULE.check, BRANCH_ACCESS_RULE.message);

export const updateUserSchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    employeeCode: employeeCodeSchema.nullable().optional(),
    discountCeilingPct: discountCeilingSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const updateUserRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_STAFF_ROLES),
});

export const updateUserBranchesSchema = z
  .object(branchAccessShape)
  .refine(BRANCH_ACCESS_RULE.check, BRANCH_ACCESS_RULE.message);

export const deactivateUserSchema = z.object({
  reason: z.string().trim().min(1).max(300).optional(),
});

export const resetUserPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, PASSWORD_MISMATCH);

export const setUserPinSchema = z
  .object({
    pin: pinSchema,
    confirmPin: z.string(),
  })
  .refine((data) => data.pin === data.confirmPin, {
    message: "PINs do not match",
    path: ["confirmPin"],
  });

export type UserStatusValue = (typeof USER_STATUSES)[number];
export type UserRoleFilter = (typeof USER_ROLE_FILTERS)[number];
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type UpdateUserBranchesInput = z.infer<typeof updateUserBranchesSchema>;
export type DeactivateUserInput = z.infer<typeof deactivateUserSchema>;
export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;
export type SetUserPinInput = z.infer<typeof setUserPinSchema>;
