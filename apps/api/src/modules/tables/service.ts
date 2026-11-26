import { randomUUID } from "node:crypto";

import { db as prisma } from "../../plugins/db.js";
import type {
  CreateTableInput,
  ListTablesQuery,
  TableStatusValue,
  UpdateTableInput,
} from "@morfikos/validation";

import { TableServiceErrorCode, TableStatus } from "@morfikos/auth";

import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import { ACTIVE_ORDER_STATUSES, OrderStatus } from "../orders/constants.js";


/**
 * Represents errors that can occur during table operations.
 */
export class TableServiceError extends Error {
  /**
   * Creates a table service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: TableServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TableServiceError";
  }
}

/**
 * Fields returned for tables in API responses, including the table's
 * floor, map position and current open or billed order (at most one per
 * table).
 */
export const tableSelect = {
  id: true,
  branchId: true,
  name: true,
  seats: true,
  floorId: true,
  floor: { select: { id: true, name: true } },
  shape: true,
  positionX: true,
  positionY: true,
  width: true,
  height: true,
  rotation: true,
  sortOrder: true,
  qrCode: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  orders: {
    where: { status: { in: ACTIVE_ORDER_STATUSES } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      totalAmount: true,
      createdAt: true,
    },
  },
} as const;

/**
 * Fields returned when a table is deactivated.
 */
const tableStatusSelect = {
  id: true,
  isActive: true,
  updatedAt: true,
} as const;

/**
 * Builds the guest URL encoded in a table's QR code. Scanning it opens the
 * web app's QR menu, which reads GET /api/v1/public/t/:qrCode/menu.
 *
 * @param qrCode - The table's QR code.
 * @returns The absolute guest menu URL.
 */
function buildQrUrl(qrCode: string): string {
  const baseUrl = process.env.WEB_APP_URL ?? "http://localhost:5173";

  return `${baseUrl}/t/${encodeURIComponent(qrCode)}`;
}

/**
 * Serializes a table with its QR URL and live status derived from its
 * current order.
 *
 * @param table - A table record selected with {@link tableSelect}.
 * @returns The table as returned by the API.
 */
export function serializeTable<
  T extends {
    qrCode: string;
    orders: Array<{
      id: string;
      orderNumber: string;
      status: string;
      totalAmount: { toNumber(): number };
      createdAt: Date;
    }>;
  },
>(table: T) {
  const { orders, ...tableData } = table;
  const activeOrder = orders[0] ?? null;

  const currentStatus = !activeOrder
    ? TableStatus.AVAILABLE
    : activeOrder.status === OrderStatus.BILLED
      ? TableStatus.BILLED
      : TableStatus.OCCUPIED;

  return {
    ...tableData,
    qrUrl: buildQrUrl(table.qrCode),
    currentStatus,
    activeOrder: activeOrder
      ? {
        id: activeOrder.id,
        orderNumber: activeOrder.orderNumber,
        status: activeOrder.status,
        runningAmount: activeOrder.totalAmount.toNumber(),
        seatedAt: activeOrder.createdAt,
      }
      : null,
  };
}

/**
 * Builds the order filter for a live table status.
 *
 * @param status - The requested table status.
 * @returns The Prisma `orders` relation filter for that status.
 */
function getStatusFilter(status: TableStatusValue) {
  switch (status) {
    case TableStatus.AVAILABLE:
      return { none: { status: { in: ACTIVE_ORDER_STATUSES } } };

    case TableStatus.BILLED:
      return { some: { status: OrderStatus.BILLED } };

    default:
      return { some: { status: OrderStatus.OPEN } };
  }
}

/**
 * Finds a table that belongs to the organization and to one of the
 * branches the user can access.
 *
 * @param id - The table ID.
 * @param organizationId - The organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The table's ID, or null if not found or not accessible.
 */
async function findAccessibleTable(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  return prisma.diningTable.findFirst({
    where: {
      id,
      branchId: { in: branchIds },
      branch: { organizationId },
    },
    select: { id: true, branchId: true },
  });
}

/**
 * Ensures a floor exists, is active and belongs to the table's branch.
 *
 * @param floorId - The floor ID.
 * @param branchId - The table's branch ID.
 * @throws TableServiceError If the floor is not found in the branch.
 */
async function assertFloorInBranch(floorId: string, branchId: string) {
  const floor = await prisma.floor.findFirst({
    where: { id: floorId, branchId, isActive: true },
    select: { id: true },
  });

  if (!floor) {
    throw new TableServiceError(
      TableServiceErrorCode.FLOOR_NOT_FOUND,
      "Active floor not found in this branch",
    );
  }
}

/**
 * Throws if the table has an open or billed order.
 *
 * @param tableId - The table ID.
 * @param message - The error message.
 * @throws TableServiceError If the table has an active order.
 */
async function assertNoActiveOrder(tableId: string, message: string) {
  const activeOrder = await prisma.order.findFirst({
    where: { tableId, status: { in: ACTIVE_ORDER_STATUSES } },
    select: { orderNumber: true },
  });

  if (activeOrder) {
    throw new TableServiceError(
      TableServiceErrorCode.TABLE_HAS_OPEN_ORDER,
      `${message} (order ${activeOrder.orderNumber})`,
    );
  }
}

/**
 * Creates a table in an active branch of the organization. A unique QR
 * code is generated automatically.
 *
 * @param data - The validated table details.
 * @param organizationId - The owning organization ID.
 * @returns The created table.
 * @throws TableServiceError If the branch or floor is not found or the name
 * is taken.
 */
export async function createTable(
  data: CreateTableInput,
  organizationId: string,
) {
  const branch = await prisma.branch.findFirst({
    where: { id: data.branchId, organizationId, status: "active" },
    select: { id: true },
  });

  if (!branch) {
    throw new TableServiceError(
      TableServiceErrorCode.BRANCH_NOT_FOUND,
      "Active branch not found",
    );
  }

  if (data.floorId !== undefined) {
    await assertFloorInBranch(data.floorId, branch.id);
  }

  try {
    const table = await prisma.diningTable.create({
      data: {
        branchId: branch.id,
        name: data.name,
        seats: data.seats,
        floorId: data.floorId ?? null,
        shape: data.shape,
        positionX: data.positionX ?? null,
        positionY: data.positionY ?? null,
        width: data.width,
        height: data.height,
        rotation: data.rotation,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
      select: tableSelect,
    });

    return serializeTable(table);
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new TableServiceError(
        TableServiceErrorCode.TABLE_NAME_CONFLICT,
        "A table with this name already exists in this branch",
      );
    }

    throw error;
  }
}

/**
 * Retrieves a paginated list of a branch's tables with their live status,
 * ordered by floor, sort order and name.
 *
 * @param organizationId - The owning organization ID.
 * @param query - Validated filters and pagination.
 * @returns The tables and pagination metadata.
 */
export async function listTables(
  organizationId: string,
  query: ListTablesQuery,
) {
  const where = {
    branchId: query.branchId,
    branch: { organizationId },
    ...(query.isActive !== undefined && { isActive: query.isActive }),
    ...(query.floorId !== undefined && { floorId: query.floorId }),
    ...(query.status !== undefined && { orders: getStatusFilter(query.status) }),
  };

  const [tables, total] = await Promise.all([
    prisma.diningTable.findMany({
      where,
      orderBy: [
        { floor: { sortOrder: "asc" } },
        { sortOrder: "asc" },
        { name: "asc" },
      ],
      take: query.limit,
      skip: query.offset,
      select: tableSelect,
    }),
    prisma.diningTable.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    tables: tables.map((table) => serializeTable(table)),
  };
}

/**
 * Retrieves a table with its live status.
 *
 * @param id - The table ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The table, or null if not found or not accessible.
 */
export async function getTable(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  const table = await prisma.diningTable.findFirst({
    where: {
      id,
      branchId: { in: branchIds },
      branch: { organizationId },
    },
    select: tableSelect,
  });

  return table ? serializeTable(table) : null;
}

/**
 * Updates the provided fields of a table.
 *
 * Fields not provided in the input are left unchanged. A table with an
 * open or billed order cannot be deactivated.
 *
 * @param id - The table ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @param data - The validated fields to update.
 * @returns The updated table, or null if not found.
 * @throws TableServiceError If the floor is not found, the name is taken or
 * the table is in use.
 */
export async function updateTable(
  id: string,
  organizationId: string,
  branchIds: string[],
  data: UpdateTableInput,
) {
  const existing = await findAccessibleTable(id, organizationId, branchIds);

  if (!existing) {
    return null;
  }

  if (data.isActive === false) {
    await assertNoActiveOrder(
      existing.id,
      "A table with an open order can't be deactivated",
    );
  }

  if (data.floorId) {
    await assertFloorInBranch(data.floorId, existing.branchId);
  }

  try {
    const table = await prisma.diningTable.update({
      where: { id: existing.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.seats !== undefined && { seats: data.seats }),
        ...(data.floorId !== undefined && { floorId: data.floorId }),
        ...(data.shape !== undefined && { shape: data.shape }),
        ...(data.positionX !== undefined && { positionX: data.positionX }),
        ...(data.positionY !== undefined && { positionY: data.positionY }),
        ...(data.width !== undefined && { width: data.width }),
        ...(data.height !== undefined && { height: data.height }),
        ...(data.rotation !== undefined && { rotation: data.rotation }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      select: tableSelect,
    });

    return serializeTable(table);
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new TableServiceError(
        TableServiceErrorCode.TABLE_NAME_CONFLICT,
        "A table with this name already exists in this branch",
      );
    }

    throw error;
  }
}

/**
 * Soft-deactivates a table without removing its order history. A
 * deactivated table's QR code stops working.
 *
 * @param id - The table ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The table status details, or null if not found.
 * @throws TableServiceError If the table has an open or billed order.
 */
export async function deactivateTable(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  const existing = await prisma.diningTable.findFirst({
    where: {
      id,
      branchId: { in: branchIds },
      branch: { organizationId },
    },
    select: tableStatusSelect,
  });

  if (!existing) {
    return null;
  }

  if (!existing.isActive) {
    return existing;
  }

  await assertNoActiveOrder(
    existing.id,
    "A table with an open order can't be deactivated",
  );

  return prisma.diningTable.update({
    where: { id: existing.id },
    data: { isActive: false },
    select: tableStatusSelect,
  });
}

/**
 * Replaces a table's QR code, so previously printed QR codes stop working
 * (e.g. if a QR sticker was copied or misused).
 *
 * @param id - The table ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The table with its new QR code, or null if not found.
 */
export async function regenerateTableQr(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  const existing = await findAccessibleTable(id, organizationId, branchIds);

  if (!existing) {
    return null;
  }

  const table = await prisma.diningTable.update({
    where: { id: existing.id },
    data: { qrCode: randomUUID() },
    select: tableSelect,
  });

  return serializeTable(table);
}

/**
 * Checks whether an unknown value matches a known table service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value contains a recognized table service error
 * code and a string message.
 */
export function isTableServiceError(
  error: unknown,
): error is TableServiceError {
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
    Object.values(TableServiceErrorCode).includes(
      error.code as TableServiceErrorCode,
    )
  );
}
