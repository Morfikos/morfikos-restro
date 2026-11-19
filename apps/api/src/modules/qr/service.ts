import { randomBytes } from "node:crypto";

import { createPrismaClient } from "@morfikos/database";
import { QrServiceErrorCode, type UserRole } from "@morfikos/auth";
import type {
  CreateServiceRequestInput,
  ListQrOrdersQuery,
  ListServiceRequestsQuery,
  ListTableSessionsQuery,
  PlaceQrOrderInput,
  StartTableSessionInput,
  UpdateQrSettingsInput,
} from "@morfikos/validation";

import { createOrFindGuest } from "../guests/service.js";
import { publishKitchenEvent } from "../kitchen/events.js";
import { publishKotTicketsCreated } from "../kitchen/service.js";
import { OrderStatus } from "../orders/constants.js";
import { placeQrOrderInTx, runOrderTransaction } from "../orders/service.js";
import {
  DEFAULT_QR_SETTINGS,
  GUEST_STATUS_FROM_TICKET,
  GuestItemStatus,
  MAX_PENDING_QR_ORDERS,
  QR_ORDER_STATUS_FROM_API,
  QrEventName,
  QrOrderStatus,
  SERVICE_REQUEST_LABELS,
  SERVICE_REQUEST_TYPE_FROM_API,
  SESSION_IDLE_HOURS,
  SESSION_TOKEN_BYTES,
  ServiceRequestStatus,
  ServiceRequestType,
  TableSessionStatus,
} from "./constants.js";

const prisma = createPrismaClient();

/** The Prisma client available inside an interactive transaction. */
type TransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/** A Prisma Decimal value, typed structurally. */
type DecimalValue = { toNumber(): number };

/**
 * The authenticated staff member handling QR tables.
 */
export interface QrActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

/**
 * Represents errors that can occur during QR table ordering.
 */
export class QrServiceError extends Error {
  /**
   * Creates a QR service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: QrServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QrServiceError";
  }
}

/** A validated QR line with the names and prices shown to staff and guests. */
interface QrLine {
  menuItemId: string;
  name: string;
  variantId: string | null;
  variantName: string | null;
  addons: { id: string; name: string; price: number }[];
  quantity: number;
  note: string | null;
  unitPrice: number;
  lineTotal: number;
}

// ─── Shared helpers ─────────────────────────────────────────────────────

/**
 * Rounds a rupee amount to paise.
 *
 * @param value - The amount.
 * @returns The rounded amount.
 */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Converts a Prisma decimal (or null) to a number.
 *
 * @param value - The decimal.
 * @returns The number, or 0 for null.
 */
function toNumber(value: DecimalValue | null | undefined): number {
  return value ? value.toNumber() : 0;
}

/**
 * Sends a QR event to the branch's live screens (POS and kitchen stream).
 *
 * @param branchId - The branch ID.
 * @param event - The event name.
 * @param data - The event payload.
 */
function publishQrEvent(branchId: string, event: QrEventName, data: unknown): void {
  publishKitchenEvent(branchId, { event, data });
}

/**
 * Loads a branch's QR settings, falling back to the defaults.
 *
 * @param client - The Prisma client or transaction client.
 * @param branchId - The branch ID.
 * @returns The settings.
 */
async function getSettings(client: TransactionClient, branchId: string) {
  const settings = await client.qrSettings.findUnique({
    where: { branchId },
    select: {
      orderingEnabled: true,
      autoAcceptOrders: true,
      requireGuestPhone: true,
      serviceRequestsEnabled: true,
    },
  });

  return settings ?? { ...DEFAULT_QR_SETTINGS };
}

/**
 * Finds the active table for a QR code, in an active branch and organization.
 *
 * @param qrCode - The table's QR code.
 * @returns The table and its branch.
 * @throws QrServiceError If the QR code doesn't map to an active table.
 */
async function resolveTable(qrCode: string) {
  const table = await prisma.diningTable.findUnique({
    where: { qrCode },
    select: {
      id: true,
      name: true,
      isActive: true,
      branch: {
        select: {
          id: true,
          name: true,
          status: true,
          organizationId: true,
          organization: { select: { status: true } },
        },
      },
    },
  });

  if (
    !table ||
    !table.isActive ||
    table.branch.status !== "active" ||
    table.branch.organization.status !== "active"
  ) {
    throw new QrServiceError(QrServiceErrorCode.TABLE_NOT_FOUND, "Table not found");
  }

  return table;
}

/** Session fields used by the guest and staff views. */
const sessionSelect = {
  id: true,
  organizationId: true,
  branchId: true,
  tableId: true,
  status: true,
  guestName: true,
  guestPhone: true,
  guestId: true,
  orderId: true,
  deviceCount: true,
  billRequestedAt: true,
  openedAt: true,
  lastActivityAt: true,
  closedAt: true,
  closeReason: true,
  table: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true } },
} as const;

type SessionRecord = {
  id: string;
  organizationId: string;
  branchId: string;
  tableId: string;
  status: string;
  guestName: string | null;
  guestPhone: string | null;
  guestId: string | null;
  orderId: string | null;
  deviceCount: number;
  billRequestedAt: Date | null;
  openedAt: Date;
  lastActivityAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  table: { id: string; name: string };
  branch: { id: string; name: string };
};

/**
 * Works out whether an open session has ended on its own: its order was
 * settled or cancelled, or it sat idle with no order for too long.
 *
 * @param client - The Prisma client or transaction client.
 * @param session - The open session.
 * @returns The reason it ended, or null if it's still live.
 */
async function getEndedReason(
  client: TransactionClient,
  session: Pick<SessionRecord, "orderId" | "lastActivityAt">,
): Promise<string | null> {
  if (session.orderId) {
    const order = await client.order.findUnique({
      where: { id: session.orderId },
      select: { status: true },
    });

    if (!order || order.status === OrderStatus.COMPLETED) {
      return "Bill settled";
    }

    if (order.status === OrderStatus.CANCELLED) {
      return "Order cancelled";
    }

    return null;
  }

  const idleSince = Date.now() - SESSION_IDLE_HOURS * 60 * 60 * 1000;

  return session.lastActivityAt.getTime() < idleSince ? "Idle" : null;
}

/**
 * Closes a session, resolving its open requests and rejecting its waiting rounds.
 *
 * @param client - The Prisma client or transaction client.
 * @param sessionId - The session ID.
 * @param reason - Why it closed.
 * @param closedById - The staff member closing it, or null when it ended on its own.
 */
async function closeSessionInTx(
  client: TransactionClient,
  sessionId: string,
  reason: string,
  closedById: string | null,
): Promise<void> {
  const now = new Date();

  await client.tableSession.update({
    where: { id: sessionId },
    data: { status: TableSessionStatus.CLOSED, closedAt: now, closeReason: reason, closedById },
  });
  await client.serviceRequest.updateMany({
    where: { sessionId, status: { not: ServiceRequestStatus.RESOLVED } },
    data: { status: ServiceRequestStatus.RESOLVED, resolvedAt: now, resolvedById: closedById },
  });
  await client.qrOrder.updateMany({
    where: { sessionId, status: QrOrderStatus.PENDING },
    data: { status: QrOrderStatus.REJECTED, rejectReason: "Table session closed", decidedAt: now, decidedById: closedById },
  });
}

/**
 * Loads the live session for a guest's token, closing it first if it has
 * ended on its own.
 *
 * @param token - The session token.
 * @returns The open session.
 * @throws QrServiceError If the token is unknown or the session has ended.
 */
export async function getLiveSession(token: string): Promise<SessionRecord> {
  const session = await prisma.tableSession.findUnique({ where: { token }, select: sessionSelect });

  if (!session) {
    throw new QrServiceError(
      QrServiceErrorCode.SESSION_NOT_FOUND,
      "Session not found. Please scan the table QR code again.",
    );
  }

  if (session.status === TableSessionStatus.OPEN) {
    const endedReason = await getEndedReason(prisma, session);

    if (!endedReason) {
      return session;
    }

    await closeSessionInTx(prisma, session.id, endedReason, null);
  }

  throw new QrServiceError(
    QrServiceErrorCode.SESSION_CLOSED,
    "This table session has ended. Scan the QR code to start a new one.",
  );
}

/**
 * Checks the guest's items against the branch menu (active, available for
 * dine-in, valid portion and add-ons) and prices them for display. Final
 * prices are always recalculated by the orders module.
 *
 * @param organizationId - The organization ID.
 * @param branchId - The branch ID.
 * @param items - The requested lines.
 * @returns The validated, priced lines.
 * @throws QrServiceError If an item, portion or add-on isn't available.
 */
async function validateQrLines(
  organizationId: string,
  branchId: string,
  items: PlaceQrOrderInput["items"],
): Promise<QrLine[]> {
  const menuItems = await prisma.menuItem.findMany({
    where: {
      id: { in: [...new Set(items.map((item) => item.menuItemId))] },
      organizationId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      branchItems: {
        where: { branchId },
        select: { price: true, isAvailable: true, dineInAvailable: true },
      },
      variants: { select: { id: true, name: true, extraPrice: true, dineInAvailable: true } },
      addons: { select: { id: true, name: true, price: true } },
    },
  });
  const itemById = new Map(menuItems.map((item) => [item.id, item]));

  return items.map((line) => {
    const item = itemById.get(line.menuItemId);
    const branchItem = item?.branchItems[0];

    if (!item || !branchItem || !branchItem.isAvailable || !branchItem.dineInAvailable) {
      throw new QrServiceError(
        QrServiceErrorCode.ITEM_UNAVAILABLE,
        `${item?.name ?? "An item"} is not available right now`,
      );
    }

    const variant = line.variantId ? item.variants.find((entry) => entry.id === line.variantId) : null;

    if (line.variantId && (!variant || !variant.dineInAvailable)) {
      throw new QrServiceError(
        QrServiceErrorCode.ITEM_UNAVAILABLE,
        `The selected size of ${item.name} is not available`,
      );
    }

    const addons = line.addonIds.map((addonId) => {
      const addon = item.addons.find((entry) => entry.id === addonId);

      if (!addon) {
        throw new QrServiceError(
          QrServiceErrorCode.ITEM_UNAVAILABLE,
          `An add-on for ${item.name} is not available`,
        );
      }

      return { id: addon.id, name: addon.name, price: addon.price.toNumber() };
    });

    const unitPrice = roundMoney(
      branchItem.price.toNumber() +
        toNumber(variant?.extraPrice) +
        addons.reduce((sum, addon) => sum + addon.price, 0),
    );

    return {
      menuItemId: item.id,
      name: item.name,
      variantId: variant?.id ?? null,
      variantName: variant?.name ?? null,
      addons,
      quantity: line.quantity,
      note: line.note ?? null,
      unitPrice,
      lineTotal: roundMoney(unitPrice * line.quantity),
    };
  });
}

/**
 * Sends a QR round to the kitchen: adds it to the table's order and
 * records the result on the round and session.
 *
 * @param tx - The transaction client.
 * @param session - The session.
 * @param qrOrder - The round's ID and lines.
 * @param acceptedById - The staff member who accepted it, or null when auto-accepted.
 * @returns The KOT created for the round.
 */
async function sendRoundToKitchenInTx(
  tx: TransactionClient,
  session: Pick<SessionRecord, "id" | "organizationId" | "branchId" | "tableId" | "guestName" | "guestPhone">,
  qrOrder: { id: string; lines: QrLine[]; note: string | null; allergyNote: string | null },
  acceptedById: string | null,
): Promise<string | null> {
  const placed = await placeQrOrderInTx(tx, {
    organizationId: session.organizationId,
    branchId: session.branchId,
    tableId: session.tableId,
    items: qrOrder.lines.map((line) => ({
      menuItemId: line.menuItemId,
      ...(line.variantId && { variantId: line.variantId }),
      addonIds: line.addons.map((addon) => addon.id),
      quantity: line.quantity,
      ...(line.note && { note: line.note }),
    })),
    customerName: session.guestName,
    customerPhone: session.guestPhone,
    note: qrOrder.note,
    allergyNote: qrOrder.allergyNote,
    acceptedById,
  });

  const now = new Date();

  await tx.qrOrder.update({
    where: { id: qrOrder.id },
    data: {
      status: QrOrderStatus.ACCEPTED,
      orderId: placed.orderId,
      kotId: placed.kotId,
      decidedAt: now,
      decidedById: acceptedById,
    },
  });
  await tx.tableSession.update({
    where: { id: session.id },
    data: { orderId: placed.orderId, lastActivityAt: now },
  });

  return placed.kotId;
}

/**
 * Serializes a service request with lowercase enums and a staff label.
 *
 * @param request - The service request.
 * @returns The request view.
 */
function serializeRequest(request: {
  id: string;
  type: string;
  status: string;
  note: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
}) {
  return {
    ...request,
    type: request.type.toLowerCase(),
    label: SERVICE_REQUEST_LABELS[request.type as ServiceRequestType],
    status: request.status.toLowerCase(),
  };
}

/**
 * Builds the full view of a session: its QR rounds, the table's order
 * with each dish's status (received → cooking → ready → served), the bill
 * and open requests. Used by both the guest and staff views.
 *
 * @param session - The session.
 * @returns The session view.
 */
async function buildSessionView(session: SessionRecord) {
  const [rounds, requests, order, settings] = await Promise.all([
    prisma.qrOrder.findMany({
      where: { sessionId: session.id },
      orderBy: { roundNumber: "asc" },
      select: {
        id: true,
        roundNumber: true,
        status: true,
        items: true,
        itemCount: true,
        estimatedTotal: true,
        note: true,
        allergyNote: true,
        rejectReason: true,
        kotId: true,
        createdAt: true,
        decidedAt: true,
      },
    }),
    prisma.serviceRequest.findMany({
      where: { sessionId: session.id, status: { not: ServiceRequestStatus.RESOLVED } },
      orderBy: { createdAt: "desc" },
      select: { id: true, type: true, status: true, note: true, createdAt: true, acknowledgedAt: true, resolvedAt: true },
    }),
    session.orderId
      ? prisma.order.findUnique({
          where: { id: session.orderId },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            subtotal: true,
            discountAmount: true,
            taxAmount: true,
            roundOff: true,
            totalAmount: true,
            amountPaid: true,
            items: {
              orderBy: { lineNumber: "asc" },
              select: {
                id: true,
                name: true,
                variantName: true,
                addons: true,
                quantity: true,
                lineSubtotal: true,
                note: true,
                status: true,
                kotId: true,
                kitchenTicket: { select: { status: true } },
              },
            },
          },
        })
      : Promise.resolve(null),
    getSettings(prisma, session.branchId),
  ]);

  const orderItems = order?.items ?? [];

  /**
   * Maps an order line to what the guest sees.
   *
   * @param item - The order line.
   * @returns The guest-facing status.
   */
  const guestStatus = (item: (typeof orderItems)[number]): GuestItemStatus => {
    if (item.status === "VOID") return GuestItemStatus.CANCELLED;
    if (item.status === "PENDING") return GuestItemStatus.AWAITING_CONFIRMATION;

    return item.kitchenTicket
      ? (GUEST_STATUS_FROM_TICKET[item.kitchenTicket.status] ?? GuestItemStatus.RECEIVED)
      : GuestItemStatus.RECEIVED;
  };

  const total = toNumber(order?.totalAmount);
  const paid = toNumber(order?.amountPaid);

  return {
    sessionId: session.id,
    status: session.status.toLowerCase(),
    table: session.table,
    branch: session.branch,
    guestName: session.guestName,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
    closeReason: session.closeReason,
    settings: {
      orderingEnabled: settings.orderingEnabled,
      autoAcceptOrders: settings.autoAcceptOrders,
      serviceRequestsEnabled: settings.serviceRequestsEnabled,
    },
    rounds: rounds.map((round) => {
      const accepted = round.status === QrOrderStatus.ACCEPTED;
      const lines = round.items as unknown as QrLine[];

      return {
        id: round.id,
        roundNumber: round.roundNumber,
        status: round.status.toLowerCase(),
        itemCount: round.itemCount,
        estimatedTotal: round.estimatedTotal.toNumber(),
        note: round.note,
        allergyNote: round.allergyNote,
        rejectReason: round.rejectReason,
        createdAt: round.createdAt,
        decidedAt: round.decidedAt,
        items: accepted
          ? orderItems
              .filter((item) => item.kotId !== null && item.kotId === round.kotId)
              .map((item) => ({
                name: item.name,
                variantName: item.variantName,
                quantity: item.quantity,
                note: item.note,
                status: guestStatus(item),
              }))
          : lines.map((line) => ({
              name: line.name,
              variantName: line.variantName,
              quantity: line.quantity,
              note: line.note,
              status:
                round.status === QrOrderStatus.REJECTED
                  ? GuestItemStatus.REJECTED
                  : GuestItemStatus.AWAITING_CONFIRMATION,
            })),
      };
    }),
    order: order
      ? {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status.toLowerCase(),
          paymentStatus: order.paymentStatus.toLowerCase(),
          items: orderItems
            .filter((item) => item.status !== "VOID")
            .map((item) => ({
              id: item.id,
              name: item.name,
              variantName: item.variantName,
              addons: item.addons,
              quantity: item.quantity,
              amount: item.lineSubtotal.toNumber(),
              note: item.note,
              status: guestStatus(item),
            })),
          subtotal: order.subtotal.toNumber(),
          discount: order.discountAmount.toNumber(),
          tax: order.taxAmount.toNumber(),
          roundOff: order.roundOff.toNumber(),
          total,
          paid,
          due: roundMoney(Math.max(total - paid, 0)),
        }
      : null,
    billRequestedAt: session.billRequestedAt,
    openRequests: requests.map(serializeRequest),
  };
}

// ─── Guest (public) APIs ────────────────────────────────────────────────

/**
 * Joins the table's live session, or opens one. Every phone at the table
 * shares one session and one order. A phone number links the guest's
 * profile (visits and loyalty); a branch can make it required.
 *
 * @param qrCode - The table's QR code.
 * @param input - Optional guest name and phone.
 * @returns The session token (sent with every later call), whether this joined an existing session, and the session view.
 * @throws QrServiceError If the table isn't found or a required phone is missing.
 */
export async function startTableSession(qrCode: string, input: StartTableSessionInput) {
  const table = await resolveTable(qrCode);
  const settings = await getSettings(prisma, table.branch.id);

  if (settings.requireGuestPhone && !input.phone) {
    throw new QrServiceError(
      QrServiceErrorCode.PHONE_REQUIRED,
      "Please enter your phone number to order",
    );
  }

  const guest = input.phone
    ? (await createOrFindGuest(null, { qrCode, phone: input.phone, ...(input.name && { name: input.name }) })).guest
    : null;

  const result = await prisma.$transaction(async (tx) => {
    // One live session per table: serialize phones scanning at the same moment.
    await tx.$queryRaw`SELECT "id" FROM "DiningTable" WHERE "id" = ${table.id} FOR UPDATE`;

    const existing = await tx.tableSession.findFirst({
      where: { tableId: table.id, status: TableSessionStatus.OPEN },
      orderBy: { openedAt: "desc" },
      select: { id: true, token: true, orderId: true, lastActivityAt: true, guestName: true, guestPhone: true, guestId: true },
    });

    if (existing) {
      const endedReason = await getEndedReason(tx, existing);

      if (!endedReason) {
        await tx.tableSession.update({
          where: { id: existing.id },
          data: {
            deviceCount: { increment: 1 },
            lastActivityAt: new Date(),
            ...(!existing.guestName && input.name && { guestName: input.name }),
            ...(!existing.guestPhone && input.phone && { guestPhone: input.phone }),
            ...(!existing.guestId && guest && { guestId: guest.id }),
          },
        });

        return { token: existing.token, joined: true };
      }

      await closeSessionInTx(tx, existing.id, endedReason, null);
    }

    // A waiter may already have started an order on this table.
    const tableOrder = await tx.order.findFirst({
      where: {
        tableId: table.id,
        status: { in: [OrderStatus.OPEN, OrderStatus.BILLED] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    const created = await tx.tableSession.create({
      data: {
        organizationId: table.branch.organizationId,
        branchId: table.branch.id,
        tableId: table.id,
        token: randomBytes(SESSION_TOKEN_BYTES).toString("base64url"),
        guestName: input.name ?? null,
        guestPhone: input.phone ?? null,
        guestId: guest?.id ?? null,
        orderId: tableOrder?.id ?? null,
      },
      select: { id: true, token: true },
    });

    return { token: created.token, joined: false, sessionId: created.id };
  });

  if (!result.joined) {
    publishQrEvent(table.branch.id, QrEventName.SESSION_OPENED, {
      sessionId: result.sessionId,
      table: { id: table.id, name: table.name },
      guestName: input.name ?? null,
    });
  }

  const session = await getLiveSession(result.token);

  return { sessionToken: result.token, joined: result.joined, session: await buildSessionView(session) };
}

/**
 * Retrieves the guest's view of their table: rounds, each dish's status,
 * the running bill and open requests. Phones poll this for live status.
 *
 * @param token - The session token.
 * @returns The session view.
 * @throws QrServiceError If the session is unknown or has ended.
 */
export async function getGuestSession(token: string) {
  return buildSessionView(await getLiveSession(token));
}

/**
 * Places a round of items from the QR menu. By default (as on menutap) it
 * goes straight to the kitchen on a KOT; when the branch requires it, it
 * waits for a staff member to accept it.
 *
 * @param token - The session token.
 * @param input - The items and notes.
 * @returns The new round's ID and the updated session view.
 * @throws QrServiceError If ordering is off, an item is unavailable, or too many rounds are waiting.
 */
export async function placeGuestOrder(token: string, input: PlaceQrOrderInput) {
  const session = await getLiveSession(token);
  const settings = await getSettings(prisma, session.branchId);

  if (!settings.orderingEnabled) {
    throw new QrServiceError(
      QrServiceErrorCode.ORDERING_DISABLED,
      "Ordering from the table is turned off. Please call a waiter.",
    );
  }

  const lines = await validateQrLines(session.organizationId, session.branchId, input.items);
  const estimatedTotal = roundMoney(lines.reduce((sum, line) => sum + line.lineTotal, 0));

  const result = await runOrderTransaction(async (tx) => {
    const [pending, rounds] = await Promise.all([
      tx.qrOrder.count({ where: { sessionId: session.id, status: QrOrderStatus.PENDING } }),
      tx.qrOrder.count({ where: { sessionId: session.id } }),
    ]);

    if (!settings.autoAcceptOrders && pending >= MAX_PENDING_QR_ORDERS) {
      throw new QrServiceError(
        QrServiceErrorCode.TOO_MANY_PENDING_ORDERS,
        "Your earlier orders are still waiting for the staff to confirm",
      );
    }

    const qrOrder = await tx.qrOrder.create({
      data: {
        organizationId: session.organizationId,
        branchId: session.branchId,
        sessionId: session.id,
        tableId: session.tableId,
        roundNumber: rounds + 1,
        items: lines as unknown as object[],
        itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
        estimatedTotal,
        note: input.note ?? null,
        allergyNote: input.allergyNote ?? null,
      },
      select: { id: true, roundNumber: true },
    });

    const kotId = settings.autoAcceptOrders
      ? await sendRoundToKitchenInTx(
          tx,
          session,
          { id: qrOrder.id, lines, note: input.note ?? null, allergyNote: input.allergyNote ?? null },
          null,
        )
      : null;

    if (!settings.autoAcceptOrders) {
      await tx.tableSession.update({ where: { id: session.id }, data: { lastActivityAt: new Date() } });
    }

    return { qrOrderId: qrOrder.id, roundNumber: qrOrder.roundNumber, kotId };
  });

  if (result.kotId) {
    await publishKotTicketsCreated(result.kotId);
  }

  publishQrEvent(
    session.branchId,
    settings.autoAcceptOrders ? QrEventName.ORDER_PLACED : QrEventName.ORDER_PENDING,
    {
      qrOrderId: result.qrOrderId,
      roundNumber: result.roundNumber,
      sessionId: session.id,
      table: session.table,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      estimatedTotal,
      needsApproval: !settings.autoAcceptOrders,
    },
  );

  return {
    qrOrderId: result.qrOrderId,
    roundNumber: result.roundNumber,
    sentToKitchen: settings.autoAcceptOrders,
    session: await getGuestSession(token),
  };
}

/**
 * Sends a request from the table (call waiter, water, napkins, bill…).
 * Asking again for something still open returns the same request.
 *
 * @param token - The session token.
 * @param input - The request type and optional note.
 * @returns The request and whether it was new.
 * @throws QrServiceError If requests are turned off or the session has ended.
 */
export async function createServiceRequest(token: string, input: CreateServiceRequestInput) {
  const session = await getLiveSession(token);
  const settings = await getSettings(prisma, session.branchId);
  const type = SERVICE_REQUEST_TYPE_FROM_API[input.type];

  if (!settings.serviceRequestsEnabled && type !== ServiceRequestType.BILL) {
    throw new QrServiceError(
      QrServiceErrorCode.SERVICE_REQUESTS_DISABLED,
      "Requests from the table are turned off. Please call a waiter.",
    );
  }

  const select = { id: true, type: true, status: true, note: true, createdAt: true, acknowledgedAt: true, resolvedAt: true } as const;

  const existing = await prisma.serviceRequest.findFirst({
    where: { sessionId: session.id, type, status: { not: ServiceRequestStatus.RESOLVED } },
    select,
  });

  if (existing) {
    return { created: false, request: serializeRequest(existing) };
  }

  const now = new Date();
  const [request] = await prisma.$transaction([
    prisma.serviceRequest.create({
      data: {
        organizationId: session.organizationId,
        branchId: session.branchId,
        sessionId: session.id,
        tableId: session.tableId,
        type,
        note: input.note ?? null,
      },
      select,
    }),
    prisma.tableSession.update({
      where: { id: session.id },
      data: {
        lastActivityAt: now,
        ...(type === ServiceRequestType.BILL && { billRequestedAt: now }),
      },
    }),
  ]);

  publishQrEvent(session.branchId, QrEventName.SERVICE_REQUEST, {
    requestId: request.id,
    sessionId: session.id,
    table: session.table,
    type: request.type.toLowerCase(),
    label: SERVICE_REQUEST_LABELS[type],
    note: request.note,
  });

  return { created: true, request: serializeRequest(request) };
}

// ─── Staff APIs ─────────────────────────────────────────────────────────

/**
 * Throws unless the staff member can access the branch.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @throws QrServiceError If the branch is not accessible.
 */
function assertBranchAccess(actor: QrActor, branchId: string): void {
  if (!actor.branchIds.includes(branchId)) {
    throw new QrServiceError(QrServiceErrorCode.BRANCH_ACCESS_DENIED, "Access denied for this branch");
  }
}

/**
 * Closes the branch's open sessions that have ended on their own (order
 * settled or cancelled, or idle with no order), so live lists stay clean.
 *
 * @param branchId - The branch ID.
 */
async function closeEndedSessions(branchId: string): Promise<void> {
  const open = await prisma.tableSession.findMany({
    where: { branchId, status: TableSessionStatus.OPEN },
    select: { id: true, orderId: true, lastActivityAt: true },
  });

  for (const session of open) {
    const endedReason = await getEndedReason(prisma, session);

    if (endedReason) {
      await closeSessionInTx(prisma, session.id, endedReason, null);
    }
  }
}

/**
 * Lists a branch's table sessions (live tables by default) with what each
 * needs: rounds waiting to be accepted, open requests and the bill.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param query - Status and pagination.
 * @returns The sessions and pagination metadata.
 */
export async function listTableSessions(actor: QrActor, branchId: string, query: ListTableSessionsQuery) {
  assertBranchAccess(actor, branchId);

  if (query.status === "open") {
    await closeEndedSessions(branchId);
  }

  const where = {
    branchId,
    organizationId: actor.organizationId,
    status: query.status === "open" ? TableSessionStatus.OPEN : TableSessionStatus.CLOSED,
  };

  const [sessions, total] = await Promise.all([
    prisma.tableSession.findMany({
      where,
      orderBy: query.status === "open" ? { openedAt: "asc" } : { closedAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        ...sessionSelect,
        _count: {
          select: {
            qrOrders: { where: { status: QrOrderStatus.PENDING } },
            requests: { where: { status: { not: ServiceRequestStatus.RESOLVED } } },
          },
        },
      },
    }),
    prisma.tableSession.count({ where }),
  ]);

  const orders = await prisma.order.findMany({
    where: { id: { in: sessions.flatMap((session) => (session.orderId ? [session.orderId] : [])) } },
    select: { id: true, orderNumber: true, status: true, totalAmount: true, amountPaid: true },
  });
  const orderById = new Map(orders.map((order) => [order.id, order]));

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    sessions: sessions.map(({ _count, ...session }) => {
      const order = session.orderId ? orderById.get(session.orderId) : undefined;

      return {
        sessionId: session.id,
        status: session.status.toLowerCase(),
        table: session.table,
        guestName: session.guestName,
        guestPhone: session.guestPhone,
        deviceCount: session.deviceCount,
        openedAt: session.openedAt,
        lastActivityAt: session.lastActivityAt,
        closedAt: session.closedAt,
        closeReason: session.closeReason,
        billRequestedAt: session.billRequestedAt,
        pendingOrders: _count.qrOrders,
        openRequests: _count.requests,
        order: order
          ? {
              id: order.id,
              orderNumber: order.orderNumber,
              status: order.status.toLowerCase(),
              total: order.totalAmount.toNumber(),
              due: roundMoney(Math.max(order.totalAmount.toNumber() - order.amountPaid.toNumber(), 0)),
            }
          : null,
      };
    }),
  };
}

/**
 * Loads a session of the staff member's branches.
 *
 * @param actor - The staff member.
 * @param sessionId - The session ID.
 * @returns The session, or null if not found.
 */
async function findStaffSession(actor: QrActor, sessionId: string) {
  return prisma.tableSession.findFirst({
    where: { id: sessionId, organizationId: actor.organizationId, branchId: { in: actor.branchIds } },
    select: sessionSelect,
  });
}

/**
 * Retrieves a table session with its rounds, order, bill and requests,
 * plus the guest's phone and profile link (staff only).
 *
 * @param actor - The staff member.
 * @param sessionId - The session ID.
 * @returns The session view, or null if not found.
 */
export async function getTableSession(actor: QrActor, sessionId: string) {
  const session = await findStaffSession(actor, sessionId);

  if (!session) {
    return null;
  }

  return {
    ...(await buildSessionView(session)),
    guestPhone: session.guestPhone,
    guestId: session.guestId,
    deviceCount: session.deviceCount,
    lastActivityAt: session.lastActivityAt,
  };
}

/**
 * Closes a table session when the guests leave. Blocked while the table's
 * order is unpaid ("Safe Clear Table Guard"): settle or cancel it first.
 *
 * @param actor - The staff member.
 * @param sessionId - The session ID.
 * @param reason - Optional reason.
 * @returns The closed session, or null if not found.
 * @throws QrServiceError If it's already closed or the order is unpaid.
 */
export async function closeTableSession(actor: QrActor, sessionId: string, reason: string | undefined) {
  const session = await findStaffSession(actor, sessionId);

  if (!session) {
    return null;
  }

  if (session.status === TableSessionStatus.CLOSED) {
    throw new QrServiceError(QrServiceErrorCode.SESSION_CLOSED, "This table session is already closed");
  }

  if (session.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: session.orderId },
      select: { status: true, totalAmount: true, amountPaid: true },
    });

    if (order && (order.status === OrderStatus.OPEN || order.status === OrderStatus.BILLED)) {
      const due = roundMoney(order.totalAmount.toNumber() - order.amountPaid.toNumber());

      throw new QrServiceError(
        QrServiceErrorCode.SESSION_HAS_UNPAID_BILL,
        `This table still has an unpaid order (₹${due.toFixed(2)} due). Settle or cancel it first.`,
      );
    }
  }

  await prisma.$transaction((tx) => closeSessionInTx(tx, session.id, reason ?? "Closed by staff", actor.userId));

  publishQrEvent(session.branchId, QrEventName.SESSION_CLOSED, { sessionId: session.id, table: session.table });

  return getTableSession(actor, session.id);
}

/**
 * Serializes a QR round for staff, with the table and guest.
 *
 * @param round - The round with its session.
 * @returns The round view.
 */
function serializeStaffRound(round: {
  id: string;
  roundNumber: number;
  status: string;
  items: unknown;
  itemCount: number;
  estimatedTotal: DecimalValue;
  note: string | null;
  allergyNote: string | null;
  rejectReason: string | null;
  orderId: string | null;
  kotId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: { id: string; name: string } | null;
  session: { id: string; guestName: string | null; table: { id: string; name: string } };
}) {
  const { session, items, estimatedTotal, ...data } = round;

  return {
    ...data,
    status: round.status.toLowerCase(),
    estimatedTotal: estimatedTotal.toNumber(),
    sessionId: session.id,
    table: session.table,
    guestName: session.guestName,
    items: items as QrLine[],
  };
}

const staffRoundSelect = {
  id: true,
  roundNumber: true,
  status: true,
  items: true,
  itemCount: true,
  estimatedTotal: true,
  note: true,
  allergyNote: true,
  rejectReason: true,
  orderId: true,
  kotId: true,
  createdAt: true,
  decidedAt: true,
  decidedBy: { select: { id: true, name: true } },
  session: { select: { id: true, guestName: true, table: { select: { id: true, name: true } } } },
} as const;

/**
 * Lists a branch's QR rounds — by default those waiting for a staff member
 * to accept (when auto-accept is off).
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param query - Status and pagination.
 * @returns The rounds and pagination metadata.
 */
export async function listQrOrders(actor: QrActor, branchId: string, query: ListQrOrdersQuery) {
  assertBranchAccess(actor, branchId);

  const where = {
    branchId,
    organizationId: actor.organizationId,
    status: QR_ORDER_STATUS_FROM_API[query.status],
  };

  const [rounds, total] = await Promise.all([
    prisma.qrOrder.findMany({
      where,
      orderBy: { createdAt: query.status === "pending" ? "asc" : "desc" },
      take: query.limit,
      skip: query.offset,
      select: staffRoundSelect,
    }),
    prisma.qrOrder.count({ where }),
  ]);

  return { total, limit: query.limit, offset: query.offset, orders: rounds.map(serializeStaffRound) };
}

/**
 * Loads a pending QR round of the staff member's branches with its session.
 *
 * @param actor - The staff member.
 * @param qrOrderId - The round ID.
 * @returns The round, or null if not found.
 * @throws QrServiceError If it was already accepted or rejected.
 */
async function findPendingRound(actor: QrActor, qrOrderId: string) {
  const round = await prisma.qrOrder.findFirst({
    where: { id: qrOrderId, organizationId: actor.organizationId, branchId: { in: actor.branchIds } },
    select: {
      id: true,
      status: true,
      items: true,
      note: true,
      allergyNote: true,
      session: { select: sessionSelect },
    },
  });

  if (round && round.status !== QrOrderStatus.PENDING) {
    throw new QrServiceError(
      QrServiceErrorCode.QR_ORDER_ALREADY_DECIDED,
      `This order was already ${round.status.toLowerCase()}`,
    );
  }

  return round;
}

/**
 * Accepts a waiting QR round: it's added to the table's order and sent to
 * the kitchen on a KOT, recorded as accepted by this staff member.
 *
 * @param actor - The staff member.
 * @param qrOrderId - The round ID.
 * @returns The accepted round, or null if not found.
 * @throws QrServiceError If it was already decided or the session has ended.
 */
export async function acceptQrOrder(actor: QrActor, qrOrderId: string) {
  const round = await findPendingRound(actor, qrOrderId);

  if (!round) {
    return null;
  }

  if (round.session.status !== TableSessionStatus.OPEN) {
    throw new QrServiceError(QrServiceErrorCode.SESSION_CLOSED, "This table session has already ended");
  }

  const kotId = await runOrderTransaction(async (tx) => {
    // Claim the round so two staff members can't accept it twice.
    const claimed = await tx.qrOrder.updateMany({
      where: { id: round.id, status: QrOrderStatus.PENDING },
      data: { decidedAt: new Date(), decidedById: actor.userId },
    });

    if (claimed.count === 0) {
      throw new QrServiceError(QrServiceErrorCode.QR_ORDER_ALREADY_DECIDED, "This order was already handled");
    }

    return sendRoundToKitchenInTx(
      tx,
      round.session,
      { id: round.id, lines: round.items as unknown as QrLine[], note: round.note, allergyNote: round.allergyNote },
      actor.userId,
    );
  });

  if (kotId) {
    await publishKotTicketsCreated(kotId);
  }

  const accepted = await prisma.qrOrder.findUniqueOrThrow({ where: { id: round.id }, select: staffRoundSelect });

  return serializeStaffRound(accepted);
}

/**
 * Rejects a waiting QR round; the guest sees it as rejected with the reason.
 *
 * @param actor - The staff member.
 * @param qrOrderId - The round ID.
 * @param reason - Why it was rejected.
 * @returns The rejected round, or null if not found.
 * @throws QrServiceError If it was already decided.
 */
export async function rejectQrOrder(actor: QrActor, qrOrderId: string, reason: string) {
  const round = await findPendingRound(actor, qrOrderId);

  if (!round) {
    return null;
  }

  const updated = await prisma.qrOrder.updateMany({
    where: { id: round.id, status: QrOrderStatus.PENDING },
    data: { status: QrOrderStatus.REJECTED, rejectReason: reason, decidedAt: new Date(), decidedById: actor.userId },
  });

  if (updated.count === 0) {
    throw new QrServiceError(QrServiceErrorCode.QR_ORDER_ALREADY_DECIDED, "This order was already handled");
  }

  const rejected = await prisma.qrOrder.findUniqueOrThrow({ where: { id: round.id }, select: staffRoundSelect });

  return serializeStaffRound(rejected);
}

const staffRequestSelect = {
  id: true,
  type: true,
  status: true,
  note: true,
  createdAt: true,
  acknowledgedAt: true,
  resolvedAt: true,
  acknowledgedBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
  session: { select: { id: true, guestName: true, table: { select: { id: true, name: true } } } },
} as const;

/**
 * Serializes a service request for staff, with its table.
 *
 * @param request - The request with its session.
 * @returns The request view.
 */
function serializeStaffRequest(request: {
  id: string;
  type: string;
  status: string;
  note: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  acknowledgedBy: { id: string; name: string } | null;
  resolvedBy: { id: string; name: string } | null;
  session: { id: string; guestName: string | null; table: { id: string; name: string } };
}) {
  const { session, acknowledgedBy, resolvedBy, ...data } = request;

  return {
    ...serializeRequest(data),
    acknowledgedBy,
    resolvedBy,
    sessionId: session.id,
    table: session.table,
    guestName: session.guestName,
  };
}

/**
 * Lists a branch's table requests — by default the ones still being handled.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param query - Status and pagination.
 * @returns The requests and pagination metadata.
 */
export async function listServiceRequests(actor: QrActor, branchId: string, query: ListServiceRequestsQuery) {
  assertBranchAccess(actor, branchId);

  const status =
    query.status === "active"
      ? { in: [ServiceRequestStatus.OPEN, ServiceRequestStatus.ACKNOWLEDGED] }
      : (query.status.toUpperCase() as ServiceRequestStatus);

  const where = { branchId, organizationId: actor.organizationId, status };

  const [requests, total] = await Promise.all([
    prisma.serviceRequest.findMany({
      where,
      orderBy: { createdAt: query.status === "resolved" ? "desc" : "asc" },
      take: query.limit,
      skip: query.offset,
      select: staffRequestSelect,
    }),
    prisma.serviceRequest.count({ where }),
  ]);

  return { total, limit: query.limit, offset: query.offset, requests: requests.map(serializeStaffRequest) };
}

/**
 * Marks a table request as seen ("on my way") or done.
 *
 * @param actor - The staff member.
 * @param requestId - The request ID.
 * @param resolve - True to mark it done, false to acknowledge it.
 * @returns The updated request, or null if not found.
 */
export async function updateServiceRequest(actor: QrActor, requestId: string, resolve: boolean) {
  const request = await prisma.serviceRequest.findFirst({
    where: { id: requestId, organizationId: actor.organizationId, branchId: { in: actor.branchIds } },
    select: { id: true, status: true },
  });

  if (!request) {
    return null;
  }

  const now = new Date();

  if (resolve && request.status !== ServiceRequestStatus.RESOLVED) {
    await prisma.serviceRequest.update({
      where: { id: request.id },
      data: {
        status: ServiceRequestStatus.RESOLVED,
        resolvedAt: now,
        resolvedById: actor.userId,
        ...(request.status === ServiceRequestStatus.OPEN && { acknowledgedAt: now, acknowledgedById: actor.userId }),
      },
    });
  } else if (!resolve && request.status === ServiceRequestStatus.OPEN) {
    await prisma.serviceRequest.update({
      where: { id: request.id },
      data: { status: ServiceRequestStatus.ACKNOWLEDGED, acknowledgedAt: now, acknowledgedById: actor.userId },
    });
  }

  const updated = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id }, select: staffRequestSelect });

  return serializeStaffRequest(updated);
}

/**
 * Retrieves a branch's QR ordering settings.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @returns The settings.
 */
export async function getQrSettings(actor: QrActor, branchId: string) {
  assertBranchAccess(actor, branchId);

  return { branchId, ...(await getSettings(prisma, branchId)) };
}

/**
 * Updates a branch's QR ordering settings.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param input - The settings to change.
 * @returns The updated settings.
 * @throws QrServiceError If the branch isn't found.
 */
export async function updateQrSettings(actor: QrActor, branchId: string, input: UpdateQrSettingsInput) {
  assertBranchAccess(actor, branchId);

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, organizationId: actor.organizationId },
    select: { id: true },
  });

  if (!branch) {
    throw new QrServiceError(QrServiceErrorCode.BRANCH_NOT_FOUND, "Branch not found");
  }

  return prisma.qrSettings.upsert({
    where: { branchId: branch.id },
    create: { branchId: branch.id, ...input },
    update: input,
    select: {
      branchId: true,
      orderingEnabled: true,
      autoAcceptOrders: true,
      requireGuestPhone: true,
      serviceRequestsEnabled: true,
      updatedAt: true,
    },
  });
}

/**
 * Checks whether an unknown value is a QR service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value is a QrServiceError with a known code.
 */
export function isQrServiceError(error: unknown): error is QrServiceError {
  return (
    error instanceof QrServiceError &&
    Object.values(QrServiceErrorCode).includes(error.code)
  );
}
