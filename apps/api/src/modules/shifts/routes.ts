import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  openShiftController,
  closeShiftController,
  addCashMovementController,
  listShiftsController,
  getCurrentShiftController,
  getShiftController,
  createExpenseController,
  listExpensesController,
  voidExpenseController,
} from "./controller.js";
import { EXPENSE_BODY_LIMIT_BYTES } from "./constants.js";

type ShiftRoute = { Params: { shiftId: string } };
type ExpenseRoute = { Params: { expenseId: string } };

/**
 * Registers the shift, cash drawer and expense API routes.
 *
 * @param app - Fastify application instance.
 */
export async function shiftRoutes(app: FastifyInstance) {
  /**
   * Opens a cash drawer shift.
   * POST /api/v1/shifts/open
   */
  app.post("/api/v1/shifts/open", { preHandler: authenticate }, openShiftController);

  /**
   * Lists a branch's shifts.
   * GET /api/v1/shifts?branchId=&status=&staffId=&businessDate=&limit=&offset=
   */
  app.get("/api/v1/shifts", { preHandler: authenticate }, listShiftsController);

  /**
   * Retrieves the caller's open shift at a branch.
   * GET /api/v1/shifts/current?branchId=
   */
  app.get("/api/v1/shifts/current", { preHandler: authenticate }, getCurrentShiftController);

  /**
   * Retrieves a shift with its cash summary.
   * GET /api/v1/shifts/:shiftId
   */
  app.get<ShiftRoute>("/api/v1/shifts/:shiftId", { preHandler: authenticate }, getShiftController);

  /**
   * Closes a shift and reconciles its cash.
   * POST /api/v1/shifts/:shiftId/close
   */
  app.post<ShiftRoute>(
    "/api/v1/shifts/:shiftId/close",
    { preHandler: authenticate },
    closeShiftController,
  );

  /**
   * Records a pay-in or pay-out on an open shift.
   * POST /api/v1/shifts/:shiftId/cash-movements
   */
  app.post<ShiftRoute>(
    "/api/v1/shifts/:shiftId/cash-movements",
    { preHandler: authenticate },
    addCashMovementController,
  );

  /**
   * Records a branch expense (receipt photo as a data URL).
   * POST /api/v1/expenses
   */
  app.post(
    "/api/v1/expenses",
    { preHandler: authenticate, bodyLimit: EXPENSE_BODY_LIMIT_BYTES },
    createExpenseController,
  );

  /**
   * Lists a branch's expenses.
   * GET /api/v1/expenses?branchId=&shiftId=&category=&from=&to=&includeVoided=&limit=&offset=
   */
  app.get("/api/v1/expenses", { preHandler: authenticate }, listExpensesController);

  /**
   * Voids an expense.
   * DELETE /api/v1/expenses/:expenseId
   */
  app.delete<ExpenseRoute>(
    "/api/v1/expenses/:expenseId",
    { preHandler: authenticate },
    voidExpenseController,
  );
}
