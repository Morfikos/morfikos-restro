import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

import {
  addOrderItemsSchema,
  addPaymentsSchema,
  billOrderSchema,
  cancelOrderSchema,
  createOrderSchema,
  listOrdersQuerySchema,
  orderIdParamsSchema,
  orderItemParamsSchema,
  removeOrderItemSchema,
  updateOrderItemSchema,
  updateOrderSchema,
  listTableTransfersQuerySchema,
  mergeOrderSchema,
  moveOrderItemsSchema,
  tableTransferBranchParamsSchema,
  tableTransferIdParamsSchema,
  transferOrderSchema,
} from "@morfikos/validation";

import {
  getTableTransfer,
  listTableTransfers,
  mergeOrder,
  moveOrderItems,
  transferOrder,
} from "./table-actions.js";

import {
  addOrderItems,
  addOrderPayments,
  billOrder,
  cancelOrder,
  createOrder,
  getOrder,
  isOrderServiceError,
  listOrders,
  removeOrderItem,
  sendOrderKot,
  updateOrder,
  updateOrderItem,
  type OrderActor,
} from "./service.js";

import { ORDER_MESSAGES, ORDER_STAFF_ROLES } from "./constants.js";

import { handleBillingServiceError } from "../billing/controller.js";
import { handleInventoryServiceError } from "../inventory/controller.js";

import { sendError, sendSuccess } from "../../utils/response.js";

import { ErrorCode } from "../../utils/error-codes.js";

import { getAuthContext, getOrganizationId, hasRole } from "../../utils/auth-helpers.js";

type OrderIdRequest = FastifyRequest<{
  Params: { id: string };
}>;

type OrderItemRequest = FastifyRequest<{
  Params: { id: string; itemId: string };
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
 * Sends a validation error using the first validation issue as the message,
 * so the POS can show the user what to fix.
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
 * Verifies the user is logged in, has a role that can work with orders,
 * and has an organization context.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @returns The order actor, or null after an error response was sent.
 */
function authorizeOrderRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): OrderActor | null {
  const context = getAuthContext(request);

  if (!context) {
    sendUnauthenticated(reply);
    return null;
  }

  if (!hasRole(context, ORDER_STAFF_ROLES)) {
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
 * Handles known order service errors, and billing errors raised by the
 * order actions that bill or take payment through the billing module.
 *
 * @param error - The error thrown by the order or billing service.
 * @param reply - The Fastify reply instance.
 * @returns An error response for known service errors, or null.
 */
export function handleOrderServiceError(
  error: unknown,
  reply: FastifyReply,
) {
  const billingHandled = handleBillingServiceError(error, reply);

  if (billingHandled) {
    return billingHandled;
  }

  // Sending a KOT deducts stock, which can fail when negative stock is off.
  const inventoryHandled = handleInventoryServiceError(error, reply);

  if (inventoryHandled) {
    return inventoryHandled;
  }

  if (!isOrderServiceError(error)) {
    return null;
  }

  switch (error.code) {
    case "INVALID_TRANSFER":
      return sendError(reply, 409, error.message, ErrorCode.INVALID_TRANSFER);

    case "TRANSFER_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.TRANSFER_NOT_FOUND);

    case "BRANCH_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.BRANCH_NOT_FOUND);

    case "TABLE_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.TABLE_NOT_FOUND);

    case "MENU_ITEM_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.MENU_ITEM_NOT_FOUND);

    case "ORDER_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.ORDER_NOT_FOUND);

    case "ORDER_ITEM_NOT_FOUND":
      return sendError(reply, 404, error.message, ErrorCode.ORDER_ITEM_NOT_FOUND);

    case "FORBIDDEN":
      return sendError(reply, 403, error.message, ErrorCode.FORBIDDEN);

    case "BRANCH_ACCESS_DENIED":
      return sendError(reply, 403, error.message, ErrorCode.BRANCH_ACCESS_DENIED);

    case "INVALID_TABLE":
      return sendError(reply, 400, error.message, ErrorCode.INVALID_TABLE);

    case "INVALID_ITEM_OPTION":
      return sendError(reply, 400, error.message, ErrorCode.INVALID_ITEM_OPTION);

    case "QUANTITY_LIMIT_EXCEEDED":
      return sendError(reply, 400, error.message, ErrorCode.QUANTITY_LIMIT_EXCEEDED);

    case "INVALID_DISCOUNT":
      return sendError(reply, 400, error.message, ErrorCode.INVALID_DISCOUNT);

    case "VOID_REASON_REQUIRED":
      return sendError(reply, 400, error.message, ErrorCode.VOID_REASON_REQUIRED);

    case "EMPTY_ORDER":
      return sendError(reply, 400, error.message, ErrorCode.EMPTY_ORDER);

    case "PAYMENT_EXCEEDS_BALANCE":
      return sendError(reply, 400, error.message, ErrorCode.PAYMENT_EXCEEDS_BALANCE);

    case "TABLE_HAS_OPEN_ORDER":
      return sendError(reply, 409, error.message, ErrorCode.TABLE_HAS_OPEN_ORDER);

    case "ITEM_UNAVAILABLE":
      return sendError(reply, 409, error.message, ErrorCode.ITEM_UNAVAILABLE);

    case "ORDER_NOT_EDITABLE":
      return sendError(reply, 409, error.message, ErrorCode.ORDER_NOT_EDITABLE);

    case "ITEM_ALREADY_SENT":
      return sendError(reply, 409, error.message, ErrorCode.ITEM_ALREADY_SENT);

    case "ITEM_ALREADY_VOID":
      return sendError(reply, 409, error.message, ErrorCode.ITEM_ALREADY_VOID);

    case "NO_ITEMS_TO_SEND":
      return sendError(reply, 409, error.message, ErrorCode.NO_ITEMS_TO_SEND);

    case "PAYMENT_NOT_ALLOWED":
      return sendError(reply, 409, error.message, ErrorCode.PAYMENT_NOT_ALLOWED);

    case "ORDER_HAS_PAYMENTS":
      return sendError(reply, 409, error.message, ErrorCode.ORDER_HAS_PAYMENTS);

    default:
      return null;
  }
}

/**
 * Creates a POS order and applies the pressed button's action
 * (HOLD / KOT / BILL / KOT_BILL), optionally settling payment.
 *
 * @param request - The incoming request containing the order.
 * @param reply - The Fastify reply instance.
 * @returns The order and its KOT ticket, or an error response.
 */
export async function createOrderController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = createOrderSchema.safeParse(request.body);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const result = await createOrder(actor, parsed.data);

    return sendSuccess(
      reply,
      201,
      ORDER_MESSAGES.ORDER_CREATED,
      result,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to create order");
  }
}

/**
 * Lists a branch's orders with filters (held bills, live orders, history).
 *
 * @param request - The incoming request containing query parameters.
 * @param reply - The Fastify reply instance.
 * @returns The matching orders or an error response.
 */
export async function listOrdersController(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = listOrdersQuerySchema.safeParse(request.query);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const orders = await listOrders(actor, parsed.data);

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.ORDERS_RETRIEVED,
      orders,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to list orders");
  }
}

/**
 * Retrieves an order's full view (View Bill).
 *
 * @param request - The incoming request containing the order ID.
 * @param reply - The Fastify reply instance.
 * @returns The order or an error response.
 */
export async function getOrderController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = orderIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const order = await getOrder(actor, parsed.data.id);

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.ORDER_RETRIEVED,
      order,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to get order");
  }
}

/**
 * Updates an open order's type, table, customer, note or discount.
 *
 * @param request - The incoming request containing the order ID and changes.
 * @param reply - The Fastify reply instance.
 * @returns The updated order or an error response.
 */
export async function updateOrderController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateOrderSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const order = await updateOrder(actor, parsedParams.data.id, parsedBody.data);

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.ORDER_UPDATED,
      order,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update order");
  }
}

/**
 * Adds items to an open order, optionally sending a KOT.
 *
 * @param request - The incoming request containing the order ID and items.
 * @param reply - The Fastify reply instance.
 * @returns The order and its KOT ticket, or an error response.
 */
export async function addOrderItemsController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = addOrderItemsSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await addOrderItems(actor, parsedParams.data.id, parsedBody.data);

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.ITEMS_ADDED,
      result,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to add order items");
  }
}

/**
 * Changes the quantity or note of a line not yet sent to the kitchen.
 *
 * @param request - The incoming request containing the order/item IDs and changes.
 * @param reply - The Fastify reply instance.
 * @returns The updated order or an error response.
 */
export async function updateOrderItemController(
  request: OrderItemRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderItemParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = updateOrderItemSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const order = await updateOrderItem(
      actor,
      parsedParams.data.id,
      parsedParams.data.itemId,
      parsedBody.data,
    );

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.ITEM_UPDATED,
      order,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to update order item");
  }
}

/**
 * Removes an unsent line, or voids a sent line (owner/manager, with reason).
 *
 * @param request - The incoming request containing the order/item IDs and reason.
 * @param reply - The Fastify reply instance.
 * @returns The updated order or an error response.
 */
export async function removeOrderItemController(
  request: OrderItemRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderItemParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = removeOrderItemSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const order = await removeOrderItem(
      actor,
      parsedParams.data.id,
      parsedParams.data.itemId,
      parsedBody.data,
    );

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.ITEM_REMOVED,
      order,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to remove order item");
  }
}

/**
 * Sends an order's pending lines to the kitchen on a new KOT.
 *
 * @param request - The incoming request containing the order ID.
 * @param reply - The Fastify reply instance.
 * @returns The order and its KOT ticket, or an error response.
 */
export async function sendKotController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsed = orderIdParamsSchema.safeParse(request.params);

  if (!parsed.success) {
    return sendValidationError(reply, parsed.error);
  }

  try {
    const result = await sendOrderKot(actor, parsed.data.id);

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.KOT_SENT,
      result,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to send KOT");
  }
}

/**
 * Generates the bill (invoice number), optionally settling payment.
 *
 * @param request - The incoming request containing the order ID and optional payments.
 * @param reply - The Fastify reply instance.
 * @returns The billed order or an error response.
 */
export async function billOrderController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = billOrderSchema.safeParse(request.body ?? {});

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const order = await billOrder(actor, parsedParams.data.id, parsedBody.data);

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.ORDER_BILLED,
      order,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to bill order");
  }
}

/**
 * Records payments (cash, UPI, card or split) against a billed order.
 *
 * @param request - The incoming request containing the order ID and payments.
 * @param reply - The Fastify reply instance.
 * @returns The updated order or an error response.
 */
export async function addPaymentsController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = addPaymentsSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const order = await addOrderPayments(actor, parsedParams.data.id, parsedBody.data);

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.PAYMENT_RECORDED,
      order,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to record payment");
  }
}

/**
 * Cancels an open or billed order without payments (owner/manager).
 *
 * @param request - The incoming request containing the order ID and reason.
 * @param reply - The Fastify reply instance.
 * @returns The cancelled order or an error response.
 */
export async function cancelOrderController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = cancelOrderSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const order = await cancelOrder(actor, parsedParams.data.id, parsedBody.data);

    return sendSuccess(
      reply,
      200,
      ORDER_MESSAGES.ORDER_CANCELLED,
      order,
    );
  } catch (error: unknown) {
    const handled = handleOrderServiceError(error, reply);

    if (handled) {
      return handled;
    }

    return sendUnexpectedError(request, reply, error, "Failed to cancel order");
  }
}

// ─── Table actions (table transfer) ─────────────────────────────────────

type TransferBranchRequest = FastifyRequest<{
  Params: { branchId: string };
}>;

type TransferIdRequest = FastifyRequest<{
  Params: { transferId: string };
}>;

/**
 * Sends the response for a caught order error, or a 500.
 *
 * @param request - The incoming request.
 * @param reply - The Fastify reply instance.
 * @param error - The caught error.
 * @param logMessage - The message to log for unexpected errors.
 * @returns The error response.
 */
function sendOrderError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
) {
  const handled = handleOrderServiceError(error, reply);

  if (handled) {
    return handled;
  }

  return sendUnexpectedError(request, reply, error, logMessage);
}

/**
 * Moves an order to another table (or swaps two tables).
 *
 * @param request - The incoming request containing the order ID and table.
 * @param reply - The Fastify reply instance.
 * @returns The order(s) and the Kitchen Shift slip, or an error response.
 */
export async function transferOrderController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = transferOrderSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await transferOrder(actor, parsedParams.data.id, parsedBody.data);

    return sendSuccess(
      reply,
      200,
      result.swappedOrder ? "Tables swapped" : "Order moved to the new table",
      result,
    );
  } catch (error: unknown) {
    return sendOrderError(request, reply, error, "Failed to transfer order");
  }
}

/**
 * Merges an order into another order or table.
 *
 * @param request - The incoming request containing the order ID and target.
 * @param reply - The Fastify reply instance.
 * @returns The combined order and slip, or an error response.
 */
export async function mergeOrderController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = mergeOrderSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await mergeOrder(actor, parsedParams.data.id, parsedBody.data);

    return sendSuccess(reply, 200, "Orders merged", result);
  } catch (error: unknown) {
    return sendOrderError(request, reply, error, "Failed to merge orders");
  }
}

/**
 * Moves some items to another order or table.
 *
 * @param request - The incoming request containing the order ID, items and target.
 * @param reply - The Fastify reply instance.
 * @returns Both orders and the slip, or an error response.
 */
export async function moveOrderItemsController(
  request: OrderIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = orderIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedBody = moveOrderItemsSchema.safeParse(request.body);

  if (!parsedBody.success) {
    return sendValidationError(reply, parsedBody.error);
  }

  try {
    const result = await moveOrderItems(actor, parsedParams.data.id, parsedBody.data);

    return sendSuccess(reply, 200, "Items moved", result);
  } catch (error: unknown) {
    return sendOrderError(request, reply, error, "Failed to move items");
  }
}

/**
 * Lists a branch's table actions (audit trail and slips).
 *
 * @param request - The incoming request containing the branch and filters.
 * @param reply - The Fastify reply instance.
 * @returns The transfers or an error response.
 */
export async function listTableTransfersController(
  request: TransferBranchRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = tableTransferBranchParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  const parsedQuery = listTableTransfersQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    return sendValidationError(reply, parsedQuery.error);
  }

  try {
    const transfers = await listTableTransfers(actor, parsedParams.data.branchId, parsedQuery.data);

    return sendSuccess(reply, 200, "Table transfers retrieved successfully", transfers);
  } catch (error: unknown) {
    return sendOrderError(request, reply, error, "Failed to list table transfers");
  }
}

/**
 * Retrieves one Kitchen Shift slip (to reprint it).
 *
 * @param request - The incoming request containing the transfer ID.
 * @param reply - The Fastify reply instance.
 * @returns The slip or an error response.
 */
export async function getTableTransferController(
  request: TransferIdRequest,
  reply: FastifyReply,
) {
  const actor = authorizeOrderRequest(request, reply);

  if (!actor) {
    return reply;
  }

  const parsedParams = tableTransferIdParamsSchema.safeParse(request.params);

  if (!parsedParams.success) {
    return sendValidationError(reply, parsedParams.error);
  }

  try {
    const transfer = await getTableTransfer(actor, parsedParams.data.transferId);

    if (!transfer) {
      return sendError(reply, 404, "Table transfer not found", ErrorCode.TRANSFER_NOT_FOUND);
    }

    return sendSuccess(reply, 200, "Kitchen Shift slip retrieved successfully", transfer);
  } catch (error: unknown) {
    return sendOrderError(request, reply, error, "Failed to get table transfer");
  }
}
