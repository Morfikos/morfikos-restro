import { z } from "zod";

/** Response formats for list reports. `csv` downloads a file that opens in Excel. */
export const REPORT_FORMATS = ["json", "csv"] as const;

/** How the item report is ordered. */
export const ITEM_REPORT_SORTS = ["revenue", "quantity"] as const;

/** Longest range a report can cover, in days. */
const MAX_REPORT_DAYS = 366;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

export const reportBranchParamsSchema = z.object({
  branchId: z.uuid(),
});

/** Business-date range; both default to the branch's current business day. */
const rangeShape = {
  from: dateSchema.optional(),
  to: dateSchema.optional(),
};

/**
 * Checks a report range is ordered and not too long.
 *
 * @param data - The range.
 * @returns True if it's valid.
 */
function isValidRange(data: { from?: string; to?: string }): boolean {
  if (!data.from || !data.to) {
    return true;
  }

  return (
    data.from <= data.to &&
    (Date.parse(data.to) - Date.parse(data.from)) / 86_400_000 < MAX_REPORT_DAYS
  );
}

const RANGE_RULE = {
  message: `from must be on or before to, and a report can cover at most ${MAX_REPORT_DAYS} days`,
  path: ["from"],
};

export const reportRangeQuerySchema = z.object(rangeShape).refine(isValidRange, RANGE_RULE);

/** A range report that can also be downloaded as CSV. */
export const exportableReportQuerySchema = z
  .object({
    ...rangeShape,
    format: z.enum(REPORT_FORMATS).default("json"),
  })
  .refine(isValidRange, RANGE_RULE);

export const itemSalesReportQuerySchema = z
  .object({
    ...rangeShape,
    format: z.enum(REPORT_FORMATS).default("json"),
    categoryId: z.uuid().optional(),
    sort: z.enum(ITEM_REPORT_SORTS).default("revenue"),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .refine(isValidRange, RANGE_RULE);

export const dashboardQuerySchema = z.object({
  /** The business day to show; defaults to today. */
  date: dateSchema.optional(),
});

export type ReportFormat = (typeof REPORT_FORMATS)[number];
export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;
export type ExportableReportQuery = z.infer<typeof exportableReportQuerySchema>;
export type ItemSalesReportQuery = z.infer<typeof itemSalesReportQuerySchema>;
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
