import { z } from "zod";

const menuNameSchema = z.string().trim().min(1).max(100);
const menuDescriptionSchema = z.string().trim().max(500);
const sortOrderSchema = z.number().int().min(0).max(10000);

export const menuIdSchema = z.object({
  id: z.string().uuid(),
});

export const listMenuQuerySchema = z.object({
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createCategorySchema = z.object({
  organizationId: z.string().uuid(),
  name: menuNameSchema,
  description: menuDescriptionSchema.optional(),
  sortOrder: sortOrderSchema.default(0),
  isActive: z.boolean().default(true),
});

export const updateCategorySchema = z
  .object({
    name: menuNameSchema.optional(),
    description: menuDescriptionSchema.nullable().optional(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const createCuisineSchema = createCategorySchema;
export const updateCuisineSchema = updateCategorySchema;

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateCuisineInput = z.infer<typeof createCuisineSchema>;
export type UpdateCuisineInput = z.infer<typeof updateCuisineSchema>;
export type ListMenuQuery = z.infer<typeof listMenuQuerySchema>;
