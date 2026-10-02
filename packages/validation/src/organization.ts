import { z } from "zod"

export const createOrganizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Organization name is required"),

  gstin: z
    .string()
    .trim()
    .min(1, "GSTIN is required"),

  state: z
    .string()
    .trim()
    .min(1, "State is required"),

  city: z
    .string()
    .trim()
    .min(1, "City is required"),

  businessType: z
    .string()
    .trim()
    .min(1, "Business type is required"),

  phone: z
    .string()
    .trim()
    .min(1, "Phone is required"),

  email: z
    .string()
    .trim()
    .email("Invalid email address"),
})

export const organizationIdSchema = z.object({
  id: z
    .string()
    .uuid("Invalid organization ID"),
})

export type CreateOrganizationInput = z.infer<
  typeof createOrganizationSchema
>