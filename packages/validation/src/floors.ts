import { z } from "zod";

/** Shapes a table can be drawn with on the floor map. */
export const TABLE_SHAPES = ["ROUND", "SQUARE", "RECTANGLE"] as const;

/** Non-table things drawn on the floor map. */
export const FLOOR_OBJECT_TYPES = [
  "WALL",
  "BAR_COUNTER",
  "ENTRANCE",
  "KITCHEN",
  "WASHROOM",
  "PILLAR",
  "STAIRS",
  "WINDOW",
  "OTHER",
] as const;

/** Lifecycle of a photo → floor map import. */
export const LAYOUT_IMPORT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "READY_FOR_REVIEW",
  "APPLIED",
  "FAILED",
  "DISCARDED",
] as const;

/** Largest floor canvas, in map units. */
export const MAX_FLOOR_SIZE = 10000;

const floorNameSchema = z.string().trim().min(1).max(50);
const sortOrderSchema = z.number().int().min(0).max(10000);
const floorSizeSchema = z.number().int().min(100).max(MAX_FLOOR_SIZE);

/** A coordinate on the floor canvas (top-left origin). */
export const positionSchema = z.number().min(0).max(MAX_FLOOR_SIZE);

/** A width or height on the floor canvas. */
export const dimensionSchema = z.number().min(1).max(MAX_FLOOR_SIZE);

/** Rotation in degrees. */
export const rotationSchema = z.number().min(0).max(360);

export const tableShapeSchema = z.enum(TABLE_SHAPES);

const tableNameSchema = z.string().trim().min(1).max(30);
const seatsSchema = z.number().int().min(1).max(50);

export const floorIdSchema = z.object({
  id: z.uuid(),
});

export const layoutImportIdSchema = z.object({
  importId: z.uuid(),
});

export const createFloorSchema = z.object({
  branchId: z.uuid(),
  name: floorNameSchema,
  sortOrder: sortOrderSchema.default(0),
  width: floorSizeSchema.default(1000),
  height: floorSizeSchema.default(600),
});

export const updateFloorSchema = z
  .object({
    name: floorNameSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    width: floorSizeSchema.optional(),
    height: floorSizeSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const listFloorsQuerySchema = z.object({
  branchId: z.uuid(),
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

/** A wall, counter, entrance or other non-table object on the map. */
export const floorObjectSchema = z.object({
  type: z.enum(FLOOR_OBJECT_TYPES),
  label: z.string().trim().max(50).optional(),
  positionX: positionSchema,
  positionY: positionSchema,
  width: dimensionSchema,
  height: dimensionSchema,
  rotation: rotationSchema.default(0),
});

/** An existing table's position on the floor, as saved by the editor. */
const tablePlacementSchema = z.object({
  id: z.uuid(),
  positionX: positionSchema,
  positionY: positionSchema,
  width: dimensionSchema,
  height: dimensionSchema,
  rotation: rotationSchema.default(0),
  shape: tableShapeSchema.optional(),
});

/**
 * Saves the floor map editor. `tables` places existing tables on this floor;
 * tables not listed keep their current position. `objects`, when sent,
 * replaces all of the floor's objects.
 */
export const saveFloorLayoutSchema = z
  .object({
    width: floorSizeSchema.optional(),
    height: floorSizeSchema.optional(),
    tables: z.array(tablePlacementSchema).max(300).default([]),
    objects: z.array(floorObjectSchema).max(300).optional(),
  })
  .refine(
    (data) => new Set(data.tables.map((table) => table.id)).size === data.tables.length,
    { message: "Each table can only be placed once", path: ["tables"] },
  );

/** A table in a photo-import layout, matched to existing tables by name. */
export const layoutTableSchema = z.object({
  name: tableNameSchema,
  seats: seatsSchema.default(2),
  shape: tableShapeSchema.default("SQUARE"),
  positionX: positionSchema,
  positionY: positionSchema,
  width: dimensionSchema,
  height: dimensionSchema,
  rotation: rotationSchema.default(0),
});

/** A full floor layout: what the AI proposes and what the owner applies. */
export const floorLayoutDraftSchema = z
  .object({
    tables: z.array(layoutTableSchema).max(300),
    objects: z.array(floorObjectSchema).max(300).default([]),
  })
  .refine(
    (data) =>
      new Set(data.tables.map((table) => table.name.toLowerCase())).size ===
      data.tables.length,
    { message: "Table names must be unique", path: ["tables"] },
  );

/**
 * Applies a photo import. Send the owner's corrected layout; omit it to
 * apply the AI's proposal as-is.
 */
export const applyLayoutImportSchema = z.object({
  layout: floorLayoutDraftSchema.optional(),
  /** Also use the uploaded photo as the floor's background. */
  setAsBackground: z.boolean().default(true),
});

export type CreateFloorInput = z.infer<typeof createFloorSchema>;
export type UpdateFloorInput = z.infer<typeof updateFloorSchema>;
export type ListFloorsQuery = z.infer<typeof listFloorsQuerySchema>;
export type SaveFloorLayoutInput = z.infer<typeof saveFloorLayoutSchema>;
export type FloorLayoutDraft = z.infer<typeof floorLayoutDraftSchema>;
export type ApplyLayoutImportInput = z.infer<typeof applyLayoutImportSchema>;
