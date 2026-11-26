import { db as prisma } from "../../plugins/db.js";
import type {
  BumpKitchenTicketInput,
  ListKitchenTicketsQuery,
} from "@morfikos/validation";

import { KitchenServiceErrorCode } from "@morfikos/auth";

import { KotStatus, OrderItemStatus } from "../orders/constants.js";
import {
  ACTIVE_TICKET_STATUSES,
  COOKING_TICKET_STATUSES,
  DEFAULT_KITCHEN_STATION,
  DEFAULT_PREP_MINUTES,
  KITCHEN_STATION_LABELS,
  KitchenEventName,
  KitchenTicketStatus,
  LATE_CHECK_INTERVAL_MS,
  TICKET_STATUS_FROM_API,
} from "./constants.js";
import {
  getSubscribedBranchIds,
  publishKitchenEvent,
  subscribeKitchenEvents,
  type KitchenEvent,
} from "./events.js";


/** The Prisma client available inside an interactive transaction. */
export type TransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

const MS_PER_MINUTE = 60 * 1000;

/**
 * Represents errors that can occur during kitchen operations.
 */
export class KitchenServiceError extends Error {
  /**
   * Creates a kitchen service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: KitchenServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KitchenServiceError";
  }
}

/**
 * Fields needed to show a kitchen ticket on the KDS.
 */
const ticketSelect = {
  id: true,
  branchId: true,
  orderId: true,
  kotId: true,
  station: true,
  status: true,
  startedAt: true,
  readyAt: true,
  bumpedAt: true,
  createdAt: true,
  kot: { select: { kotNumber: true, roundNo: true } },
  order: {
    select: {
      orderNumber: true,
      orderType: true,
      tableId: true,
      customerName: true,
      note: true,
      allergyNote: true,
      createdAt: true,
      table: { select: { name: true } },
    },
  },
  items: {
    where: { status: { not: OrderItemStatus.VOID } },
    orderBy: { lineNumber: "asc" },
    select: {
      id: true,
      name: true,
      variantName: true,
      addons: true,
      quantity: true,
      note: true,
      kitchenReadyAt: true,
      menuItem: { select: { preparationTime: true, allergens: true } },
    },
  },
} as const;

/**
 * Returns a station's display name.
 *
 * @param station - The station key, e.g. "hot_kitchen".
 * @returns The display name, e.g. "Hot Kitchen".
 */
function getStationName(station: string): string {
  return (
    KITCHEN_STATION_LABELS[station] ??
    station.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
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
      typeof addon === "object" && addon !== null && "name" in addon ? addon.name : null,
    )
    .filter((name): name is string => typeof name === "string");
}

/**
 * Returns when a ticket is expected to be ready: its creation time plus the
 * longest preparation time of its items (or the default prep time).
 *
 * @param createdAt - When the ticket reached the kitchen.
 * @param prepTimes - Item preparation times in minutes (null when unknown).
 * @returns The expected ready time.
 */
function getExpectedReadyAt(createdAt: Date, prepTimes: Array<number | null>): Date {
  const known = prepTimes.filter((minutes): minutes is number => minutes !== null);
  const prepMinutes = known.length > 0 ? Math.max(...known) : DEFAULT_PREP_MINUTES;

  return new Date(createdAt.getTime() + prepMinutes * MS_PER_MINUTE);
}

/**
 * Serializes a ticket for the KDS: items with readiness and allergens,
 * table, channel, round and whether it is late.
 *
 * @param ticket - A ticket selected with {@link ticketSelect}.
 * @param now - The current time, used for the late flag.
 * @returns The ticket as returned by the API and the live stream.
 */
function serializeTicket<
  T extends {
    status: string;
    station: string;
    createdAt: Date;
    kot: { kotNumber: number; roundNo: number };
    order: {
      orderNumber: string;
      orderType: string;
      tableId: string | null;
      customerName: string | null;
      note: string | null;
      allergyNote: string | null;
      createdAt: Date;
      table: { name: string } | null;
    };
    items: Array<{
      id: string;
      name: string;
      variantName: string | null;
      addons: unknown;
      quantity: number;
      note: string | null;
      kitchenReadyAt: Date | null;
      menuItem: { preparationTime: number | null; allergens: string[] } | null;
    }>;
  },
>(ticket: T, now: number = Date.now()) {
  const { kot, order, items, status, station, ...ticketData } = ticket;
  const expectedReadyAt = getExpectedReadyAt(
    ticket.createdAt,
    items.map((item) => item.menuItem?.preparationTime ?? null),
  );
  const isCooking = COOKING_TICKET_STATUSES.some((cooking) => cooking === status);

  return {
    ...ticketData,
    kotNumber: kot.kotNumber,
    roundNo: kot.roundNo,
    orderNumber: order.orderNumber,
    tableId: order.tableId,
    tableName: order.table?.name ?? null,
    channel: order.orderType.toLowerCase(),
    customerName: order.customerName,
    station,
    stationName: getStationName(station),
    status: status.toLowerCase(),
    items: items.map((item, index) => ({
      index,
      id: item.id,
      name: item.name,
      variantName: item.variantName,
      addons: getAddonNames(item.addons),
      qty: item.quantity,
      note: item.note,
      allergens: item.menuItem?.allergens ?? [],
      ready: item.kitchenReadyAt !== null,
      readyAt: item.kitchenReadyAt,
    })),
    allergyNote: order.allergyNote,
    orderNote: order.note,
    placedAt: order.createdAt,
    expectedReadyAt,
    late: isCooking && now > expectedReadyAt.getTime(),
  };
}

/** A kitchen ticket as returned by the API. */
export type KitchenTicketView = ReturnType<typeof serializeTicket>;

/**
 * Loads one ticket's KDS view.
 *
 * @param ticketId - The ticket ID.
 * @returns The ticket view, or null if it no longer exists.
 */
async function loadTicketView(ticketId: string): Promise<KitchenTicketView | null> {
  const ticket = await prisma.kitchenTicket.findUnique({
    where: { id: ticketId },
    select: ticketSelect,
  });

  return ticket ? serializeTicket(ticket) : null;
}

/**
 * Checks that a branch belongs to the organization and is active.
 *
 * @param branchId - The branch ID.
 * @param organizationId - The organization ID.
 * @throws KitchenServiceError If the branch is not found.
 */
export async function assertKitchenBranch(branchId: string, organizationId: string) {
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, organizationId, status: "active" },
    select: { id: true },
  });

  if (!branch) {
    throw new KitchenServiceError(
      KitchenServiceErrorCode.BRANCH_NOT_FOUND,
      "Active branch not found",
    );
  }
}

/**
 * Lists a branch's kitchen tickets, oldest first, grouped by station.
 * Without a status filter, returns every ticket still on the board.
 *
 * @param branchId - The branch ID.
 * @param organizationId - The organization ID.
 * @param query - Validated filters and pagination.
 * @returns The total, and the stations with their ticket counts and tickets.
 * @throws KitchenServiceError If the branch is not found.
 */
export async function listKitchenTickets(
  branchId: string,
  organizationId: string,
  query: ListKitchenTicketsQuery,
) {
  await assertKitchenBranch(branchId, organizationId);

  const where = {
    branchId,
    status:
      query.status !== undefined
        ? TICKET_STATUS_FROM_API[query.status]
        : { in: ACTIVE_TICKET_STATUSES },
    ...(query.station !== undefined && { station: query.station }),
  };

  const [tickets, stationCounts] = await Promise.all([
    prisma.kitchenTicket.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: query.limit,
      skip: query.offset,
      select: ticketSelect,
    }),
    prisma.kitchenTicket.groupBy({
      by: ["station"],
      where,
      _count: { _all: true },
    }),
  ]);

  const now = Date.now();
  const serialized = tickets.map((ticket) => serializeTicket(ticket, now));

  const stations = stationCounts
    .map((entry) => ({
      station: entry.station,
      name: getStationName(entry.station),
      totalTickets: entry._count._all,
      tickets: serialized.filter((ticket) => ticket.station === entry.station),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    total: stationCounts.reduce((sum, entry) => sum + entry._count._all, 0),
    limit: query.limit,
    offset: query.offset,
    stations,
  };
}

/**
 * Retrieves one kitchen ticket.
 *
 * @param ticketId - The ticket ID.
 * @param organizationId - The organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The ticket, or null if not found or not accessible.
 */
export async function getKitchenTicket(
  ticketId: string,
  organizationId: string,
  branchIds: string[],
) {
  const ticket = await prisma.kitchenTicket.findFirst({
    where: { id: ticketId, branchId: { in: branchIds }, branch: { organizationId } },
    select: ticketSelect,
  });

  return ticket ? serializeTicket(ticket) : null;
}

/**
 * Recomputes a KOT's status from its station tickets, so the order view
 * shows overall kitchen progress.
 *
 * @param tx - The transaction client.
 * @param kotId - The KOT ID.
 */
async function syncKotStatus(tx: TransactionClient, kotId: string) {
  const tickets = await tx.kitchenTicket.findMany({
    where: { kotId },
    select: { status: true },
  });

  const statuses = tickets
    .map((ticket) => ticket.status)
    .filter((status) => status !== KitchenTicketStatus.CANCELLED);

  let kotStatus: KotStatus;

  if (statuses.length === 0) {
    kotStatus = KotStatus.CANCELLED;
  } else if (statuses.every((status) => status === KitchenTicketStatus.SERVED)) {
    kotStatus = KotStatus.SERVED;
  } else if (
    statuses.every(
      (status) =>
        status === KitchenTicketStatus.READY || status === KitchenTicketStatus.SERVED,
    )
  ) {
    kotStatus = KotStatus.READY;
  } else if (statuses.some((status) => status !== KitchenTicketStatus.OPEN)) {
    kotStatus = KotStatus.PREPARING;
  } else {
    kotStatus = KotStatus.PENDING;
  }

  await tx.kot.update({ where: { id: kotId }, data: { status: kotStatus } });
}

/**
 * Bumps a ticket. With `itemIndex`, marks that item ready; the ticket turns
 * ready when every item is. Without it, moves the ticket to its next status:
 * open → in progress → ready → served. Changes are pushed to live screens.
 *
 * @param ticketId - The ticket ID.
 * @param organizationId - The organization ID.
 * @param branchIds - The branches the user can access.
 * @param input - The validated bump request.
 * @returns The updated ticket, or null if not found.
 * @throws KitchenServiceError If the ticket is closed or the item index is invalid.
 */
export async function bumpKitchenTicket(
  ticketId: string,
  organizationId: string,
  branchIds: string[],
  input: BumpKitchenTicketInput,
) {
  const ticket = await prisma.kitchenTicket.findFirst({
    where: { id: ticketId, branchId: { in: branchIds }, branch: { organizationId } },
    select: {
      id: true,
      branchId: true,
      kotId: true,
      status: true,
      startedAt: true,
      items: {
        where: { status: { not: OrderItemStatus.VOID } },
        orderBy: { lineNumber: "asc" },
        select: { id: true, kitchenReadyAt: true },
      },
    },
  });

  if (!ticket) {
    return null;
  }

  if (
    ticket.status === KitchenTicketStatus.SERVED ||
    ticket.status === KitchenTicketStatus.CANCELLED
  ) {
    throw new KitchenServiceError(
      KitchenServiceErrorCode.TICKET_CLOSED,
      `This ticket is already ${ticket.status.toLowerCase()}`,
    );
  }

  const now = new Date();
  let nextStatus = ticket.status as KitchenTicketStatus;
  let readyItemIds: string[] = [];

  if (input.itemIndex !== undefined) {
    const item = ticket.items[input.itemIndex];

    if (!item) {
      throw new KitchenServiceError(
        KitchenServiceErrorCode.INVALID_ITEM_INDEX,
        `Item ${input.itemIndex} does not exist on this ticket`,
      );
    }

    readyItemIds = item.kitchenReadyAt ? [] : [item.id];

    const allReady = ticket.items.every(
      (entry) => entry.kitchenReadyAt !== null || entry.id === item.id,
    );

    if (allReady) {
      nextStatus = KitchenTicketStatus.READY;
    } else if (ticket.status === KitchenTicketStatus.OPEN) {
      nextStatus = KitchenTicketStatus.IN_PROGRESS;
    }
  } else if (ticket.status === KitchenTicketStatus.OPEN) {
    nextStatus = KitchenTicketStatus.IN_PROGRESS;
  } else if (ticket.status === KitchenTicketStatus.IN_PROGRESS) {
    nextStatus = KitchenTicketStatus.READY;
    readyItemIds = ticket.items
      .filter((entry) => entry.kitchenReadyAt === null)
      .map((entry) => entry.id);
  } else {
    nextStatus = KitchenTicketStatus.SERVED;
  }

  const statusChanged = nextStatus !== ticket.status;

  await prisma.$transaction(async (tx) => {
    if (readyItemIds.length > 0) {
      await tx.orderItem.updateMany({
        where: { id: { in: readyItemIds }, kitchenReadyAt: null },
        data: { kitchenReadyAt: now },
      });
    }

    if (statusChanged) {
      // Guarded by the current status so two screens can't double-bump.
      await tx.kitchenTicket.updateMany({
        where: { id: ticket.id, status: ticket.status },
        data: {
          status: nextStatus,
          ...(ticket.startedAt === null && { startedAt: now }),
          ...(nextStatus === KitchenTicketStatus.READY && { readyAt: now }),
          ...(nextStatus === KitchenTicketStatus.SERVED && { bumpedAt: now }),
        },
      });

      await syncKotStatus(tx, ticket.kotId);
    }
  });

  const view = await loadTicketView(ticket.id);

  if (view) {
    publishKitchenEvent(ticket.branchId, {
      event: statusChanged
        ? KitchenEventName.TICKET_STATUS_CHANGED
        : KitchenEventName.TICKET_UPDATED,
      data: statusChanged
        ? {
            ticketId: view.id,
            orderId: view.orderId,
            station: view.station,
            status: view.status,
            readyAt: view.readyAt,
            bumpedAt: view.bumpedAt,
            ticket: view,
          }
        : { ticket: view },
    });
  }

  return view;
}

/**
 * Creates one kitchen ticket per station for a newly sent KOT and links
 * each item to its station's ticket. Used by the orders module.
 *
 * @param tx - The transaction client.
 * @param kot - The KOT, its order and branch.
 * @param items - The KOT's items with their kitchen station.
 * @returns The created ticket IDs.
 */
export async function createKitchenTicketsForKot(
  tx: TransactionClient,
  kot: { id: string; orderId: string; branchId: string },
  items: Array<{ id: string; kitchenStation: string | null }>,
): Promise<string[]> {
  const itemsByStation = new Map<string, string[]>();

  for (const item of items) {
    const station = item.kitchenStation ?? DEFAULT_KITCHEN_STATION;
    itemsByStation.set(station, [...(itemsByStation.get(station) ?? []), item.id]);
  }

  const ticketIds: string[] = [];

  for (const [station, itemIds] of itemsByStation) {
    const ticket = await tx.kitchenTicket.create({
      data: { branchId: kot.branchId, orderId: kot.orderId, kotId: kot.id, station },
      select: { id: true },
    });

    await tx.orderItem.updateMany({
      where: { id: { in: itemIds } },
      data: { kitchenTicketId: ticket.id },
    });

    ticketIds.push(ticket.id);
  }

  return ticketIds;
}

/**
 * Cancels an order's tickets that the kitchen has not finished. Used by
 * the orders module when an order is cancelled.
 *
 * @param tx - The transaction client.
 * @param orderId - The order ID.
 * @returns The cancelled ticket IDs.
 */
export async function cancelOrderKitchenTickets(
  tx: TransactionClient,
  orderId: string,
): Promise<string[]> {
  const tickets = await tx.kitchenTicket.findMany({
    where: { orderId, status: { in: COOKING_TICKET_STATUSES } },
    select: { id: true },
  });

  if (tickets.length > 0) {
    await tx.kitchenTicket.updateMany({
      where: { id: { in: tickets.map((ticket) => ticket.id) } },
      data: { status: KitchenTicketStatus.CANCELLED },
    });
  }

  return tickets.map((ticket) => ticket.id);
}

/**
 * Cancels a ticket when all of its items were voided, and keeps the KOT
 * status in step. Used by the orders module after voiding an item.
 *
 * @param tx - The transaction client.
 * @param ticketId - The ticket ID.
 */
export async function cancelKitchenTicketIfEmpty(
  tx: TransactionClient,
  ticketId: string,
): Promise<void> {
  const ticket = await tx.kitchenTicket.findUnique({
    where: { id: ticketId },
    select: {
      kotId: true,
      status: true,
      _count: { select: { items: { where: { status: { not: OrderItemStatus.VOID } } } } },
    },
  });

  if (!ticket || ticket._count.items > 0) {
    return;
  }

  if (COOKING_TICKET_STATUSES.some((status) => status === ticket.status)) {
    await tx.kitchenTicket.update({
      where: { id: ticketId },
      data: { status: KitchenTicketStatus.CANCELLED },
    });
    await syncKotStatus(tx, ticket.kotId);
  }
}

/**
 * Pushes events for tickets to their branch's live screens. Never throws:
 * a failed push must not fail the order operation that caused it.
 *
 * @param ticketIds - The ticket IDs.
 * @param eventName - The event to send.
 */
async function publishTicketEvents(ticketIds: string[], eventName: KitchenEventName) {
  for (const ticketId of ticketIds) {
    try {
      const view = await loadTicketView(ticketId);

      if (!view) {
        continue;
      }

      const event: KitchenEvent =
        eventName === KitchenEventName.TICKET_STATUS_CHANGED
          ? {
              event: eventName,
              data: {
                ticketId: view.id,
                orderId: view.orderId,
                station: view.station,
                status: view.status,
                ticket: view,
              },
            }
          : { event: eventName, data: { ticket: view } };

      publishKitchenEvent(view.branchId, event);
    } catch {
      // Screens resync from the list API; a missed push is not fatal.
    }
  }
}

/**
 * Pushes `ticket_created` for every ticket of a newly sent KOT.
 *
 * @param kotId - The KOT ID.
 */
export async function publishKotTicketsCreated(kotId: string): Promise<void> {
  try {
    const tickets = await prisma.kitchenTicket.findMany({
      where: { kotId },
      select: { id: true },
    });

    await publishTicketEvents(
      tickets.map((ticket) => ticket.id),
      KitchenEventName.TICKET_CREATED,
    );
  } catch {
    // Screens resync from the list API; a missed push is not fatal.
  }
}

/**
 * Pushes `ticket_status_changed` for tickets cancelled with their order.
 *
 * @param ticketIds - The cancelled ticket IDs.
 */
export async function publishTicketsCancelled(ticketIds: string[]): Promise<void> {
  await publishTicketEvents(ticketIds, KitchenEventName.TICKET_STATUS_CHANGED);
}

/**
 * Pushes `ticket_updated` for a ticket whose items changed (e.g. a void).
 *
 * @param ticketId - The ticket ID.
 */
export async function publishTicketUpdated(ticketId: string): Promise<void> {
  await publishTicketEvents([ticketId], KitchenEventName.TICKET_UPDATED);
}

let lateMonitor: NodeJS.Timeout | null = null;

/**
 * Finds cooking tickets that just passed their expected ready time on
 * branches with a connected screen, marks them as notified and pushes
 * `order_late` once per ticket.
 */
async function checkLateTickets(): Promise<void> {
  const branchIds = getSubscribedBranchIds();

  if (branchIds.length === 0) {
    stopLateMonitor();
    return;
  }

  const candidates = await prisma.kitchenTicket.findMany({
    where: {
      branchId: { in: branchIds },
      status: { in: COOKING_TICKET_STATUSES },
      lateNotifiedAt: null,
    },
    select: {
      id: true,
      branchId: true,
      orderId: true,
      station: true,
      createdAt: true,
      items: {
        where: { status: { not: OrderItemStatus.VOID } },
        select: { menuItem: { select: { preparationTime: true } } },
      },
    },
  });

  const now = Date.now();
  const lateTickets = candidates.filter(
    (ticket) =>
      now >
      getExpectedReadyAt(
        ticket.createdAt,
        ticket.items.map((item) => item.menuItem?.preparationTime ?? null),
      ).getTime(),
  );

  if (lateTickets.length === 0) {
    return;
  }

  await prisma.kitchenTicket.updateMany({
    where: { id: { in: lateTickets.map((ticket) => ticket.id) } },
    data: { lateNotifiedAt: new Date(now) },
  });

  for (const ticket of lateTickets) {
    publishKitchenEvent(ticket.branchId, {
      event: KitchenEventName.ORDER_LATE,
      data: {
        ticketId: ticket.id,
        orderId: ticket.orderId,
        station: ticket.station,
        late: true,
      },
    });
  }
}

/**
 * Stops the late-ticket check.
 */
function stopLateMonitor(): void {
  if (lateMonitor) {
    clearInterval(lateMonitor);
    lateMonitor = null;
  }
}

/**
 * Starts the late-ticket check if it is not running. It stops by itself
 * once no kitchen screen is connected.
 */
function ensureLateMonitor(): void {
  if (lateMonitor) {
    return;
  }

  lateMonitor = setInterval(() => {
    checkLateTickets().catch(() => {
      // A failed check is retried on the next interval.
    });
  }, LATE_CHECK_INTERVAL_MS);

  // Don't keep the process alive just for this timer.
  lateMonitor.unref();
}

/**
 * Connects a kitchen screen to a branch's live events.
 *
 * @param branchId - The branch ID.
 * @param listener - Called for every kitchen event of the branch.
 * @returns A function that disconnects the screen.
 */
export function openKitchenStream(
  branchId: string,
  listener: (event: KitchenEvent) => void,
): () => void {
  const unsubscribe = subscribeKitchenEvents(branchId, listener);
  ensureLateMonitor();

  return unsubscribe;
}

/**
 * Checks whether an unknown value matches a known kitchen service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value contains a recognized kitchen service error
 * code and a string message.
 */
export function isKitchenServiceError(
  error: unknown,
): error is KitchenServiceError {
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
    Object.values(KitchenServiceErrorCode).includes(
      error.code as KitchenServiceErrorCode,
    )
  );
}
