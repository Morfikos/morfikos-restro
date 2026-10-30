import { z } from "zod";

/** How the order is served. TAKEAWAY is a parcel order. */
export const ORDER_TYPES = ["DINE_IN", "TAKEAWAY", "DELIVERY"] as const;

export const ORDER_STATUSES = ["OPEN", "BILLED", "COMPLETED", "CANCELLED"] as const;

export const PAYMENT_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID"] as const;

export const PAYMENT_METHODS = ["CASH", "UPI", "CARD"] as const;

/**
 * POS button actions applied when an order is created:
 * HOLD saves it, KOT also sends it to the kitchen, BILL also generates the
 * invoice, KOT_BILL does both.
 */
export const POS_ACTIONS = ["HOLD", "KOT", "BILL", "KOT_BILL"] as const;

/** Default GST rate for custom (off-menu) items. */
export const DEFAULT_CUSTOM_ITEM_GST = 5;

const moneySchema = z.number().min(0).max(10_000_000);
const quantitySchema = z.number().int().min(1).max(999);
const noteSchema = z.string().trim().max(300);
const customerNameSchema = z.string().trim().min(1).max(100);
const customerPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?\d{7,15}$/, "Phone number must be 7 to 15 digits");

const menuOrderLineSchema = z.object({
  menuItemId: z.uuid(),
  variantId: z.uuid().optional(),
  addonIds: z
    .array(z.uuid())
    .max(20)
    .transform((ids) => [...new Set(ids)])
    .default([]),
  quantity: quantitySchema,
  note: noteSchema.optional(),
});

const customOrderLineSchema = z.object({
  customName: z.string().trim().min(1).max(100),
  customPrice: moneySchema,
  gst: z.number().min(0).max(100).default(DEFAULT_CUSTOM_ITEM_GST),
  quantity: quantitySchema,
  note: noteSchema.optional(),
});

/** An order line: a menu item (with portion and addons) or a custom item. */
export const orderLineSchema = z.union([menuOrderLineSchema, customOrderLineSchema]);

const orderLinesSchema = z
  .array(orderLineSchema)
  .min(1, "Add at least one item")
  .max(100, "An order can have at most 100 lines");

export const paymentSchema = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    amount: moneySchema.min(0.01),
    /** Cash handed over by the customer; change is returned on the difference. */
    tenderedAmount: moneySchema.optional(),
    /** UPI/card transaction reference. */
    reference: z.string().trim().max(100).optional(),
  })
  .refine((payment) => payment.tenderedAmount === undefined || payment.method === "CASH", {
    message: "tenderedAmount is only allowed for cash payments",
    path: ["tenderedAmount"],
  })
  .refine(
    (payment) =>
      payment.tenderedAmount === undefined || payment.tenderedAmount >= payment.amount,
    {
      message: "tenderedAmount must be at least the payment amount",
      path: ["tenderedAmount"],
    },
  );

const paymentsSchema = z.array(paymentSchema).min(1).max(5);

export const createOrderSchema = z
  .object({
    branchId: z.uuid(),
    orderType: z.enum(ORDER_TYPES).default("DINE_IN"),
    /** Omit for a counter / walk-in order. */
    tableId: z.uuid().optional(),
    customerName: customerNameSchema.optional(),
    customerPhone: customerPhoneSchema.optional(),
    note: noteSchema.optional(),
    discountAmount: moneySchema.default(0),
    items: orderLinesSchema,
    action: z.enum(POS_ACTIONS).default("HOLD"),
    /** Settle the bill in the same call (BILL / KOT_BILL only). */
    payments: paymentsSchema.optional(),
  })
  .refine((data) => data.tableId === undefined || data.orderType === "DINE_IN", {
    message: "A table can only be set for dine-in orders",
    path: ["tableId"],
  })
  .refine(
    (data) =>
      data.payments === undefined || data.action === "BILL" || data.action === "KOT_BILL",
    {
      message: "Payments can only be sent with the BILL or KOT_BILL action",
      path: ["payments"],
    },
  );

export const updateOrderSchema = z
  .object({
    orderType: z.enum(ORDER_TYPES).optional(),
    /** null moves the order to the counter. */
    tableId: z.uuid().nullable().optional(),
    customerName: customerNameSchema.nullable().optional(),
    customerPhone: customerPhoneSchema.nullable().optional(),
    note: noteSchema.nullable().optional(),
    discountAmount: moneySchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const addOrderItemsSchema = z.object({
  items: orderLinesSchema,
  /** Send the new items to the kitchen right away. */
  sendKot: z.boolean().default(false),
});

export const updateOrderItemSchema = z
  .object({
    quantity: quantitySchema.optional(),
    note: noteSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const removeOrderItemSchema = z.object({
  /** Required when voiding an item that was already sent to the kitchen. */
  reason: z.string().trim().min(3).max(300).optional(),
});

export const billOrderSchema = z.object({
  payments: paymentsSchema.optional(),
});

export const addPaymentsSchema = z.object({
  payments: paymentsSchema,
});

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

export const orderIdParamsSchema = z.object({
  id: z.uuid(),
});

export const orderItemParamsSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
});

export const listOrdersQuerySchema = z.object({
  branchId: z.uuid(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  orderType: z.enum(ORDER_TYPES).optional(),
  tableId: z.uuid().optional(),
  /** Business day in YYYY-MM-DD. */
  businessDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "businessDate must be in YYYY-MM-DD format")
    .optional(),
  /** Matches order number, invoice number, customer name or phone. */
  search: z.string().trim().min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type OrderType = (typeof ORDER_TYPES)[number];
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];
export type PosAction = (typeof POS_ACTIONS)[number];
export type OrderLineInput = z.infer<typeof orderLineSchema>;
export type MenuOrderLineInput = z.infer<typeof menuOrderLineSchema>;
export type CustomOrderLineInput = z.infer<typeof customOrderLineSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type AddOrderItemsInput = z.infer<typeof addOrderItemsSchema>;
export type UpdateOrderItemInput = z.infer<typeof updateOrderItemSchema>;
export type RemoveOrderItemInput = z.infer<typeof removeOrderItemSchema>;
export type BillOrderInput = z.infer<typeof billOrderSchema>;
export type AddPaymentsInput = z.infer<typeof addPaymentsSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
