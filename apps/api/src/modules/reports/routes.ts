import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  dashboardController,
  salesSummaryController,
  itemSalesController,
  categorySalesController,
  hourlySalesController,
  paymentReportController,
  gstReportController,
  discountReportController,
  voidReportController,
  staffReportController,
  branchComparisonController,
} from "./controller.js";

type BranchRoute = { Params: { branchId: string } };

const BRANCH_REPORTS = "/api/v1/branches/:branchId/reports";

/**
 * Registers the sales report and dashboard routes (owner and manager).
 * Ranges use business dates (`from`, `to` as YYYY-MM-DD) and default to
 * the current business day. Add `format=csv` to download most reports.
 *
 * @param app - Fastify application instance.
 */
export async function reportRoutes(app: FastifyInstance) {
  const auth = { preHandler: authenticate };

  /**
   * Live dashboard for one day.
   * GET /api/v1/branches/:branchId/reports/dashboard?date=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/dashboard`, auth, dashboardController);

  /**
   * Sales summary / day-end report.
   * GET /api/v1/branches/:branchId/reports/sales-summary?from=&to=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/sales-summary`, auth, salesSummaryController);

  /**
   * Item-wise sales.
   * GET /api/v1/branches/:branchId/reports/items?from=&to=&categoryId=&sort=&limit=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/items`, auth, itemSalesController);

  /**
   * Category-wise sales.
   * GET /api/v1/branches/:branchId/reports/categories?from=&to=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/categories`, auth, categorySalesController);

  /**
   * Sales by hour and weekday.
   * GET /api/v1/branches/:branchId/reports/hourly?from=&to=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/hourly`, auth, hourlySalesController);

  /**
   * Payment-mode report.
   * GET /api/v1/branches/:branchId/reports/payments?from=&to=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/payments`, auth, paymentReportController);

  /**
   * GST report (rate-wise, HSN summary, credit notes).
   * GET /api/v1/branches/:branchId/reports/gst?from=&to=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/gst`, auth, gstReportController);

  /**
   * Discount report.
   * GET /api/v1/branches/:branchId/reports/discounts?from=&to=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/discounts`, auth, discountReportController);

  /**
   * Void and cancellation report.
   * GET /api/v1/branches/:branchId/reports/voids?from=&to=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/voids`, auth, voidReportController);

  /**
   * Staff performance report.
   * GET /api/v1/branches/:branchId/reports/staff?from=&to=&format=
   */
  app.get<BranchRoute>(`${BRANCH_REPORTS}/staff`, auth, staffReportController);

  /**
   * Branch comparison across all accessible branches.
   * GET /api/v1/reports/branches?from=&to=
   */
  app.get("/api/v1/reports/branches", auth, branchComparisonController);
}
