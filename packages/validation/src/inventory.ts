import { z } from "zod";

/** Units an ingredient can be tracked in. kg↔g and l↔ml convert automatically. */
export const INVENTORY_UNITS = ["kg", "g", "l", "ml", "pcs"] as const;

export const INVENTORY_CATEGORIES = [
  "vegetables",
  "fruits",
  "dairy",
  "meat",
  "seafood",
  "grocery",
  "spices",
  "beverages",
  "bakery",
  "packaging",
  "cleaning",
  "other",
] as const;

/** Stock status of an ingredient at a branch. */
export const STOCK_STATUSES = ["in_stock", "low_stock", "out_of_stock"] as const;

export const STOCK_MOVEMENT_TYPES = [
  "opening",
  "purchase",
  "sale",
  "sale_reversal",
  "wastage",
  "count",
  "adjustment",
] as const;

export const WASTAGE_REASONS = [
  "spoiled",
  "expired",
  "spilled",
  "overcooked",
  "staff_meal",
  "other",
] as const;

export const STOCK_ALERT_STATUSES = ["active", "acknowledged", "resolved"] as const;

/** Largest quantity accepted for one line. */
const MAX_QUANTITY = 1_000_000;

/** Largest unit cost accepted: ₹10 lakh. */
const MAX_UNIT_COST = 1_000_000;

/** Longest report range, in days. */
const MAX_REPORT_DAYS = 92;

/**
 * Checks a number has at most the given decimal places.
 *
 * @param value - The number.
 * @param places - Allowed decimal places.
 * @returns True if it fits.
 */
function hasMaxDecimals(value: number, places: number): boolean {
  const factor = 10 ** places;

  return Math.abs(value * factor - Math.round(value * factor)) < 1e-6;
}

/** A stock quantity (≥ 0) with at most 3 decimals, e.g. 0.125 kg. */
const quantitySchema = z
  .number()
  .min(0)
  .max(MAX_QUANTITY)
  .refine((value) => hasMaxDecimals(value, 3), {
    message: "Quantity can have at most 3 decimal places",
  });

const positiveQuantitySchema = quantitySchema.refine((value) => value > 0, {
  message: "Quantity must be greater than 0",
});

/** Cost of one unit in rupees, with at most 4 decimals (e.g. ₹0.4125 per g). */
const unitCostSchema = z
  .number()
  .min(0)
  .max(MAX_UNIT_COST)
  .refine((value) => hasMaxDecimals(value, 4), {
    message: "Unit cost can have at most 4 decimal places",
  });

const noteSchema = z.string().trim().min(1).max(300);

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

const booleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const paginationShape = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

/**
 * Checks every value in a list is distinct.
 *
 * @param values - The values.
 * @returns True if there are no duplicates.
 */
function isUnique(values: (string | null)[]): boolean {
  return new Set(values).size === values.length;
}

// ─── Params ─────────────────────────────────────────────────────────────

export const inventoryItemIdParamsSchema = z.object({
  itemId: z.uuid(),
});

export const branchInventoryParamsSchema = z.object({
  branchId: z.uuid(),
});

export const branchInventoryItemParamsSchema = z.object({
  branchId: z.uuid(),
  itemId: z.uuid(),
});

export const supplierIdParamsSchema = z.object({
  supplierId: z.uuid(),
});

export const purchaseParamsSchema = z.object({
  branchId: z.uuid(),
  purchaseId: z.uuid(),
});

export const stockCountParamsSchema = z.object({
  branchId: z.uuid(),
  countId: z.uuid(),
});

export const recipeParamsSchema = z.object({
  menuItemId: z.uuid(),
});

export const stockAlertParamsSchema = z.object({
  alertId: z.uuid(),
});

// ─── Inventory items ────────────────────────────────────────────────────

const itemNameSchema = z.string().trim().min(1).max(100);
const skuSchema = z.string().trim().min(1).max(50);

export const createInventoryItemSchema = z.object({
  name: itemNameSchema,
  category: z.enum(INVENTORY_CATEGORIES).default("other"),
  /** The unit stock is kept in. It can't be changed later. */
  unit: z.enum(INVENTORY_UNITS),
  sku: skuSchema.optional(),
  /** When it runs out, dishes that use it are turned off (auto-86). */
  isEssential: z.boolean().default(true),
  /** Opening stock per branch; branches left out start at 0. */
  branchStock: z
    .array(
      z.object({
        branchId: z.uuid(),
        openingQuantity: quantitySchema.default(0),
        unitCost: unitCostSchema.default(0),
        lowStockLevel: quantitySchema.default(0),
      }),
    )
    .max(50)
    .refine((rows) => isUnique(rows.map((row) => row.branchId)), {
      message: "Each branch can appear only once",
    })
    .default([]),
});

export const updateInventoryItemSchema = z
  .object({
    name: itemNameSchema.optional(),
    category: z.enum(INVENTORY_CATEGORIES).optional(),
    sku: skuSchema.nullable().optional(),
    isEssential: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const listInventoryItemsQuerySchema = z.object({
  branchId: z.uuid(),
  category: z.enum(INVENTORY_CATEGORIES).optional(),
  status: z.enum(STOCK_STATUSES).optional(),
  /** Matches name or SKU. */
  search: z.string().trim().min(1).max(50).optional(),
  includeInactive: booleanQuerySchema.default(false),
  ...paginationShape,
});

export const inventoryItemQuerySchema = z.object({
  /** Limits stock and recent movements to one branch. */
  branchId: z.uuid().optional(),
});

export const deleteInventoryItemQuerySchema = z.object({
  /** Deactivate even when active recipes use it (those lines are removed). */
  force: booleanQuerySchema.default(false),
});

export const updateBranchStockSchema = z.object({
  lowStockLevel: quantitySchema,
});

// ─── Suppliers ──────────────────────────────────────────────────────────

const supplierShape = {
  name: z.string().trim().min(1).max(100),
  contactName: z.string().trim().min(1).max(100),
  phone: z.string().trim().regex(/^\+?[\d\s-]{8,15}$/, "Enter a valid phone number"),
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, "Enter a valid GSTIN"),
  address: z.string().trim().min(1).max(300),
  notes: noteSchema,
};

export const createSupplierSchema = z.object({
  name: supplierShape.name,
  contactName: supplierShape.contactName.optional(),
  phone: supplierShape.phone.optional(),
  email: supplierShape.email.optional(),
  gstin: supplierShape.gstin.optional(),
  address: supplierShape.address.optional(),
  notes: supplierShape.notes.optional(),
});

export const updateSupplierSchema = z
  .object({
    name: supplierShape.name.optional(),
    contactName: supplierShape.contactName.nullable().optional(),
    phone: supplierShape.phone.nullable().optional(),
    email: supplierShape.email.nullable().optional(),
    gstin: supplierShape.gstin.nullable().optional(),
    address: supplierShape.address.nullable().optional(),
    notes: supplierShape.notes.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const listSuppliersQuerySchema = z.object({
  search: z.string().trim().min(1).max(50).optional(),
  includeInactive: booleanQuerySchema.default(false),
  ...paginationShape,
});

// ─── Stock movements ────────────────────────────────────────────────────

/** An ingredient quantity; `unit` defaults to the item's own unit. */
const stockLineShape = {
  inventoryItemId: z.uuid(),
  quantity: positiveQuantitySchema,
  unit: z.enum(INVENTORY_UNITS).optional(),
};

const uniqueItemsMessage = { message: "Each item can appear only once" };

export const createPurchaseSchema = z.object({
  supplierId: z.uuid().optional(),
  /** The supplier's bill number. */
  invoiceNumber: z.string().trim().min(1).max(50).optional(),
  /** Defaults to the branch's business day. */
  purchaseDate: dateSchema.optional(),
  items: z
    .array(z.object({ ...stockLineShape, unitCost: unitCostSchema }))
    .min(1, "Add at least one item")
    .max(100)
    .refine((items) => isUnique(items.map((item) => item.inventoryItemId)), uniqueItemsMessage),
  notes: noteSchema.optional(),
});

export const listPurchasesQuerySchema = z
  .object({
    supplierId: z.uuid().optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    ...paginationShape,
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

export const recordWastageSchema = z.object({
  items: z
    .array(
      z.object({
        ...stockLineShape,
        reason: z.enum(WASTAGE_REASONS),
        notes: noteSchema.optional(),
      }),
    )
    .min(1, "Add at least one item")
    .max(100)
    .refine((items) => isUnique(items.map((item) => item.inventoryItemId)), uniqueItemsMessage),
});

export const createStockCountSchema = z.object({
  /** When the count was taken; defaults to now. */
  countedAt: z.iso.datetime({ offset: true }).optional(),
  items: z
    .array(
      z.object({
        inventoryItemId: z.uuid(),
        countedQuantity: quantitySchema,
        unit: z.enum(INVENTORY_UNITS).optional(),
      }),
    )
    .min(1, "Add at least one item")
    .max(500)
    .refine((items) => isUnique(items.map((item) => item.inventoryItemId)), uniqueItemsMessage),
  notes: noteSchema.optional(),
});

export const listStockCountsQuerySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    ...paginationShape,
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

export const stockAdjustmentSchema = z.object({
  inventoryItemId: z.uuid(),
  /** Positive adds stock, negative removes it. */
  quantity: z
    .number()
    .min(-MAX_QUANTITY)
    .max(MAX_QUANTITY)
    .refine((value) => value !== 0, { message: "Quantity can't be 0" })
    .refine((value) => hasMaxDecimals(value, 3), {
      message: "Quantity can have at most 3 decimal places",
    }),
  unit: z.enum(INVENTORY_UNITS).optional(),
  reason: noteSchema,
  managerPin: z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits"),
});

export const listStockMovementsQuerySchema = z
  .object({
    itemId: z.uuid().optional(),
    type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    ...paginationShape,
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

// ─── Recipes ────────────────────────────────────────────────────────────

const recipeIngredientsSchema = z
  .array(
    z.object({
      inventoryItemId: z.uuid(),
      quantity: positiveQuantitySchema,
      unit: z.enum(INVENTORY_UNITS).optional(),
    }),
  )
  .min(1, "A recipe needs at least one ingredient")
  .max(50)
  .refine(
    (ingredients) => isUnique(ingredients.map((entry) => entry.inventoryItemId)),
    { message: "Each ingredient can appear only once in a recipe" },
  );

/** Replaces a dish's whole recipe. */
export const saveRecipeSchema = z
  .object({
    /** `variantId: null` is the base recipe, used by variants without their own. */
    variants: z
      .array(
        z.object({
          variantId: z.uuid().nullable(),
          ingredients: recipeIngredientsSchema,
        }),
      )
      .max(30)
      .refine((rows) => isUnique(rows.map((row) => row.variantId)), {
        message: "Each variant can appear only once",
      })
      .default([]),
    addons: z
      .array(
        z.object({
          addonId: z.uuid(),
          ingredients: recipeIngredientsSchema,
        }),
      )
      .max(30)
      .refine((rows) => isUnique(rows.map((row) => row.addonId)), {
        message: "Each add-on can appear only once",
      })
      .default([]),
  })
  .refine((data) => data.variants.length > 0 || data.addons.length > 0, {
    message: "Add at least one recipe",
  });

export const recipeQuerySchema = z.object({
  /** Costs and prices are taken from this branch. */
  branchId: z.uuid().optional(),
});

export const listRecipesQuerySchema = z.object({
  /** Only dishes that have no recipe yet. */
  missing: booleanQuerySchema.default(false),
  search: z.string().trim().min(1).max(50).optional(),
  ...paginationShape,
});

// ─── Settings and alerts ────────────────────────────────────────────────

export const updateInventorySettingsSchema = z
  .object({
    autoDeductEnabled: z.boolean().optional(),
    auto86Enabled: z.boolean().optional(),
    allowNegativeStock: z.boolean().optional(),
    lowStockAlertsEnabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one setting must be provided",
  });

export const listStockAlertsQuerySchema = z.object({
  /** Defaults to open alerts (active and acknowledged). */
  status: z.enum(STOCK_ALERT_STATUSES).optional(),
  ...paginationShape,
});

// ─── Reports ────────────────────────────────────────────────────────────

export const inventoryReportQuerySchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
  })
  .refine((data) => data.from <= data.to, {
    message: "from must be on or before to",
    path: ["from"],
  })
  .refine(
    (data) =>
      (Date.parse(data.to) - Date.parse(data.from)) / 86_400_000 < MAX_REPORT_DAYS,
    { message: `A report can cover at most ${MAX_REPORT_DAYS} days`, path: ["to"] },
  );

export type InventoryUnitValue = (typeof INVENTORY_UNITS)[number];
export type InventoryCategoryValue = (typeof INVENTORY_CATEGORIES)[number];
export type StockStatusValue = (typeof STOCK_STATUSES)[number];
export type StockMovementTypeValue = (typeof STOCK_MOVEMENT_TYPES)[number];
export type WastageReasonValue = (typeof WASTAGE_REASONS)[number];
export type StockAlertStatusValue = (typeof STOCK_ALERT_STATUSES)[number];
export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;
export type ListInventoryItemsQuery = z.infer<typeof listInventoryItemsQuerySchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;
export type ListPurchasesQuery = z.infer<typeof listPurchasesQuerySchema>;
export type RecordWastageInput = z.infer<typeof recordWastageSchema>;
export type CreateStockCountInput = z.infer<typeof createStockCountSchema>;
export type ListStockCountsQuery = z.infer<typeof listStockCountsQuerySchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type ListStockMovementsQuery = z.infer<typeof listStockMovementsQuerySchema>;
export type SaveRecipeInput = z.infer<typeof saveRecipeSchema>;
export type ListRecipesQuery = z.infer<typeof listRecipesQuerySchema>;
export type UpdateInventorySettingsInput = z.infer<typeof updateInventorySettingsSchema>;
export type ListStockAlertsQuery = z.infer<typeof listStockAlertsQuerySchema>;
export type InventoryReportQuery = z.infer<typeof inventoryReportQuerySchema>;
