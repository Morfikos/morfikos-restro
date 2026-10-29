import { z } from "zod";

import {
  dimensionSchema,
  positionSchema,
  rotationSchema,
  tableShapeSchema,
} from "./floors.js";

/** Live table statuses, derived from the table's current order. */
export const TABLE_STATUSES = ["available", "occupied", "billed"] as const;

const tableNameSchema = z.string().trim().min(1).max(30);
const seatsSchema = z.number().int().min(1).max(50);
const sortOrderSchema = z.number().int().min(0).max(10000);

export const tableIdSchema = z.object({
  id: z.uuid(),
});

export const createTableSchema = z.object({
  branchId: z.uuid(),
  /** Table number or label shown on the floor plan, e.g. "10" or "Patio 2". */
  name: tableNameSchema,
  seats: seatsSchema.default(2),
  floorId: z.uuid().optional(),
  shape: tableShapeSchema.default("SQUARE"),
  positionX: positionSchema.optional(),
  positionY: positionSchema.optional(),
  width: dimensionSchema.default(80),
  height: dimensionSchema.default(80),
  rotation: rotationSchema.default(0),
  sortOrder: sortOrderSchema.default(0),
  isActive: z.boolean().default(true),
});

export const updateTableSchema = z
  .object({
    name: tableNameSchema.optional(),
    seats: seatsSchema.optional(),
    /** null removes the table from its floor. */
    floorId: z.uuid().nullable().optional(),
    shape: tableShapeSchema.optional(),
    positionX: positionSchema.nullable().optional(),
    positionY: positionSchema.nullable().optional(),
    width: dimensionSchema.optional(),
    height: dimensionSchema.optional(),
    rotation: rotationSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const listTablesQuerySchema = z.object({
  branchId: z.uuid(),
  status: z.enum(TABLE_STATUSES).optional(),
  floorId: z.uuid().optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type TableStatusValue = (typeof TABLE_STATUSES)[number];
export type CreateTableInput = z.infer<typeof createTableSchema>;
export type UpdateTableInput = z.infer<typeof updateTableSchema>;
export type ListTablesQuery = z.infer<typeof listTablesQuerySchema>;
