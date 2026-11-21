import { createPrismaClient } from "@morfikos/database";
import { OrderServiceErrorCode } from "@morfikos/auth";
import type {
  ListTableTransfersQuery,
  MergeOrderInput,
  MoveOrderItemsInput,
  TransferOrderInput,
} from "@morfikos/validation";

import { getBusinessDate } from "../../utils/branch-time.js";
import { KitchenEventName } from "../kitchen/constants.js";
import { publishKitchenEvent } from "../kitchen/events.js";
import { publishTicketUpdated } from "../kitchen/service.js";
import { ACTIVE_ORDER_STATUSES, OrderItemStatus, OrderStatus, OrderType } from "./constants.js";
import { fromPaise, toPaise } from "./pricing.js";
import {
  OrderServiceError,
  assertOrderStatus,
  formatOrderNumber,
  getOrderDetail,
  loadOrderForAction,
  nextBranchCounter,
  recalculateOrderTotals,
  runOrderTransaction,
  type OrderActor,
  type TransactionClient,
} from "./service.js";

const prisma = createPrismaClient();

/**
 * Table actions (menutap: "Table transfer"): move an order to another
 * table, swap two tables, merge two orders, or move some items. Every
 * action is logged and produces a "Kitchen Shift slip" so the kitchen
 * knows where the food now goes.
 */

/** The kind of table action. Values match the Prisma `TableTransferType` enum. */
export enum TableTransferType {
  TRANSFER = "TRANSFER",
  SWAP = "SWAP",
  MERGE = "MERGE",
  ITEM_MOVE = "ITEM_MOVE",
}

/** Slip headings printed in the kitchen. */
const SLIP_TITLES: Record<TableTransferType, string> = {
  [TableTransferType.TRANSFER]: "TABLE TRANSFER",
  [TableTransferType.SWAP]: "TABLE SWAP",
  [TableTransferType.MERGE]: "TABLES MERGED",
  [TableTransferType.ITEM_MOVE]: "ITEMS MOVED",
};

/** API transfer type → stored type. */
const TRANSFER_TYPE_FROM_API: Record<string, TableTransferType> = {
  transfer: TableTransferType.TRANSFER,
  swap: TableTransferType.SWAP,
  merge: TableTransferType.MERGE,
  item_move: TableTransferType.ITEM_MOVE,
};

/** One moved line on a slip. */
interface SlipItem {
  name: string;
  variantName: string | null;
  quantity: number;
  sentToKitchen: boolean;
  station: string | null;
}

type LoadedOrder = Awaited<ReturnType<typeof loadOrderForAction>>;

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Loads an active table of the branch.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @param tableId - The table ID.
 * @returns The table.
 * @throws OrderServiceError If the table isn't found or inactive.
 */
async function loadTable(tx: TransactionClient, branchId: string, tableId: string) {
  const table = await tx.diningTable.findFirst({
    where: { id: tableId, branchId, isActive: true },
    select: { id: true, name: true },
  });

  if (!table) {
    throw new OrderServiceError(OrderServiceErrorCode.TABLE_NOT_FOUND, "Active table not found in this branch");
  }

  return table;
}

/**
 * Finds the open or billed order on a table.
 *
 * @param tx - The transaction client.
 * @param tableId - The table ID.
 * @param excludeOrderId - An order to ignore.
 * @returns The order, or null when the table is free.
 */
async function findTableOrder(tx: TransactionClient, tableId: string, excludeOrderId?: string) {
  return tx.order.findFirst({
    where: {
      tableId,
      status: { in: ACTIVE_ORDER_STATUSES },
      ...(excludeOrderId && { id: { not: excludeOrderId } }),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, orderNumber: true, status: true },
  });
}

/**
 * Loads an order's number, table, bill and notes.
 *
 * @param tx - The transaction client.
 * @param orderId - The order ID.
 * @returns The order's details.
 */
async function loadOrderInfo(tx: TransactionClient, orderId: string) {
  return tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      tableId: true,
      billId: true,
      discountAmount: true,
      note: true,
      allergyNote: true,
      customerName: true,
      customerPhone: true,
      table: { select: { name: true } },
    },
  });
}

/**
 * Throws when an order already has money taken against it.
 *
 * @param order - The order.
 * @throws OrderServiceError If the order has payments.
 */
function assertNoPayments(order: LoadedOrder): void {
  if (toPaise(order.amountPaid) > 0) {
    throw new OrderServiceError(
      OrderServiceErrorCode.ORDER_HAS_PAYMENTS,
      "This order already has payments, so its items can't be moved",
    );
  }
}

/**
 * Snapshots order lines for the Kitchen Shift slip.
 *
 * @param items - The lines and the quantity moved.
 * @returns The slip lines.
 */
function toSlipItems(
  items: { name: string; variantName: string | null; quantity: number; status: string; kitchenStation: string | null }[],
): SlipItem[] {
  return items.map((item) => ({
    name: item.name,
    variantName: item.variantName,
    quantity: item.quantity,
    sentToKitchen: item.status === OrderItemStatus.SENT,
    station: item.kitchenStation,
  }));
}

/**
 * Logs a table action, numbered per branch per business day.
 *
 * @param tx - The transaction client.
 * @param actor - The staff member.
 * @param branch - The branch's ID and clock.
 * @param data - What moved where.
 * @returns The transfer ID.
 */
async function recordTransfer(
  tx: TransactionClient,
  actor: OrderActor,
  branch: LoadedOrder["branch"],
  data: {
    type: TableTransferType;
    from: { orderId: string; orderNumber: string; tableId: string | null; tableName: string | null };
    to: { orderId: string; orderNumber: string; tableId: string | null; tableName: string | null };
    items: SlipItem[];
    reason: string | undefined;
  },
): Promise<string> {
  const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);
  const transferNumber = await nextBranchCounter(tx, branch.id, `transfer:${businessDate}`);

  const transfer = await tx.tableTransfer.create({
    data: {
      organizationId: actor.organizationId,
      branchId: branch.id,
      transferNumber,
      businessDate,
      type: data.type,
      fromOrderId: data.from.orderId,
      toOrderId: data.to.orderId,
      fromOrderNumber: data.from.orderNumber,
      toOrderNumber: data.to.orderNumber,
      fromTableId: data.from.tableId,
      toTableId: data.to.tableId,
      fromTableName: data.from.tableName,
      toTableName: data.to.tableName,
      items: data.items as unknown as object[],
      kitchenItemCount: data.items.filter((item) => item.sentToKitchen).reduce((sum, item) => sum + item.quantity, 0),
      reason: data.reason ?? null,
      createdById: actor.userId,
    },
    select: { id: true },
  });

  return transfer.id;
}

/** Fields of a transfer used for its slip. */
const transferSelect = {
  id: true,
  branchId: true,
  transferNumber: true,
  businessDate: true,
  type: true,
  fromOrderId: true,
  toOrderId: true,
  fromOrderNumber: true,
  toOrderNumber: true,
  fromTableId: true,
  toTableId: true,
  fromTableName: true,
  toTableName: true,
  items: true,
  kitchenItemCount: true,
  reason: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/**
 * Builds the Kitchen Shift slip for a transfer.
 *
 * @param transfer - The transfer record.
 * @returns The slip.
 */
function serializeSlip(transfer: {
  id: string;
  branchId: string;
  transferNumber: number;
  businessDate: string;
  type: string;
  fromOrderId: string;
  toOrderId: string;
  fromOrderNumber: string;
  toOrderNumber: string;
  fromTableId: string | null;
  toTableId: string | null;
  fromTableName: string | null;
  toTableName: string | null;
  items: unknown;
  kitchenItemCount: number;
  reason: string | null;
  createdAt: Date;
  createdBy: { id: string; name: string };
}) {
  const type = transfer.type as TableTransferType;
  const from = transfer.fromTableName ?? transfer.fromOrderNumber;
  const to = transfer.toTableName ?? transfer.toOrderNumber;

  return {
    id: transfer.id,
    branchId: transfer.branchId,
    transferNumber: transfer.transferNumber,
    businessDate: transfer.businessDate,
    type: type.toLowerCase(),
    title: SLIP_TITLES[type],
    message: type === TableTransferType.SWAP ? `${from} ⇄ ${to}` : `${from} → ${to}`,
    from: {
      orderId: transfer.fromOrderId,
      orderNumber: transfer.fromOrderNumber,
      tableId: transfer.fromTableId,
      tableName: transfer.fromTableName,
    },
    to: {
      orderId: transfer.toOrderId,
      orderNumber: transfer.toOrderNumber,
      tableId: transfer.toTableId,
      tableName: transfer.toTableName,
    },
    items: transfer.items as SlipItem[],
    kitchenItemCount: transfer.kitchenItemCount,
    reason: transfer.reason,
    createdBy: transfer.createdBy,
    createdAt: transfer.createdAt,
  };
}

/**
 * Tells the kitchen about a transfer: refreshes the affected tickets (they
 * show the new table) and pushes the Kitchen Shift slip.
 *
 * @param transferId - The transfer ID.
 * @param orderIds - The orders whose tickets changed.
 * @param ticketIds - Further tickets whose items moved.
 */
async function notifyKitchen(transferId: string, orderIds: string[], ticketIds: string[] = []): Promise<void> {
  try {
    const transfer = await prisma.tableTransfer.findUniqueOrThrow({ where: { id: transferId }, select: transferSelect });
    const tickets = await prisma.kitchenTicket.findMany({
      where: { OR: [{ orderId: { in: orderIds } }, { id: { in: ticketIds } }], status: { not: "CANCELLED" } },
      select: { id: true },
    });

    for (const ticket of tickets) {
      await publishTicketUpdated(ticket.id);
    }

    if (transfer.kitchenItemCount > 0) {
      publishKitchenEvent(transfer.branchId, {
        event: KitchenEventName.TABLE_TRANSFERRED,
        data: serializeSlip(transfer),
      });
    }
  } catch {
    // Screens resync from the list APIs; a missed push is not fatal.
  }
}

/**
 * Loads a transfer's slip.
 *
 * @param transferId - The transfer ID.
 * @returns The slip.
 */
async function getSlip(transferId: string) {
  return serializeSlip(await prisma.tableTransfer.findUniqueOrThrow({ where: { id: transferId }, select: transferSelect }));
}

/**
 * Moves a live QR table session along with its order, and closes idle
 * sessions on the destination table (nobody ordered there).
 *
 * @param tx - The transaction client.
 * @param orderId - The order that moved.
 * @param toTableId - Its new table.
 */
async function moveQrSessions(tx: TransactionClient, orderId: string, toTableId: string): Promise<void> {
  await tx.tableSession.updateMany({
    where: { tableId: toTableId, status: "OPEN", orderId: null },
    data: { status: "CLOSED", closedAt: new Date(), closeReason: "Table reassigned" },
  });
  await tx.tableSession.updateMany({
    where: { orderId, status: "OPEN" },
    data: { tableId: toTableId },
  });
}

// ─── Actions ────────────────────────────────────────────────────────────

/**
 * Moves an order (and its bill, if printed) to another table. If that
 * table is busy, `swap: true` swaps the two tables' orders; otherwise
 * merge them instead. Kitchen tickets show the new table and a Kitchen
 * Shift slip is pushed.
 *
 * @param actor - The staff member.
 * @param orderId - The order ID.
 * @param input - The new table, swap flag and reason.
 * @returns The order(s) and the slip.
 * @throws OrderServiceError If the order can't move or the table is busy.
 */
export async function transferOrder(actor: OrderActor, orderId: string, input: TransferOrderInput) {
  const result = await runOrderTransaction(async (tx) => {
    const order = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(order, [OrderStatus.OPEN, OrderStatus.BILLED], "Only open or billed orders can change table");

    if (order.orderType !== OrderType.DINE_IN) {
      throw new OrderServiceError(OrderServiceErrorCode.INVALID_TRANSFER, "Only dine-in orders can be moved to a table");
    }

    const table = await loadTable(tx, order.branchId, input.tableId);

    if (order.tableId === table.id) {
      throw new OrderServiceError(OrderServiceErrorCode.INVALID_TRANSFER, `The order is already on ${table.name}`);
    }

    const info = await loadOrderInfo(tx, order.id);
    const other = await findTableOrder(tx, table.id, order.id);

    if (other && !input.swap) {
      throw new OrderServiceError(
        OrderServiceErrorCode.TABLE_HAS_OPEN_ORDER,
        `${table.name} already has order ${other.orderNumber}. Swap the tables or merge the orders instead.`,
      );
    }

    if (other && !order.tableId) {
      throw new OrderServiceError(OrderServiceErrorCode.INVALID_TRANSFER, "An order without a table can't be swapped");
    }

    // Swap: the other order takes this order's old table first.
    if (other) {
      const otherInfo = await loadOrderInfo(tx, other.id);

      await tx.order.update({ where: { id: other.id }, data: { tableId: order.tableId } });

      if (otherInfo.billId) {
        await tx.bill.update({ where: { id: otherInfo.billId }, data: { tableId: order.tableId } });
      }

      await tx.tableSession.updateMany({
        where: { orderId: other.id, status: "OPEN" },
        data: { tableId: order.tableId as string },
      });
    }

    await tx.tableSession.updateMany({
      where: { orderId: order.id, status: "OPEN" },
      data: { tableId: table.id },
    });

    if (!other) {
      await moveQrSessions(tx, order.id, table.id);
    }

    await tx.order.update({ where: { id: order.id }, data: { tableId: table.id } });

    if (info.billId) {
      await tx.bill.update({ where: { id: info.billId }, data: { tableId: table.id } });
    }

    const items = await tx.orderItem.findMany({
      where: { orderId: order.id, status: { not: OrderItemStatus.VOID } },
      orderBy: { lineNumber: "asc" },
      select: { name: true, variantName: true, quantity: true, status: true, kitchenStation: true },
    });

    const transferId = await recordTransfer(tx, actor, order.branch, {
      type: other ? TableTransferType.SWAP : TableTransferType.TRANSFER,
      from: { orderId: order.id, orderNumber: info.orderNumber, tableId: order.tableId, tableName: info.table?.name ?? null },
      to: { orderId: other?.id ?? order.id, orderNumber: other?.orderNumber ?? info.orderNumber, tableId: table.id, tableName: table.name },
      items: toSlipItems(items),
      reason: input.reason,
    });

    return { transferId, otherOrderId: other?.id ?? null };
  });

  const orderIds = [orderId, ...(result.otherOrderId ? [result.otherOrderId] : [])];
  await notifyKitchen(result.transferId, orderIds);

  return {
    order: await getOrderDetail(prisma, orderId),
    swappedOrder: result.otherOrderId ? await getOrderDetail(prisma, result.otherOrderId) : null,
    transfer: await getSlip(result.transferId),
  };
}

/**
 * Resolves the order to merge or move items into: a given order, or the
 * open order on a given table. Optionally creates a new order when the
 * table is free (item moves only).
 *
 * @param tx - The transaction client.
 * @param actor - The staff member.
 * @param source - The source order.
 * @param target - The target order or table.
 * @param createIfFree - Create a new order on a free table.
 * @returns The target order's ID and whether it was created.
 * @throws OrderServiceError If the target is invalid or not open.
 */
async function resolveTarget(
  tx: TransactionClient,
  actor: OrderActor,
  source: LoadedOrder,
  target: { targetOrderId?: string; tableId?: string },
  createIfFree: boolean,
): Promise<{ id: string; created: boolean }> {
  let targetId: string;

  if (target.targetOrderId) {
    const order = await loadOrderForAction(tx, actor, target.targetOrderId);

    if (order.branchId !== source.branchId) {
      throw new OrderServiceError(OrderServiceErrorCode.INVALID_TRANSFER, "Both orders must be in the same branch");
    }

    targetId = order.id;
  } else {
    const table = await loadTable(tx, source.branchId, target.tableId as string);
    const tableOrder = await findTableOrder(tx, table.id);

    if (!tableOrder) {
      if (!createIfFree) {
        throw new OrderServiceError(
          OrderServiceErrorCode.INVALID_TRANSFER,
          `${table.name} has no open order. Move the whole order there with a transfer instead.`,
        );
      }

      const { branch } = source;
      const businessDate = getBusinessDate(branch.timezone, branch.businessDayCutoff);
      const sequence = await nextBranchCounter(tx, branch.id, `order:${businessDate}`);
      const created = await tx.order.create({
        data: {
          organizationId: actor.organizationId,
          branchId: branch.id,
          orderNumber: formatOrderNumber(branch.code, businessDate, sequence),
          businessDate,
          orderType: OrderType.DINE_IN,
          tableId: table.id,
          createdById: actor.userId,
        },
        select: { id: true },
      });

      return { id: created.id, created: true };
    }

    targetId = tableOrder.id;
  }

  if (targetId === source.id) {
    throw new OrderServiceError(OrderServiceErrorCode.INVALID_TRANSFER, "Pick a different order to move into");
  }

  const order = await tx.order.findUniqueOrThrow({ where: { id: targetId }, select: { status: true, orderNumber: true } });

  assertOrderStatus(order, [OrderStatus.OPEN], `Order ${order.orderNumber}'s bill is already printed or closed`);

  return { id: targetId, created: false };
}

/**
 * Gives moved lines line numbers after the target order's last line.
 *
 * @param tx - The transaction client.
 * @param targetOrderId - The target order.
 * @returns A function returning the next free line number.
 */
async function lineNumberAllocator(tx: TransactionClient, targetOrderId: string) {
  const { _max } = await tx.orderItem.aggregate({ where: { orderId: targetOrderId }, _max: { lineNumber: true } });
  let next = _max.lineNumber ?? 0;

  return () => {
    next += 1;
    return next;
  };
}

/**
 * Closes an order whose items all moved away: it is cancelled and points
 * to the order it went into (excluded from void reports).
 *
 * @param tx - The transaction client.
 * @param actor - The staff member.
 * @param orderId - The emptied order.
 * @param target - The order it went into.
 * @param reason - Why it closed.
 */
async function closeMergedOrder(
  tx: TransactionClient,
  actor: OrderActor,
  orderId: string,
  target: { id: string; orderNumber: string },
  reason: string,
): Promise<void> {
  const now = new Date();

  await tx.order.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.CANCELLED,
      cancelledAt: now,
      cancelledById: actor.userId,
      cancelReason: reason,
      mergedIntoId: target.id,
      mergedAt: now,
      discountAmount: 0,
    },
  });
  await tx.tableSession.updateMany({
    where: { orderId, status: "OPEN" },
    data: { orderId: target.id },
  });
}

/**
 * Merges this order into another one (or the open order on a table): all
 * items and KOTs move across, the order-level discount and notes are
 * combined, and this order is closed as "merged". Both must be open
 * (no bill printed) and this one unpaid.
 *
 * @param actor - The staff member.
 * @param orderId - The order to merge away.
 * @param input - The target order or table and reason.
 * @returns The combined order and the slip.
 * @throws OrderServiceError If either order can't be merged.
 */
export async function mergeOrder(actor: OrderActor, orderId: string, input: MergeOrderInput) {
  const result = await runOrderTransaction(async (tx) => {
    const source = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(source, [OrderStatus.OPEN], "Only open orders can be merged");
    assertNoPayments(source);

    const target = await resolveTarget(tx, actor, source, input, false);
    const [sourceInfo, targetInfo] = await Promise.all([loadOrderInfo(tx, source.id), loadOrderInfo(tx, target.id)]);

    const items = await tx.orderItem.findMany({
      where: { orderId: source.id },
      orderBy: { lineNumber: "asc" },
      select: { id: true, name: true, variantName: true, quantity: true, status: true, kitchenStation: true },
    });
    const nextLine = await lineNumberAllocator(tx, target.id);

    for (const item of items) {
      await tx.orderItem.update({ where: { id: item.id }, data: { orderId: target.id, lineNumber: nextLine() } });
    }

    await tx.kot.updateMany({ where: { orderId: source.id }, data: { orderId: target.id } });
    await tx.kitchenTicket.updateMany({ where: { orderId: source.id }, data: { orderId: target.id } });

    await tx.order.update({
      where: { id: target.id },
      data: {
        discountAmount: { increment: sourceInfo.discountAmount },
        note: [targetInfo.note, sourceInfo.note].filter(Boolean).join("; ") || null,
        allergyNote: [targetInfo.allergyNote, sourceInfo.allergyNote].filter(Boolean).join("; ") || null,
        ...(!targetInfo.customerName && sourceInfo.customerName && { customerName: sourceInfo.customerName }),
        ...(!targetInfo.customerPhone && sourceInfo.customerPhone && { customerPhone: sourceInfo.customerPhone }),
      },
    });

    await closeMergedOrder(tx, actor, source.id, { id: target.id, orderNumber: targetInfo.orderNumber }, `Merged into ${targetInfo.orderNumber}`);
    await recalculateOrderTotals(tx, source.id);
    await recalculateOrderTotals(tx, target.id);

    const transferId = await recordTransfer(tx, actor, source.branch, {
      type: TableTransferType.MERGE,
      from: { orderId: source.id, orderNumber: sourceInfo.orderNumber, tableId: sourceInfo.tableId, tableName: sourceInfo.table?.name ?? null },
      to: { orderId: target.id, orderNumber: targetInfo.orderNumber, tableId: targetInfo.tableId, tableName: targetInfo.table?.name ?? null },
      items: toSlipItems(items.filter((item) => item.status !== OrderItemStatus.VOID)),
      reason: input.reason,
    });

    return { transferId, targetId: target.id };
  });

  await notifyKitchen(result.transferId, [result.targetId]);

  return {
    order: await getOrderDetail(prisma, result.targetId),
    mergedOrderId: orderId,
    transfer: await getSlip(result.transferId),
  };
}

/**
 * Moves some items to another order, the open order on a table, or a new
 * order on a free table. A smaller quantity splits the line. Items
 * already sent keep their kitchen ticket, and a Kitchen Shift slip tells
 * the kitchen where they now go. If nothing is left, this order closes.
 *
 * @param actor - The staff member.
 * @param orderId - The order the items come from.
 * @param input - The items (and quantities), target and reason.
 * @returns Both orders and the slip.
 * @throws OrderServiceError If an item or the target is invalid.
 */
export async function moveOrderItems(actor: OrderActor, orderId: string, input: MoveOrderItemsInput) {
  const result = await runOrderTransaction(async (tx) => {
    const source = await loadOrderForAction(tx, actor, orderId);
    assertOrderStatus(source, [OrderStatus.OPEN], "Items can only be moved from an open order");
    assertNoPayments(source);

    const lines = await tx.orderItem.findMany({
      where: { orderId: source.id, id: { in: input.items.map((item) => item.orderItemId) } },
      select: {
        id: true,
        menuItemId: true,
        variantId: true,
        name: true,
        variantName: true,
        isCustom: true,
        unitPrice: true,
        addons: true,
        addonsPrice: true,
        quantity: true,
        gstRate: true,
        hsn: true,
        kitchenStation: true,
        note: true,
        status: true,
        kotId: true,
        kitchenTicketId: true,
        kitchenReadyAt: true,
      },
    });
    const lineById = new Map(lines.map((line) => [line.id, line]));

    for (const request of input.items) {
      const line = lineById.get(request.orderItemId);

      if (!line) {
        throw new OrderServiceError(OrderServiceErrorCode.ORDER_ITEM_NOT_FOUND, "An item to move isn't on this order");
      }

      if (line.status === OrderItemStatus.VOID) {
        throw new OrderServiceError(OrderServiceErrorCode.ITEM_ALREADY_VOID, `${line.name} is void and can't be moved`);
      }

      if (request.quantity !== undefined && request.quantity > line.quantity) {
        throw new OrderServiceError(
          OrderServiceErrorCode.INVALID_TRANSFER,
          `Only ${line.quantity} × ${line.name} on this order`,
        );
      }
    }

    const target = await resolveTarget(tx, actor, source, input, true);
    const [sourceInfo, targetInfo] = await Promise.all([loadOrderInfo(tx, source.id), loadOrderInfo(tx, target.id)]);
    const nextLine = await lineNumberAllocator(tx, target.id);
    const moved: SlipItem[] = [];
    const ticketIds = new Set<string>();

    for (const request of input.items) {
      const line = lineById.get(request.orderItemId)!;
      const quantity = request.quantity ?? line.quantity;
      const unitPaise = toPaise(line.unitPrice) + toPaise(line.addonsPrice);

      if (line.kitchenTicketId) {
        ticketIds.add(line.kitchenTicketId);
      }

      if (quantity === line.quantity) {
        // Whole line: same row, so its stock and kitchen links stay intact.
        await tx.orderItem.update({ where: { id: line.id }, data: { orderId: target.id, lineNumber: nextLine() } });
      } else {
        await tx.orderItem.update({
          where: { id: line.id },
          data: { quantity: line.quantity - quantity, lineSubtotal: fromPaise(unitPaise * (line.quantity - quantity)) },
        });
        await tx.orderItem.create({
          data: {
            orderId: target.id,
            lineNumber: nextLine(),
            menuItemId: line.menuItemId,
            variantId: line.variantId,
            name: line.name,
            variantName: line.variantName,
            isCustom: line.isCustom,
            unitPrice: line.unitPrice,
            addons: line.addons ?? [],
            addonsPrice: line.addonsPrice,
            quantity,
            lineSubtotal: fromPaise(unitPaise * quantity),
            gstRate: line.gstRate,
            hsn: line.hsn,
            kitchenStation: line.kitchenStation,
            note: line.note,
            status: line.status,
            kotId: line.kotId,
            kitchenTicketId: line.kitchenTicketId,
            kitchenReadyAt: line.kitchenReadyAt,
          },
        });
      }

      moved.push({
        name: line.name,
        variantName: line.variantName,
        quantity,
        sentToKitchen: line.status === OrderItemStatus.SENT,
        station: line.kitchenStation,
      });
    }

    const remaining = await tx.orderItem.count({ where: { orderId: source.id, status: { not: OrderItemStatus.VOID } } });

    if (remaining === 0) {
      await closeMergedOrder(tx, actor, source.id, { id: target.id, orderNumber: targetInfo.orderNumber }, `All items moved to ${targetInfo.orderNumber}`);
    }

    await recalculateOrderTotals(tx, source.id);
    await recalculateOrderTotals(tx, target.id);

    const transferId = await recordTransfer(tx, actor, source.branch, {
      type: TableTransferType.ITEM_MOVE,
      from: { orderId: source.id, orderNumber: sourceInfo.orderNumber, tableId: sourceInfo.tableId, tableName: sourceInfo.table?.name ?? null },
      to: { orderId: target.id, orderNumber: targetInfo.orderNumber, tableId: targetInfo.tableId, tableName: targetInfo.table?.name ?? null },
      items: moved,
      reason: input.reason,
    });

    return { transferId, targetId: target.id, createdTarget: target.created, sourceClosed: remaining === 0, ticketIds: [...ticketIds] };
  });

  await notifyKitchen(result.transferId, [orderId, result.targetId], result.ticketIds);

  return {
    fromOrder: await getOrderDetail(prisma, orderId),
    toOrder: await getOrderDetail(prisma, result.targetId),
    newOrderCreated: result.createdTarget,
    fromOrderClosed: result.sourceClosed,
    transfer: await getSlip(result.transferId),
  };
}

/**
 * Lists a branch's table actions (transfers, swaps, merges, item moves),
 * newest first — the audit trail and the slips to reprint.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param query - Day, type, order and pagination.
 * @returns The slips and pagination metadata.
 * @throws OrderServiceError If the branch isn't accessible.
 */
export async function listTableTransfers(actor: OrderActor, branchId: string, query: ListTableTransfersQuery) {
  if (!actor.branchIds.includes(branchId)) {
    throw new OrderServiceError(OrderServiceErrorCode.BRANCH_ACCESS_DENIED, "Access denied for this branch");
  }

  const where = {
    branchId,
    organizationId: actor.organizationId,
    ...(query.date !== undefined && { businessDate: query.date }),
    ...(query.type !== undefined && { type: TRANSFER_TYPE_FROM_API[query.type] }),
    ...(query.orderId !== undefined && { OR: [{ fromOrderId: query.orderId }, { toOrderId: query.orderId }] }),
  };

  const [transfers, total] = await Promise.all([
    prisma.tableTransfer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: transferSelect,
    }),
    prisma.tableTransfer.count({ where }),
  ]);

  return { total, limit: query.limit, offset: query.offset, transfers: transfers.map(serializeSlip) };
}

/**
 * Retrieves one table action's Kitchen Shift slip (to reprint it).
 *
 * @param actor - The staff member.
 * @param transferId - The transfer ID.
 * @returns The slip, or null if not found.
 */
export async function getTableTransfer(actor: OrderActor, transferId: string) {
  const transfer = await prisma.tableTransfer.findFirst({
    where: { id: transferId, organizationId: actor.organizationId, branchId: { in: actor.branchIds } },
    select: transferSelect,
  });

  return transfer ? serializeSlip(transfer) : null;
}
