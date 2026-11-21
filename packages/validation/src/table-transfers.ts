import { z } from "zod";

/** Kinds of table action, as used by the API. */
export const TABLE_TRANSFER_TYPES = ["transfer", "swap", "merge", "item_move"] as const;

const reasonSchema = z.string().trim().min(1).max(300);

/** Exactly one target: an order, or a table (its open order, or a new order if it's free). */
const ONE_TARGET = {
  message: "Send either targetOrderId or tableId",
  path: ["targetOrderId"],
};

/**
 * Checks exactly one target is given.
 *
 * @param data - The request.
 * @returns True when exactly one of targetOrderId and tableId is set.
 */
function hasOneTarget(data: { targetOrderId?: string; tableId?: string }): boolean {
  return (data.targetOrderId === undefined) !== (data.tableId === undefined);
}

/**
 * Moves an order to another table. If that table is busy, `swap: true`
 * swaps the two tables' orders; otherwise use merge.
 */
export const transferOrderSchema = z.object({
  tableId: z.uuid(),
  swap: z.boolean().default(false),
  reason: reasonSchema.optional(),
});

/** Merges this order into another order (or the open order on a table). */
export const mergeOrderSchema = z
  .object({
    targetOrderId: z.uuid().optional(),
    tableId: z.uuid().optional(),
    reason: reasonSchema.optional(),
  })
  .refine(hasOneTarget, ONE_TARGET);

/**
 * Moves some items to another order or table. Leave out `quantity` to move
 * the whole line; a smaller quantity splits the line.
 */
export const moveOrderItemsSchema = z
  .object({
    items: z
      .array(
        z.object({
          orderItemId: z.uuid(),
          quantity: z.number().int().min(1, "Quantity must be at least 1").optional(),
        }),
      )
      .min(1, "Pick at least one item to move")
      .max(100)
      .refine((items) => new Set(items.map((item) => item.orderItemId)).size === items.length, {
        message: "Each item can appear only once",
      }),
    targetOrderId: z.uuid().optional(),
    tableId: z.uuid().optional(),
    reason: reasonSchema.optional(),
  })
  .refine(hasOneTarget, ONE_TARGET);

export const tableTransferBranchParamsSchema = z.object({
  branchId: z.uuid(),
});

export const tableTransferIdParamsSchema = z.object({
  transferId: z.uuid(),
});

export const listTableTransfersQuerySchema = z.object({
  /** Business day (YYYY-MM-DD); defaults to all days, newest first. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format").optional(),
  type: z.enum(TABLE_TRANSFER_TYPES).optional(),
  orderId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type TableTransferTypeValue = (typeof TABLE_TRANSFER_TYPES)[number];
export type TransferOrderInput = z.infer<typeof transferOrderSchema>;
export type MergeOrderInput = z.infer<typeof mergeOrderSchema>;
export type MoveOrderItemsInput = z.infer<typeof moveOrderItemsSchema>;
export type ListTableTransfersQuery = z.infer<typeof listTableTransfersQuerySchema>;
