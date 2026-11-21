import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  addOrderItemsController,
  addPaymentsController,
  billOrderController,
  cancelOrderController,
  createOrderController,
  getOrderController,
  listOrdersController,
  removeOrderItemController,
  sendKotController,
  updateOrderController,
  updateOrderItemController,
  transferOrderController,
  mergeOrderController,
  moveOrderItemsController,
  listTableTransfersController,
  getTableTransferController,
} from "./controller.js";

type OrderIdRoute = { Params: { id: string } };
type OrderItemRoute = { Params: { id: string; itemId: string } };

/**
 * Registers the order API routes used by the POS billing counter, live
 * orders and order history.
 *
 * @param app - Fastify application instance.
 */
type OrderTransferRoute = { Params: { id: string } };

export async function orderRoutes(app: FastifyInstance) {
  /**
   * Creates an order and applies a POS action (HOLD / KOT / BILL / KOT_BILL).
   * POST /api/v1/orders
   */
  app.post("/api/v1/orders", { preHandler: authenticate }, createOrderController);

  /**
   * Lists a branch's orders.
   * GET /api/v1/orders?branchId=&status=&paymentStatus=&orderType=&tableId=&businessDate=&search=
   */
  app.get("/api/v1/orders", { preHandler: authenticate }, listOrdersController);

  /**
   * Retrieves an order's full view (View Bill).
   * GET /api/v1/orders/:id
   */
  app.get<OrderIdRoute>("/api/v1/orders/:id", { preHandler: authenticate }, getOrderController);

  /**
   * Updates an open order's type, table, customer, note or discount.
   * PUT /api/v1/orders/:id
   */
  app.put<OrderIdRoute>("/api/v1/orders/:id", { preHandler: authenticate }, updateOrderController);

  /**
   * Adds items to an open order.
   * POST /api/v1/orders/:id/items
   */
  app.post<OrderIdRoute>(
    "/api/v1/orders/:id/items",
    { preHandler: authenticate },
    addOrderItemsController,
  );

  /**
   * Changes an unsent line's quantity or note.
   * PATCH /api/v1/orders/:id/items/:itemId
   */
  app.patch<OrderItemRoute>(
    "/api/v1/orders/:id/items/:itemId",
    { preHandler: authenticate },
    updateOrderItemController,
  );

  /**
   * Removes an unsent line, or voids a sent line.
   * DELETE /api/v1/orders/:id/items/:itemId
   */
  app.delete<OrderItemRoute>(
    "/api/v1/orders/:id/items/:itemId",
    { preHandler: authenticate },
    removeOrderItemController,
  );

  /**
   * Sends pending lines to the kitchen on a new KOT.
   * POST /api/v1/orders/:id/kot
   */
  app.post<OrderIdRoute>("/api/v1/orders/:id/kot", { preHandler: authenticate }, sendKotController);

  /**
   * Generates the bill, optionally settling payment.
   * POST /api/v1/orders/:id/bill
   */
  app.post<OrderIdRoute>("/api/v1/orders/:id/bill", { preHandler: authenticate }, billOrderController);

  /**
   * Records payments (cash, UPI, card or split).
   * POST /api/v1/orders/:id/payments
   */
  app.post<OrderIdRoute>(
    "/api/v1/orders/:id/payments",
    { preHandler: authenticate },
    addPaymentsController,
  );

  /**
   * Cancels an order (owner/manager).
   * POST /api/v1/orders/:id/cancel
   */
  app.post<OrderIdRoute>(
    "/api/v1/orders/:id/cancel",
    { preHandler: authenticate },
    cancelOrderController,
  );

  // ─── Table actions (table transfer) ───────────────────────────────────

  /**
   * Moves an order to another table; `swap: true` swaps two busy tables.
   * POST /api/v1/orders/:id/transfer
   */
  app.post<OrderTransferRoute>("/api/v1/orders/:id/transfer", { preHandler: authenticate }, transferOrderController);

  /**
   * Merges this order into another order or table.
   * POST /api/v1/orders/:id/merge
   */
  app.post<OrderTransferRoute>("/api/v1/orders/:id/merge", { preHandler: authenticate }, mergeOrderController);

  /**
   * Moves some items to another order or table.
   * POST /api/v1/orders/:id/items/move
   */
  app.post<OrderTransferRoute>("/api/v1/orders/:id/items/move", { preHandler: authenticate }, moveOrderItemsController);

  /**
   * Lists table actions (audit trail, slips to reprint).
   * GET /api/v1/branches/:branchId/table-transfers?date=&type=&orderId=&limit=&offset=
   */
  app.get<{ Params: { branchId: string } }>(
    "/api/v1/branches/:branchId/table-transfers",
    { preHandler: authenticate },
    listTableTransfersController,
  );

  /**
   * Retrieves one Kitchen Shift slip.
   * GET /api/v1/table-transfers/:transferId
   */
  app.get<{ Params: { transferId: string } }>(
    "/api/v1/table-transfers/:transferId",
    { preHandler: authenticate },
    getTableTransferController,
  );
}
