import { z } from "zod";

const menuNameSchema = z.string().trim().min(1).max(100);
const menuDescriptionSchema = z.string().trim().max(500);
const sortOrderSchema = z.number().int().min(0).max(10000);

export const menuIdSchema = z.object({
  id: z.uuid(),
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
  organizationId: z.uuid(),
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

/** Kitchen stations an item's KOT can be routed to. */
export const KITCHEN_STATIONS = [
  "hot_kitchen",
  "cold_kitchen",
  "tandoor",
  "bar",
  "bakery",
  "dessert",
] as const;

/** Days of the week used for item availability timings. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const priceSchema = z.number().min(0).max(1_000_000);

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:mm format");

/**
 * Checks that every entry in a list has a unique name (case-insensitive).
 *
 * @param entries - Entries with a name.
 * @returns True if no two entries share a name.
 */
function hasUniqueNames(entries: { name: string }[]): boolean {
  const names = entries.map((entry) => entry.name.toLowerCase());
  return new Set(names).size === names.length;
}

const menuItemVariantSchema = z.object({
  name: z.string().trim().min(1).max(50),
  extraPrice: priceSchema.default(0),
  dineInAvailable: z.boolean().default(true),
  parcelAvailable: z.boolean().default(true),
  deliveryAvailable: z.boolean().default(true),
});

const menuItemAddonSchema = z.object({
  name: z.string().trim().min(1).max(100),
  price: priceSchema,
  isVeg: z.boolean().default(true),
});

// Menu item field rules shared by the create and update schemas.
const gstSchema = z.number().min(0).max(100);

const hsnSchema = z
  .string()
  .trim()
  .regex(/^(\d{4}|\d{6}|\d{8})$/, "HSN must be 4, 6 or 8 digits");

const allergensSchema = z
  .array(z.enum(ALLERGENS))
  .transform((allergens) => [...new Set(allergens)]);

const preparationTimeSchema = z.number().int().min(0).max(600);

const imageUrlSchema = z.string().trim().pipe(z.url().max(2000));

const kitchenStationSchema = z.enum(KITCHEN_STATIONS);

const availableDaysSchema = z
  .array(z.enum(WEEKDAYS))
  .min(1)
  .transform((days) => [...new Set(days)]);

const variantsSchema = z
  .array(menuItemVariantSchema)
  .max(20)
  .refine(hasUniqueNames, { message: "Variant names must be unique" });

const addonsSchema = z
  .array(menuItemAddonSchema)
  .max(50)
  .refine(hasUniqueNames, { message: "Addon names must be unique" });

const TIMING_REQUIRED_MESSAGE =
  "availableTimeStart and availableTimeEnd are required when timingEnabled is true";

export const createMenuItemSchema = z
  .object({
    organizationId: z.uuid(),
    categoryId: z.uuid(),
    name: menuNameSchema,
    description: menuDescriptionSchema.optional(),
    gst: gstSchema,
    hsn: hsnSchema,
    isVeg: z.boolean(),
    isJain: z.boolean().default(false),
    isRecommended: z.boolean().default(false),
    allergens: allergensSchema.default([]),
    preparationTime: preparationTimeSchema.optional(),
    imageUrl: imageUrlSchema.optional(),
    sortOrder: sortOrderSchema.default(0),
    kitchenStation: kitchenStationSchema.default("hot_kitchen"),
    timingEnabled: z.boolean().default(false),
    availableDays: availableDaysSchema.default([...WEEKDAYS]),
    availableTimeStart: timeOfDaySchema.optional(),
    availableTimeEnd: timeOfDaySchema.optional(),
    variants: variantsSchema.default([]),
    addons: addonsSchema.default([]),
    isActive: z.boolean().default(true),
  })
  .refine(
    (data) =>
      !data.timingEnabled ||
      (data.availableTimeStart !== undefined && data.availableTimeEnd !== undefined),
    { message: TIMING_REQUIRED_MESSAGE, path: ["availableTimeStart"] },
  );

/**
 * Partial update of a menu item. Fields are optional and have no defaults,
 * so omitted fields stay unchanged. `null` clears an optional field.
 * `variants` and `addons`, when sent, replace the item's existing lists.
 */
export const updateMenuItemSchema = z
  .object({
    categoryId: z.uuid().optional(),
    name: menuNameSchema.optional(),
    description: menuDescriptionSchema.nullable().optional(),
    gst: gstSchema.optional(),
    hsn: hsnSchema.optional(),
    isVeg: z.boolean().optional(),
    isJain: z.boolean().optional(),
    isRecommended: z.boolean().optional(),
    allergens: allergensSchema.optional(),
    preparationTime: preparationTimeSchema.nullable().optional(),
    imageUrl: imageUrlSchema.nullable().optional(),
    sortOrder: sortOrderSchema.optional(),
    kitchenStation: kitchenStationSchema.optional(),
    timingEnabled: z.boolean().optional(),
    availableDays: availableDaysSchema.optional(),
    availableTimeStart: timeOfDaySchema.nullable().optional(),
    availableTimeEnd: timeOfDaySchema.nullable().optional(),
    variants: variantsSchema.optional(),
    addons: addonsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const listMenuItemsQuerySchema = listMenuQuerySchema.extend({
  branchId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
});

export const branchMenuItemParamsSchema = z.object({
  branchId: z.uuid(),
  itemId: z.uuid(),
});

export const upsertBranchMenuItemSchema = z
  .object({
    price: priceSchema,
    costPrice: priceSchema.nullable().optional(),
    comparePrice: priceSchema.nullable().optional(),
    isAvailable: z.boolean().optional(),
    dineInAvailable: z.boolean().optional(),
    parcelAvailable: z.boolean().optional(),
    deliveryAvailable: z.boolean().optional(),
    maxQuantityPerOrder: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .refine(
    (data) =>
      data.comparePrice === undefined ||
      data.comparePrice === null ||
      data.comparePrice >= data.price,
    {
      message: "comparePrice must be greater than or equal to price",
      path: ["comparePrice"],
    },
  );

export const qrCodeParamsSchema = z.object({
  qrCode: z.string().trim().min(1).max(100),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateCuisineInput = z.infer<typeof createCuisineSchema>;
export type UpdateCuisineInput = z.infer<typeof updateCuisineSchema>;
export type ListMenuQuery = z.infer<typeof listMenuQuerySchema>;
export type Allergen = (typeof ALLERGENS)[number];
export type KitchenStation = (typeof KITCHEN_STATIONS)[number];
export type Weekday = (typeof WEEKDAYS)[number];
export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;
export type ListMenuItemsQuery = z.infer<typeof listMenuItemsQuerySchema>;
export type UpsertBranchMenuItemInput = z.infer<typeof upsertBranchMenuItemSchema>;
