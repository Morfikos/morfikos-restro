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

/** The 14 major food allergens a menu item can be tagged with. */
export const ALLERGENS = [
  "gluten",
  "dairy",
  "egg",
  "peanuts",
  "tree_nuts",
  "soy",
  "fish",
  "shellfish",
  "molluscs",
  "sesame",
  "mustard",
  "celery",
  "sulphites",
  "lupin",
] as const;

const priceSchema = z.number().min(0).max(1_000_000);

export const createMenuItemSchema = z.object({
  organizationId: z.string().uuid(),
  categoryId: z.string().uuid(),
  name: menuNameSchema,
  description: menuDescriptionSchema.optional(),
  gst: z.number().min(0).max(100),
  hsn: z
    .string()
    .trim()
    .regex(/^(\d{4}|\d{6}|\d{8})$/, "HSN must be 4, 6 or 8 digits"),
  isVeg: z.boolean(),
  allergens: z
    .array(z.enum(ALLERGENS))
    .default([])
    .transform((allergens) => [...new Set(allergens)]),
  preparationTime: z.number().int().min(0).max(600).optional(),
  isActive: z.boolean().default(true),
});

export const branchMenuItemParamsSchema = z.object({
  branchId: z.string().uuid(),
  itemId: z.string().uuid(),
});

export const upsertBranchMenuItemSchema = z.object({
  price: priceSchema,
  costPrice: priceSchema.nullable().optional(),
  isAvailable: z.boolean().optional(),
  maxQuantityPerOrder: z.number().int().min(1).max(1000).nullable().optional(),
});

export const qrCodeParamsSchema = z.object({
  qrCode: z.string().trim().min(1).max(100),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateCuisineInput = z.infer<typeof createCuisineSchema>;
export type UpdateCuisineInput = z.infer<typeof updateCuisineSchema>;
export type ListMenuQuery = z.infer<typeof listMenuQuerySchema>;
export type Allergen = (typeof ALLERGENS)[number];
export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpsertBranchMenuItemInput = z.infer<typeof upsertBranchMenuItemSchema>;
