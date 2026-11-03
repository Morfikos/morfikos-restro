import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import type { UserRole } from "@morfikos/auth";

import {
  applyBillDiscountSchema,
  billParamsSchema,
  billingBranchParamsSchema,
  cancelBillSchema,
  createBillSchema,
  createCreditNoteSchema,
  invoiceParamsSchema,
  listBillsQuerySchema,
  listInvoicesQuerySchema,
  recordBillPaymentSchema,
  settleBillSchema,
} from "@morfikos/validation";

import {
  applyBillDiscount,
  cancelBill,
  createBill,
  createCreditNote,
  getBill,
  getInvoice,
  isBillingServiceError,
  listBills,
  listInvoices,
  recordBillPayment,
  settleBill,
  type BillingActor,
} from "./service.js";

import {
  BILLING_MANAGER_ROLES,
  BILLING_STAFF_ROLES,
  INVOICE_VIEW_ROLES,
} from "./constants.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type BranchRequest = FastifyRequest<{
  Params: { branchId: string };
}>;

type BillRequest = FastifyRequest<{
  Params: { branchId: string; billId: string };
}>;

type InvoiceRequest = FastifyRequest<{
  Params: { branchId: string; invoiceId: string };
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
 * Sends a response when the bill does not exist.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendBillNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Bill not found",
    ErrorCode.BILL_NOT_FOUND,
  );
}

/**
 * Sends a response when the invoice does not exist.
 *
 * @param reply - The Fastify reply instance.
 * @returns A not-found response.
 */
function sendInvoiceNotFound(reply: FastifyReply) {
  return sendError(
    reply,
    404,
    "Invoice not found",
    ErrorCode.INVOICE_NOT_FOUND,
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
 * Verifies the user is logged in, has one of the allowed roles (cashier
 * roles by default), has an organization context and can access the branch.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param branchId - The branch in the URL.
 * @param allowedRoles - Roles permitted to perform the action.
 * @returns The billing actor, or null after an error response was sent.
 */
function authorizeBillingRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  branchId: string,
  allowedRoles: UserRole[] = BILLING_STAFF_ROLES,
): BillingActor | null {
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

  if (!context.branchIds.includes(branchId)) {
    sendBranchAccessDenied(reply);
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
 * Handles known billing service errors. Also used by the orders module,
 * whose billing actions run through the billing service.
 *
 * @param error - The error thrown by the billing service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
export function handleBillingServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  if (!isBillingServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    case "TABLE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.TABLE_NOT_FOUND);

    case "ORDER_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.ORDER_NOT_FOUND);

    case "BILL_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BILL_NOT_FOUND);

    case "INVOICE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.INVOICE_NOT_FOUND);

    case "ORDER_TABLE_MISMATCH":
      return sendError(reply, 400, error.message, ErrorCode.ORDER_TABLE_MISMATCH);

    case "EMPTY_ORDER":
      return sendError(reply, 400, error.message, ErrorCode.EMPTY_ORDER);

    case "INVALID_DISCOUNT":
      return sendError(reply, 400, error.message, ErrorCode.INVALID_DISCOUNT);

    case "PAYMENT_EXCEEDS_BALANCE":
      return sendError(reply, 400, error.message, ErrorCode.PAYMENT_EXCEEDS_BALANCE);

    case "CREDIT_EXCEEDS_INVOICE":
      return sendError(reply, 400, error.message, ErrorCode.CREDIT_EXCEEDS_INVOICE);

    case "FORBIDDEN":
      return sendError(reply, 403, error.message, ErrorCode.FORBIDDEN);

    case "MANAGER_APPROVAL_REQUIRED":
      return sendError(reply, 403, error.message, ErrorCode.MANAGER_APPROVAL_REQUIRED);

    case "INVALID_MANAGER_PIN":
      return sendError(reply, 403, error.message, ErrorCode.INVALID_MANAGER_PIN);

    case "PIN_NOT_SET":
      return sendError(reply, 403, error.message, ErrorCode.PIN_NOT_SET);

    case "ORDER_NOT_BILLABLE":
      return sendError(reply, 409, error.message, ErrorCode.ORDER_NOT_BILLABLE);

    case "BILL_NOT_OPEN":
      return sendError(reply, 409, error.message, ErrorCode.BILL_NOT_OPEN);

    case "BILL_HAS_PAYMENTS":
      return sendError(reply, 409, error.message, ErrorCode.BILL_HAS_PAYMENTS);

    case "BILL_NOT_FULLY_PAID":
      return sendError(reply, 409, error.message, ErrorCode.BILL_NOT_FULLY_PAID);

    case "PAYMENT_MISMATCH":
      return sendError(reply, 409, error.message, ErrorCode.PAYMENT_MISMATCH);

    case "DISCOUNT_BELOW_PAID":
      return sendError(reply, 409, error.message, ErrorCode.DISCOUNT_BELOW_PAID);

    default:
      return null;
  }
}

/**
 * Creates a bill from one or more table orders.
 *
 * @param request - The incoming request containing the branch ID and bill details.
 * @param reply - The Fastify reply instance.
 * @returns The created bill or an error response.
 */
export async function createBillController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const parsedParams = billingBranchParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const actor = authorizeBillingRequest(request, reply, parsedParams.data.branchId);

  if (!actor) {
    return reply;
  }

  const parsedBody = createBillSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const bill = await createBill(actor, parsedParams.data.branchId, parsedBody.data);

    return sendSuccess(
      reply,
      201,
      "Bill created successfully",
      bill,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create bill");
  }
}

/**
 * Lists a branch's bills.
 *
 * @param request - The incoming request containing the branch ID and filters.
 * @param reply - The Fastify reply instance.
 * @returns The bills or an error response.
 */
export async function listBillsController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const parsedParams = billingBranchParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const actor = authorizeBillingRequest(request, reply, parsedParams.data.branchId);

  if (!actor) {
    return reply;
  }

  const parsedQuery = listBillsQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const bills = await listBills(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(
      reply,
      200,
      "Bills retrieved successfully",
      bills,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list bills");
  }
}

/**
 * Retrieves a bill's full view.
 *
 * @param request - The incoming request containing the branch and bill IDs.
 * @param reply - The Fastify reply instance.
 * @returns The bill or an error response.
 */
export async function getBillController(
  request: BillRequest,
  reply: FastifyReply,
) {
  const parsed = billParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  const actor = authorizeBillingRequest(request, reply, parsed.data.branchId);

  if (!actor) {
    return reply;
  }

  try {
    const bill = await getBill(actor, parsed.data.branchId, parsed.data.billId);

    if (!bill) {
      return sendBillNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Bill retrieved successfully",
      bill,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get bill");
  }
}

/**
 * Applies a discount to a bill with approval rules.
 *
 * @param request - The incoming request containing the bill and discount.
 * @param reply - The Fastify reply instance.
 * @returns The discount and updated totals or an error response.
 */
export async function applyBillDiscountController(
  request: BillRequest,
  reply: FastifyReply,
) {
  const parsedParams = billParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const actor = authorizeBillingRequest(request, reply, parsedParams.data.branchId);

  if (!actor) {
    return reply;
  }

  const parsedBody = applyBillDiscountSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await applyBillDiscount(
      actor,
      parsedParams.data.branchId,
      parsedParams.data.billId,
      parsedBody.data,
    );

    if (!result) {
      return sendBillNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Discount applied successfully",
      result,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to apply discount");
  }
}

/**
 * Records a payment on a bill.
 *
 * @param request - The incoming request containing the bill and payment.
 * @param reply - The Fastify reply instance.
 * @returns The payment with the bill's balance or an error response.
 */
export async function recordBillPaymentController(
  request: BillRequest,
  reply: FastifyReply,
) {
  const parsedParams = billParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const actor = authorizeBillingRequest(request, reply, parsedParams.data.branchId);

  if (!actor) {
    return reply;
  }

  const parsedBody = recordBillPaymentSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const payment = await recordBillPayment(
      actor,
      parsedParams.data.branchId,
      parsedParams.data.billId,
      parsedBody.data,
    );

    if (!payment) {
      return sendBillNotFound(reply);
    }

    return sendSuccess(
      reply,
      payment.replayed ? 200 : 201,
      payment.replayed ? "Payment already recorded" : "Payment recorded successfully",
      payment,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to record payment");
  }
}

/**
 * Settles a fully paid bill and issues its GST invoice.
 *
 * @param request - The incoming request containing the bill and collected total.
 * @param reply - The Fastify reply instance.
 * @returns The settled bill with its invoice or an error response.
 */
export async function settleBillController(
  request: BillRequest,
  reply: FastifyReply,
) {
  const parsedParams = billParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const actor = authorizeBillingRequest(request, reply, parsedParams.data.branchId);

  if (!actor) {
    return reply;
  }

  const parsedBody = settleBillSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const bill = await settleBill(
      actor,
      parsedParams.data.branchId,
      parsedParams.data.billId,
      parsedBody.data,
    );

    if (!bill) {
      return sendBillNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Bill settled and invoice generated successfully",
      bill,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to settle bill");
  }
}

/**
 * Cancels an open bill without payments (owner/manager).
 *
 * @param request - The incoming request containing the bill and reason.
 * @param reply - The Fastify reply instance.
 * @returns The cancelled bill or an error response.
 */
export async function cancelBillController(
  request: BillRequest,
  reply: FastifyReply,
) {
  const parsedParams = billParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const actor = authorizeBillingRequest(
    request,
    reply,
    parsedParams.data.branchId,
    BILLING_MANAGER_ROLES,
  );

  if (!actor) {
    return reply;
  }

  const parsedBody = cancelBillSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const bill = await cancelBill(
      actor,
      parsedParams.data.branchId,
      parsedParams.data.billId,
      parsedBody.data,
    );

    if (!bill) {
      return sendBillNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Bill cancelled successfully",
      bill,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to cancel bill");
  }
}

/**
 * Issues a credit note against an invoice (owner/manager, with PIN).
 *
 * @param request - The incoming request containing the invoice and credit details.
 * @param reply - The Fastify reply instance.
 * @returns The credit note or an error response.
 */
export async function createCreditNoteController(
  request: InvoiceRequest,
  reply: FastifyReply,
) {
  const parsedParams = invoiceParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const actor = authorizeBillingRequest(
    request,
    reply,
    parsedParams.data.branchId,
    BILLING_MANAGER_ROLES,
  );

  if (!actor) {
    return reply;
  }

  const parsedBody = createCreditNoteSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const creditNote = await createCreditNote(
      actor,
      parsedParams.data.branchId,
      parsedParams.data.invoiceId,
      parsedBody.data,
    );

    if (!creditNote) {
      return sendInvoiceNotFound(reply);
    }

    return sendSuccess(
      reply,
      201,
      "Credit note issued successfully",
      creditNote,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create credit note");
  }
}

/**
 * Lists a branch's invoices.
 *
 * @param request - The incoming request containing the branch ID and filters.
 * @param reply - The Fastify reply instance.
 * @returns The invoices or an error response.
 */
export async function listInvoicesController(
  request: BranchRequest,
  reply: FastifyReply,
) {
  const parsedParams = billingBranchParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const actor = authorizeBillingRequest(
    request,
    reply,
    parsedParams.data.branchId,
    INVOICE_VIEW_ROLES,
  );

  if (!actor) {
    return reply;
  }

  const parsedQuery = listInvoicesQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const invoices = await listInvoices(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(
      reply,
      200,
      "Invoices retrieved successfully",
      invoices,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list invoices");
  }
}

/**
 * Retrieves an invoice with its credit notes.
 *
 * @param request - The incoming request containing the branch and invoice IDs.
 * @param reply - The Fastify reply instance.
 * @returns The invoice or an error response.
 */
export async function getInvoiceController(
  request: InvoiceRequest,
  reply: FastifyReply,
) {
  const parsed = invoiceParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  const actor = authorizeBillingRequest(
    request,
    reply,
    parsed.data.branchId,
    INVOICE_VIEW_ROLES,
  );

  if (!actor) {
    return reply;
  }

  try {
    const invoice = await getInvoice(actor, parsed.data.branchId, parsed.data.invoiceId);

    if (!invoice) {
      return sendInvoiceNotFound(reply);
    }

    return sendSuccess(
      reply,
      200,
      "Invoice retrieved successfully",
      invoice,
    );
  } catch (error: unknown) {
    const handled = handleBillingServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get invoice");
  }
}
