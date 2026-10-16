
import { z } from "zod";

const businessDaySchema = z.enum([
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
  "SUN",
]);

const timeSchema = z.string().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d$/,
  "Time must be in HH:mm format",
);

export const createBranchSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(300),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(7).max(20),
  gstin: z.string().trim().min(1).max(20),
  fssaiNo: z.string().trim().max(30).optional(),
  noOfTables: z.number().int().min(0).max(10000),
  timezone: z.string().trim().min(1).default("Asia/Kolkata"),
  businessDays: z.array(businessDaySchema).min(1),
  // businessDayCutoff: timeSchema.optional(),
  businessDayCutoff: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  googleReviewUrl: z.union([
    z.string().url(),
    z.literal(""),
  ]).optional(),
});

export const branchIdSchema = z.object({
  id: z.string().uuid(),
});

export const listBranchesQuerySchema = z.object({
  status: z.enum(["active", "inactive"]).default("active"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const updateBranchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().min(1).max(300).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  state: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(7).max(20).optional(),
  gstin: z.string().trim().min(1).max(20).optional(),
  fssaiNo: z.string().trim().max(30).nullable().optional(),
  noOfTables: z.number().int().min(0).max(10000).optional(),
  timezone: z.string().trim().min(1).optional(),
  businessDays: z.array(businessDaySchema).min(1).optional(),
  businessDayCutoff: timeSchema.nullable().optional(),
  googleReviewUrl: z.union([
    z.string().url(),
    z.literal(""),
  ]).nullable().optional(),
});

export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
export type ListBranchesQuery = z.infer<typeof listBranchesQuerySchema>;