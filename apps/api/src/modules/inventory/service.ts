import { db as prisma } from "../../plugins/db.js";
import { InventoryServiceErrorCode, verifyPassword, type UserRole } from "@morfikos/auth";
import type {
  CreateInventoryItemInput,
  CreateStockCountInput,
  CreatePurchaseInput,
  CreateSupplierInput,
  InventoryReportQuery,
  ListInventoryItemsQuery,
  ListPurchasesQuery,
  ListRecipesQuery,
  ListStockAlertsQuery,
  ListStockCountsQuery,
  ListStockMovementsQuery,
  ListSuppliersQuery,
  RecordWastageInput,
  SaveRecipeInput,
  StockAdjustmentInput,
  UpdateInventoryItemInput,
  UpdateInventorySettingsInput,
  UpdateSupplierInput,
} from "@morfikos/validation";

import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import {
  ALERT_STATUS_FROM_API,
  CATEGORY_FROM_API,
  INVENTORY_TRANSACTION_OPTIONS,
  InventoryEventName,
  MOVEMENT_TYPE_FROM_API,
  RECENT_MOVEMENTS_LIMIT,
  REORDER_TARGET_MULTIPLIER,
  StockAlertStatus,
  StockMovementType,
  StockStatus,
  UNIT_FROM_API,
  WASTAGE_REASON_FROM_API,
  type InventoryUnit,
} from "./constants.js";
import { InventoryServiceError } from "./errors.js";
import { queueInventoryEvents, withInventoryEvents, type InventoryEvent } from "./events.js";
import {
  applyStockChangesInTx,
  convertQuantity,
  getDishBlockersInTx,
  getInventorySettingsInTx,
  getStockContextInTx,
  getStockStatus,
  refreshDishAvailabilityInTx,
  refreshDishesInAllBranchesInTx,
  refreshStockStateInTx,
  roundMoney,
  roundQuantity,
  roundUnitCost,
  type StockChange,
  type TransactionClient,
} from "./stock.js";

export { InventoryServiceError, isInventoryServiceError } from "./errors.js";


/** A Prisma decimal value. */
type DecimalValue = { toNumber(): number };

/**
 * The authenticated user performing an inventory operation.
 */
export interface InventoryActor {
  userId: string;
  role: UserRole;
  organizationId: string;
  branchIds: string[];
}

// ─── Shared helpers ─────────────────────────────────────────────────────

/**
 * Runs inventory work in a transaction and publishes the live events it
 * raised once it commits.
 *
 * @param work - The transactional work.
 * @returns The work's result.
 */
function runInventoryTransaction<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
  return withInventoryEvents(() => prisma.$transaction(work, INVENTORY_TRANSACTION_OPTIONS));
}

/**
 * Loads an active branch of the actor's organization that the actor can access.
 *
 * @param client - The Prisma client or transaction client.
 * @param actor - The authenticated user.
 * @param branchId - The branch ID.
 * @returns The branch's ID, name and clock settings.
 * @throws InventoryServiceError If the branch is not accessible or not found.
 */
async function getAccessibleBranch(
  client: TransactionClient,
  actor: InventoryActor,
  branchId: string,
) {
  if (!actor.branchIds.includes(branchId)) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.BRANCH_ACCESS_DENIED,
      "Access denied for this branch",
    );
  }

  const branch = await client.branch.findFirst({
    where: { id: branchId, organizationId: actor.organizationId, status: "active" },
    select: { id: true, name: true, timezone: true, businessDayCutoff: true },
  });

  if (!branch) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.BRANCH_NOT_FOUND,
      "Branch not found",
    );
  }

  return branch;
}

/**
 * Loads active inventory items of the organization, failing if any is missing.
 *
 * @param client - The Prisma client or transaction client.
 * @param organizationId - The organization ID.
 * @param itemIds - The item IDs.
 * @returns The items keyed by ID.
 * @throws InventoryServiceError If an item is not found or inactive.
 */
async function loadActiveItems(
  client: TransactionClient,
  organizationId: string,
  itemIds: string[],
) {
  const items = await client.inventoryItem.findMany({
    where: { id: { in: itemIds }, organizationId, isActive: true },
    select: { id: true, name: true, unit: true },
  });

  if (items.length !== new Set(itemIds).size) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.INVENTORY_ITEM_NOT_FOUND,
      "One or more inventory items were not found or are inactive",
    );
  }

  return new Map(items.map((item) => [item.id, { ...item, unit: item.unit as InventoryUnit }]));
}

/**
 * Converts an entered quantity to the item's own unit.
 *
 * @param item - The item's name and unit.
 * @param quantity - The quantity entered.
 * @param unit - The unit entered (defaults to the item's unit).
 * @returns The quantity in the item's unit.
 */
function toItemUnit(
  item: { name: string; unit: InventoryUnit },
  quantity: number,
  unit: keyof typeof UNIT_FROM_API | undefined,
): number {
  return convertQuantity(quantity, unit ? UNIT_FROM_API[unit] : item.unit, item.unit, item.name);
}

/**
 * Atomically increments and returns a named per-branch counter.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @param name - The counter name, e.g. "purchase".
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
 * Converts a Prisma decimal (or null) to a number.
 *
 * @param value - The decimal.
 * @returns The number, or 0 for null.
 */
function toNumber(value: DecimalValue | null | undefined): number {
  return value ? value.toNumber() : 0;
}

/**
 * Returns the dishes that were turned back on, from a batch of events.
 *
 * @param events - Events raised by a stock change.
 * @returns The restored dishes.
 */
function getRestoredDishes(events: InventoryEvent[]) {
  return events
    .filter((event) => event.event === InventoryEventName.DISHES_RESTORED)
    .flatMap((event) => (event.data as { dishes: { menuItemId: string; name: string }[] }).dishes);
}

/**
 * Serializes an ingredient's stock at a branch.
 *
 * @param stock - The stock row.
 * @returns The stock view with value and status.
 */
function serializeStock(stock: {
  branchId: string;
  quantity: DecimalValue;
  lowStockLevel: DecimalValue;
  avgUnitCost: DecimalValue;
  lastMovementAt: Date | null;
  branch?: { name: string };
}) {
  const quantity = stock.quantity.toNumber();
  const lowStockLevel = stock.lowStockLevel.toNumber();
  const avgUnitCost = stock.avgUnitCost.toNumber();

  return {
    branchId: stock.branchId,
    ...(stock.branch && { branchName: stock.branch.name }),
    quantity,
    lowStockLevel,
    avgUnitCost,
    stockValue: roundMoney(Math.max(quantity, 0) * avgUnitCost),
    status: getStockStatus(quantity, lowStockLevel),
    lastMovementAt: stock.lastMovementAt,
  };
}

/**
 * Verifies the actor's own manager PIN.
 *
 * @param actor - The owner or manager.
 * @param pin - The PIN entered.
 * @throws InventoryServiceError If no PIN is set or it doesn't match.
 */
async function assertManagerPin(actor: InventoryActor, pin: string): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: {
      organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId },
    },
    select: { pinHash: true },
  });

  if (!membership?.pinHash) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.PIN_NOT_SET,
      "Set your manager PIN first (POST /api/v1/auth/manager-pin)",
    );
  }

  if (!(await verifyPassword(pin, membership.pinHash))) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.INVALID_MANAGER_PIN,
      "Invalid manager PIN",
    );
  }
}

// ─── Inventory items ────────────────────────────────────────────────────

/** Fields returned for an inventory item. */
const itemSelect = {
  id: true,
  name: true,
  category: true,
  unit: true,
  sku: true,
  isEssential: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Serializes an inventory item's own fields with lowercase enums.
 *
 * @param item - The item.
 * @returns The item view.
 */
function serializeItem<T extends { category: string; unit: string }>(item: T) {
  return { ...item, category: item.category.toLowerCase(), unit: item.unit.toLowerCase() };
}

/**
 * Creates an ingredient with optional opening stock per branch.
 *
 * @param actor - The owner or manager.
 * @param input - The item and its opening stock.
 * @returns The created item with its branch stock.
 * @throws InventoryServiceError If a branch is not accessible or the name is taken.
 */
export async function createInventoryItem(actor: InventoryActor, input: CreateInventoryItemInput) {
  for (const row of input.branchStock) {
    if (!actor.branchIds.includes(row.branchId)) {
      throw new InventoryServiceError(
        InventoryServiceErrorCode.BRANCH_ACCESS_DENIED,
        "Access denied for one of the branches",
      );
    }
  }

  try {
    const itemId = await runInventoryTransaction(async (tx) => {
      const branches = await tx.branch.findMany({
        where: {
          id: { in: input.branchStock.map((row) => row.branchId) },
          organizationId: actor.organizationId,
          status: "active",
        },
        select: { id: true },
      });

      if (branches.length !== input.branchStock.length) {
        throw new InventoryServiceError(
          InventoryServiceErrorCode.BRANCH_NOT_FOUND,
          "One or more branches were not found",
        );
      }

      const item = await tx.inventoryItem.create({
        data: {
          organizationId: actor.organizationId,
          name: input.name,
          category: CATEGORY_FROM_API[input.category],
          unit: UNIT_FROM_API[input.unit],
          sku: input.sku ?? null,
          isEssential: input.isEssential,
        },
        select: { id: true },
      });

      for (const row of input.branchStock) {
        await tx.branchStock.create({
          data: {
            branchId: row.branchId,
            inventoryItemId: item.id,
            lowStockLevel: row.lowStockLevel,
            avgUnitCost: row.unitCost,
          },
        });

        const context = await getStockContextInTx(tx, actor.organizationId, row.branchId, actor.userId);

        queueInventoryEvents(
          row.openingQuantity > 0
            ? await applyStockChangesInTx(tx, context, [
                {
                  inventoryItemId: item.id,
                  quantity: row.openingQuantity,
                  type: StockMovementType.OPENING,
                  unitCost: row.unitCost,
                  note: "Opening stock",
                },
              ])
            : await refreshStockStateInTx(tx, context, [item.id]),
        );
      }

      return item.id;
    });

    return getInventoryItem(actor, itemId, {});
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new InventoryServiceError(
        InventoryServiceErrorCode.INVENTORY_ITEM_EXISTS,
        "An inventory item with this name already exists",
      );
    }

    throw error;
  }
}

/**
 * Builds the database filter for an item's stock status at a branch.
 * Items the branch has never stocked count as out of stock.
 *
 * @param branchId - The branch ID.
 * @param status - The requested status.
 * @returns The Prisma where clause.
 */
function getStockStatusFilter(branchId: string, status: StockStatus) {
  const fields = prisma.branchStock.fields;

  switch (status) {
    case StockStatus.OUT_OF_STOCK:
      return {
        OR: [
          { stocks: { none: { branchId } } },
          { stocks: { some: { branchId, quantity: { lte: 0 } } } },
        ],
      };

    case StockStatus.LOW_STOCK:
      return {
        stocks: {
          some: {
            branchId,
            quantity: { gt: 0, lte: fields.lowStockLevel },
            lowStockLevel: { gt: 0 },
          },
        },
      };

    default:
      return {
        stocks: {
          some: {
            branchId,
            quantity: { gt: 0 },
            OR: [{ lowStockLevel: 0 }, { quantity: { gt: fields.lowStockLevel } }],
          },
        },
      };
  }
}

/**
 * Lists ingredients with their stock at one branch, plus a stock summary.
 *
 * @param actor - The staff member.
 * @param query - Branch, filters and pagination.
 * @returns The items, summary and pagination metadata.
 */
export async function listInventoryItems(actor: InventoryActor, query: ListInventoryItemsQuery) {
  const branch = await getAccessibleBranch(prisma, actor, query.branchId);

  const where = {
    organizationId: actor.organizationId,
    ...(!query.includeInactive && { isActive: true }),
    ...(query.category !== undefined && { category: CATEGORY_FROM_API[query.category] }),
    ...(query.search !== undefined && {
      OR: [
        { name: { contains: query.search, mode: "insensitive" as const } },
        { sku: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
    ...(query.status !== undefined && {
      AND: [getStockStatusFilter(branch.id, query.status as StockStatus)],
    }),
  };

  const [items, total, summaryStocks, activeCount] = await Promise.all([
    prisma.inventoryItem.findMany({
      where,
      orderBy: { name: "asc" },
      take: query.limit,
      skip: query.offset,
      select: {
        ...itemSelect,
        stocks: {
          where: { branchId: branch.id },
          select: {
            branchId: true,
            quantity: true,
            lowStockLevel: true,
            avgUnitCost: true,
            lastMovementAt: true,
          },
        },
        recipeLines: { select: { menuItemId: true }, distinct: ["menuItemId"] },
      },
    }),
    prisma.inventoryItem.count({ where }),
    prisma.branchStock.findMany({
      where: { branchId: branch.id, inventoryItem: { organizationId: actor.organizationId, isActive: true } },
      select: { quantity: true, lowStockLevel: true, avgUnitCost: true },
    }),
    prisma.inventoryItem.count({ where: { organizationId: actor.organizationId, isActive: true } }),
  ]);

  const summary = { inStock: 0, lowStock: 0, outOfStock: activeCount - summaryStocks.length, stockValue: 0 };

  for (const stock of summaryStocks) {
    const quantity = stock.quantity.toNumber();
    const status = getStockStatus(quantity, stock.lowStockLevel.toNumber());

    if (status === StockStatus.IN_STOCK) summary.inStock += 1;
    else if (status === StockStatus.LOW_STOCK) summary.lowStock += 1;
    else summary.outOfStock += 1;

    summary.stockValue += Math.max(quantity, 0) * stock.avgUnitCost.toNumber();
  }

  summary.stockValue = roundMoney(summary.stockValue);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    summary,
    items: items.map(({ stocks, recipeLines, createdAt, updatedAt, ...item }) => {
      const stock = stocks[0];
      const view = stock
        ? serializeStock(stock)
        : {
            quantity: 0,
            lowStockLevel: 0,
            avgUnitCost: 0,
            stockValue: 0,
            status: StockStatus.OUT_OF_STOCK,
            lastMovementAt: null,
          };

      return {
        ...serializeItem(item),
        quantity: view.quantity,
        lowStockLevel: view.lowStockLevel,
        avgUnitCost: view.avgUnitCost,
        stockValue: view.stockValue,
        status: view.status,
        usedInDishes: recipeLines.length,
        lastMovementAt: view.lastMovementAt,
      };
    }),
  };
}

/**
 * Retrieves an ingredient with its stock in the actor's branches, the
 * dishes that use it and its recent stock movements.
 *
 * @param actor - The staff member.
 * @param itemId - The inventory item ID.
 * @param query - Optional branch to limit stock and movements to.
 * @returns The item, or null if not found.
 */
export async function getInventoryItem(
  actor: InventoryActor,
  itemId: string,
  query: { branchId?: string },
) {
  const branchIds =
    query.branchId !== undefined
      ? [(await getAccessibleBranch(prisma, actor, query.branchId)).id]
      : actor.branchIds;

  const item = await prisma.inventoryItem.findFirst({
    where: { id: itemId, organizationId: actor.organizationId },
    select: {
      ...itemSelect,
      stocks: {
        where: { branchId: { in: branchIds } },
        select: {
          branchId: true,
          quantity: true,
          lowStockLevel: true,
          avgUnitCost: true,
          lastMovementAt: true,
          branch: { select: { name: true } },
        },
      },
      recipeLines: {
        select: {
          quantity: true,
          menuItem: { select: { id: true, name: true } },
          variant: { select: { name: true } },
          addon: { select: { name: true } },
        },
      },
    },
  });

  if (!item) {
    return null;
  }

  const movements = await prisma.stockMovement.findMany({
    where: { inventoryItemId: item.id, branchId: { in: branchIds } },
    orderBy: { createdAt: "desc" },
    take: RECENT_MOVEMENTS_LIMIT,
    select: {
      id: true,
      branchId: true,
      type: true,
      quantity: true,
      stockAfter: true,
      value: true,
      note: true,
      createdAt: true,
    },
  });

  const { stocks, recipeLines, ...itemData } = item;

  return {
    ...serializeItem(itemData),
    branchStock: stocks.map(serializeStock),
    usedIn: recipeLines.map((line) => ({
      menuItemId: line.menuItem.id,
      dish: line.menuItem.name,
      variant: line.variant?.name ?? null,
      addon: line.addon?.name ?? null,
      quantity: line.quantity.toNumber(),
    })),
    recentMovements: movements.map((movement) => ({
      ...movement,
      type: movement.type.toLowerCase(),
      quantity: movement.quantity.toNumber(),
      stockAfter: movement.stockAfter.toNumber(),
      value: movement.value.toNumber(),
    })),
  };
}

/**
 * Updates an ingredient's name, category, SKU, essential flag or active
 * state. Dish availability is refreshed when the essential or active flag
 * changes. The unit can't be changed once stock exists in it.
 *
 * @param actor - The owner or manager.
 * @param itemId - The inventory item ID.
 * @param input - The changes.
 * @returns The updated item, or null if not found.
 * @throws InventoryServiceError If the name is taken.
 */
export async function updateInventoryItem(
  actor: InventoryActor,
  itemId: string,
  input: UpdateInventoryItemInput,
) {
  const existing = await prisma.inventoryItem.findFirst({
    where: { id: itemId, organizationId: actor.organizationId },
    select: { id: true, isEssential: true, isActive: true },
  });

  if (!existing) {
    return null;
  }

  try {
    await runInventoryTransaction(async (tx) => {
      await tx.inventoryItem.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.category !== undefined && { category: CATEGORY_FROM_API[input.category] }),
          ...(input.sku !== undefined && { sku: input.sku }),
          ...(input.isEssential !== undefined && { isEssential: input.isEssential }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
        },
      });

      const availabilityChanged =
        (input.isEssential !== undefined && input.isEssential !== existing.isEssential) ||
        (input.isActive !== undefined && input.isActive !== existing.isActive);

      if (availabilityChanged) {
        const dishes = await tx.recipeLine.findMany({
          where: { inventoryItemId: existing.id, addonId: null },
          select: { menuItemId: true },
          distinct: ["menuItemId"],
        });

        queueInventoryEvents(
          await refreshDishesInAllBranchesInTx(tx, dishes.map((dish) => dish.menuItemId)),
        );
      }
    });
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new InventoryServiceError(
        InventoryServiceErrorCode.INVENTORY_ITEM_EXISTS,
        "An inventory item with this name already exists",
      );
    }

    throw error;
  }

  return getInventoryItem(actor, existing.id, {});
}

/**
 * Deactivates an ingredient. If recipes use it, `force` is required and
 * it is removed from those recipes; dishes it was blocking come back on.
 * Its stock history is kept.
 *
 * @param actor - The owner or manager.
 * @param itemId - The inventory item ID.
 * @param force - Remove it from recipes too.
 * @returns The result, or null if not found.
 * @throws InventoryServiceError If recipes use it and force is false.
 */
export async function deleteInventoryItem(actor: InventoryActor, itemId: string, force: boolean) {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: itemId, organizationId: actor.organizationId },
    select: { id: true, name: true, _count: { select: { recipeLines: true } } },
  });

  if (!item) {
    return null;
  }

  if (item._count.recipeLines > 0 && !force) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.ITEM_IN_RECIPES,
      `${item.name} is used in ${item._count.recipeLines} recipe line(s). Pass ?force=true to remove it from those recipes.`,
    );
  }

  return runInventoryTransaction(async (tx) => {
    const dishes = await tx.recipeLine.findMany({
      where: { inventoryItemId: item.id },
      select: { menuItemId: true },
      distinct: ["menuItemId"],
    });

    const removed = await tx.recipeLine.deleteMany({ where: { inventoryItemId: item.id } });

    await tx.inventoryItem.update({ where: { id: item.id }, data: { isActive: false } });
    await tx.stockAlert.updateMany({
      where: {
        inventoryItemId: item.id,
        status: { in: [StockAlertStatus.ACTIVE, StockAlertStatus.ACKNOWLEDGED] },
      },
      data: { status: StockAlertStatus.RESOLVED, resolvedAt: new Date() },
    });

    queueInventoryEvents(
      await refreshDishesInAllBranchesInTx(tx, dishes.map((dish) => dish.menuItemId)),
    );

    return { id: item.id, isActive: false, removedRecipeLines: removed.count };
  });
}

/**
 * Sets an ingredient's low-stock level at a branch.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param itemId - The inventory item ID.
 * @param lowStockLevel - The new safety level (0 turns warnings off).
 * @returns The branch stock, or null if the item is not found.
 */
export async function updateBranchStock(
  actor: InventoryActor,
  branchId: string,
  itemId: string,
  lowStockLevel: number,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);
  const item = await prisma.inventoryItem.findFirst({
    where: { id: itemId, organizationId: actor.organizationId },
    select: { id: true },
  });

  if (!item) {
    return null;
  }

  return runInventoryTransaction(async (tx) => {
    const stock = await tx.branchStock.upsert({
      where: { branchId_inventoryItemId: { branchId: branch.id, inventoryItemId: item.id } },
      create: { branchId: branch.id, inventoryItemId: item.id, lowStockLevel },
      update: { lowStockLevel },
      select: {
        branchId: true,
        quantity: true,
        lowStockLevel: true,
        avgUnitCost: true,
        lastMovementAt: true,
      },
    });

    const settings = await getInventorySettingsInTx(tx, branch.id);
    queueInventoryEvents(
      await refreshStockStateInTx(
        tx,
        { organizationId: actor.organizationId, branchId: branch.id, settings },
        [item.id],
      ),
    );

    return { inventoryItemId: item.id, ...serializeStock(stock) };
  });
}

// ─── Suppliers ──────────────────────────────────────────────────────────

const supplierSelect = {
  id: true,
  name: true,
  contactName: true,
  phone: true,
  email: true,
  gstin: true,
  address: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Throws a friendly error when a supplier name is already taken.
 *
 * @param error - The error thrown by Prisma.
 * @throws InventoryServiceError For a duplicate name, otherwise the original error.
 */
function rethrowSupplierError(error: unknown): never {
  if (isPrismaUniqueConstraintError(error)) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.SUPPLIER_EXISTS,
      "A supplier with this name already exists",
    );
  }

  throw error;
}

/**
 * Creates a supplier.
 *
 * @param actor - The owner or manager.
 * @param input - The supplier details.
 * @returns The created supplier.
 * @throws InventoryServiceError If the name is taken.
 */
export async function createSupplier(actor: InventoryActor, input: CreateSupplierInput) {
  try {
    return await prisma.supplier.create({
      data: { organizationId: actor.organizationId, ...input },
      select: supplierSelect,
    });
  } catch (error: unknown) {
    return rethrowSupplierError(error);
  }
}

/**
 * Lists the organization's suppliers.
 *
 * @param actor - The staff member.
 * @param query - Search and pagination.
 * @returns The suppliers and pagination metadata.
 */
export async function listSuppliers(actor: InventoryActor, query: ListSuppliersQuery) {
  const where = {
    organizationId: actor.organizationId,
    ...(!query.includeInactive && { isActive: true }),
    ...(query.search !== undefined && {
      OR: [
        { name: { contains: query.search, mode: "insensitive" as const } },
        { contactName: { contains: query.search, mode: "insensitive" as const } },
        { phone: { contains: query.search } },
      ],
    }),
  };

  const [suppliers, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      orderBy: { name: "asc" },
      take: query.limit,
      skip: query.offset,
      select: { ...supplierSelect, _count: { select: { purchases: true } } },
    }),
    prisma.supplier.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    suppliers: suppliers.map(({ _count, ...supplier }) => ({
      ...supplier,
      purchaseCount: _count.purchases,
    })),
  };
}

/**
 * Updates a supplier; `isActive: false` hides it from new purchases.
 *
 * @param actor - The owner or manager.
 * @param supplierId - The supplier ID.
 * @param input - The changes.
 * @returns The updated supplier, or null if not found.
 * @throws InventoryServiceError If the name is taken.
 */
export async function updateSupplier(
  actor: InventoryActor,
  supplierId: string,
  input: UpdateSupplierInput,
) {
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, organizationId: actor.organizationId },
    select: { id: true },
  });

  if (!supplier) {
    return null;
  }

  try {
    return await prisma.supplier.update({
      where: { id: supplier.id },
      data: input,
      select: supplierSelect,
    });
  } catch (error: unknown) {
    return rethrowSupplierError(error);
  }
}

// ─── Purchases (stock in) ───────────────────────────────────────────────

/**
 * Records goods received at a branch. Stock goes up, the average cost is
 * updated, and dishes auto-86 turned off come back on if restocked.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param input - Supplier, bill number and lines (cost per entered unit).
 * @returns The purchase with each line's new stock, and restored dishes.
 * @throws InventoryServiceError If the supplier or an item is not found, or a unit doesn't match.
 */
export async function createPurchase(
  actor: InventoryActor,
  branchId: string,
  input: CreatePurchaseInput,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  if (input.supplierId !== undefined) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: input.supplierId, organizationId: actor.organizationId, isActive: true },
      select: { id: true },
    });

    if (!supplier) {
      throw new InventoryServiceError(
        InventoryServiceErrorCode.SUPPLIER_NOT_FOUND,
        "Supplier not found",
      );
    }
  }

  const items = await loadActiveItems(
    prisma,
    actor.organizationId,
    input.items.map((line) => line.inventoryItemId),
  );

  const lines = input.items.map((line) => {
    const item = items.get(line.inventoryItemId)!;
    const quantity = toItemUnit(item, line.quantity, line.unit);
    const lineCost = roundMoney(line.quantity * line.unitCost);

    return {
      inventoryItemId: item.id,
      quantity,
      enteredQuantity: line.quantity,
      enteredUnit: line.unit ? UNIT_FROM_API[line.unit] : item.unit,
      unitCost: roundUnitCost(lineCost / quantity),
      lineCost,
    };
  });

  const { purchaseId, restoredDishes } = await runInventoryTransaction(async (tx) => {
    const context = await getStockContextInTx(tx, actor.organizationId, branch.id, actor.userId);
    const purchaseNumber = await nextBranchCounter(tx, branch.id, "purchase");

    const purchase = await tx.purchase.create({
      data: {
        organizationId: actor.organizationId,
        branchId: branch.id,
        purchaseNumber,
        supplierId: input.supplierId ?? null,
        invoiceNumber: input.invoiceNumber ?? null,
        purchaseDate: input.purchaseDate ?? context.businessDate,
        businessDate: context.businessDate,
        totalCost: roundMoney(lines.reduce((sum, line) => sum + line.lineCost, 0)),
        notes: input.notes ?? null,
        createdById: actor.userId,
        lines: { create: lines },
      },
      select: { id: true, purchaseNumber: true },
    });

    const events = await applyStockChangesInTx(
      tx,
      context,
      lines.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        type: StockMovementType.PURCHASE,
        unitCost: line.unitCost,
        purchaseId: purchase.id,
        note: `Purchase #${purchase.purchaseNumber}`,
      })),
    );

    queueInventoryEvents(events);

    return { purchaseId: purchase.id, restoredDishes: getRestoredDishes(events) };
  });

  const purchase = await getPurchase(actor, branch.id, purchaseId);

  return { ...purchase!, restoredDishes };
}

/**
 * Lists a branch's purchases, newest first.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param query - Supplier, date range and pagination.
 * @returns The purchases and pagination metadata.
 */
export async function listPurchases(
  actor: InventoryActor,
  branchId: string,
  query: ListPurchasesQuery,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const where = {
    branchId: branch.id,
    ...(query.supplierId !== undefined && { supplierId: query.supplierId }),
    ...((query.from !== undefined || query.to !== undefined) && {
      purchaseDate: {
        ...(query.from !== undefined && { gte: query.from }),
        ...(query.to !== undefined && { lte: query.to }),
      },
    }),
  };

  const [purchases, total, sum] = await Promise.all([
    prisma.purchase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        purchaseNumber: true,
        invoiceNumber: true,
        purchaseDate: true,
        totalCost: true,
        createdAt: true,
        supplier: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.purchase.count({ where }),
    prisma.purchase.aggregate({ where, _sum: { totalCost: true } }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    totalCost: toNumber(sum._sum.totalCost),
    purchases: purchases.map(({ _count, totalCost, ...purchase }) => ({
      ...purchase,
      totalCost: totalCost.toNumber(),
      itemCount: _count.lines,
    })),
  };
}

/**
 * Retrieves a purchase with its lines and each item's current stock.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param purchaseId - The purchase ID.
 * @returns The purchase, or null if not found.
 */
export async function getPurchase(actor: InventoryActor, branchId: string, purchaseId: string) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const purchase = await prisma.purchase.findFirst({
    where: { id: purchaseId, branchId: branch.id },
    select: {
      id: true,
      purchaseNumber: true,
      invoiceNumber: true,
      purchaseDate: true,
      businessDate: true,
      totalCost: true,
      notes: true,
      createdAt: true,
      supplier: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      lines: {
        select: {
          inventoryItemId: true,
          quantity: true,
          enteredQuantity: true,
          enteredUnit: true,
          unitCost: true,
          lineCost: true,
          inventoryItem: {
            select: {
              name: true,
              unit: true,
              stocks: {
                where: { branchId: branch.id },
                select: { quantity: true, avgUnitCost: true },
              },
            },
          },
        },
      },
    },
  });

  if (!purchase) {
    return null;
  }

  return {
    ...purchase,
    totalCost: purchase.totalCost.toNumber(),
    lines: purchase.lines.map((line) => ({
      inventoryItemId: line.inventoryItemId,
      name: line.inventoryItem.name,
      quantity: line.quantity.toNumber(),
      unit: line.inventoryItem.unit.toLowerCase(),
      enteredQuantity: line.enteredQuantity.toNumber(),
      enteredUnit: line.enteredUnit.toLowerCase(),
      unitCost: line.unitCost.toNumber(),
      lineCost: line.lineCost.toNumber(),
      currentStock: toNumber(line.inventoryItem.stocks[0]?.quantity),
      avgUnitCost: toNumber(line.inventoryItem.stocks[0]?.avgUnitCost),
    })),
  };
}

// ─── Wastage, counts and adjustments ────────────────────────────────────

/**
 * Records stock thrown away (spoiled, expired, spilled…), valued at the
 * average cost.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param input - The wasted items and reasons.
 * @returns Each line's cost and new stock, and the total cost.
 * @throws InventoryServiceError If an item is not found, a unit doesn't match, or stock would go negative when not allowed.
 */
export async function recordWastage(
  actor: InventoryActor,
  branchId: string,
  input: RecordWastageInput,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);
  const items = await loadActiveItems(
    prisma,
    actor.organizationId,
    input.items.map((line) => line.inventoryItemId),
  );

  const changes: StockChange[] = input.items.map((line) => ({
    inventoryItemId: line.inventoryItemId,
    quantity: -toItemUnit(items.get(line.inventoryItemId)!, line.quantity, line.unit),
    type: StockMovementType.WASTAGE,
    wastageReason: WASTAGE_REASON_FROM_API[line.reason],
    note: line.notes ?? null,
  }));

  return runInventoryTransaction(async (tx) => {
    const context = await getStockContextInTx(tx, actor.organizationId, branch.id, actor.userId);

    queueInventoryEvents(await applyStockChangesInTx(tx, context, changes));

    // Wastage doesn't change the average cost, so cost = quantity × average.
    const stocks = await tx.branchStock.findMany({
      where: { branchId: branch.id, inventoryItemId: { in: changes.map((change) => change.inventoryItemId) } },
      select: { inventoryItemId: true, quantity: true, avgUnitCost: true },
    });
    const stockById = new Map(stocks.map((stock) => [stock.inventoryItemId, stock]));

    const lines = input.items.map((line, index) => {
      const item = items.get(line.inventoryItemId)!;
      const stock = stockById.get(line.inventoryItemId);
      const quantity = -changes[index]!.quantity;

      return {
        inventoryItemId: item.id,
        name: item.name,
        quantity,
        unit: item.unit.toLowerCase(),
        reason: line.reason,
        notes: line.notes ?? null,
        cost: roundMoney(quantity * toNumber(stock?.avgUnitCost)),
        stockAfter: toNumber(stock?.quantity),
      };
    });

    return {
      businessDate: context.businessDate,
      totalCost: roundMoney(lines.reduce((sum, line) => sum + line.cost, 0)),
      items: lines,
    };
  });
}

/**
 * Saves a physical stock count: each item's stock is set to what was
 * counted and the difference is recorded as variance.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param input - Counted quantities.
 * @returns The count with each item's variance.
 * @throws InventoryServiceError If an item is not found or a unit doesn't match.
 */
export async function createStockCount(
  actor: InventoryActor,
  branchId: string,
  input: CreateStockCountInput,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);
  const items = await loadActiveItems(
    prisma,
    actor.organizationId,
    input.items.map((line) => line.inventoryItemId),
  );

  const counted = input.items.map((line) => ({
    inventoryItemId: line.inventoryItemId,
    countedQuantity: toItemUnit(items.get(line.inventoryItemId)!, line.countedQuantity, line.unit),
  }));

  const countId = await runInventoryTransaction(async (tx) => {
    const context = await getStockContextInTx(tx, actor.organizationId, branch.id, actor.userId);
    const countedAt = input.countedAt ? new Date(input.countedAt) : new Date();
    const stocks = await tx.branchStock.findMany({
      where: { branchId: branch.id, inventoryItemId: { in: counted.map((line) => line.inventoryItemId) } },
      select: { inventoryItemId: true, quantity: true, avgUnitCost: true },
    });
    const stockById = new Map(stocks.map((stock) => [stock.inventoryItemId, stock]));

    const lines = counted.map((line) => {
      const stock = stockById.get(line.inventoryItemId);
      const systemQuantity = toNumber(stock?.quantity);
      const varianceQuantity = roundQuantity(line.countedQuantity - systemQuantity);

      return {
        inventoryItemId: line.inventoryItemId,
        systemQuantity,
        countedQuantity: line.countedQuantity,
        varianceQuantity,
        varianceValue: roundMoney(varianceQuantity * toNumber(stock?.avgUnitCost)),
      };
    });

    const countNumber = await nextBranchCounter(tx, branch.id, "stock-count");
    const count = await tx.stockCount.create({
      data: {
        organizationId: actor.organizationId,
        branchId: branch.id,
        countNumber,
        countedAt,
        businessDate: context.businessDate,
        totalVarianceValue: roundMoney(lines.reduce((sum, line) => sum + line.varianceValue, 0)),
        notes: input.notes ?? null,
        createdById: actor.userId,
        lines: { create: lines },
      },
      select: { id: true },
    });

    queueInventoryEvents(
      await applyStockChangesInTx(
        tx,
        context,
        lines.map((line) => ({
          inventoryItemId: line.inventoryItemId,
          quantity: line.varianceQuantity,
          type: StockMovementType.COUNT,
          stockCountId: count.id,
          note: `Stock count #${countNumber}`,
        })),
      ),
    );

    return count.id;
  });

  return (await getStockCount(actor, branch.id, countId))!;
}

/**
 * Lists a branch's stock counts, newest first.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - Date range and pagination.
 * @returns The counts and pagination metadata.
 */
export async function listStockCounts(
  actor: InventoryActor,
  branchId: string,
  query: ListStockCountsQuery,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const where = {
    branchId: branch.id,
    ...((query.from !== undefined || query.to !== undefined) && {
      businessDate: {
        ...(query.from !== undefined && { gte: query.from }),
        ...(query.to !== undefined && { lte: query.to }),
      },
    }),
  };

  const [counts, total] = await Promise.all([
    prisma.stockCount.findMany({
      where,
      orderBy: { countedAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        countNumber: true,
        countedAt: true,
        businessDate: true,
        totalVarianceValue: true,
        notes: true,
        createdBy: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.stockCount.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    counts: counts.map(({ _count, totalVarianceValue, ...count }) => ({
      ...count,
      totalVarianceValue: totalVarianceValue.toNumber(),
      itemCount: _count.lines,
    })),
  };
}

/**
 * Retrieves a stock count with each item's system, counted and variance figures.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param countId - The stock count ID.
 * @returns The count, or null if not found.
 */
export async function getStockCount(actor: InventoryActor, branchId: string, countId: string) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const count = await prisma.stockCount.findFirst({
    where: { id: countId, branchId: branch.id },
    select: {
      id: true,
      countNumber: true,
      countedAt: true,
      businessDate: true,
      totalVarianceValue: true,
      notes: true,
      createdBy: { select: { id: true, name: true } },
      lines: {
        select: {
          inventoryItemId: true,
          systemQuantity: true,
          countedQuantity: true,
          varianceQuantity: true,
          varianceValue: true,
          inventoryItem: { select: { name: true, unit: true } },
        },
      },
    },
  });

  if (!count) {
    return null;
  }

  const { lines, ...countData } = count;

  return {
    ...countData,
    totalVarianceValue: count.totalVarianceValue.toNumber(),
    items: lines.map((line) => ({
      inventoryItemId: line.inventoryItemId,
      name: line.inventoryItem.name,
      unit: line.inventoryItem.unit.toLowerCase(),
      systemQuantity: line.systemQuantity.toNumber(),
      countedQuantity: line.countedQuantity.toNumber(),
      varianceQuantity: line.varianceQuantity.toNumber(),
      varianceValue: line.varianceValue.toNumber(),
    })),
  };
}

/**
 * Corrects one item's stock by hand, with a reason. Needs the actor's
 * manager PIN.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param input - The signed quantity, reason and PIN.
 * @returns The ledger entry and the new stock.
 * @throws InventoryServiceError If the PIN is wrong, the item is not found, or stock would go negative when not allowed.
 */
export async function adjustStock(
  actor: InventoryActor,
  branchId: string,
  input: StockAdjustmentInput,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);
  await assertManagerPin(actor, input.managerPin);

  const items = await loadActiveItems(prisma, actor.organizationId, [input.inventoryItemId]);
  const item = items.get(input.inventoryItemId)!;
  const sign = Math.sign(input.quantity);
  const quantity = sign * toItemUnit(item, Math.abs(input.quantity), input.unit);

  return runInventoryTransaction(async (tx) => {
    const context = await getStockContextInTx(tx, actor.organizationId, branch.id, actor.userId);

    queueInventoryEvents(
      await applyStockChangesInTx(tx, context, [
        {
          inventoryItemId: item.id,
          quantity,
          type: StockMovementType.ADJUSTMENT,
          note: input.reason,
        },
      ]),
    );

    const stock = await tx.branchStock.findUniqueOrThrow({
      where: { branchId_inventoryItemId: { branchId: branch.id, inventoryItemId: item.id } },
      select: { quantity: true, avgUnitCost: true },
    });

    return {
      inventoryItemId: item.id,
      name: item.name,
      unit: item.unit.toLowerCase(),
      quantity,
      stockAfter: stock.quantity.toNumber(),
      value: roundMoney(quantity * stock.avgUnitCost.toNumber()),
      reason: input.reason,
      businessDate: context.businessDate,
    };
  });
}

/**
 * Lists a branch's stock ledger, newest first, with a readable reference
 * for each entry (KOT and order, purchase or stock count).
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param query - Item, type, date range and pagination.
 * @returns The movements and pagination metadata.
 */
export async function listStockMovements(
  actor: InventoryActor,
  branchId: string,
  query: ListStockMovementsQuery,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const where = {
    branchId: branch.id,
    ...(query.itemId !== undefined && { inventoryItemId: query.itemId }),
    ...(query.type !== undefined && { type: MOVEMENT_TYPE_FROM_API[query.type] }),
    ...((query.from !== undefined || query.to !== undefined) && {
      businessDate: {
        ...(query.from !== undefined && { gte: query.from }),
        ...(query.to !== undefined && { lte: query.to }),
      },
    }),
  };

  const [movements, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        type: true,
        quantity: true,
        stockAfter: true,
        unitCost: true,
        value: true,
        businessDate: true,
        wastageReason: true,
        note: true,
        kotId: true,
        createdAt: true,
        inventoryItem: { select: { id: true, name: true, unit: true } },
        purchase: { select: { id: true, purchaseNumber: true } },
        stockCount: { select: { id: true, countNumber: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
    prisma.stockMovement.count({ where }),
  ]);

  const kotIds = [...new Set(movements.flatMap((movement) => (movement.kotId ? [movement.kotId] : [])))];
  const kots = await prisma.kot.findMany({
    where: { id: { in: kotIds } },
    select: { id: true, kotNumber: true, order: { select: { id: true, orderNumber: true } } },
  });
  const kotById = new Map(kots.map((kot) => [kot.id, kot]));

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    movements: movements.map((movement) => {
      const kot = movement.kotId ? kotById.get(movement.kotId) : undefined;
      const reference = kot
        ? { type: "kot", id: kot.id, orderId: kot.order.id, label: `KOT #${kot.kotNumber} · Order #${kot.order.orderNumber}` }
        : movement.purchase
          ? { type: "purchase", id: movement.purchase.id, label: `Purchase #${movement.purchase.purchaseNumber}` }
          : movement.stockCount
            ? { type: "stock_count", id: movement.stockCount.id, label: `Stock count #${movement.stockCount.countNumber}` }
            : null;

      return {
        id: movement.id,
        type: movement.type.toLowerCase(),
        item: { ...movement.inventoryItem, unit: movement.inventoryItem.unit.toLowerCase() },
        quantity: movement.quantity.toNumber(),
        stockAfter: movement.stockAfter.toNumber(),
        unitCost: movement.unitCost.toNumber(),
        value: movement.value.toNumber(),
        businessDate: movement.businessDate,
        wastageReason: movement.wastageReason?.toLowerCase() ?? null,
        note: movement.note,
        reference,
        createdBy: movement.createdBy,
        createdAt: movement.createdAt,
      };
    }),
  };
}

// ─── Recipes ────────────────────────────────────────────────────────────

/**
 * Replaces a dish's recipe (base, per-variant and per-add-on ingredients).
 * Quantities may be entered in any compatible unit and are stored in each
 * ingredient's unit. Dish availability is refreshed in every branch.
 *
 * @param actor - The owner or manager.
 * @param menuItemId - The menu item ID.
 * @param input - The recipes.
 * @returns The saved recipe with costs, or null if the dish is not found.
 * @throws InventoryServiceError If a variant, add-on or ingredient is invalid.
 */
export async function saveRecipe(actor: InventoryActor, menuItemId: string, input: SaveRecipeInput) {
  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, organizationId: actor.organizationId },
    select: {
      id: true,
      variants: { select: { id: true } },
      addons: { select: { id: true } },
    },
  });

  if (!menuItem) {
    return null;
  }

  const variantIds = new Set(menuItem.variants.map((variant) => variant.id));
  const addonIds = new Set(menuItem.addons.map((addon) => addon.id));

  for (const row of input.variants) {
    if (row.variantId !== null && !variantIds.has(row.variantId)) {
      throw new InventoryServiceError(
        InventoryServiceErrorCode.INVALID_RECIPE,
        "A variant doesn't belong to this dish",
      );
    }
  }

  for (const row of input.addons) {
    if (!addonIds.has(row.addonId)) {
      throw new InventoryServiceError(
        InventoryServiceErrorCode.INVALID_RECIPE,
        "An add-on doesn't belong to this dish",
      );
    }
  }

  const ingredientIds = [
    ...input.variants.flatMap((row) => row.ingredients),
    ...input.addons.flatMap((row) => row.ingredients),
  ].map((ingredient) => ingredient.inventoryItemId);
  const items = await loadActiveItems(prisma, actor.organizationId, ingredientIds);

  const toLines = (
    ingredients: SaveRecipeInput["variants"][number]["ingredients"],
    keys: { variantId: string | null; addonId: string | null },
  ) =>
    ingredients.map((ingredient) => ({
      menuItemId: menuItem.id,
      ...keys,
      inventoryItemId: ingredient.inventoryItemId,
      quantity: toItemUnit(items.get(ingredient.inventoryItemId)!, ingredient.quantity, ingredient.unit),
    }));

  const lines = [
    ...input.variants.flatMap((row) => toLines(row.ingredients, { variantId: row.variantId, addonId: null })),
    ...input.addons.flatMap((row) => toLines(row.ingredients, { variantId: null, addonId: row.addonId })),
  ];

  await runInventoryTransaction(async (tx) => {
    await tx.recipeLine.deleteMany({ where: { menuItemId: menuItem.id } });
    await tx.recipeLine.createMany({ data: lines });
    queueInventoryEvents(await refreshDishesInAllBranchesInTx(tx, [menuItem.id]));
  });

  return getRecipe(actor, menuItem.id, {});
}

/**
 * Retrieves a dish's recipe with the cost of each serving. With a branch,
 * costs and prices are that branch's and servings possible from current
 * stock are shown; without one, costs are averaged across branches.
 *
 * @param actor - The staff member.
 * @param menuItemId - The menu item ID.
 * @param query - Optional branch.
 * @returns The recipe, or null if the dish is not found.
 * @throws InventoryServiceError If the dish has no recipe.
 */
export async function getRecipe(
  actor: InventoryActor,
  menuItemId: string,
  query: { branchId?: string },
) {
  const branch =
    query.branchId !== undefined ? await getAccessibleBranch(prisma, actor, query.branchId) : null;

  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, organizationId: actor.organizationId },
    select: {
      id: true,
      name: true,
      variants: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, extraPrice: true } },
      addons: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, price: true } },
      recipeLines: {
        select: {
          variantId: true,
          addonId: true,
          inventoryItemId: true,
          quantity: true,
          inventoryItem: { select: { name: true, unit: true, isActive: true } },
        },
      },
      ...(branch && {
        branchItems: { where: { branchId: branch.id }, select: { price: true, isAvailable: true } },
      }),
    },
  });

  if (!menuItem) {
    return null;
  }

  if (menuItem.recipeLines.length === 0) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.RECIPE_NOT_FOUND,
      "This dish has no recipe yet",
    );
  }

  const ingredientIds = [...new Set(menuItem.recipeLines.map((line) => line.inventoryItemId))];
  const stocks = await prisma.branchStock.findMany({
    where: {
      inventoryItemId: { in: ingredientIds },
      ...(branch ? { branchId: branch.id } : { branchId: { in: actor.branchIds } }),
    },
    select: { inventoryItemId: true, quantity: true, avgUnitCost: true },
  });

  const costById = new Map<string, number>();
  const quantityById = new Map<string, number>();

  for (const id of ingredientIds) {
    const itemStocks = stocks.filter((stock) => stock.inventoryItemId === id);
    const costs = itemStocks.map((stock) => stock.avgUnitCost.toNumber()).filter((cost) => cost > 0);

    costById.set(id, costs.length ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : 0);
    quantityById.set(id, itemStocks.reduce((sum, stock) => sum + stock.quantity.toNumber(), 0));
  }

  const branchItem = "branchItems" in menuItem ? menuItem.branchItems?.[0] : undefined;
  const basePrice = branchItem ? branchItem.price.toNumber() : null;

  const costLines = (lines: typeof menuItem.recipeLines) => {
    const ingredients = lines.map((line) => {
      const unitCost = roundUnitCost(costById.get(line.inventoryItemId) ?? 0);
      const quantity = line.quantity.toNumber();

      return {
        inventoryItemId: line.inventoryItemId,
        name: line.inventoryItem.name,
        quantity,
        unit: line.inventoryItem.unit.toLowerCase(),
        unitCost,
        cost: roundMoney(quantity * unitCost),
        isActive: line.inventoryItem.isActive,
        ...(branch && { inStock: (quantityById.get(line.inventoryItemId) ?? 0) > 0 }),
      };
    });

    const servingsPossible = branch
      ? Math.max(
          0,
          Math.min(
            ...lines.map((line) =>
              Math.floor((quantityById.get(line.inventoryItemId) ?? 0) / line.quantity.toNumber()),
            ),
          ),
        )
      : undefined;

    return {
      ingredients,
      foodCost: roundMoney(ingredients.reduce((sum, ingredient) => sum + ingredient.cost, 0)),
      ...(servingsPossible !== undefined && { servingsPossible }),
    };
  };

  const withMargins = (costed: ReturnType<typeof costLines>, sellingPrice: number | null) => ({
    ...costed,
    sellingPrice,
    foodCostPercent:
      sellingPrice && sellingPrice > 0 ? roundMoney((costed.foodCost / sellingPrice) * 100) : null,
    grossMargin: sellingPrice !== null ? roundMoney(sellingPrice - costed.foodCost) : null,
  });

  const dishLines = menuItem.recipeLines.filter((line) => line.addonId === null);
  const baseLines = dishLines.filter((line) => line.variantId === null);

  const servings =
    menuItem.variants.length === 0
      ? [{ variantId: null, variantName: null, usesBaseRecipe: true, lines: baseLines, extraPrice: 0 }]
      : menuItem.variants.map((variant) => {
          const own = dishLines.filter((line) => line.variantId === variant.id);

          return {
            variantId: variant.id,
            variantName: variant.name,
            usesBaseRecipe: own.length === 0,
            lines: own.length > 0 ? own : baseLines,
            extraPrice: variant.extraPrice.toNumber(),
          };
        });

  return {
    menuItemId: menuItem.id,
    name: menuItem.name,
    branchId: branch?.id ?? null,
    hasBaseRecipe: baseLines.length > 0,
    variants: servings
      .filter((serving) => serving.lines.length > 0)
      .map(({ lines, extraPrice, ...serving }) => ({
        ...serving,
        ...withMargins(costLines(lines), basePrice !== null ? basePrice + extraPrice : null),
      })),
    addons: menuItem.addons.flatMap((addon) => {
      const lines = menuItem.recipeLines.filter((line) => line.addonId === addon.id);

      return lines.length > 0
        ? [{ addonId: addon.id, name: addon.name, ...withMargins(costLines(lines), addon.price.toNumber()) }]
        : [];
    }),
  };
}

/**
 * Removes a dish's recipe; it no longer uses stock and can't be auto-86'd.
 *
 * @param actor - The owner or manager.
 * @param menuItemId - The menu item ID.
 * @returns The number of lines removed, or null if the dish or recipe is not found.
 */
export async function deleteRecipe(actor: InventoryActor, menuItemId: string) {
  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, organizationId: actor.organizationId },
    select: { id: true },
  });

  if (!menuItem) {
    return null;
  }

  return runInventoryTransaction(async (tx) => {
    const removed = await tx.recipeLine.deleteMany({ where: { menuItemId: menuItem.id } });

    if (removed.count === 0) {
      return null;
    }

    queueInventoryEvents(await refreshDishesInAllBranchesInTx(tx, [menuItem.id]));

    return { menuItemId: menuItem.id, removedLines: removed.count };
  });
}

/**
 * Lists a branch's dishes with their recipe status and food cost %, so
 * missing recipes can be filled in.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - Missing-only filter, search and pagination.
 * @returns The dishes, a summary and pagination metadata.
 */
export async function listRecipes(actor: InventoryActor, branchId: string, query: ListRecipesQuery) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const baseWhere = {
    organizationId: actor.organizationId,
    isActive: true,
    branchItems: { some: { branchId: branch.id } },
  };
  const where = {
    ...baseWhere,
    ...(query.missing && { recipeLines: { none: { addonId: null } } }),
    ...(query.search !== undefined && {
      name: { contains: query.search, mode: "insensitive" as const },
    }),
  };

  const [dishes, total, totalDishes, missingCount] = await Promise.all([
    prisma.menuItem.findMany({
      where,
      orderBy: { name: "asc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        name: true,
        category: { select: { id: true, name: true } },
        branchItems: { where: { branchId: branch.id }, select: { price: true } },
        variants: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true } },
        recipeLines: {
          where: { addonId: null },
          select: { variantId: true, inventoryItemId: true, quantity: true },
        },
      },
    }),
    prisma.menuItem.count({ where }),
    prisma.menuItem.count({ where: baseWhere }),
    prisma.menuItem.count({ where: { ...baseWhere, recipeLines: { none: { addonId: null } } } }),
  ]);

  const ingredientIds = [...new Set(dishes.flatMap((dish) => dish.recipeLines.map((line) => line.inventoryItemId)))];
  const stocks = await prisma.branchStock.findMany({
    where: { branchId: branch.id, inventoryItemId: { in: ingredientIds } },
    select: { inventoryItemId: true, avgUnitCost: true },
  });
  const costById = new Map(stocks.map((stock) => [stock.inventoryItemId, stock.avgUnitCost.toNumber()]));

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    summary: { totalDishes, withRecipe: totalDishes - missingCount, missingRecipe: missingCount },
    dishes: dishes.map((dish) => {
      // Default serving: the base recipe, else the first variant's.
      const baseLines = dish.recipeLines.filter((line) => line.variantId === null);
      const firstVariantId = dish.variants[0]?.id;
      const lines =
        baseLines.length > 0
          ? baseLines
          : dish.recipeLines.filter((line) => line.variantId === firstVariantId);
      const foodCost = roundMoney(
        lines.reduce(
          (sum, line) => sum + line.quantity.toNumber() * (costById.get(line.inventoryItemId) ?? 0),
          0,
        ),
      );
      const sellingPrice = toNumber(dish.branchItems[0]?.price);

      return {
        menuItemId: dish.id,
        name: dish.name,
        category: dish.category,
        hasRecipe: dish.recipeLines.length > 0,
        ingredientCount: new Set(dish.recipeLines.map((line) => line.inventoryItemId)).size,
        foodCost: dish.recipeLines.length > 0 ? foodCost : null,
        sellingPrice,
        foodCostPercent:
          dish.recipeLines.length > 0 && sellingPrice > 0
            ? roundMoney((foodCost / sellingPrice) * 100)
            : null,
      };
    }),
  };
}

// ─── Settings, auto-86 and alerts ───────────────────────────────────────

/**
 * Retrieves a branch's inventory settings.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @returns The settings.
 */
export async function getInventorySettings(actor: InventoryActor, branchId: string) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  return { branchId: branch.id, ...(await getInventorySettingsInTx(prisma, branch.id)) };
}

/**
 * Updates a branch's inventory settings. Turning auto-86 off brings back
 * dishes it had turned off.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param input - The settings to change.
 * @returns The updated settings.
 */
export async function updateInventorySettings(
  actor: InventoryActor,
  branchId: string,
  input: UpdateInventorySettingsInput,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  return runInventoryTransaction(async (tx) => {
    const settings = await tx.inventorySettings.upsert({
      where: { branchId: branch.id },
      create: { branchId: branch.id, ...input },
      update: input,
      select: {
        branchId: true,
        autoDeductEnabled: true,
        auto86Enabled: true,
        allowNegativeStock: true,
        lowStockAlertsEnabled: true,
        updatedAt: true,
      },
    });

    if (input.auto86Enabled === false) {
      const restored = await tx.branchMenuItem.updateMany({
        where: { branchId: branch.id, autoUnavailableAt: { not: null } },
        data: { isAvailable: true, autoUnavailableAt: null },
      });

      return { ...settings, restoredDishes: restored.count };
    }

    if (input.auto86Enabled === true) {
      const dishes = await tx.recipeLine.findMany({
        where: { addonId: null, menuItem: { branchItems: { some: { branchId: branch.id } } } },
        select: { menuItemId: true },
        distinct: ["menuItemId"],
      });
      queueInventoryEvents(
        await refreshDishAvailabilityInTx(
          tx,
          branch.id,
          settings,
          dishes.map((dish) => dish.menuItemId),
        ),
      );
    }

    return settings;
  });
}

/**
 * Lists dishes auto-86 has turned off at a branch, with the ingredients
 * keeping each one off.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @returns The 86'd dishes.
 */
export async function listAuto86Dishes(actor: InventoryActor, branchId: string) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const branchItems = await prisma.branchMenuItem.findMany({
    where: { branchId: branch.id, autoUnavailableAt: { not: null } },
    orderBy: { autoUnavailableAt: "desc" },
    select: { menuItemId: true, autoUnavailableAt: true, menuItem: { select: { name: true } } },
  });

  const blockers = await getDishBlockersInTx(
    prisma,
    branch.id,
    branchItems.map((item) => item.menuItemId),
  );

  return {
    dishes: branchItems.map((item) => ({
      menuItemId: item.menuItemId,
      name: item.menuItem.name,
      since: item.autoUnavailableAt,
      blockedBy: blockers.get(item.menuItemId) ?? [],
    })),
  };
}

/**
 * Lists a branch's stock alerts, newest first. Defaults to open alerts.
 *
 * @param actor - The staff member.
 * @param branchId - The branch ID.
 * @param query - Status filter and pagination.
 * @returns The alerts and pagination metadata.
 */
export async function listStockAlerts(
  actor: InventoryActor,
  branchId: string,
  query: ListStockAlertsQuery,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const where = {
    branchId: branch.id,
    status:
      query.status !== undefined
        ? ALERT_STATUS_FROM_API[query.status]
        : { in: [StockAlertStatus.ACTIVE, StockAlertStatus.ACKNOWLEDGED] },
  };

  const [alerts, total] = await Promise.all([
    prisma.stockAlert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        type: true,
        status: true,
        quantity: true,
        lowStockLevel: true,
        createdAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        acknowledgedBy: { select: { id: true, name: true } },
        inventoryItem: {
          select: {
            id: true,
            name: true,
            unit: true,
            stocks: { where: { branchId: branch.id }, select: { quantity: true } },
          },
        },
      },
    }),
    prisma.stockAlert.count({ where }),
  ]);

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    alerts: alerts.map(({ inventoryItem, quantity, lowStockLevel, ...alert }) => {
      const currentQuantity = toNumber(inventoryItem.stocks[0]?.quantity);
      const level = lowStockLevel.toNumber();

      return {
        ...alert,
        type: alert.type.toLowerCase(),
        status: alert.status.toLowerCase(),
        item: { id: inventoryItem.id, name: inventoryItem.name, unit: inventoryItem.unit.toLowerCase() },
        quantityAtAlert: quantity.toNumber(),
        quantity: currentQuantity,
        lowStockLevel: level,
        suggestedReorder:
          level > 0 ? roundQuantity(Math.max(level * REORDER_TARGET_MULTIPLIER - currentQuantity, 0)) : null,
      };
    }),
  };
}

/**
 * Marks a stock alert as seen. Resolved alerts are returned unchanged.
 *
 * @param actor - The staff member.
 * @param alertId - The alert ID.
 * @returns The alert, or null if not found.
 */
export async function acknowledgeStockAlert(actor: InventoryActor, alertId: string) {
  const alert = await prisma.stockAlert.findFirst({
    where: { id: alertId, organizationId: actor.organizationId, branchId: { in: actor.branchIds } },
    select: { id: true, status: true },
  });

  if (!alert) {
    return null;
  }

  const select = {
    id: true,
    branchId: true,
    type: true,
    status: true,
    acknowledgedAt: true,
    resolvedAt: true,
    acknowledgedBy: { select: { id: true, name: true } },
  } as const;

  const updated =
    alert.status === StockAlertStatus.ACTIVE
      ? await prisma.stockAlert.update({
          where: { id: alert.id },
          data: {
            status: StockAlertStatus.ACKNOWLEDGED,
            acknowledgedAt: new Date(),
            acknowledgedById: actor.userId,
          },
          select,
        })
      : await prisma.stockAlert.findUniqueOrThrow({ where: { id: alert.id }, select });

  return { ...updated, type: updated.type.toLowerCase(), status: updated.status.toLowerCase() };
}

// ─── Reports ────────────────────────────────────────────────────────────

/**
 * Food cost per dish sold in a date range: revenue (before tax) against
 * the ingredient cost actually deducted for those dishes.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns Totals and per-dish figures, highest food cost % first.
 */
export async function getFoodCostReport(
  actor: InventoryActor,
  branchId: string,
  query: InventoryReportQuery,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const [sales, costs] = await Promise.all([
    prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        menuItemId: { not: null },
        status: { not: "VOID" },
        order: {
          branchId: branch.id,
          businessDate: { gte: query.from, lte: query.to },
          status: { not: "CANCELLED" },
        },
      },
      _sum: { quantity: true, lineSubtotal: true, discountAmount: true },
    }),
    prisma.$queryRaw<{ menuItemId: string; cost: DecimalValue }[]>`
      SELECT oi."menuItemId", SUM(-sm."value") AS cost
      FROM "StockMovement" sm
      JOIN "OrderItem" oi ON oi."id" = sm."orderItemId"
      JOIN "Order" o ON o."id" = oi."orderId"
      WHERE o."branchId" = ${branch.id}
        AND o."businessDate" BETWEEN ${query.from} AND ${query.to}
        AND o."status" <> 'CANCELLED'
        AND oi."status" <> 'VOID'
        AND sm."type" IN ('SALE', 'SALE_REVERSAL')
      GROUP BY oi."menuItemId"
    `,
  ]);

  const costByDish = new Map(costs.map((row) => [row.menuItemId, Number(row.cost)]));
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: sales.flatMap((row) => (row.menuItemId ? [row.menuItemId] : [])) } },
    select: { id: true, name: true, _count: { select: { recipeLines: true } } },
  });
  const dishById = new Map(menuItems.map((item) => [item.id, item]));

  const dishes = sales.map((row) => {
    const revenue = roundMoney(toNumber(row._sum.lineSubtotal) - toNumber(row._sum.discountAmount));
    const foodCost = roundMoney(costByDish.get(row.menuItemId as string) ?? 0);
    const dish = dishById.get(row.menuItemId as string);

    return {
      menuItemId: row.menuItemId,
      name: dish?.name ?? "Deleted dish",
      hasRecipe: (dish?._count.recipeLines ?? 0) > 0,
      quantitySold: row._sum.quantity ?? 0,
      revenue,
      foodCost,
      foodCostPercent: revenue > 0 ? roundMoney((foodCost / revenue) * 100) : null,
      grossMargin: roundMoney(revenue - foodCost),
    };
  });

  dishes.sort((a, b) => (b.foodCostPercent ?? -1) - (a.foodCostPercent ?? -1));

  const revenue = roundMoney(dishes.reduce((sum, dish) => sum + dish.revenue, 0));
  const foodCost = roundMoney(dishes.reduce((sum, dish) => sum + dish.foodCost, 0));

  return {
    branchId: branch.id,
    from: query.from,
    to: query.to,
    totals: {
      revenue,
      foodCost,
      foodCostPercent: revenue > 0 ? roundMoney((foodCost / revenue) * 100) : null,
      grossMargin: roundMoney(revenue - foodCost),
      dishesWithoutRecipe: dishes.filter((dish) => !dish.hasRecipe).length,
    },
    dishes,
  };
}

/**
 * Stock variance per ingredient for a date range: what should be left
 * (opening + received − sold − wasted) against what is left after counts
 * and adjustments. A negative variance points to theft, leakage or
 * over-portioning.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @param query - The business-date range.
 * @returns Per-ingredient figures and totals, largest loss first.
 */
export async function getVarianceReport(
  actor: InventoryActor,
  branchId: string,
  query: InventoryReportQuery,
) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const [inRange, sinceFrom, stocks] = await Promise.all([
    prisma.stockMovement.groupBy({
      by: ["inventoryItemId", "type"],
      where: { branchId: branch.id, businessDate: { gte: query.from, lte: query.to } },
      _sum: { quantity: true, value: true },
    }),
    prisma.stockMovement.groupBy({
      by: ["inventoryItemId"],
      where: { branchId: branch.id, businessDate: { gte: query.from } },
      _sum: { quantity: true },
    }),
    prisma.branchStock.findMany({
      where: { branchId: branch.id },
      select: {
        inventoryItemId: true,
        quantity: true,
        inventoryItem: { select: { name: true, unit: true, category: true } },
      },
    }),
  ]);

  const sinceFromById = new Map(sinceFrom.map((row) => [row.inventoryItemId, toNumber(row._sum.quantity)]));

  const sum = (itemId: string, types: StockMovementType[], field: "quantity" | "value") =>
    inRange
      .filter((row) => row.inventoryItemId === itemId && types.includes(row.type as StockMovementType))
      .reduce((total, row) => total + toNumber(row._sum[field]), 0);

  const items = stocks
    .map((stock) => {
      const id = stock.inventoryItemId;
      const opening = roundQuantity(stock.quantity.toNumber() - (sinceFromById.get(id) ?? 0));
      const received = roundQuantity(sum(id, [StockMovementType.OPENING, StockMovementType.PURCHASE], "quantity"));
      const idealUsage = roundQuantity(-sum(id, [StockMovementType.SALE, StockMovementType.SALE_REVERSAL], "quantity"));
      const wastage = roundQuantity(-sum(id, [StockMovementType.WASTAGE], "quantity"));
      const varianceQuantity = roundQuantity(sum(id, [StockMovementType.COUNT, StockMovementType.ADJUSTMENT], "quantity"));
      const expectedClosing = roundQuantity(opening + received - idealUsage - wastage);

      return {
        inventoryItemId: id,
        name: stock.inventoryItem.name,
        category: stock.inventoryItem.category.toLowerCase(),
        unit: stock.inventoryItem.unit.toLowerCase(),
        opening,
        received,
        idealUsage,
        idealUsageValue: roundMoney(-sum(id, [StockMovementType.SALE, StockMovementType.SALE_REVERSAL], "value")),
        wastage,
        wastageValue: roundMoney(-sum(id, [StockMovementType.WASTAGE], "value")),
        expectedClosing,
        actualClosing: roundQuantity(expectedClosing + varianceQuantity),
        varianceQuantity,
        varianceValue: roundMoney(sum(id, [StockMovementType.COUNT, StockMovementType.ADJUSTMENT], "value")),
        variancePercent: idealUsage > 0 ? roundMoney((varianceQuantity / idealUsage) * 100) : null,
      };
    })
    .filter(
      (item) =>
        item.opening !== 0 || item.received !== 0 || item.idealUsage !== 0 || item.wastage !== 0 || item.varianceQuantity !== 0,
    )
    .sort((a, b) => a.varianceValue - b.varianceValue);

  return {
    branchId: branch.id,
    from: query.from,
    to: query.to,
    totals: {
      idealUsageValue: roundMoney(items.reduce((total, item) => total + item.idealUsageValue, 0)),
      wastageValue: roundMoney(items.reduce((total, item) => total + item.wastageValue, 0)),
      varianceValue: roundMoney(items.reduce((total, item) => total + item.varianceValue, 0)),
    },
    items,
  };
}

/**
 * Current stock value at a branch (quantity × average cost), by category
 * and by item. Negative stock counts as zero.
 *
 * @param actor - The owner or manager.
 * @param branchId - The branch ID.
 * @returns The total value, per-category totals and items by value.
 */
export async function getStockValuation(actor: InventoryActor, branchId: string) {
  const branch = await getAccessibleBranch(prisma, actor, branchId);

  const stocks = await prisma.branchStock.findMany({
    where: { branchId: branch.id, inventoryItem: { isActive: true } },
    select: {
      inventoryItemId: true,
      quantity: true,
      avgUnitCost: true,
      inventoryItem: { select: { name: true, unit: true, category: true } },
    },
  });

  const items = stocks
    .map((stock) => {
      const quantity = stock.quantity.toNumber();
      const avgUnitCost = stock.avgUnitCost.toNumber();

      return {
        inventoryItemId: stock.inventoryItemId,
        name: stock.inventoryItem.name,
        category: stock.inventoryItem.category.toLowerCase(),
        unit: stock.inventoryItem.unit.toLowerCase(),
        quantity,
        avgUnitCost,
        value: roundMoney(Math.max(quantity, 0) * avgUnitCost),
      };
    })
    .sort((a, b) => b.value - a.value);

  const byCategory = new Map<string, { value: number; items: number }>();

  for (const item of items) {
    const entry = byCategory.get(item.category) ?? { value: 0, items: 0 };
    entry.value += item.value;
    entry.items += 1;
    byCategory.set(item.category, entry);
  }

  return {
    branchId: branch.id,
    valuedAt: new Date(),
    totalValue: roundMoney(items.reduce((sum, item) => sum + item.value, 0)),
    categories: [...byCategory.entries()]
      .map(([category, entry]) => ({ category, items: entry.items, value: roundMoney(entry.value) }))
      .sort((a, b) => b.value - a.value),
    items,
  };
}
