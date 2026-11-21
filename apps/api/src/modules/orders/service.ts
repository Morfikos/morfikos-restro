import { createPrismaClient } from "@morfikos/database";
import { OrderServiceErrorCode, type UserRole } from "@morfikos/auth";
import type {
  AddOrderItemsInput,
  AddPaymentsInput,
  BillOrderInput,
  CancelOrderInput,
  CreateOrderInput,
  ListOrdersQuery,
  MenuOrderLineInput,
  OrderLineInput,
  OrderType as OrderTypeValue,
  PaymentInput,
  RemoveOrderItemInput,
  UpdateOrderInput,
  UpdateOrderItemInput,
} from "@morfikos/validation";

import { getBusinessDate } from "../../utils/branch-time.js";
import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import {
  buildTaxBreakdown,
  calculateOrderTotals,
  fromPaise,
  toPaise,
} from "./pricing.js";
import {
  ACTIVE_ORDER_STATUSES,
  CHANNEL_AVAILABILITY_FIELD,
  KotStatus,
  MAX_NUMBERING_RETRIES,
  ORDER_MANAGER_ROLES,
  ORDER_TRANSACTION_OPTIONS,
  ORDER_TYPE_LABELS,
  OrderItemStatus,
  OrderStatus,
  OrderType,
  PaymentStatus,
  PosAction,
} from "./constants.js";
import {
  deductStockForKotInTx,
  reverseStockForOrderItemsInTx,
} from "../inventory/stock.js";
import { withInventoryEvents } from "../inventory/events.js";
import {
  cancelKitchenTicketIfEmpty,
  cancelOrderKitchenTickets,
  createKitchenTicketsForKot,
  publishKotTicketsCreated,
  publishTicketUpdated,
  publishTicketsCancelled,
} from "../kitchen/service.js";
import { createBillInTx, recordPaymentsInTx } from "../billing/service.js";
import type { PaymentMethod } from "../billing/constants.js";

const prisma = createPrismaClient();

/** The Prisma client available inside an interactive transaction. */
type TransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/** A Prisma Decimal value, typed structurally. */
type DecimalValue = { toNumber(): number };

/**
 * The authenticated user performing an order operation.
 */
export interface OrderActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

/**
 * Represents errors that can occur during order operations.
 */
export class OrderServiceError extends Error {
  /**
   * Creates an order service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: OrderServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrderServiceError";
  }
}

/**
 * Checks whether an unknown value matches a known order service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value contains a recognized order service error
 * code and a string message.
 */
export function isOrderServiceError(
  error: unknown,
): error is OrderServiceError {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("message" in error)
  ) {
    return false;
  }

  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    Object.values(OrderServiceErrorCode).includes(
      error.code as OrderServiceErrorCode,
    )
  );
}


/**
 * Formats a paise amount as a rupee string for error messages.
 *
 * @param paise - The amount in paise.
 * @returns The amount, e.g. "₹125.50".
 */
function formatRupees(paise: number): string {
  return `₹${fromPaise(paise).toFixed(2)}`;
}

/**
 * Runs order work in an interactive transaction. Numbering conflicts
 * (two orders taking the same number at once) are retried a few times.
 *
 * @param work - The transactional work.
 * @returns The work's result.
 */
async function runOrderTransaction<T>(
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // Inventory events (low stock, dishes 86'd) go out only after a commit.
      return await withInventoryEvents(() => prisma.$transaction(work, ORDER_TRANSACTION_OPTIONS));
    } catch (error: unknown) {
      if (attempt < MAX_NUMBERING_RETRIES && isPrismaUniqueConstraintError(error)) {
        continue;
      }

      throw error;
    }
  }
}

/**
 * Throws unless the actor can access the branch.
 *
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @throws OrderServiceError When the branch is not in the actor's access.
 */
function assertBranchAccess(actor: OrderActor, branchId: string): void {
  if (!actor.branchIds.includes(branchId)) {
    throw new OrderServiceError(
      OrderServiceErrorCode.BRANCH_ACCESS_DENIED,
      "Access denied for this branch",
    );
  }
}

/** Branch fields needed for numbering and business-day calculation. */
const branchClockSelect = {
  id: true,
  code: true,
  timezone: true,
  businessDayCutoff: true,
} as const;

type BranchClock = {
  id: string;
  code: string | null;
  timezone: string;
  businessDayCutoff: Date | null;
};

/**
 * Loads an active branch of the actor's organization.
 *
 * @param tx - The transaction client.
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @returns The branch's numbering and clock settings.
 * @throws OrderServiceError When the branch is not found or inactive.
 */
async function getActiveBranch(
  tx: TransactionClient,
  actor: OrderActor,
  branchId: string,
): Promise<BranchClock> {
  const branch = await tx.branch.findFirst({
    where: { id: branchId, organizationId: actor.organizationId, status: "active" },
    select: branchClockSelect,
  });

  if (!branch) {
    throw new OrderServiceError(
      OrderServiceErrorCode.BRANCH_NOT_FOUND,
      "Active branch not found",
    );
  }

  return branch;
}

/**
 * Returns the prefix used in order and invoice numbers: up to five
 * alphanumeric characters of the branch code.
 *
 * @param code - The branch code, or null.
 * @returns The prefix, e.g. "SOHNA".
 */
function getNumberPrefix(code: string | null): string {
  return (code ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 5) || "INV";
}

/**
 * Formats an order number, e.g. "SOHNA-261024-007". Order numbers restart
 * every business day.
 *
 * @param code - The branch code.
 * @param businessDate - The business date (YYYY-MM-DD).
 * @param sequence - The order's sequence number for the day.
 * @returns The order number.
 */
function formatOrderNumber(
  code: string | null,
  businessDate: string,
  sequence: number,
): string {
  const day = businessDate.slice(2).replaceAll("-", "");
  return `${getNumberPrefix(code)}-${day}-${String(sequence).padStart(3, "0")}`;
}


/**
 * Atomically increments and returns a named per-branch counter.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @param name - The counter name, e.g. "kot:2026-10-24".
 * @returns The new counter value.
 */
async function nextBranchCounter(
  tx: TransactionClient,
  branchId: string,
  name: string,
): Promise<number> {
  const counter = await tx.branchCounter.upsert({
    where: { branchId_name: { branchId, name } },
    create: { branchId, name, value: 1 },
    update: { value: { increment: 1 } },
    select: { value: true },
  });

  return counter.value;
}

/**
 * Ensures a table belongs to the branch, is active, and has no other
 * open or billed order.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @param tableId - The table ID.
 * @param excludeOrderId - An order to ignore (the one being edited).
 * @throws OrderServiceError When the table is not found or occupied.
 */
async function assertTableAvailable(
  tx: TransactionClient,
  branchId: string,
  tableId: string,
  excludeOrderId?: string,
): Promise<void> {
  const table = await tx.diningTable.findFirst({
    where: { id: tableId, branchId, isActive: true },
    select: { id: true, name: true },
  });

  if (!table) {
    throw new OrderServiceError(
      OrderServiceErrorCode.TABLE_NOT_FOUND,
      "Active table not found in this branch",
    );
  }

  const openOrder = await tx.order.findFirst({
    where: {
      tableId,
      status: { in: ACTIVE_ORDER_STATUSES },
      ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
    },
    select: { orderNumber: true },
  });

  if (openOrder) {
    throw new OrderServiceError(
      OrderServiceErrorCode.TABLE_HAS_OPEN_ORDER,
      `Table ${table.name} already has an open order (${openOrder.orderNumber})`,
    );
  }
}

/** An addon as stored on an order line. */
type OrderLineAddon = { id: string; name: string; price: number };

/** A priced order line ready to be stored. Money is in paise. */
type ResolvedLine = {
  menuItemId: string | null;
  variantId: string | null;
  name: string;
  variantName: string | null;
  isCustom: boolean;
  unitPrice: number;
  addons: OrderLineAddon[];
  addonsPrice: number;
  quantity: number;
  lineSubtotal: number;
  gstRate: number;
  hsn: string | null;
  kitchenStation: string | null;
  note: string | null;
};

/**
 * Checks whether an order line refers to a menu item.
 *
 * @param line - The order line.
 * @returns True for menu item lines, false for custom items.
 */
function isMenuLine(line: OrderLineInput): line is MenuOrderLineInput {
  return "menuItemId" in line;
}

/**
 * Returns the quantity of each menu item already on an order (void lines
 * excluded), used to enforce per-order quantity limits.
 *
 * @param tx - The transaction client.
 * @param orderId - The order ID.
 * @returns A map of menu item ID to quantity.
 */
async function getExistingQuantities(
  tx: TransactionClient,
  orderId: string,
): Promise<Map<string, number>> {
  const rows = await tx.orderItem.groupBy({
    by: ["menuItemId"],
    where: {
      orderId,
      status: { not: OrderItemStatus.VOID },
      menuItemId: { not: null },
    },
    _sum: { quantity: true },
  });

  const quantities = new Map<string, number>();

  for (const row of rows) {
    if (row.menuItemId) {
      quantities.set(row.menuItemId, row._sum.quantity ?? 0);
    }
  }

  return quantities;
}

/**
 * Prices order lines from the branch menu. Prices are never taken from the
 * client: menu items use the branch price plus the portion's extra price
 * and the addons. Each item must be active, available at the branch for the
 * order type, and within its per-order quantity limit.
 *
 * @param tx - The transaction client.
 * @param organizationId - The organization ID.
 * @param branchId - The branch ID.
 * @param orderType - The order type (decides which channel must be enabled).
 * @param lines - The requested lines.
 * @param existingQuantities - Quantities already on the order, per menu item.
 * @returns The priced lines.
 * @throws OrderServiceError When an item, portion or addon is invalid or unavailable.
 */
async function resolveOrderLines(
  tx: TransactionClient,
  organizationId: string,
  branchId: string,
  orderType: OrderTypeValue,
  lines: OrderLineInput[],
  existingQuantities: Map<string, number>,
): Promise<ResolvedLine[]> {
  const menuItemIds = [
    ...new Set(lines.filter(isMenuLine).map((line) => line.menuItemId)),
  ];

  const menuItems =
    menuItemIds.length === 0
      ? []
      : await tx.menuItem.findMany({
          where: { id: { in: menuItemIds }, organizationId, isActive: true },
          select: {
            id: true,
            name: true,
            gst: true,
            hsn: true,
            kitchenStation: true,
            variants: {
              select: {
                id: true,
                name: true,
                extraPrice: true,
                dineInAvailable: true,
                parcelAvailable: true,
                deliveryAvailable: true,
              },
            },
            addons: { select: { id: true, name: true, price: true } },
            branchItems: {
              where: { branchId },
              select: {
                price: true,
                isAvailable: true,
                dineInAvailable: true,
                parcelAvailable: true,
                deliveryAvailable: true,
                maxQuantityPerOrder: true,
              },
            },
          },
        });

  const menuItemsById = new Map(menuItems.map((item) => [item.id, item]));
  const quantities = new Map(existingQuantities);
  const channel = CHANNEL_AVAILABILITY_FIELD[orderType];
  const channelLabel = ORDER_TYPE_LABELS[orderType];

  return lines.map((line): ResolvedLine => {
    if (!isMenuLine(line)) {
      const unitPrice = toPaise(line.customPrice);

      return {
        menuItemId: null,
        variantId: null,
        name: line.customName,
        variantName: null,
        isCustom: true,
        unitPrice,
        addons: [],
        addonsPrice: 0,
        quantity: line.quantity,
        lineSubtotal: unitPrice * line.quantity,
        gstRate: line.gst,
        hsn: null,
        kitchenStation: null,
        note: line.note ?? null,
      };
    }

    const item = menuItemsById.get(line.menuItemId);

    if (!item) {
      throw new OrderServiceError(
        OrderServiceErrorCode.MENU_ITEM_NOT_FOUND,
        "Menu item not found or inactive",
      );
    }

    const branchItem = item.branchItems[0];

    if (!branchItem || !branchItem.isAvailable || !branchItem[channel]) {
      throw new OrderServiceError(
        OrderServiceErrorCode.ITEM_UNAVAILABLE,
        `${item.name} is not available for ${channelLabel} at this branch`,
      );
    }

    let variant: (typeof item.variants)[number] | null = null;

    if (line.variantId !== undefined) {
      variant = item.variants.find((entry) => entry.id === line.variantId) ?? null;

      if (!variant) {
        throw new OrderServiceError(
          OrderServiceErrorCode.INVALID_ITEM_OPTION,
          `Invalid portion selected for ${item.name}`,
        );
      }

      if (!variant[channel]) {
        throw new OrderServiceError(
          OrderServiceErrorCode.ITEM_UNAVAILABLE,
          `${item.name} (${variant.name}) is not available for ${channelLabel}`,
        );
      }
    } else if (item.variants.length > 0) {
      throw new OrderServiceError(
        OrderServiceErrorCode.INVALID_ITEM_OPTION,
        `Select a portion for ${item.name}`,
      );
    }

    const addons = line.addonIds.map((addonId) => {
      const addon = item.addons.find((entry) => entry.id === addonId);

      if (!addon) {
        throw new OrderServiceError(
          OrderServiceErrorCode.INVALID_ITEM_OPTION,
          `Invalid addon selected for ${item.name}`,
        );
      }

      return addon;
    });

    const quantity = (quantities.get(item.id) ?? 0) + line.quantity;
    const maxQuantity = branchItem.maxQuantityPerOrder;

    if (maxQuantity !== null && quantity > maxQuantity) {
      throw new OrderServiceError(
        OrderServiceErrorCode.QUANTITY_LIMIT_EXCEEDED,
        `A maximum of ${maxQuantity} × ${item.name} is allowed per order`,
      );
    }

    quantities.set(item.id, quantity);

    const unitPrice =
      toPaise(branchItem.price) + (variant ? toPaise(variant.extraPrice) : 0);
    const addonsPrice = addons.reduce((sum, addon) => sum + toPaise(addon.price), 0);

    return {
      menuItemId: item.id,
      variantId: variant?.id ?? null,
      name: item.name,
      variantName: variant?.name ?? null,
      isCustom: false,
      unitPrice,
      addons: addons.map((addon) => ({
        id: addon.id,
        name: addon.name,
        price: addon.price.toNumber(),
      })),
      addonsPrice,
      quantity: line.quantity,
      lineSubtotal: (unitPrice + addonsPrice) * line.quantity,
      gstRate: item.gst.toNumber(),
      hsn: item.hsn,
      kitchenStation: item.kitchenStation,
      note: line.note ?? null,
    };
  });
}

/**
 * Appends priced lines to an order, numbering them after existing lines.
 * Tax is pre-filled assuming no discount; totals are recalculated after.
 *
 * @param tx - The transaction client.
 * @param orderId - The order ID.
 * @param lines - The priced lines.
 */
async function insertOrderLines(
  tx: TransactionClient,
  orderId: string,
  lines: ResolvedLine[],
): Promise<void> {
  const { _max } = await tx.orderItem.aggregate({
    where: { orderId },
    _max: { lineNumber: true },
  });
  const firstLineNumber = (_max.lineNumber ?? 0) + 1;

  await tx.orderItem.createMany({
    data: lines.map((line, index) => ({
      orderId,
      lineNumber: firstLineNumber + index,
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      name: line.name,
      variantName: line.variantName,
      isCustom: line.isCustom,
      unitPrice: fromPaise(line.unitPrice),
      addons: line.addons,
      addonsPrice: fromPaise(line.addonsPrice),
      quantity: line.quantity,
      lineSubtotal: fromPaise(line.lineSubtotal),
      taxAmount: fromPaise(Math.round((line.lineSubtotal * line.gstRate) / 100)),
      gstRate: line.gstRate,
      hsn: line.hsn,
      kitchenStation: line.kitchenStation,
      note: line.note,
    })),
  });
}

/**
 * Recalculates and stores an order's totals and each line's discount share
 * and tax. Only lines whose charges changed are written.
 *
 * @param tx - The transaction client.
 * @param orderId - The order ID.
 * @param options - `strictDiscount` rejects a discount above the subtotal
 * instead of capping it.
 * @returns The totals (in paise) and the number of billable lines.
 * @throws OrderServiceError When strict and the discount exceeds the subtotal.
 */
async function recalculateOrderTotals(
  tx: TransactionClient,
  orderId: string,
  options: { strictDiscount?: boolean } = {},
) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      discountAmount: true,
      items: {
        where: { status: { not: OrderItemStatus.VOID } },
        select: {
          id: true,
          lineSubtotal: true,
          gstRate: true,
          discountAmount: true,
          taxAmount: true,
        },
      },
    },
  });

  const requestedDiscount = toPaise(order.discountAmount);
  const totals = calculateOrderTotals(
    order.items.map((item) => ({
      key: item.id,
      lineSubtotal: toPaise(item.lineSubtotal),
      gstRate: item.gstRate.toNumber(),
    })),
    requestedDiscount,
  );

  if (options.strictDiscount && requestedDiscount > totals.subtotal) {
    throw new OrderServiceError(
      OrderServiceErrorCode.INVALID_DISCOUNT,
      `Discount can't be more than the subtotal of ${formatRupees(totals.subtotal)}`,
    );
  }

  const storedCharges = new Map(
    order.items.map((item) => [
      item.id,
      { discount: toPaise(item.discountAmount), tax: toPaise(item.taxAmount) },
    ]),
  );

  for (const line of totals.lines) {
    const stored = storedCharges.get(line.key);

    if (stored && stored.discount === line.discount && stored.tax === line.tax) {
      continue;
    }

    await tx.orderItem.update({
      where: { id: line.key },
      data: {
        discountAmount: fromPaise(line.discount),
        taxAmount: fromPaise(line.tax),
      },
    });
  }

  await tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: fromPaise(totals.subtotal),
      discountAmount: fromPaise(totals.discount),
      taxAmount: fromPaise(totals.tax),
      roundOff: fromPaise(totals.roundOff),
      totalAmount: fromPaise(totals.total),
    },
  });

  return { ...totals, itemCount: order.items.length };
}

/**
 * Sends all of an order's pending lines to the kitchen on a new KOT.
 * KOT numbers restart every business day.
 *
 * @param tx - The transaction client.
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param branch - The order's branch.
 * @returns The new KOT's ID, or null when no lines were pending.
 */
async function sendPendingItemsToKitchen(
  tx: TransactionClient,
  actor: OrderActor,
  orderId: string,
  branch: BranchClock,
): Promise<string | null> {
  const pendingItems = await tx.orderItem.findMany({
    where: { orderId, status: OrderItemStatus.PENDING },
    select: { id: true, kitchenStation: true },
  });

  if (pendingItems.length === 0) {
    return null;
  }

  const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);
  const kotNumber = await nextBranchCounter(tx, branch.id, `kot:${businessDate}`);

  // Round 1 is the first KOT of the order, round 2 the next, and so on.
  const previousKots = await tx.kot.count({ where: { orderId } });

  const kot = await tx.kot.create({
    data: {
      orderId,
      branchId: branch.id,
      kotNumber,
      roundNo: previousKots + 1,
      businessDate,
      createdById: actor.userId,
    },
    select: { id: true },
  });

  await tx.orderItem.updateMany({
    where: { id: { in: pendingItems.map((item) => item.id) } },
    data: { status: OrderItemStatus.SENT, kotId: kot.id },
  });

  // The kitchen starts cooking: take the recipe ingredients out of stock.
  await deductStockForKotInTx(tx, {
    organizationId: actor.organizationId,
    branchId: branch.id,
    kotId: kot.id,
    userId: actor.userId,
  });

  // Split the KOT into one kitchen display ticket per station.
  await createKitchenTicketsForKot(
    tx,
    { id: kot.id, orderId, branchId: branch.id },
    pendingItems,
  );

  return kot.id;
}

/**
 * Generates the bill for one order through the billing module, so the POS
 * "Bill" button and table bills share one bill and invoice series. The
 * GST invoice is issued when the bill is settled (paid in full); a
 * zero-value bill is settled at once.
 *
 * @param tx - The transaction client.
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param branch - The order's branch.
 * @throws OrderServiceError When the order has no billable lines.
 */
async function generateBill(
  tx: TransactionClient,
  actor: OrderActor,
  orderId: string,
  branch: BranchClock,
): Promise<void> {
  const totals = await recalculateOrderTotals(tx, orderId);

  if (totals.itemCount === 0) {
    throw new OrderServiceError(
      OrderServiceErrorCode.EMPTY_ORDER,
      "Add at least one item before generating the bill",
    );
  }

  await createBillInTx(tx, actor, { branchId: branch.id, orderIds: [orderId] });
}

/**
 * Records payments against an order's bill. Several payments make a split
 * payment. When the bill is fully paid it is settled, its invoice issued
 * and the order completed.
 *
 * @param tx - The transaction client.
 * @param actor - The authenticated user receiving the payment.
 * @param orderId - The order ID.
 * @param payments - The payments to record, in rupees.
 * @throws OrderServiceError When the order has no open bill.
 */
async function applyPayments(
  tx: TransactionClient,
  actor: OrderActor,
  orderId: string,
  payments: PaymentInput[],
): Promise<void> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, billId: true },
  });

  if (order.status !== OrderStatus.BILLED || !order.billId) {
    const reason =
      order.status === OrderStatus.OPEN
        ? "Generate the bill before taking payment"
        : order.status === OrderStatus.COMPLETED
          ? "This order is already fully paid"
          : "This order is cancelled";

    throw new OrderServiceError(
      OrderServiceErrorCode.PAYMENT_NOT_ALLOWED,
      reason,
    );
  }

  await recordPaymentsInTx(
    tx,
    actor,
    order.billId,
    payments.map((payment) => ({
      method: payment.method as PaymentMethod,
      amountPaise: toPaise(payment.amount),
      tenderedPaise:
        payment.tenderedAmount !== undefined ? toPaise(payment.tenderedAmount) : undefined,
      reference: payment.reference ?? null,
    })),
  );
}

/**
 * Loads an order of the actor's organization for a change, checking
 * branch access.
 *
 * @param tx - The transaction client.
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @returns The order's state and branch.
 * @throws OrderServiceError When not found or the branch is not accessible.
 */
async function loadOrderForAction(
  tx: TransactionClient,
  actor: OrderActor,
  orderId: string,
) {
  const order = await tx.order.findFirst({
    where: { id: orderId, organizationId: actor.organizationId },
    select: {
      id: true,
      branchId: true,
      status: true,
      orderType: true,
      tableId: true,
      amountPaid: true,
      branch: { select: branchClockSelect },
    },
  });

  if (!order) {
    throw new OrderServiceError(
      OrderServiceErrorCode.ORDER_NOT_FOUND,
      "Order not found",
    );
  }

  assertBranchAccess(actor, order.branchId);

  return order;
}

/**
 * Throws unless the order is in one of the allowed statuses.
 *
 * @param order - The order's current status.
 * @param allowed - The statuses that permit the operation.
 * @param message - The error message when not allowed.
 * @throws OrderServiceError When the status is not allowed.
 */
function assertOrderStatus(
  order: { status: string },
  allowed: OrderStatus[],
  message: string,
): void {
  if (!allowed.some((status) => status === order.status)) {
    throw new OrderServiceError(
      OrderServiceErrorCode.ORDER_NOT_EDITABLE,
      message,
    );
  }
}

/**
 * Throws unless the actor is an owner or manager.
 *
 * @param actor - The authenticated user.
 * @param message - The error message when not allowed.
 * @throws OrderServiceError When the actor lacks the role.
 */
function assertManager(actor: OrderActor, message: string): void {
  if (!ORDER_MANAGER_ROLES.includes(actor.role)) {
    throw new OrderServiceError(
      OrderServiceErrorCode.FORBIDDEN,
      message,
    );
  }
}

/**
 * Extracts addon names from an order line's stored addons.
 *
 * @param addons - The stored addons JSON.
 * @returns The addon names.
 */
function getAddonNames(addons: unknown): string[] {
  if (!Array.isArray(addons)) {
    return [];
  }

  return addons
    .map((addon: unknown) =>
      typeof addon === "object" && addon !== null && "name" in addon
        ? addon.name
        : null,
    )
    .filter((name): name is string => typeof name === "string");
}

/** Fields returned for an order's full view (bill). */
const orderDetailSelect = {
  id: true,
  orderNumber: true,
  invoiceNumber: true,
  financialYear: true,
  businessDate: true,
  orderType: true,
  source: true,
  status: true,
  paymentStatus: true,
  customerName: true,
  customerPhone: true,
  note: true,
  allergyNote: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  roundOff: true,
  totalAmount: true,
  amountPaid: true,
  billedAt: true,
  paidAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  branch: {
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      state: true,
      phone: true,
      gstin: true,
      fssaiNo: true,
    },
  },
  table: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, name: true } },
  items: {
    orderBy: { lineNumber: "asc" },
    select: {
      id: true,
      lineNumber: true,
      menuItemId: true,
      variantId: true,
      name: true,
      variantName: true,
      isCustom: true,
      unitPrice: true,
      addons: true,
      addonsPrice: true,
      quantity: true,
      lineSubtotal: true,
      discountAmount: true,
      taxAmount: true,
      gstRate: true,
      hsn: true,
      kitchenStation: true,
      note: true,
      status: true,
      voidReason: true,
      voidedAt: true,
      kot: { select: { kotNumber: true } },
    },
  },
  kots: {
    orderBy: { kotNumber: "asc" },
    select: {
      id: true,
      kotNumber: true,
      status: true,
      createdAt: true,
      _count: { select: { items: true } },
    },
  },
  bill: {
    select: {
      id: true,
      billNumber: true,
      status: true,
      totalPaise: true,
      paidPaise: true,
      invoice: { select: { id: true, invoiceNumber: true } },
      payments: {
        orderBy: { paidAt: "asc" },
        select: {
          id: true,
          method: true,
          amountPaise: true,
          tenderedPaise: true,
          reference: true,
          paidAt: true,
          receivedBy: { select: { id: true, name: true } },
        },
      },
    },
  },
} as const;

/**
 * Loads an order's full view: header, lines, KOTs, payments and the bill
 * summary with the CGST/SGST breakdown.
 *
 * @param client - A Prisma client or transaction client.
 * @param orderId - The order ID.
 * @returns The serialized order.
 */
async function getOrderDetail(client: TransactionClient, orderId: string) {
  const order = await client.order.findUniqueOrThrow({
    where: { id: orderId },
    select: orderDetailSelect,
  });

  const {
    items,
    kots,
    bill: orderBill,
    subtotal,
    discountAmount,
    taxAmount,
    roundOff,
    totalAmount,
    amountPaid,
    ...header
  } = order;

  const billableItems = items.filter((item) => item.status !== OrderItemStatus.VOID);

  return {
    ...header,
    items: items.map(
      ({
        kot,
        unitPrice,
        addons,
        addonsPrice,
        lineSubtotal,
        discountAmount: lineDiscount,
        taxAmount: lineTax,
        gstRate,
        ...item
      }) => ({
        ...item,
        unitPrice: unitPrice.toNumber(),
        addons,
        addonsPrice: addonsPrice.toNumber(),
        lineSubtotal: lineSubtotal.toNumber(),
        discountAmount: lineDiscount.toNumber(),
        taxAmount: lineTax.toNumber(),
        gstRate: gstRate.toNumber(),
        kotNumber: kot?.kotNumber ?? null,
      }),
    ),
    kots: kots.map(({ _count, ...kot }) => ({ ...kot, itemCount: _count.items })),
    // Payments live on the order's bill (shared when tables combine orders).
    payments: (orderBill?.payments ?? []).map(
      ({ amountPaise, tenderedPaise, paidAt, ...payment }) => ({
        ...payment,
        amount: fromPaise(amountPaise),
        tenderedAmount: tenderedPaise !== null ? fromPaise(tenderedPaise) : null,
        changeDue: tenderedPaise !== null ? fromPaise(tenderedPaise - amountPaise) : null,
        createdAt: paidAt,
      }),
    ),
    billRef: orderBill
      ? {
          id: orderBill.id,
          billNumber: orderBill.billNumber,
          status: orderBill.status.toLowerCase(),
          totalPaise: orderBill.totalPaise,
          paidPaise: orderBill.paidPaise,
          remainingPaise: Math.max(orderBill.totalPaise - orderBill.paidPaise, 0),
          invoice: orderBill.invoice,
        }
      : null,
    bill: {
      subtotal: subtotal.toNumber(),
      discountAmount: discountAmount.toNumber(),
      taxBreakdown: buildTaxBreakdown(
        billableItems.map((item) => ({
          gstRate: item.gstRate.toNumber(),
          taxableAmount: toPaise(item.lineSubtotal) - toPaise(item.discountAmount),
          tax: toPaise(item.taxAmount),
        })),
      ),
      taxAmount: taxAmount.toNumber(),
      roundOff: roundOff.toNumber(),
      totalAmount: totalAmount.toNumber(),
      amountPaid: amountPaid.toNumber(),
      balanceDue: fromPaise(toPaise(totalAmount) - toPaise(amountPaid)),
    },
  };
}

/**
 * Loads a KOT in the shape the kitchen printer needs.
 *
 * @param client - A Prisma client or transaction client.
 * @param kotId - The KOT ID.
 * @returns The serialized KOT ticket.
 */
async function getKotTicket(client: TransactionClient, kotId: string) {
  const kot = await client.kot.findUniqueOrThrow({
    where: { id: kotId },
    select: {
      id: true,
      kotNumber: true,
      businessDate: true,
      status: true,
      createdAt: true,
      createdBy: { select: { name: true } },
      order: {
        select: {
          id: true,
          orderNumber: true,
          orderType: true,
          customerName: true,
          note: true,
          allergyNote: true,
          table: { select: { name: true } },
        },
      },
      items: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          name: true,
          variantName: true,
          addons: true,
          quantity: true,
          note: true,
          kitchenStation: true,
        },
      },
    },
  });

  return {
    id: kot.id,
    kotNumber: kot.kotNumber,
    businessDate: kot.businessDate,
    status: kot.status,
    createdAt: kot.createdAt,
    createdBy: kot.createdBy.name,
    orderId: kot.order.id,
    orderNumber: kot.order.orderNumber,
    orderType: kot.order.orderType,
    tableName: kot.order.table?.name ?? null,
    customerName: kot.order.customerName,
    orderNote: kot.order.note,
    allergyNote: kot.order.allergyNote,
    items: kot.items.map((item) => ({
      ...item,
      addons: getAddonNames(item.addons),
    })),
  };
}

/**
 * Builds the response for operations that may print a KOT.
 *
 * @param result - The order ID and the new KOT's ID, if any.
 * @returns The order's full view and the KOT ticket (or null).
 */
async function buildOrderWithKot(result: { orderId: string; kotId: string | null }) {
  const [order, kot] = await Promise.all([
    getOrderDetail(prisma, result.orderId),
    result.kotId ? getKotTicket(prisma, result.kotId) : null,
  ]);

  return { order, kot };
}

/**
 * Creates a POS order and applies the pressed button's action:
 * HOLD saves it, KOT also sends it to the kitchen, BILL also generates the
 * invoice, KOT_BILL does both. Payments, when sent with BILL/KOT_BILL,
 * settle the bill in the same transaction.
 *
 * @param actor - The authenticated user.
 * @param input - The validated order.
 * @returns The order's full view and the KOT ticket (or null).
 * @throws OrderServiceError On invalid branch, table, items, discount or payments.
 */
export async function createOrder(actor: OrderActor, input: CreateOrderInput) {
  assertBranchAccess(actor, input.branchId);

  const result = await runOrderTransaction(async (tx) => {
    const branch = await getActiveBranch(tx, actor, input.branchId);

    if (input.tableId !== undefined) {
      await assertTableAvailable(tx, branch.id, input.tableId);
    }

    const lines = await resolveOrderLines(
      tx,
      actor.organizationId,
      branch.id,
      input.orderType,
      input.items,
      new Map(),
    );

    const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);
    const sequence = await nextBranchCounter(tx, branch.id, `order:${businessDate}`);

    const order = await tx.order.create({
      data: {
        organizationId: actor.organizationId,
        branchId: branch.id,
        orderNumber: formatOrderNumber(branch.code, businessDate, sequence),
        businessDate,
        orderType: input.orderType,
        tableId: input.tableId ?? null,
        customerName: input.customerName ?? null,
        customerPhone: input.customerPhone ?? null,
        note: input.note ?? null,
        allergyNote: input.allergyNote ?? null,
        discountAmount: input.discountAmount,
        createdById: actor.userId,
      },
      select: { id: true },
    });

    await insertOrderLines(tx, order.id, lines);
    await recalculateOrderTotals(tx, order.id, { strictDiscount: true });

    const sendKot = input.action === PosAction.KOT || input.action === PosAction.KOT_BILL;
    const bill = input.action === PosAction.BILL || input.action === PosAction.KOT_BILL;

    const kotId = sendKot
      ? await sendPendingItemsToKitchen(tx, actor, order.id, branch)
      : null;

    if (bill) {
      await generateBill(tx, actor, order.id, branch);
    }

    if (input.payments !== undefined) {
      await applyPayments(tx, actor, order.id, input.payments);
    }

    return { orderId: order.id, kotId };
  });

  if (result.kotId) {
    await publishKotTicketsCreated(result.kotId);
  }

  return buildOrderWithKot(result);
}

/**
 * Lists a branch's orders, newest first. Used for held bills (status OPEN),
 * live orders and order history.
 *
 * @param actor - The authenticated user.
 * @param query - Validated filters and pagination.
 * @returns The order summaries and pagination metadata.
 * @throws OrderServiceError When the branch is not accessible.
 */
export async function listOrders(actor: OrderActor, query: ListOrdersQuery) {
  assertBranchAccess(actor, query.branchId);

  const where = {
    organizationId: actor.organizationId,
    branchId: query.branchId,
    ...(query.status !== undefined && { status: query.status }),
    ...(query.paymentStatus !== undefined && { paymentStatus: query.paymentStatus }),
    ...(query.orderType !== undefined && { orderType: query.orderType }),
    ...(query.tableId !== undefined && { tableId: query.tableId }),
    ...(query.businessDate !== undefined && { businessDate: query.businessDate }),
    ...(query.search !== undefined && {
      OR: [
        { orderNumber: { contains: query.search, mode: "insensitive" as const } },
        { invoiceNumber: { contains: query.search, mode: "insensitive" as const } },
        { customerName: { contains: query.search, mode: "insensitive" as const } },
        { customerPhone: { contains: query.search } },
      ],
    }),
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        orderNumber: true,
        invoiceNumber: true,
        businessDate: true,
        orderType: true,
        status: true,
        paymentStatus: true,
        customerName: true,
        customerPhone: true,
        totalAmount: true,
        amountPaid: true,
        createdAt: true,
        billedAt: true,
        paidAt: true,
        table: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        _count: {
          select: { items: { where: { status: { not: OrderItemStatus.VOID } } } },
        },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    orders: orders.map(({ _count, totalAmount, amountPaid, ...order }) => ({
      ...order,
      itemCount: _count.items,
      totalAmount: totalAmount.toNumber(),
      amountPaid: amountPaid.toNumber(),
    })),
  };
}

/**
 * Retrieves an order's full view (View Bill).
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @returns The order's full view.
 * @throws OrderServiceError When not found or not accessible.
 */
export async function getOrder(actor: OrderActor, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId: actor.organizationId },
    select: { id: true, branchId: true },
  });

  if (!order) {
    throw new OrderServiceError(
      OrderServiceErrorCode.ORDER_NOT_FOUND,
      "Order not found",
    );
  }

  assertBranchAccess(actor, order.branchId);

  return getOrderDetail(prisma, order.id);
}

/**
 * Updates an open order's details: order type, table, customer, note and
 * discount. Moving to takeaway or delivery clears the table.
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param input - The validated fields to update.
 * @returns The order's full view.
 * @throws OrderServiceError When the order is not open, or the table or
 * discount is invalid.
 */
export async function updateOrder(
  actor: OrderActor,
  orderId: string,
  input: UpdateOrderInput,
) {
  await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(order, [OrderStatus.OPEN], "Only open orders can be edited");

    const orderType = input.orderType ?? order.orderType;
    let tableId = input.tableId !== undefined ? input.tableId : order.tableId;

    if (orderType !== OrderType.DINE_IN) {
      if (input.tableId) {
        throw new OrderServiceError(
          OrderServiceErrorCode.INVALID_TABLE,
          "A table can only be set for dine-in orders",
        );
      }

      tableId = null;
    }

    if (tableId && tableId !== order.tableId) {
      await assertTableAvailable(tx, order.branchId, tableId, order.id);
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        orderType,
        tableId,
        ...(input.customerName !== undefined && { customerName: input.customerName }),
        ...(input.customerPhone !== undefined && { customerPhone: input.customerPhone }),
        ...(input.note !== undefined && { note: input.note }),
        ...(input.allergyNote !== undefined && { allergyNote: input.allergyNote }),
        ...(input.discountAmount !== undefined && {
          discountAmount: input.discountAmount,
        }),
      },
    });

    if (input.discountAmount !== undefined) {
      await recalculateOrderTotals(tx, order.id, { strictDiscount: true });
    }
  });

  return getOrderDetail(prisma, orderId);
}

/**
 * Adds items to an open order, optionally sending all pending items to the
 * kitchen on a new KOT.
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param input - The validated items and KOT flag.
 * @returns The order's full view and the KOT ticket (or null).
 * @throws OrderServiceError When the order is not open or an item is invalid.
 */
export async function addOrderItems(
  actor: OrderActor,
  orderId: string,
  input: AddOrderItemsInput,
) {
  const result = await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(order, [OrderStatus.OPEN], "Items can only be added to open orders");

    const lines = await resolveOrderLines(
      tx,
      actor.organizationId,
      order.branchId,
      order.orderType,
      input.items,
      await getExistingQuantities(tx, order.id),
    );

    await insertOrderLines(tx, order.id, lines);
    await recalculateOrderTotals(tx, order.id);

    const kotId = input.sendKot
      ? await sendPendingItemsToKitchen(tx, actor, order.id, order.branch)
      : null;

    return { orderId: order.id, kotId };
  });

  if (result.kotId) {
    await publishKotTicketsCreated(result.kotId);
  }

  return buildOrderWithKot(result);
}

/**
 * Changes the quantity or note of an order line not yet sent to the kitchen.
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param itemId - The order item ID.
 * @param input - The validated changes.
 * @returns The order's full view.
 * @throws OrderServiceError When the order is not open, the line is not
 * found or already sent, or the quantity limit is exceeded.
 */
export async function updateOrderItem(
  actor: OrderActor,
  orderId: string,
  itemId: string,
  input: UpdateOrderItemInput,
) {
  await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(order, [OrderStatus.OPEN], "Only open orders can be edited");

    const item = await tx.orderItem.findFirst({
      where: { id: itemId, orderId: order.id },
      select: {
        id: true,
        name: true,
        status: true,
        menuItemId: true,
        unitPrice: true,
        addonsPrice: true,
        quantity: true,
      },
    });

    if (!item) {
      throw new OrderServiceError(
        OrderServiceErrorCode.ORDER_ITEM_NOT_FOUND,
        "Order item not found",
      );
    }

    if (item.status !== OrderItemStatus.PENDING) {
      throw new OrderServiceError(
        OrderServiceErrorCode.ITEM_ALREADY_SENT,
        "Items already sent to the kitchen can't be changed. Void the item and add it again.",
      );
    }

    if (input.quantity !== undefined && item.menuItemId !== null) {
      const branchItem = await tx.branchMenuItem.findUnique({
        where: {
          branchId_menuItemId: { branchId: order.branchId, menuItemId: item.menuItemId },
        },
        select: { maxQuantityPerOrder: true },
      });
      const maxQuantity = branchItem?.maxQuantityPerOrder ?? null;

      if (maxQuantity !== null) {
        const existing = await getExistingQuantities(tx, order.id);
        const quantity =
          (existing.get(item.menuItemId) ?? 0) - item.quantity + input.quantity;

        if (quantity > maxQuantity) {
          throw new OrderServiceError(
            OrderServiceErrorCode.QUANTITY_LIMIT_EXCEEDED,
            `A maximum of ${maxQuantity} × ${item.name} is allowed per order`,
          );
        }
      }
    }

    await tx.orderItem.update({
      where: { id: item.id },
      data: {
        ...(input.quantity !== undefined && {
          quantity: input.quantity,
          lineSubtotal: fromPaise(
            (toPaise(item.unitPrice) + toPaise(item.addonsPrice)) * input.quantity,
          ),
        }),
        ...(input.note !== undefined && { note: input.note }),
      },
    });

    if (input.quantity !== undefined) {
      await recalculateOrderTotals(tx, order.id);
    }
  });

  return getOrderDetail(prisma, orderId);
}

/**
 * Removes a line from an open order. A line not yet sent to the kitchen is
 * deleted; a sent line is voided (kept for audit) and needs an owner or
 * manager and a reason.
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param itemId - The order item ID.
 * @param input - The void reason, required for sent lines.
 * @returns The order's full view.
 * @throws OrderServiceError When the order is not open, the line is not
 * found or already void, or voiding is not permitted.
 */
export async function removeOrderItem(
  actor: OrderActor,
  orderId: string,
  itemId: string,
  input: RemoveOrderItemInput,
) {
  const affectedTicketId = await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(order, [OrderStatus.OPEN], "Only open orders can be edited");

    const item = await tx.orderItem.findFirst({
      where: { id: itemId, orderId: order.id },
      select: { id: true, status: true, kitchenTicketId: true },
    });

    if (!item) {
      throw new OrderServiceError(
        OrderServiceErrorCode.ORDER_ITEM_NOT_FOUND,
        "Order item not found",
      );
    }

    if (item.status === OrderItemStatus.VOID) {
      throw new OrderServiceError(
        OrderServiceErrorCode.ITEM_ALREADY_VOID,
        "This item is already void",
      );
    }

    if (item.status === OrderItemStatus.PENDING) {
      await tx.orderItem.delete({ where: { id: item.id } });
    } else {
      assertManager(
        actor,
        "Only an owner or manager can void items already sent to the kitchen",
      );

      if (!input.reason) {
        throw new OrderServiceError(
          OrderServiceErrorCode.VOID_REASON_REQUIRED,
          "A reason is required to void an item already sent to the kitchen",
        );
      }

      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          status: OrderItemStatus.VOID,
          voidedAt: new Date(),
          voidedById: actor.userId,
          voidReason: input.reason,
          discountAmount: 0,
          taxAmount: 0,
        },
      });

      // Put its ingredients back in stock.
      await reverseStockForOrderItemsInTx(tx, {
        organizationId: actor.organizationId,
        branchId: order.branch.id,
        orderItemIds: [item.id],
        userId: actor.userId,
        note: `Item voided: ${input.reason}`,
      });

      // The kitchen stops cooking it; an emptied ticket is cancelled.
      if (item.kitchenTicketId) {
        await cancelKitchenTicketIfEmpty(tx, item.kitchenTicketId);
      }
    }

    await recalculateOrderTotals(tx, order.id);

    return item.status === OrderItemStatus.SENT ? item.kitchenTicketId : null;
  });

  if (affectedTicketId) {
    await publishTicketUpdated(affectedTicketId);
  }

  return getOrderDetail(prisma, orderId);
}

/**
 * Sends an order's pending lines to the kitchen on a new KOT. Allowed until
 * the order is cancelled, so a counter that bills first can still send it.
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @returns The order's full view and the KOT ticket.
 * @throws OrderServiceError When the order is cancelled or nothing is pending.
 */
export async function sendOrderKot(actor: OrderActor, orderId: string) {
  const result = await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(
      order,
      [OrderStatus.OPEN, OrderStatus.BILLED, OrderStatus.COMPLETED],
      "A KOT can't be sent for a cancelled order",
    );

    const kotId = await sendPendingItemsToKitchen(tx, actor, order.id, order.branch);

    if (!kotId) {
      throw new OrderServiceError(
        OrderServiceErrorCode.NO_ITEMS_TO_SEND,
        "All items have already been sent to the kitchen",
      );
    }

    return { orderId: order.id, kotId };
  });

  await publishKotTicketsCreated(result.kotId);

  return buildOrderWithKot(result);
}

/**
 * Generates the bill for an open order, optionally settling it with
 * payments in the same transaction.
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param input - Optional payments.
 * @returns The order's full view.
 * @throws OrderServiceError When the order is not open, empty, or the
 * payments exceed the total.
 */
export async function billOrder(
  actor: OrderActor,
  orderId: string,
  input: BillOrderInput,
) {
  await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(
      order,
      [OrderStatus.OPEN],
      "This order is already billed or closed",
    );

    await generateBill(tx, actor, order.id, order.branch);

    if (input.payments !== undefined) {
      await applyPayments(tx, actor, order.id, input.payments);
    }
  });

  return getOrderDetail(prisma, orderId);
}

/**
 * Records payments against a billed order (cash, UPI, card or a split).
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param input - The payments.
 * @returns The order's full view.
 * @throws OrderServiceError When the order is not billed or the payments
 * exceed the balance due.
 */
export async function addOrderPayments(
  actor: OrderActor,
  orderId: string,
  input: AddPaymentsInput,
) {
  await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    await applyPayments(tx, actor, order.id, input.payments);
  });

  return getOrderDetail(prisma, orderId);
}

/**
 * Cancels an open order and its KOTs that the kitchen has not finished.
 * A billed order must have its bill cancelled first, which reopens it.
 * Owners and managers only.
 *
 * @param actor - The authenticated user.
 * @param orderId - The order ID.
 * @param input - The cancellation reason.
 * @returns The order's full view.
 * @throws OrderServiceError When not permitted or the order is not open.
 */
export async function cancelOrder(
  actor: OrderActor,
  orderId: string,
  input: CancelOrderInput,
) {
  assertManager(actor, "Only an owner or manager can cancel orders");

  const cancelledTicketIds = await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(
      order,
      [OrderStatus.OPEN],
      order.status === OrderStatus.BILLED
        ? "This order is on a bill. Cancel the bill first, then the order."
        : "Only open orders can be cancelled",
    );

    if (toPaise(order.amountPaid) > 0) {
      throw new OrderServiceError(
        OrderServiceErrorCode.ORDER_HAS_PAYMENTS,
        "This order has payments and can't be cancelled",
      );
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: actor.userId,
        cancelReason: input.reason,
      },
    });

    // Ingredients of dishes the kitchen hadn't finished go back into stock.
    const unfinishedItems = await tx.orderItem.findMany({
      where: {
        orderId: order.id,
        status: OrderItemStatus.SENT,
        kot: { status: { in: [KotStatus.PENDING, KotStatus.PREPARING] } },
      },
      select: { id: true },
    });

    await reverseStockForOrderItemsInTx(tx, {
      organizationId: actor.organizationId,
      branchId: order.branch.id,
      orderItemIds: unfinishedItems.map((item) => item.id),
      userId: actor.userId,
      note: `Order cancelled: ${input.reason}`,
    });

    await tx.kot.updateMany({
      where: {
        orderId: order.id,
        status: { in: [KotStatus.PENDING, KotStatus.PREPARING] },
      },
      data: { status: KotStatus.CANCELLED },
    });

    return cancelOrderKitchenTickets(tx, order.id);
  });

  await publishTicketsCancelled(cancelledTicketIds);

  return getOrderDetail(prisma, orderId);
}
