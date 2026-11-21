import type { createPrismaClient } from "@morfikos/database";
import { InventoryServiceErrorCode } from "@morfikos/auth";

import { getBusinessDate } from "../../utils/branch-time.js";
import {
  DEFAULT_INVENTORY_SETTINGS,
  InventoryEventName,
  InventoryUnit,
  StockAlertStatus,
  StockAlertType,
  StockMovementType,
  StockStatus,
  UNIT_SCALE,
  type WastageReason,
} from "./constants.js";
import { InventoryServiceError } from "./errors.js";
import { queueInventoryEvents, type InventoryEvent } from "./events.js";

/**
 * The stock engine: every change to a branch's stock goes through
 * {@link applyStockChangesInTx}, which updates the balance, writes the
 * ledger, raises low-stock alerts and turns dishes off or back on
 * (auto-86). The orders module calls {@link deductStockForKotInTx} and
 * {@link reverseStockForOrderItemsInTx} inside its own transactions.
 */

/** The Prisma client available inside an interactive transaction. */
export type TransactionClient = Omit<
  ReturnType<typeof createPrismaClient>,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

/** A branch's inventory switches. */
export interface InventorySettingsValues {
  autoDeductEnabled: boolean;
  auto86Enabled: boolean;
  allowNegativeStock: boolean;
  lowStockAlertsEnabled: boolean;
}

/** Where and by whom a batch of stock changes is made. */
export interface StockContext {
  organizationId: string;
  branchId: string;
  businessDate: string;
  userId: string | null;
  settings: InventorySettingsValues;
}

/** One signed change to an ingredient's stock, in the ingredient's unit. */
export interface StockChange {
  inventoryItemId: string;
  quantity: number;
  type: StockMovementType;
  /** Cost of one unit; defaults to the branch's average cost. */
  unitCost?: number;
  wastageReason?: WastageReason;
  note?: string | null;
  purchaseId?: string;
  stockCountId?: string;
  kotId?: string;
  orderItemId?: string;
}

/** An ingredient that keeps a dish off the menu. */
export interface DishBlocker {
  inventoryItemId: string;
  name: string;
  quantity: number;
  unit: string;
}

/**
 * Rounds a number to a fixed number of decimals.
 *
 * @param value - The number.
 * @param places - Decimal places.
 * @returns The rounded number.
 */
export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  const rounded = Math.round((value + Math.sign(value) * Number.EPSILON) * factor) / factor;

  return rounded === 0 ? 0 : rounded;
}

/** Rounds a stock quantity (3 decimals). */
export const roundQuantity = (value: number) => roundTo(value, 3);

/** Rounds a rupee amount (2 decimals). */
export const roundMoney = (value: number) => roundTo(value, 2);

/** Rounds a unit cost (4 decimals). */
export const roundUnitCost = (value: number) => roundTo(value, 4);

/**
 * Converts a quantity between units of the same kind (kg↔g, l↔ml).
 *
 * @param quantity - The quantity in `from` units.
 * @param from - The unit it was entered in.
 * @param to - The ingredient's unit.
 * @param itemName - The ingredient's name, for the error message.
 * @returns The quantity in `to` units, rounded to 3 decimals.
 * @throws InventoryServiceError If the units can't be converted or the result rounds to 0.
 */
export function convertQuantity(
  quantity: number,
  from: InventoryUnit,
  to: InventoryUnit,
  itemName: string,
): number {
  if (from === to) {
    return roundQuantity(quantity);
  }

  const source = UNIT_SCALE[from];
  const target = UNIT_SCALE[to];

  if (source.dimension !== target.dimension) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.INCOMPATIBLE_UNIT,
      `${itemName} is measured in ${to.toLowerCase()}; ${from.toLowerCase()} can't be converted to it`,
    );
  }

  const converted = roundQuantity((quantity * source.toBase) / target.toBase);

  if (quantity !== 0 && converted === 0) {
    throw new InventoryServiceError(
      InventoryServiceErrorCode.INCOMPATIBLE_UNIT,
      `${quantity} ${from.toLowerCase()} is too small to record for ${itemName}; track it in ${target.dimension === "mass" ? "g" : "ml"} instead`,
    );
  }

  return converted;
}

/**
 * Works out an ingredient's stock status.
 *
 * @param quantity - The stock on hand.
 * @param lowStockLevel - The safety level (0 = no low-stock warning).
 * @returns The stock status.
 */
export function getStockStatus(quantity: number, lowStockLevel: number): StockStatus {
  if (quantity <= 0) {
    return StockStatus.OUT_OF_STOCK;
  }

  if (lowStockLevel > 0 && quantity <= lowStockLevel) {
    return StockStatus.LOW_STOCK;
  }

  return StockStatus.IN_STOCK;
}

/**
 * Loads a branch's inventory settings, falling back to the defaults.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @returns The settings.
 */
export async function getInventorySettingsInTx(
  tx: TransactionClient,
  branchId: string,
): Promise<InventorySettingsValues> {
  const settings = await tx.inventorySettings.findUnique({
    where: { branchId },
    select: {
      autoDeductEnabled: true,
      auto86Enabled: true,
      allowNegativeStock: true,
      lowStockAlertsEnabled: true,
    },
  });

  return settings ?? { ...DEFAULT_INVENTORY_SETTINGS };
}

/**
 * Builds the context for stock changes at a branch: its business day and
 * inventory settings.
 *
 * @param tx - The transaction client.
 * @param organizationId - The organization ID.
 * @param branchId - The branch ID.
 * @param userId - The user making the changes, if any.
 * @returns The stock context.
 */
export async function getStockContextInTx(
  tx: TransactionClient,
  organizationId: string,
  branchId: string,
  userId: string | null,
): Promise<StockContext> {
  const [branch, settings] = await Promise.all([
    tx.branch.findUniqueOrThrow({
      where: { id: branchId },
      select: { timezone: true, businessDayCutoff: true },
    }),
    getInventorySettingsInTx(tx, branchId),
  ]);

  return {
    organizationId,
    branchId,
    businessDate: getBusinessDate(branch.timezone, branch.businessDayCutoff),
    userId,
    settings,
  };
}

/**
 * Applies stock changes at a branch: updates each ingredient's balance and
 * average cost (purchases and opening stock), writes one ledger entry per
 * change, then refreshes alerts and dish availability.
 *
 * @param tx - The transaction client.
 * @param context - The branch, business day, user and settings.
 * @param changes - The signed changes, in each ingredient's unit.
 * @returns The live events to publish once the transaction commits.
 * @throws InventoryServiceError If stock would go negative and the branch doesn't allow it.
 */
export async function applyStockChangesInTx(
  tx: TransactionClient,
  context: StockContext,
  changes: StockChange[],
): Promise<InventoryEvent[]> {
  const nonZero = changes.filter((change) => roundQuantity(change.quantity) !== 0);

  if (nonZero.length === 0) {
    return [];
  }

  const itemIds = [...new Set(nonZero.map((change) => change.inventoryItemId))];
  const items = await tx.inventoryItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, name: true, unit: true },
  });
  const itemById = new Map(items.map((item) => [item.id, item]));
  const now = new Date();
  const movements = [];

  for (const itemId of itemIds) {
    const itemChanges = nonZero.filter((change) => change.inventoryItemId === itemId);
    const total = roundQuantity(itemChanges.reduce((sum, change) => sum + change.quantity, 0));

    const stock = await tx.branchStock.upsert({
      where: { branchId_inventoryItemId: { branchId: context.branchId, inventoryItemId: itemId } },
      create: {
        branchId: context.branchId,
        inventoryItemId: itemId,
        quantity: total,
        lastMovementAt: now,
      },
      update: { quantity: { increment: total }, lastMovementAt: now },
      select: { id: true, quantity: true, avgUnitCost: true },
    });

    const quantityAfter = stock.quantity.toNumber();
    const quantityBefore = roundQuantity(quantityAfter - total);

    if (!context.settings.allowNegativeStock && total < 0 && quantityAfter < 0) {
      const item = itemById.get(itemId);

      throw new InventoryServiceError(
        InventoryServiceErrorCode.INSUFFICIENT_STOCK,
        `Not enough ${item?.name ?? "stock"}: only ${Math.max(quantityBefore, 0)} ${item?.unit.toLowerCase() ?? ""} left`,
      );
    }

    // Weighted average cost: stock received at a price blends into what's on hand.
    let avgUnitCost = stock.avgUnitCost.toNumber();
    const received = itemChanges.filter(
      (change) =>
        (change.type === StockMovementType.PURCHASE || change.type === StockMovementType.OPENING) &&
        change.quantity > 0 &&
        change.unitCost !== undefined,
    );

    if (received.length > 0) {
      const receivedQuantity = received.reduce((sum, change) => sum + change.quantity, 0);
      const receivedCost = received.reduce(
        (sum, change) => sum + change.quantity * (change.unitCost ?? 0),
        0,
      );
      const onHand = Math.max(quantityBefore, 0);

      avgUnitCost = roundUnitCost(
        onHand <= 0
          ? receivedCost / receivedQuantity
          : (onHand * avgUnitCost + receivedCost) / (onHand + receivedQuantity),
      );

      await tx.branchStock.update({ where: { id: stock.id }, data: { avgUnitCost } });
    }

    let running = quantityBefore;

    for (const change of itemChanges) {
      const quantity = roundQuantity(change.quantity);
      const unitCost = roundUnitCost(change.unitCost ?? avgUnitCost);
      running = roundQuantity(running + quantity);

      movements.push({
        organizationId: context.organizationId,
        branchId: context.branchId,
        inventoryItemId: itemId,
        type: change.type,
        quantity,
        stockAfter: running,
        unitCost,
        value: roundMoney(quantity * unitCost),
        businessDate: context.businessDate,
        wastageReason: change.wastageReason ?? null,
        note: change.note ?? null,
        purchaseId: change.purchaseId ?? null,
        stockCountId: change.stockCountId ?? null,
        kotId: change.kotId ?? null,
        orderItemId: change.orderItemId ?? null,
        createdById: context.userId,
      });
    }
  }

  await tx.stockMovement.createMany({ data: movements });

  return refreshStockStateInTx(tx, context, itemIds);
}

/**
 * Re-checks ingredients after their stock changed: opens or resolves
 * low/out-of-stock alerts and refreshes the availability of dishes that
 * use them.
 *
 * @param tx - The transaction client.
 * @param context - The branch and its settings.
 * @param inventoryItemIds - The ingredients to check.
 * @returns The live events to publish once the transaction commits.
 */
export async function refreshStockStateInTx(
  tx: TransactionClient,
  context: Pick<StockContext, "organizationId" | "branchId" | "settings">,
  inventoryItemIds: string[],
): Promise<InventoryEvent[]> {
  if (inventoryItemIds.length === 0) {
    return [];
  }

  const [stocks, openAlerts] = await Promise.all([
    tx.branchStock.findMany({
      where: { branchId: context.branchId, inventoryItemId: { in: inventoryItemIds } },
      select: {
        inventoryItemId: true,
        quantity: true,
        lowStockLevel: true,
        inventoryItem: { select: { name: true, unit: true, isActive: true } },
      },
    }),
    tx.stockAlert.findMany({
      where: {
        branchId: context.branchId,
        inventoryItemId: { in: inventoryItemIds },
        status: { in: [StockAlertStatus.ACTIVE, StockAlertStatus.ACKNOWLEDGED] },
      },
      select: { id: true, inventoryItemId: true, type: true },
    }),
  ]);

  const events: InventoryEvent[] = [];
  const now = new Date();

  for (const stock of stocks) {
    const quantity = stock.quantity.toNumber();
    const lowStockLevel = stock.lowStockLevel.toNumber();
    const status = getStockStatus(quantity, lowStockLevel);
    const alertType =
      status === StockStatus.OUT_OF_STOCK
        ? StockAlertType.OUT_OF_STOCK
        : status === StockStatus.LOW_STOCK
          ? StockAlertType.LOW_STOCK
          : null;
    const itemAlerts = openAlerts.filter((alert) => alert.inventoryItemId === stock.inventoryItemId);

    if (alertType && itemAlerts.some((alert) => alert.type === alertType)) {
      continue;
    }

    // Stock recovered, or moved from low to out (or back): close the old alert.
    if (itemAlerts.length > 0) {
      await tx.stockAlert.updateMany({
        where: { id: { in: itemAlerts.map((alert) => alert.id) } },
        data: { status: StockAlertStatus.RESOLVED, resolvedAt: now },
      });
    }

    if (!alertType || !context.settings.lowStockAlertsEnabled || !stock.inventoryItem.isActive) {
      continue;
    }

    const alert = await tx.stockAlert.create({
      data: {
        organizationId: context.organizationId,
        branchId: context.branchId,
        inventoryItemId: stock.inventoryItemId,
        type: alertType,
        quantity,
        lowStockLevel,
      },
      select: { id: true, createdAt: true },
    });

    events.push({
      branchId: context.branchId,
      event:
        alertType === StockAlertType.OUT_OF_STOCK
          ? InventoryEventName.OUT_OF_STOCK
          : InventoryEventName.LOW_STOCK,
      data: {
        alertId: alert.id,
        inventoryItemId: stock.inventoryItemId,
        name: stock.inventoryItem.name,
        unit: stock.inventoryItem.unit.toLowerCase(),
        quantity,
        lowStockLevel,
        createdAt: alert.createdAt,
      },
    });
  }

  const dishLines = await tx.recipeLine.findMany({
    where: { inventoryItemId: { in: inventoryItemIds }, addonId: null },
    select: { menuItemId: true },
    distinct: ["menuItemId"],
  });

  events.push(
    ...(await refreshDishAvailabilityInTx(
      tx,
      context.branchId,
      context.settings,
      dishLines.map((line) => line.menuItemId),
    )),
  );

  return events;
}

/**
 * Finds, for each dish, the essential ingredients that are out of stock at
 * a branch. Only ingredients the branch tracks (has a stock row for) can
 * block a dish; add-on ingredients never do.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @param menuItemIds - The dishes to check.
 * @returns The blocking ingredients per dish (dishes with none are left out).
 */
export async function getDishBlockersInTx(
  tx: TransactionClient,
  branchId: string,
  menuItemIds: string[],
): Promise<Map<string, DishBlocker[]>> {
  const blockers = new Map<string, DishBlocker[]>();

  if (menuItemIds.length === 0) {
    return blockers;
  }

  const lines = await tx.recipeLine.findMany({
    where: {
      menuItemId: { in: menuItemIds },
      addonId: null,
      inventoryItem: { isActive: true, isEssential: true },
    },
    select: {
      menuItemId: true,
      inventoryItemId: true,
      inventoryItem: { select: { name: true, unit: true } },
    },
  });

  const stocks = await tx.branchStock.findMany({
    where: { branchId, inventoryItemId: { in: [...new Set(lines.map((line) => line.inventoryItemId))] } },
    select: { inventoryItemId: true, quantity: true },
  });
  const quantityById = new Map(stocks.map((stock) => [stock.inventoryItemId, stock.quantity.toNumber()]));

  for (const line of lines) {
    const quantity = quantityById.get(line.inventoryItemId);

    if (quantity === undefined || quantity > 0) {
      continue;
    }

    const dishBlockers = blockers.get(line.menuItemId) ?? [];

    if (!dishBlockers.some((blocker) => blocker.inventoryItemId === line.inventoryItemId)) {
      dishBlockers.push({
        inventoryItemId: line.inventoryItemId,
        name: line.inventoryItem.name,
        quantity,
        unit: line.inventoryItem.unit.toLowerCase(),
      });
    }

    blockers.set(line.menuItemId, dishBlockers);
  }

  return blockers;
}

/**
 * Turns dishes off at a branch when an essential ingredient has run out
 * (auto-86), and back on once nothing blocks them. Only dishes auto-86
 * turned off are turned back on; a manager's manual "unavailable" stays.
 *
 * @param tx - The transaction client.
 * @param branchId - The branch ID.
 * @param settings - The branch's inventory settings.
 * @param menuItemIds - The dishes to check.
 * @returns The live events to publish once the transaction commits.
 */
export async function refreshDishAvailabilityInTx(
  tx: TransactionClient,
  branchId: string,
  settings: InventorySettingsValues,
  menuItemIds: string[],
): Promise<InventoryEvent[]> {
  if (menuItemIds.length === 0) {
    return [];
  }

  const [branchItems, blockers] = await Promise.all([
    tx.branchMenuItem.findMany({
      where: { branchId, menuItemId: { in: menuItemIds } },
      select: {
        id: true,
        menuItemId: true,
        isAvailable: true,
        autoUnavailableAt: true,
        menuItem: { select: { name: true } },
      },
    }),
    getDishBlockersInTx(tx, branchId, menuItemIds),
  ]);

  const now = new Date();
  const turnedOff = [];
  const restored = [];

  for (const branchItem of branchItems) {
    const dishBlockers = blockers.get(branchItem.menuItemId) ?? [];

    if (dishBlockers.length > 0 && settings.auto86Enabled && branchItem.isAvailable) {
      await tx.branchMenuItem.update({
        where: { id: branchItem.id },
        data: { isAvailable: false, autoUnavailableAt: now },
      });
      turnedOff.push({
        menuItemId: branchItem.menuItemId,
        name: branchItem.menuItem.name,
        blockedBy: dishBlockers.map(({ inventoryItemId, name }) => ({ inventoryItemId, name })),
      });
    } else if (dishBlockers.length === 0 && branchItem.autoUnavailableAt) {
      await tx.branchMenuItem.update({
        where: { id: branchItem.id },
        data: { isAvailable: true, autoUnavailableAt: null },
      });
      restored.push({ menuItemId: branchItem.menuItemId, name: branchItem.menuItem.name });
    }
  }

  const events: InventoryEvent[] = [];

  if (turnedOff.length > 0) {
    events.push({ branchId, event: InventoryEventName.DISHES_86, data: { dishes: turnedOff } });
  }

  if (restored.length > 0) {
    events.push({ branchId, event: InventoryEventName.DISHES_RESTORED, data: { dishes: restored } });
  }

  return events;
}

/**
 * Refreshes dish availability in every branch that sells the dishes, e.g.
 * after a recipe changed or an ingredient stopped being essential.
 *
 * @param tx - The transaction client.
 * @param menuItemIds - The dishes to check.
 * @returns The live events to publish once the transaction commits.
 */
export async function refreshDishesInAllBranchesInTx(
  tx: TransactionClient,
  menuItemIds: string[],
): Promise<InventoryEvent[]> {
  if (menuItemIds.length === 0) {
    return [];
  }

  const branches = await tx.branchMenuItem.findMany({
    where: { menuItemId: { in: menuItemIds } },
    select: { branchId: true },
    distinct: ["branchId"],
  });

  const events: InventoryEvent[] = [];

  for (const { branchId } of branches) {
    const settings = await getInventorySettingsInTx(tx, branchId);
    events.push(...(await refreshDishAvailabilityInTx(tx, branchId, settings, menuItemIds)));
  }

  return events;
}

/**
 * Deducts the ingredients of a KOT's dishes (recipe × quantity, using the
 * variant's own recipe if it has one, plus add-on recipes). Dishes
 * without a recipe and inactive ingredients are skipped. Called by the
 * orders module when a KOT is sent; events go out after the commit.
 *
 * @param tx - The transaction client.
 * @param kot - The KOT, its branch and organization, and the user sending it.
 * @throws InventoryServiceError If stock would go negative and the branch doesn't allow it.
 */
export async function deductStockForKotInTx(
  tx: TransactionClient,
  kot: { organizationId: string; branchId: string; kotId: string; userId: string },
): Promise<void> {
  const settings = await getInventorySettingsInTx(tx, kot.branchId);

  if (!settings.autoDeductEnabled) {
    return;
  }

  const orderItems = await tx.orderItem.findMany({
    where: { kotId: kot.kotId, menuItemId: { not: null } },
    select: { id: true, menuItemId: true, variantId: true, addons: true, quantity: true },
  });

  if (orderItems.length === 0) {
    return;
  }

  const recipeLines = await tx.recipeLine.findMany({
    where: {
      menuItemId: { in: [...new Set(orderItems.map((item) => item.menuItemId as string))] },
      inventoryItem: { isActive: true },
    },
    select: { menuItemId: true, variantId: true, addonId: true, inventoryItemId: true, quantity: true },
  });

  if (recipeLines.length === 0) {
    return;
  }

  const changes: StockChange[] = [];

  for (const orderItem of orderItems) {
    const dishLines = recipeLines.filter(
      (line) => line.menuItemId === orderItem.menuItemId && line.addonId === null,
    );
    const variantLines = orderItem.variantId
      ? dishLines.filter((line) => line.variantId === orderItem.variantId)
      : [];
    const servingLines =
      variantLines.length > 0 ? variantLines : dishLines.filter((line) => line.variantId === null);

    const addonIds = Array.isArray(orderItem.addons)
      ? orderItem.addons.flatMap((addon) =>
          addon && typeof addon === "object" && "id" in addon && typeof addon.id === "string"
            ? [addon.id]
            : [],
        )
      : [];
    const addonLines = recipeLines.filter(
      (line) => line.menuItemId === orderItem.menuItemId && line.addonId !== null && addonIds.includes(line.addonId),
    );

    const perIngredient = new Map<string, number>();

    for (const line of [...servingLines, ...addonLines]) {
      perIngredient.set(
        line.inventoryItemId,
        (perIngredient.get(line.inventoryItemId) ?? 0) + line.quantity.toNumber() * orderItem.quantity,
      );
    }

    for (const [inventoryItemId, quantity] of perIngredient) {
      changes.push({
        inventoryItemId,
        quantity: -roundQuantity(quantity),
        type: StockMovementType.SALE,
        kotId: kot.kotId,
        orderItemId: orderItem.id,
      });
    }
  }

  if (changes.length === 0) {
    return;
  }

  const context = await getStockContextInTx(tx, kot.organizationId, kot.branchId, kot.userId);
  queueInventoryEvents(await applyStockChangesInTx(tx, { ...context, settings }, changes));
}

/**
 * Puts back the ingredients deducted for order lines that were voided or
 * cancelled, at the cost they were taken out at. Safe to call twice: only
 * what is still deducted is returned.
 *
 * @param tx - The transaction client.
 * @param reversal - The branch, organization, order lines, user and reason.
 */
export async function reverseStockForOrderItemsInTx(
  tx: TransactionClient,
  reversal: {
    organizationId: string;
    branchId: string;
    orderItemIds: string[];
    userId: string;
    note: string;
  },
): Promise<void> {
  if (reversal.orderItemIds.length === 0) {
    return;
  }

  const deducted = await tx.stockMovement.groupBy({
    by: ["orderItemId", "inventoryItemId"],
    where: {
      branchId: reversal.branchId,
      orderItemId: { in: reversal.orderItemIds },
      type: { in: [StockMovementType.SALE, StockMovementType.SALE_REVERSAL] },
    },
    _sum: { quantity: true, value: true },
  });

  const changes: StockChange[] = [];

  for (const entry of deducted) {
    const netQuantity = roundQuantity(entry._sum.quantity?.toNumber() ?? 0);
    const netValue = entry._sum.value?.toNumber() ?? 0;

    if (netQuantity >= 0 || !entry.orderItemId) {
      continue;
    }

    changes.push({
      inventoryItemId: entry.inventoryItemId,
      quantity: -netQuantity,
      type: StockMovementType.SALE_REVERSAL,
      unitCost: roundUnitCost(netValue / netQuantity),
      orderItemId: entry.orderItemId,
      note: reversal.note,
    });
  }

  if (changes.length === 0) {
    return;
  }

  const context = await getStockContextInTx(
    tx,
    reversal.organizationId,
    reversal.branchId,
    reversal.userId,
  );
  queueInventoryEvents(await applyStockChangesInTx(tx, context, changes));
}
