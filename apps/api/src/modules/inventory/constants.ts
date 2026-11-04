import type { UserRole } from "@morfikos/auth";
import type {
  InventoryCategoryValue,
  InventoryUnitValue,
  StockAlertStatusValue,
  StockMovementTypeValue,
  WastageReasonValue,
} from "@morfikos/validation";

/**
 * Units stock is kept in. Values match the Prisma `InventoryUnit` enum.
 */
export enum InventoryUnit {
  KG = "KG",
  G = "G",
  L = "L",
  ML = "ML",
  PCS = "PCS",
}

/**
 * Ingredient categories. Values match the Prisma `InventoryCategory` enum.
 */
export enum InventoryCategory {
  VEGETABLES = "VEGETABLES",
  FRUITS = "FRUITS",
  DAIRY = "DAIRY",
  MEAT = "MEAT",
  SEAFOOD = "SEAFOOD",
  GROCERY = "GROCERY",
  SPICES = "SPICES",
  BEVERAGES = "BEVERAGES",
  BAKERY = "BAKERY",
  PACKAGING = "PACKAGING",
  CLEANING = "CLEANING",
  OTHER = "OTHER",
}

/**
 * Stock ledger entry types. Values match the Prisma `StockMovementType` enum.
 */
export enum StockMovementType {
  OPENING = "OPENING",
  PURCHASE = "PURCHASE",
  SALE = "SALE",
  SALE_REVERSAL = "SALE_REVERSAL",
  WASTAGE = "WASTAGE",
  COUNT = "COUNT",
  ADJUSTMENT = "ADJUSTMENT",
}

/**
 * Why stock was thrown away. Values match the Prisma `WastageReason` enum.
 */
export enum WastageReason {
  SPOILED = "SPOILED",
  EXPIRED = "EXPIRED",
  SPILLED = "SPILLED",
  OVERCOOKED = "OVERCOOKED",
  STAFF_MEAL = "STAFF_MEAL",
  OTHER = "OTHER",
}

/**
 * Stock alert kinds. Values match the Prisma `StockAlertType` enum.
 */
export enum StockAlertType {
  LOW_STOCK = "LOW_STOCK",
  OUT_OF_STOCK = "OUT_OF_STOCK",
}

/**
 * Stock alert lifecycle. Values match the Prisma `StockAlertStatus` enum.
 */
export enum StockAlertStatus {
  ACTIVE = "ACTIVE",
  ACKNOWLEDGED = "ACKNOWLEDGED",
  RESOLVED = "RESOLVED",
}

/**
 * An ingredient's stock status at a branch, as returned by the API.
 */
export enum StockStatus {
  IN_STOCK = "in_stock",
  LOW_STOCK = "low_stock",
  OUT_OF_STOCK = "out_of_stock",
}

/**
 * Live inventory events pushed to a branch's screens.
 */
export enum InventoryEventName {
  LOW_STOCK = "inventory.low_stock",
  OUT_OF_STOCK = "inventory.out_of_stock",
  DISHES_86 = "inventory.dishes_86",
  DISHES_RESTORED = "inventory.dishes_restored",
}

/** API unit → stored unit. */
export const UNIT_FROM_API: Record<InventoryUnitValue, InventoryUnit> = {
  kg: InventoryUnit.KG,
  g: InventoryUnit.G,
  l: InventoryUnit.L,
  ml: InventoryUnit.ML,
  pcs: InventoryUnit.PCS,
};

/** API category → stored category. */
export const CATEGORY_FROM_API: Record<InventoryCategoryValue, InventoryCategory> = {
  vegetables: InventoryCategory.VEGETABLES,
  fruits: InventoryCategory.FRUITS,
  dairy: InventoryCategory.DAIRY,
  meat: InventoryCategory.MEAT,
  seafood: InventoryCategory.SEAFOOD,
  grocery: InventoryCategory.GROCERY,
  spices: InventoryCategory.SPICES,
  beverages: InventoryCategory.BEVERAGES,
  bakery: InventoryCategory.BAKERY,
  packaging: InventoryCategory.PACKAGING,
  cleaning: InventoryCategory.CLEANING,
  other: InventoryCategory.OTHER,
};

/** API movement type → stored movement type. */
export const MOVEMENT_TYPE_FROM_API: Record<StockMovementTypeValue, StockMovementType> = {
  opening: StockMovementType.OPENING,
  purchase: StockMovementType.PURCHASE,
  sale: StockMovementType.SALE,
  sale_reversal: StockMovementType.SALE_REVERSAL,
  wastage: StockMovementType.WASTAGE,
  count: StockMovementType.COUNT,
  adjustment: StockMovementType.ADJUSTMENT,
};

/** API wastage reason → stored wastage reason. */
export const WASTAGE_REASON_FROM_API: Record<WastageReasonValue, WastageReason> = {
  spoiled: WastageReason.SPOILED,
  expired: WastageReason.EXPIRED,
  spilled: WastageReason.SPILLED,
  overcooked: WastageReason.OVERCOOKED,
  staff_meal: WastageReason.STAFF_MEAL,
  other: WastageReason.OTHER,
};

/** API alert status → stored alert status. */
export const ALERT_STATUS_FROM_API: Record<StockAlertStatusValue, StockAlertStatus> = {
  active: StockAlertStatus.ACTIVE,
  acknowledged: StockAlertStatus.ACKNOWLEDGED,
  resolved: StockAlertStatus.RESOLVED,
};

/**
 * Each unit's dimension and size in its base unit (g, ml or pcs). Units of
 * the same dimension convert into each other.
 */
export const UNIT_SCALE: Record<InventoryUnit, { dimension: string; toBase: number }> = {
  [InventoryUnit.KG]: { dimension: "mass", toBase: 1000 },
  [InventoryUnit.G]: { dimension: "mass", toBase: 1 },
  [InventoryUnit.L]: { dimension: "volume", toBase: 1000 },
  [InventoryUnit.ML]: { dimension: "volume", toBase: 1 },
  [InventoryUnit.PCS]: { dimension: "count", toBase: 1 },
};

/** Defaults for a branch without saved inventory settings. */
export const DEFAULT_INVENTORY_SETTINGS = {
  autoDeductEnabled: true,
  auto86Enabled: true,
  allowNegativeStock: true,
  lowStockAlertsEnabled: true,
} as const;

/** How many recent movements an item's detail view shows. */
export const RECENT_MOVEMENTS_LIMIT = 10;

/** Low-stock reorder suggestion: refill to this many times the low-stock level. */
export const REORDER_TARGET_MULTIPLIER = 2;

/** Roles that can view stock, record wastage and receive goods. */
export const INVENTORY_STAFF_ROLES: UserRole[] = ["owner", "manager", "staff"];

/** Roles that manage items, recipes, suppliers, counts, settings and reports. */
export const INVENTORY_MANAGER_ROLES: UserRole[] = ["owner", "manager"];

/** Interactive transaction limits for stock work. */
export const INVENTORY_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 };
