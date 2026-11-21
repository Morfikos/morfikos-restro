import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import {
  createBillController,
  listBillsController,
  getBillController,
  applyBillDiscountController,
  recordBillPaymentController,
  settleBillController,
  cancelBillController,
  createCreditNoteController,
  listInvoicesController,
  getInvoiceController,
  previewBillSplitController,
  splitBillController,
  getBillSplitController,
  removeBillSplitController,
  getBillSplitPartController,
  payBillSplitPartController,
} from "./controller.js";

type BranchRoute = { Params: { branchId: string } };
type BillRoute = { Params: { branchId: string; billId: string } };
type SplitPartRoute = { Params: { branchId: string; billId: string; partNumber: string } };
type InvoiceRoute = { Params: { branchId: string; invoiceId: string } };

/**
 * Registers the billing, invoice and credit note API routes.
 *
 * @param app - Fastify application instance.
 */
export async function billingRoutes(app: FastifyInstance) {
  /**
   * Creates a bill from one or more table orders.
   * POST /api/v1/branches/:branchId/bills
   */
  app.post<BranchRoute>(
    "/api/v1/branches/:branchId/bills",
    { preHandler: authenticate },
    createBillController,
  );

  /**
   * Lists a branch's bills.
   * GET /api/v1/branches/:branchId/bills?status=&tableId=&businessDate=&limit=&offset=
   */
  app.get<BranchRoute>(
    "/api/v1/branches/:branchId/bills",
    { preHandler: authenticate },
    listBillsController,
  );

  /**
   * Retrieves a bill.
   * GET /api/v1/branches/:branchId/bills/:billId
   */
  app.get<BillRoute>(
    "/api/v1/branches/:branchId/bills/:billId",
    { preHandler: authenticate },
    getBillController,
  );

  /**
   * Applies a discount to a bill.
   * POST /api/v1/branches/:branchId/bills/:billId/discounts
   */
  app.post<BillRoute>(
    "/api/v1/branches/:branchId/bills/:billId/discounts",
    { preHandler: authenticate },
    applyBillDiscountController,
  );

  /**
   * Records a payment on a bill.
   * POST /api/v1/branches/:branchId/bills/:billId/payments
   */
  app.post<BillRoute>(
    "/api/v1/branches/:branchId/bills/:billId/payments",
    { preHandler: authenticate },
    recordBillPaymentController,
  );

  /**
   * Settles a bill and generates its GST invoice.
   * POST /api/v1/branches/:branchId/bills/:billId/settle
   */
  app.post<BillRoute>(
    "/api/v1/branches/:branchId/bills/:billId/settle",
    { preHandler: authenticate },
    settleBillController,
  );

  /**
   * Cancels an open bill without payments.
   * POST /api/v1/branches/:branchId/bills/:billId/cancel
   */
  app.post<BillRoute>(
    "/api/v1/branches/:branchId/bills/:billId/cancel",
    { preHandler: authenticate },
    cancelBillController,
  );

  /**
   * Issues a credit note against an invoice.
   * POST /api/v1/branches/:branchId/invoices/:invoiceId/credit-notes
   */
  app.post<InvoiceRoute>(
    "/api/v1/branches/:branchId/invoices/:invoiceId/credit-notes",
    { preHandler: authenticate },
    createCreditNoteController,
  );

  /**
   * Lists a branch's invoices.
   * GET /api/v1/branches/:branchId/invoices?from=&to=&status=&billId=&limit=&offset=
   */
  app.get<BranchRoute>(
    "/api/v1/branches/:branchId/invoices",
    { preHandler: authenticate },
    listInvoicesController,
  );

  /**
   * Retrieves an invoice with its credit notes.
   * GET /api/v1/branches/:branchId/invoices/:invoiceId
   */
  app.get<InvoiceRoute>(
    "/api/v1/branches/:branchId/invoices/:invoiceId",
    { preHandler: authenticate },
    getInvoiceController,
  );

  // ─── Split bills ──────────────────────────────────────────────────────

  const SPLIT = "/api/v1/branches/:branchId/bills/:billId/split";

  /**
   * Previews a split without saving.
   * POST /api/v1/branches/:branchId/bills/:billId/split/preview
   */
  app.post<BillRoute>(`${SPLIT}/preview`, { preHandler: authenticate }, previewBillSplitController);

  /**
   * Splits a bill: equal, custom_amount, percentage or items.
   * POST /api/v1/branches/:branchId/bills/:billId/split
   */
  app.post<BillRoute>(SPLIT, { preHandler: authenticate }, splitBillController);

  /**
   * Retrieves the split with each part's status.
   * GET /api/v1/branches/:branchId/bills/:billId/split
   */
  app.get<BillRoute>(SPLIT, { preHandler: authenticate }, getBillSplitController);

  /**
   * Removes the split (no part may be paid).
   * DELETE /api/v1/branches/:branchId/bills/:billId/split
   */
  app.delete<BillRoute>(SPLIT, { preHandler: authenticate }, removeBillSplitController);

  /**
   * One part as a slip to print.
   * GET /api/v1/branches/:branchId/bills/:billId/split/parts/:partNumber
   */
  app.get<SplitPartRoute>(`${SPLIT}/parts/:partNumber`, { preHandler: authenticate }, getBillSplitPartController);

  /**
   * Takes a payment for one part.
   * POST /api/v1/branches/:branchId/bills/:billId/split/parts/:partNumber/payments
   */
  app.post<SplitPartRoute>(
    `${SPLIT}/parts/:partNumber/payments`,
    { preHandler: authenticate },
    payBillSplitPartController,
  );
}
