import { z } from "zod";

/** How a bill is divided between guests. */
export const BILL_SPLIT_MODES = ["equal", "custom_amount", "percentage", "items"] as const;

/** A bill can be split into 2 to 20 parts. */
const MIN_PARTS = 2;
const MAX_PARTS = 20;

/** Largest amount accepted: ₹1 crore, in paise. */
const MAX_PAISE = 1_000_000_000;

/** e.g. "Rahul", "Seat 3". Defaults to "Guest 1", "Guest 2"… */
const labelSchema = z.string().trim().min(1).max(50);

const partCountMessage = `A bill can be split into ${MIN_PARTS} to ${MAX_PARTS} parts`;

export const splitPartParamsSchema = z.object({
  branchId: z.uuid(),
  billId: z.uuid(),
  partNumber: z.coerce.number().int().min(1).max(MAX_PARTS),
});

/** Split into N equal parts (any leftover paise go to the first parts). */
const equalSplitSchema = z.object({
  mode: z.literal("equal"),
  parts: z.number().int().min(MIN_PARTS, partCountMessage).max(MAX_PARTS, partCountMessage),
  labels: z.array(labelSchema).max(MAX_PARTS).optional(),
});

/** Split by amounts that must add up to the amount due. */
const customAmountSplitSchema = z.object({
  mode: z.literal("custom_amount"),
  parts: z
    .array(
      z.object({
        label: labelSchema.optional(),
        amountPaise: z.number().int().min(1, "Each part must be at least ₹0.01").max(MAX_PAISE),
      }),
    )
    .min(MIN_PARTS, partCountMessage)
    .max(MAX_PARTS, partCountMessage),
});

/** Split by percentages that must add up to 100. */
const percentageSplitSchema = z.object({
  mode: z.literal("percentage"),
  parts: z
    .array(
      z.object({
        label: labelSchema.optional(),
        percent: z
          .number()
          .gt(0, "Each part must be more than 0%")
          .max(100)
          .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
            message: "Percent can have at most 2 decimal places",
          }),
      }),
    )
    .min(MIN_PARTS, partCountMessage)
    .max(MAX_PARTS, partCountMessage)
    .refine((parts) => Math.abs(parts.reduce((sum, part) => sum + part.percent, 0) - 100) < 0.001, {
      message: "Percentages must add up to 100",
    }),
});

/**
 * Split by items: each guest pays for what they had. A shared dish can be
 * divided with a fractional quantity (e.g. 0.5 of a pizza each). Every
 * item on the bill must be fully assigned.
 */
const itemSplitSchema = z.object({
  mode: z.literal("items"),
  parts: z
    .array(
      z.object({
        label: labelSchema.optional(),
        items: z
          .array(
            z.object({
              orderItemId: z.uuid(),
              quantity: z
                .number()
                .gt(0, "Quantity must be more than 0")
                .max(1000)
                .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6, {
                  message: "Quantity can have at most 3 decimal places",
                }),
            }),
          )
          .min(1, "Each part needs at least one item")
          .max(200),
      }),
    )
    .min(MIN_PARTS, partCountMessage)
    .max(MAX_PARTS, partCountMessage),
});

export const splitBillSchema = z.discriminatedUnion("mode", [
  equalSplitSchema,
  customAmountSplitSchema,
  percentageSplitSchema,
  itemSplitSchema,
]);

export type BillSplitModeValue = (typeof BILL_SPLIT_MODES)[number];
export type SplitBillInput = z.infer<typeof splitBillSchema>;
