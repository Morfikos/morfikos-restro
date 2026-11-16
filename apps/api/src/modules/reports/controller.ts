import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import {
  dashboardQuerySchema,
  exportableReportQuerySchema,
  itemSalesReportQuerySchema,
  reportBranchParamsSchema,
  reportRangeQuerySchema,
} from "@morfikos/validation";

import {
  getBranchComparison,
  getCategorySalesReport,
  getDashboard,
  getDiscountReport,
  getGstReport,
  getHourlySalesReport,
  getItemSalesReport,
  getPaymentReport,
  getSalesSummary,
  getStaffReport,
  getVoidReport,
  isReportServiceError,
  type ReportActor,
} from "./service.js";

import { REPORT_ROLES } from "./constants.js";

import { toCsv, type CsvColumn } from "../../utils/csv.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type BranchRequest = FastifyRequest<{ Params: { branchId: string } }>;

/**
 * Sends an authentication error when the user is not logged in.
 *
 * @param reply - The Fastify reply instance.
 * @returns An unauthorized response.
 */
function sendUnauthenticated(reply: FastifyReply) {
  return sendError(
    reply,
    401,
    "Login required",
    ErrorCode.UNAUTHENTICATED,
  );
}

/**
 * Sends an authorization error when the user lacks permission.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendForbidden(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Access denied",
    ErrorCode.FORBIDDEN,
  );
}

/**
 * Sends a response when the organization context is missing.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendMissingOrganization(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Organization context is missing",
    ErrorCode.FORBIDDEN,
  );
}

/**
 * Sends a validation error using the first validation issue as the message.
 *
 * @param reply - The Fastify reply instance.
 * @param error - The Zod validation error.
 * @returns A bad-request response.
 */
function sendValidationError(
  reply: FastifyReply,
  error: Pick<ZodError, "issues">,
) {
  return sendError(
    reply,
    400,
    error.issues[0]?.message ?? "Request validation failed",
    ErrorCode.VALIDATION_ERROR,
  );
}

/**
 * Sends a generic server error after logging the underlying error.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param error - The unexpected error.
 * @param logMessage - The message to log alongside the error.
 * @returns An internal server error response.
 */
function sendUnexpectedError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
) {
  request.log.error(
    { err: error },
    logMessage,
  );

  return sendError(
    reply,
    500,
    "An unexpected error occurred",
    ErrorCode.INTERNAL_SERVER_ERROR,
  );
}

/**
 * Verifies the user is logged in as an owner or manager with an
 * organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns The report actor, or null after an error response was sent.
 */
function authorizeReportRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): ReportActor | null {
  const context = getAuthContext(request);

  if (!context) {
    sendUnauthenticated(reply);
    return null;
  }

  if (!hasRole(context, REPORT_ROLES)) {
    sendForbidden(reply);
    return null;
  }

  const organizationId = getOrganizationId(request);

  if (!organizationId) {
    sendMissingOrganization(reply);
    return null;
  }

  return {
    userId: context.userId,
    role: context.role,
    organizationId,
    branchIds: context.branchIds,
  };
}

/**
 * Handles known report service errors.
 *
 * @param error - The error thrown by the report service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleReportServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isReportServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "INVALID_RANGE":
      return sendError(reply, 400, error.message, ErrorCode.INVALID_RANGE);

    case "BRANCH_ACCESS_DENIED":
      return sendError(reply, 403, error.message, ErrorCode.BRANCH_ACCESS_DENIED);

    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    default:
      return null;
  }
}

/**
 * Sends a CSV download (opens in Excel).
 *
 * @param reply - The Fastify reply instance.
 * @param fileName - The download's file name, without extension.
 * @param rows - The rows.
 * @param columns - The columns.
 * @returns The reply.
 */
function sendCsv<T>(reply: FastifyReply, fileName: string, rows: T[], columns: CsvColumn<T>[]) {
  return reply
    .status(200)
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${fileName}.csv"`)
    .send(toCsv(rows, columns));
}

/**
 * Runs a branch report: authorizes the caller, validates the branch and
 * query, builds the report and sends it as JSON — or as CSV when the
 * query asks for `format=csv` and the report has a CSV layout.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param options - The query schema, report builder, message and optional CSV layout.
 * @returns The report or an error response.
 */
async function runBranchReport<Q extends object, R>(
  request: BranchRequest,
  reply: FastifyReply,
  options: {
    querySchema: { safeParse: (value: unknown) => { success: true; data: Q } | { success: false; error: Pick<ZodError, "issues"> } };
    build: (actor: ReportActor, branchId: string, query: Q) => Promise<R>;
    message: string;
    csv?: (report: R) => { fileName: string; send: (reply: FastifyReply, fileName: string) => FastifyReply };
  },
) {
  const actor = authorizeReportRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = reportBranchParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = options.querySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const report = await options.build(actor, parsedParams.data.branchId, parsedQuery.data);
    const wantsCsv = "format" in parsedQuery.data && parsedQuery.data.format === "csv";

    if (wantsCsv && options.csv) {
      const csv = options.csv(report);
      return csv.send(reply, csv.fileName);
    }

    return sendSuccess(reply, 200, options.message, report);
  } catch (error: unknown) {
    const handled = handleReportServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, `Failed to build report: ${options.message}`);
  }
}

/**
 * Builds a CSV layout for a report.
 *
 * @param name - The report name used in the file name.
 * @param rowsOf - Reads the rows from the report.
 * @param columns - The CSV columns.
 * @returns The CSV layout.
 */
function csvLayout<R extends { from: string; to: string }, T>(
  name: string,
  rowsOf: (report: R) => T[],
  columns: CsvColumn<T>[],
) {
  return (report: R) => ({
    fileName: `${name}_${report.from}_to_${report.to}`,
    send: (reply: FastifyReply, fileName: string) => sendCsv(reply, fileName, rowsOf(report), columns),
  });
}

/**
 * Live dashboard for one business day.
 *
 * @param request - The incoming request containing the branch and date.
 * @param reply - The Fastify reply instance.
 * @returns The dashboard or an error response.
 */
export function dashboardController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: dashboardQuerySchema,
    build: getDashboard,
    message: "Dashboard retrieved successfully",
  });
}

/**
 * Sales summary (day-end / Z report); CSV gives one row per day.
 *
 * @param request - The incoming request containing the branch and range.
 * @param reply - The Fastify reply instance.
 * @returns The summary or an error response.
 */
export function salesSummaryController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: exportableReportQuerySchema,
    build: getSalesSummary,
    message: "Sales summary generated successfully",
    csv: csvLayout("sales-summary", (report) => report.days, [
      { header: "Date", value: (row) => row.date },
      { header: "Bills", value: (row) => row.bills },
      { header: "Gross sales", value: (row) => row.grossSales },
      { header: "Discounts", value: (row) => row.discounts },
      { header: "Net sales", value: (row) => row.netSales },
      { header: "Tax", value: (row) => row.tax },
      { header: "Total sales", value: (row) => row.totalSales },
      { header: "Average bill", value: (row) => row.averageBillValue },
    ]),
  });
}

/**
 * Item-wise sales.
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export function itemSalesController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: itemSalesReportQuerySchema,
    build: getItemSalesReport,
    message: "Item sales report generated successfully",
    csv: csvLayout("item-sales", (report) => report.items, [
      { header: "Rank", value: (row) => row.rank },
      { header: "Item", value: (row) => row.name },
      { header: "Category", value: (row) => row.category },
      { header: "Quantity", value: (row) => row.quantity },
      { header: "Revenue", value: (row) => row.revenue },
      { header: "Average price", value: (row) => row.averagePrice },
      { header: "Orders", value: (row) => row.orders },
      { header: "Revenue share %", value: (row) => row.revenueShare },
    ]),
  });
}

/**
 * Category-wise sales.
 *
 * @param request - The incoming request containing the branch and range.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export function categorySalesController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: exportableReportQuerySchema,
    build: getCategorySalesReport,
    message: "Category sales report generated successfully",
    csv: csvLayout("category-sales", (report) => report.categories, [
      { header: "Category", value: (row) => row.name },
      { header: "Dishes sold", value: (row) => row.dishes },
      { header: "Quantity", value: (row) => row.quantity },
      { header: "Revenue", value: (row) => row.revenue },
      { header: "Revenue share %", value: (row) => row.revenueShare },
    ]),
  });
}

/**
 * Sales by hour and weekday.
 *
 * @param request - The incoming request containing the branch and range.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export function hourlySalesController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: exportableReportQuerySchema,
    build: getHourlySalesReport,
    message: "Hourly sales report generated successfully",
    csv: csvLayout("hourly-sales", (report) => report.hourly, [
      { header: "Hour", value: (row) => row.label },
      { header: "Bills", value: (row) => row.bills },
      { header: "Sales", value: (row) => row.sales },
    ]),
  });
}

/**
 * Payment-mode report.
 *
 * @param request - The incoming request containing the branch and range.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export function paymentReportController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: exportableReportQuerySchema,
    build: getPaymentReport,
    message: "Payment report generated successfully",
    csv: csvLayout("payments", (report) => report.days, [
      { header: "Date", value: (row) => row.date },
      { header: "Cash", value: (row) => row.cash },
      { header: "UPI", value: (row) => row.upi },
      { header: "Card", value: (row) => row.card },
      { header: "Total", value: (row) => row.total },
    ]),
  });
}

/**
 * GST report; CSV gives the HSN summary.
 *
 * @param request - The incoming request containing the branch and range.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export function gstReportController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: exportableReportQuerySchema,
    build: getGstReport,
    message: "GST report generated successfully",
    csv: csvLayout("gst-hsn-summary", (report) => report.hsnSummary, [
      { header: "HSN", value: (row) => row.hsn },
      { header: "GST rate %", value: (row) => row.rate },
      { header: "Quantity", value: (row) => row.quantity },
      { header: "Taxable value", value: (row) => row.taxableValue },
      { header: "CGST", value: (row) => row.cgst },
      { header: "SGST", value: (row) => row.sgst },
      { header: "Total tax", value: (row) => row.totalTax },
    ]),
  });
}

/**
 * Discount report; CSV lists the discounted bills.
 *
 * @param request - The incoming request containing the branch and range.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export function discountReportController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: exportableReportQuerySchema,
    build: getDiscountReport,
    message: "Discount report generated successfully",
    csv: csvLayout("discounts", (report) => report.bills, [
      { header: "Date", value: (row) => row.date },
      { header: "Bill no.", value: (row) => row.billNumber },
      { header: "Table", value: (row) => row.table },
      { header: "Gross amount", value: (row) => row.grossAmount },
      { header: "Discount", value: (row) => row.discount },
      { header: "Discount %", value: (row) => row.discountPercent },
      { header: "Reason", value: (row) => row.reason },
      { header: "Applied by", value: (row) => row.appliedBy?.name },
      { header: "Approved by", value: (row) => row.approvedBy?.name },
    ]),
  });
}

/**
 * Void and cancellation report; CSV lists the voided items.
 *
 * @param request - The incoming request containing the branch and range.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export function voidReportController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: exportableReportQuerySchema,
    build: getVoidReport,
    message: "Void report generated successfully",
    csv: csvLayout("voids", (report) => report.voidedItems.items, [
      { header: "Voided at", value: (row) => row.voidedAt?.toISOString() },
      { header: "Order no.", value: (row) => row.orderNumber },
      { header: "Table", value: (row) => row.table },
      { header: "Item", value: (row) => row.name },
      { header: "Quantity", value: (row) => row.quantity },
      { header: "Value", value: (row) => row.value },
      { header: "Reason", value: (row) => row.reason },
      { header: "Voided by", value: (row) => row.voidedBy?.name },
    ]),
  });
}

/**
 * Staff performance report.
 *
 * @param request - The incoming request containing the branch and range.
 * @param reply - The Fastify reply instance.
 * @returns The report or an error response.
 */
export function staffReportController(request: BranchRequest, reply: FastifyReply) {
  return runBranchReport(request, reply, {
    querySchema: exportableReportQuerySchema,
    build: getStaffReport,
    message: "Staff report generated successfully",
    csv: csvLayout("staff-performance", (report) => report.staff, [
      { header: "Staff", value: (row) => row.name },
      { header: "Role", value: (row) => row.role },
      { header: "Orders taken", value: (row) => row.ordersTaken },
      { header: "Sales value", value: (row) => row.salesValue },
      { header: "Average order", value: (row) => row.averageOrderValue },
      { header: "Bills created", value: (row) => row.billsCreated },
      { header: "Cash collected", value: (row) => row.collected.cash },
      { header: "UPI collected", value: (row) => row.collected.upi },
      { header: "Card collected", value: (row) => row.collected.card },
      { header: "Discount bills", value: (row) => row.discounts.bills },
      { header: "Discount amount", value: (row) => row.discounts.amount },
      { header: "Items voided", value: (row) => row.voids.lines },
      { header: "Void value", value: (row) => row.voids.value },
      { header: "Orders cancelled", value: (row) => row.ordersCancelled },
    ]),
  });
}

/**
 * Branch comparison (owner's master dashboard across locations).
 *
 * @param request - The incoming request containing the range.
 * @param reply - The Fastify reply instance.
 * @returns The comparison or an error response.
 */
export async function branchComparisonController(request: FastifyRequest, reply: FastifyReply) {
  const actor = authorizeReportRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = reportRangeQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const report = await getBranchComparison(actor, parsed.data);

    return sendSuccess(reply, 200, "Branch comparison generated successfully", report);
  } catch (error: unknown) {
    const handled = handleReportServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to build branch comparison");
  }
}
