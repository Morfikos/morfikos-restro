import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  cashMovementSchema,
  closeShiftSchema,
  createExpenseSchema,
  currentShiftQuerySchema,
  expenseIdParamsSchema,
  listExpensesQuerySchema,
  listShiftsQuerySchema,
  openShiftSchema,
  shiftIdParamsSchema,
  voidExpenseSchema,
} from "@morfikos/validation";

import {
  addCashMovement,
  closeShift,
  createExpense,
  getCurrentShift,
  getShift,
  isShiftServiceError,
  listExpenses,
  listShifts,
  openShift,
  voidExpense,
  type ShiftActor,
} from "./service.js";

import { SHIFT_MANAGER_ROLES, SHIFT_VIEW_ROLES } from "./constants.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type ShiftRequest = FastifyRequest<{
  Params: { shiftId: string };
}>;

type ExpenseRequest = FastifyRequest<{
  Params: { expenseId: string };
}>;

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
 * Sends a response when the user cannot access the requested branch.
 *
 * @param reply - The Fastify reply instance.
 * @returns A forbidden response.
 */
function sendBranchAccessDenied(reply: FastifyReply) {
  return sendError(
    reply,
    403,
    "Access denied for this branch",
    ErrorCode.BRANCH_ACCESS_DENIED,
  );
}

/**
 * Sends a response when the shift does not exist or is not visible.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendShiftNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Shift not found",
    ErrorCode.SHIFT_NOT_FOUND,
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
 * Verifies the user is logged in, has one of the allowed roles (owner or
 * manager by default) and has an organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The shift actor, or null after an error response was sent.
 */
function authorizeShiftRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: UserRole[] = SHIFT_MANAGER_ROLES,
): ShiftActor | null {
  const context = getAuthContext(request);

  if (!context) {
    sendUnauthenticated(reply);
    return null;
  }

  if (!hasRole(context, allowedRoles)) {
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
 * Handles known shift service errors.
 *
 * @param error - The error thrown by the shift service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
function handleShiftServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isShiftServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    case "STAFF_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.STAFF_NOT_FOUND);

    case "SHIFT_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.SHIFT_NOT_FOUND);

    case "EXPENSE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.EXPENSE_NOT_FOUND);

    case "CASH_COUNT_MISMATCH":
      return sendError(reply, 400, error.message, ErrorCode.CASH_COUNT_MISMATCH);

    case "INVALID_RECEIPT":
      return sendError(reply, 400, error.message, ErrorCode.INVALID_RECEIPT);

    case "SHIFT_ALREADY_OPEN":
      return sendError(reply, 409, error.message, ErrorCode.SHIFT_ALREADY_OPEN);

    case "SHIFT_CLOSED":
      return sendError(reply, 409, error.message, ErrorCode.SHIFT_CLOSED);

    case "INSUFFICIENT_CASH":
      return sendError(reply, 409, error.message, ErrorCode.INSUFFICIENT_CASH);

    case "EXPENSE_ALREADY_VOID":
      return sendError(reply, 409, error.message, ErrorCode.EXPENSE_ALREADY_VOID);

    default:
      return null;
  }
}

/**
 * Opens a cash drawer shift for a cashier.
 *
 * @param request - The incoming request containing the branch, cashier and opening cash.
 * @param reply - The Fastify reply instance.
 * @returns The opened shift or an error response.
 */
export async function openShiftController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = openShiftSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!actor.branchIds.includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const shift = await openShift(actor, parsed.data);

    return sendSuccess(
      reply,
      201,
      "Shift opened successfully",
      shift,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to open shift");
  }
}

/**
 * Closes a shift and reconciles its cash.
 *
 * @param request - The incoming request containing the shift ID and cash count.
 * @param reply - The Fastify reply instance.
 * @returns The closed shift with its variance or an error response.
 */
export async function closeShiftController(
  request: ShiftRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = shiftIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = closeShiftSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  if (
    parsedBody.data.shiftId !== undefined &&
    parsedBody.data.shiftId !== parsedParams.data.shiftId
  ) {
    return sendError(
      reply,
      400,
      "shiftId in the body does not match the URL",
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const shift = await closeShift(actor, parsedParams.data.shiftId, parsedBody.data);

    if (!shift) {
      return sendShiftNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Shift closed successfully",
      shift,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to close shift");
  }
}

/**
 * Records a pay-in or pay-out on an open shift.
 *
 * @param request - The incoming request containing the shift ID and movement.
 * @param reply - The Fastify reply instance.
 * @returns The movement with the drawer's expected cash or an error response.
 */
export async function addCashMovementController(
  request: ShiftRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = shiftIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = cashMovementSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const movement = await addCashMovement(actor, parsedParams.data.shiftId, parsedBody.data);

    if (!movement) {
      return sendShiftNotFound(reply);
    }

    return sendSuccess(
      reply,
      201,
      "Cash movement recorded successfully",
      movement,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to record cash movement");
  }
}

/**
 * Lists a branch's shifts (cashiers see only their own).
 *
 * @param request - The incoming request containing filters.
 * @param reply - The Fastify reply instance.
 * @returns The shifts or an error response.
 */
export async function listShiftsController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply, SHIFT_VIEW_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = listShiftsQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!actor.branchIds.includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const shifts = await listShifts(actor, parsed.data);

    return sendSuccess(
      reply,
      200,
      "Shifts retrieved successfully",
      shifts,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list shifts");
  }
}

/**
 * Retrieves the caller's open shift at a branch.
 *
 * @param request - The incoming request containing the branch ID.
 * @param reply - The Fastify reply instance.
 * @returns The open shift (or null) or an error response.
 */
export async function getCurrentShiftController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply, SHIFT_VIEW_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = currentShiftQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!actor.branchIds.includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const shift = await getCurrentShift(actor, parsed.data.branchId);

    return sendSuccess(
      reply,
      200,
      shift ? "Current shift retrieved successfully" : "No open shift",
      shift,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get current shift");
  }
}

/**
 * Retrieves a shift with its cash summary.
 *
 * @param request - The incoming request containing the shift ID.
 * @param reply - The Fastify reply instance.
 * @returns The shift or an error response.
 */
export async function getShiftController(
  request: ShiftRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply, SHIFT_VIEW_ROLES);

  if (!actor) {
    return reply;
  }

  const parsed = shiftIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const shift = await getShift(actor, parsed.data.shiftId);

    if (!shift) {
      return sendShiftNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Shift retrieved successfully",
      shift,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get shift");
  }
}

/**
 * Records a branch expense.
 *
 * @param request - The incoming request containing the expense.
 * @param reply - The Fastify reply instance.
 * @returns The created expense or an error response.
 */
export async function createExpenseController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = createExpenseSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!actor.branchIds.includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const expense = await createExpense(actor, parsed.data);

    return sendSuccess(
      reply,
      201,
      "Expense recorded successfully",
      expense,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to record expense");
  }
}

/**
 * Lists a branch's expenses.
 *
 * @param request - The incoming request containing filters.
 * @param reply - The Fastify reply instance.
 * @returns The expenses or an error response.
 */
export async function listExpensesController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = listExpensesQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  if (!actor.branchIds.includes(parsed.data.branchId)) {
    return sendBranchAccessDenied(reply);
  }

  try {
    const expenses = await listExpenses(actor, parsed.data);

    return sendSuccess(
      reply,
      200,
      "Expenses retrieved successfully",
      expenses,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list expenses");
  }
}

/**
 * Voids an expense entered by mistake.
 *
 * @param request - The incoming request containing the expense ID and reason.
 * @param reply - The Fastify reply instance.
 * @returns The voided expense or an error response.
 */
export async function voidExpenseController(
  request: ExpenseRequest,
  reply: FastifyReply,
) {
  const actor = authorizeShiftRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = expenseIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = voidExpenseSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const expense = await voidExpense(
      actor,
      parsedParams.data.expenseId,
      parsedBody.data.reason,
    );

    if (!expense) {
      return sendError(reply, 404, "Expense not found", ErrorCode.EXPENSE_NOT_FOUND);
    }

    return sendSuccess(
      reply,
      200,
      "Expense voided successfully",
      expense,
    );
  } catch (error: unknown) {
    const handled = handleShiftServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to void expense");
  }
}
