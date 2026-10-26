import { createPrismaClient } from "@morfikos/database";
import type {
  CreateCategoryInput,
  CreateCuisineInput,
  CreateMenuItemInput,
  ListMenuItemsQuery,
  ListMenuQuery,
  UpdateCategoryInput,
  UpdateCuisineInput,
  UpdateMenuItemInput,
  UpsertBranchMenuItemInput,
} from "@morfikos/validation";

import { MenuServiceErrorCode } from "@morfikos/auth";

import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";

const prisma = createPrismaClient();

/**
 * Fields returned for categories and cuisines in API responses.
 */
const menuEntitySelect = {
  id: true,
  name: true,
  description: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Fields returned when a category or cuisine is deactivated.
 */
const menuStatusSelect = {
  id: true,
  isActive: true,
  updatedAt: true,
} as const;

/**
 * Represents errors that can occur during menu operations.
 */
export class MenuServiceError extends Error {
  /**
   * Creates a menu service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: MenuServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MenuServiceError";
  }
}

/**
 * Ensures the organization exists and is active.
 *
 * @param organizationId - The organization ID.
 * @throws MenuServiceError If the organization does not exist or is inactive.
 */
async function assertActiveOrganization(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { status: true },
  });

  if (!organization || organization.status !== "active") {
    throw new MenuServiceError(
      MenuServiceErrorCode.ORGANIZATION_NOT_FOUND,
      "Active organization not found",
    );
  }
}

/**
 * Creates a menu category for an organization.
 *
 * @param data - The validated category details.
 * @returns The created category.
 * @throws MenuServiceError If the organization is inactive or the name is taken.
 */
export async function createCategory(data: CreateCategoryInput) {
  await assertActiveOrganization(data.organizationId);

  try {
    return await prisma.menuCategory.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        description: data.description || null,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
      select: menuEntitySelect,
    });
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new MenuServiceError(
        MenuServiceErrorCode.CATEGORY_NAME_CONFLICT,
        "A category with this name already exists",
      );
    }

    throw error;
  }
}

/**
 * Retrieves a paginated list of menu categories for an organization.
 *
 * @param organizationId - The owning organization ID.
 * @param isActive - The active state to filter by, or undefined for all.
 * @param limit - The maximum number of categories to return.
 * @param offset - The number of categories to skip.
 * @returns The categories and pagination metadata.
 */
export async function listCategories(
  organizationId: string,
  isActive: ListMenuQuery["isActive"],
  limit: number,
  offset: number,
) {
  const where = {
    organizationId,
    ...(isActive !== undefined && { isActive }),
  };

  const [categories, total] = await Promise.all([
    prisma.menuCategory.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      take: limit,
      skip: offset,
      select: menuEntitySelect,
    }),
    prisma.menuCategory.count({ where }),
  ]);

  return { total, limit, offset, categories };
}

/**
 * Updates the provided fields of a menu category.
 *
 * Fields not provided in the input are left unchanged.
 *
 * @param id - The category ID.
 * @param organizationId - The owning organization ID.
 * @param data - The validated fields to update.
 * @returns The updated category, or null if not found.
 * @throws MenuServiceError If the new name is already taken.
 */
export async function updateCategory(
  id: string,
  organizationId: string,
  data: UpdateCategoryInput,
) {
  const existing = await prisma.menuCategory.findFirst({
    where: { id, organizationId },
    select: { id: true },
  });

  if (!existing) {
    return null;
  }

  try {
    return await prisma.menuCategory.update({
      where: { id: existing.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && {
          description: data.description || null,
        }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      select: menuEntitySelect,
    });
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new MenuServiceError(
        MenuServiceErrorCode.CATEGORY_NAME_CONFLICT,
        "A category with this name already exists",
      );
    }

    throw error;
  }
}

/**
 * Soft-deactivates a menu category without removing linked menu history.
 *
 * @param id - The category ID.
 * @param organizationId - The owning organization ID.
 * @returns The category status details, or null if not found.
 */
export async function deactivateCategory(
  id: string,
  organizationId: string,
) {
  const existing = await prisma.menuCategory.findFirst({
    where: { id, organizationId },
    select: menuStatusSelect,
  });

  if (!existing) {
    return null;
  }

  if (!existing.isActive) {
    return existing;
  }

  return prisma.menuCategory.update({
    where: { id: existing.id },
    data: { isActive: false },
    select: menuStatusSelect,
  });
}

/**
 * Creates a cuisine for an organization.
 *
 * @param data - The validated cuisine details.
 * @returns The created cuisine.
 * @throws MenuServiceError If the organization is inactive or the name is taken.
 */
export async function createCuisine(data: CreateCuisineInput) {
  await assertActiveOrganization(data.organizationId);

  try {
    return await prisma.cuisine.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        description: data.description || null,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
      select: menuEntitySelect,
    });
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new MenuServiceError(
        MenuServiceErrorCode.CUISINE_NAME_CONFLICT,
        "A cuisine with this name already exists",
      );
    }

    throw error;
  }
}

/**
 * Retrieves a paginated list of cuisines for an organization.
 *
 * @param organizationId - The owning organization ID.
 * @param isActive - The active state to filter by, or undefined for all.
 * @param limit - The maximum number of cuisines to return.
 * @param offset - The number of cuisines to skip.
 * @returns The cuisines and pagination metadata.
 */
export async function listCuisines(
  organizationId: string,
  isActive: ListMenuQuery["isActive"],
  limit: number,
  offset: number,
) {
  const where = {
    organizationId,
    ...(isActive !== undefined && { isActive }),
  };

  const [cuisines, total] = await Promise.all([
    prisma.cuisine.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      take: limit,
      skip: offset,
      select: menuEntitySelect,
    }),
    prisma.cuisine.count({ where }),
  ]);

  return { total, limit, offset, cuisines };
}

/**
 * Updates the provided fields of a cuisine.
 *
 * Fields not provided in the input are left unchanged.
 *
 * @param id - The cuisine ID.
 * @param organizationId - The owning organization ID.
 * @param data - The validated fields to update.
 * @returns The updated cuisine, or null if not found.
 * @throws MenuServiceError If the new name is already taken.
 */
export async function updateCuisine(
  id: string,
  organizationId: string,
  data: UpdateCuisineInput,
) {
  const existing = await prisma.cuisine.findFirst({
    where: { id, organizationId },
    select: { id: true },
  });

  if (!existing) {
    return null;
  }

  try {
    return await prisma.cuisine.update({
      where: { id: existing.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && {
          description: data.description || null,
        }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      select: menuEntitySelect,
    });
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new MenuServiceError(
        MenuServiceErrorCode.CUISINE_NAME_CONFLICT,
        "A cuisine with this name already exists",
      );
    }

    throw error;
  }
}

/**
 * Soft-deactivates a cuisine without removing linked menu history.
 *
 * @param id - The cuisine ID.
 * @param organizationId - The owning organization ID.
 * @returns The cuisine status details, or null if not found.
 */
export async function deactivateCuisine(
  id: string,
  organizationId: string,
) {
  const existing = await prisma.cuisine.findFirst({
    where: { id, organizationId },
    select: menuStatusSelect,
  });

  if (!existing) {
    return null;
  }

  if (!existing.isActive) {
    return existing;
  }

  return prisma.cuisine.update({
    where: { id: existing.id },
    data: { isActive: false },
    select: menuStatusSelect,
  });
}

/**
 * Fields returned for menu items in API responses.
 */
const menuItemSelect = {
  id: true,
  name: true,
  description: true,
  category: { select: { id: true, name: true } },
  gst: true,
  hsn: true,
  imageUrl: true,
  isVeg: true,
  isJain: true,
  isRecommended: true,
  allergens: true,
  preparationTime: true,
  kitchenStation: true,
  sortOrder: true,
  timingEnabled: true,
  availableDays: true,
  availableTimeStart: true,
  availableTimeEnd: true,
  isActive: true,
  variants: {
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      extraPrice: true,
      dineInAvailable: true,
      parcelAvailable: true,
      deliveryAvailable: true,
    },
  },
  addons: {
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, price: true, isVeg: true },
  },
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Branch-level fields of a menu item (price, availability and channels).
 */
const branchItemSelect = {
  menuItemId: true,
  price: true,
  costPrice: true,
  comparePrice: true,
  isAvailable: true,
  dineInAvailable: true,
  parcelAvailable: true,
  deliveryAvailable: true,
  maxQuantityPerOrder: true,
} as const;

/**
 * A Prisma Decimal value, typed structurally so the Prisma namespace
 * does not need to be imported.
 */
type DecimalValue = { toNumber(): number };

/**
 * Branch-level menu item fields as selected by {@link branchItemSelect}.
 */
type BranchItemRecord = {
  price: DecimalValue;
  costPrice: DecimalValue | null;
  comparePrice: DecimalValue | null;
  isAvailable: boolean;
  dineInAvailable: boolean;
  parcelAvailable: boolean;
  deliveryAvailable: boolean;
  maxQuantityPerOrder: number | null;
};

/**
 * Converts a Prisma Decimal to a JSON-friendly number.
 *
 * @param value - The Decimal value, or null.
 * @returns The numeric value, or null.
 */
function decimalToNumber(value: DecimalValue | null): number | null {
  return value === null ? null : value.toNumber();
}

/**
 * Serializes a menu item by converting its Decimal fields (GST, variant
 * extra prices and addon prices) to numbers.
 *
 * @param item - A menu item record selected with {@link menuItemSelect}.
 * @returns The menu item with numeric values.
 */
function serializeMenuItem<
  T extends {
    gst: DecimalValue;
    variants: Array<{ extraPrice: DecimalValue }>;
    addons: Array<{ price: DecimalValue }>;
  },
>(item: T) {
  return {
    ...item,
    gst: item.gst.toNumber(),
    variants: item.variants.map((variant) => ({
      ...variant,
      extraPrice: variant.extraPrice.toNumber(),
    })),
    addons: item.addons.map((addon) => ({
      ...addon,
      price: addon.price.toNumber(),
    })),
  };
}

/**
 * Serializes the branch-level fields of a menu item. An item that has not
 * been priced at the branch yet is reported as unpriced and unavailable.
 *
 * @param branchItem - The branch entry, or undefined if not priced there.
 * @param includeCostPrice - Whether the cost price may be returned.
 * @returns The branch price, availability and ordering channels.
 */
function serializeBranchFields(
  branchItem: BranchItemRecord | undefined,
  includeCostPrice: boolean,
) {
  return {
    price: branchItem ? branchItem.price.toNumber() : null,
    comparePrice: branchItem ? decimalToNumber(branchItem.comparePrice) : null,
    // Cost price is margin data, so only owners and managers see it.
    ...(includeCostPrice && {
      costPrice: branchItem ? decimalToNumber(branchItem.costPrice) : null,
    }),
    isAvailable: branchItem?.isAvailable ?? false,
    dineInAvailable: branchItem?.dineInAvailable ?? false,
    parcelAvailable: branchItem?.parcelAvailable ?? false,
    deliveryAvailable: branchItem?.deliveryAvailable ?? false,
    maxQuantityPerOrder: branchItem?.maxQuantityPerOrder ?? null,
  };
}

/**
 * Creates a menu item, with its variants and addons, under an active
 * category of the organization.
 *
 * @param data - The validated menu item details.
 * @returns The created menu item.
 * @throws MenuServiceError If the organization or category is not found,
 * or an item with the same name exists in the category.
 */
export async function createMenuItem(data: CreateMenuItemInput) {
  await assertActiveOrganization(data.organizationId);

  const category = await prisma.menuCategory.findFirst({
    where: {
      id: data.categoryId,
      organizationId: data.organizationId,
      isActive: true,
    },
    select: { id: true },
  });

  if (!category) {
    throw new MenuServiceError(
      MenuServiceErrorCode.CATEGORY_NOT_FOUND,
      "Active category not found",
    );
  }

  try {
    // Nested creates keep the item, its variants and addons atomic.
    const item = await prisma.menuItem.create({
      data: {
        organizationId: data.organizationId,
        categoryId: data.categoryId,
        name: data.name,
        description: data.description || null,
        gst: data.gst,
        hsn: data.hsn,
        imageUrl: data.imageUrl ?? null,
        isVeg: data.isVeg,
        isJain: data.isJain,
        isRecommended: data.isRecommended,
        allergens: data.allergens,
        preparationTime: data.preparationTime ?? null,
        kitchenStation: data.kitchenStation,
        sortOrder: data.sortOrder,
        timingEnabled: data.timingEnabled,
        availableDays: data.availableDays,
        // Times only apply when timing restrictions are enabled.
        availableTimeStart: data.timingEnabled ? (data.availableTimeStart ?? null) : null,
        availableTimeEnd: data.timingEnabled ? (data.availableTimeEnd ?? null) : null,
        isActive: data.isActive,
        variants: {
          create: data.variants.map((variant, index) => ({
            ...variant,
            sortOrder: index,
          })),
        },
        addons: {
          create: data.addons.map((addon, index) => ({
            ...addon,
            sortOrder: index,
          })),
        },
      },
      select: menuItemSelect,
    });

    return serializeMenuItem(item);
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new MenuServiceError(
        MenuServiceErrorCode.MENU_ITEM_NAME_CONFLICT,
        "A menu item with this name already exists in this category",
      );
    }

    throw error;
  }
}

/**
 * Updates the provided fields of a menu item.
 *
 * Fields not provided are left unchanged. When `variants` or `addons` are
 * provided they replace the item's existing lists. Timing is validated
 * against the merged (stored + provided) values, and times are cleared
 * when timing is disabled.
 *
 * @param id - The menu item ID.
 * @param organizationId - The owning organization ID.
 * @param data - The validated fields to update.
 * @returns The updated menu item, or null if not found.
 * @throws MenuServiceError If the new category is not found, timing is
 * incomplete, or the new name is already taken in the category.
 */
export async function updateMenuItem(
  id: string,
  organizationId: string,
  data: UpdateMenuItemInput,
) {
  const existing = await prisma.menuItem.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      timingEnabled: true,
      availableTimeStart: true,
      availableTimeEnd: true,
    },
  });

  if (!existing) {
    return null;
  }

  if (data.categoryId !== undefined) {
    const category = await prisma.menuCategory.findFirst({
      where: { id: data.categoryId, organizationId, isActive: true },
      select: { id: true },
    });

    if (!category) {
      throw new MenuServiceError(
        MenuServiceErrorCode.CATEGORY_NOT_FOUND,
        "Active category not found",
      );
    }
  }

  const timingEnabled = data.timingEnabled ?? existing.timingEnabled;
  const availableTimeStart =
    data.availableTimeStart !== undefined
      ? data.availableTimeStart
      : existing.availableTimeStart;
  const availableTimeEnd =
    data.availableTimeEnd !== undefined
      ? data.availableTimeEnd
      : existing.availableTimeEnd;

  if (timingEnabled && (!availableTimeStart || !availableTimeEnd)) {
    throw new MenuServiceError(
      MenuServiceErrorCode.INVALID_ITEM_TIMING,
      "availableTimeStart and availableTimeEnd are required when timingEnabled is true",
    );
  }

  try {
    const item = await prisma.menuItem.update({
      where: { id: existing.id },
      data: {
        ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && {
          description: data.description || null,
        }),
        ...(data.gst !== undefined && { gst: data.gst }),
        ...(data.hsn !== undefined && { hsn: data.hsn }),
        ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
        ...(data.isVeg !== undefined && { isVeg: data.isVeg }),
        ...(data.isJain !== undefined && { isJain: data.isJain }),
        ...(data.isRecommended !== undefined && {
          isRecommended: data.isRecommended,
        }),
        ...(data.allergens !== undefined && { allergens: data.allergens }),
        ...(data.preparationTime !== undefined && {
          preparationTime: data.preparationTime,
        }),
        ...(data.kitchenStation !== undefined && {
          kitchenStation: data.kitchenStation,
        }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.availableDays !== undefined && {
          availableDays: data.availableDays,
        }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        // Always write the resolved timing so times are cleared when disabled.
        timingEnabled,
        availableTimeStart: timingEnabled ? availableTimeStart : null,
        availableTimeEnd: timingEnabled ? availableTimeEnd : null,
        // Sent lists replace the existing ones within the same update.
        ...(data.variants !== undefined && {
          variants: {
            deleteMany: {},
            create: data.variants.map((variant, index) => ({
              ...variant,
              sortOrder: index,
            })),
          },
        }),
        ...(data.addons !== undefined && {
          addons: {
            deleteMany: {},
            create: data.addons.map((addon, index) => ({
              ...addon,
              sortOrder: index,
            })),
          },
        }),
      },
      select: menuItemSelect,
    });

    return serializeMenuItem(item);
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new MenuServiceError(
        MenuServiceErrorCode.MENU_ITEM_NAME_CONFLICT,
        "A menu item with this name already exists in this category",
      );
    }

    throw error;
  }
}

/**
 * Retrieves a paginated list of menu items for an organization, ordered
 * by category and item sort order.
 *
 * When a branch is given, each item also carries that branch's price,
 * availability and ordering channels.
 *
 * @param organizationId - The owning organization ID.
 * @param query - Validated filters and pagination.
 * @param includeCostPrice - Whether branch cost prices may be returned.
 * @returns The menu items and pagination metadata.
 */
export async function listMenuItems(
  organizationId: string,
  query: ListMenuItemsQuery,
  includeCostPrice: boolean,
) {
  const where = {
    organizationId,
    ...(query.categoryId !== undefined && { categoryId: query.categoryId }),
    ...(query.isActive !== undefined && { isActive: query.isActive }),
  };

  const [items, total] = await Promise.all([
    prisma.menuItem.findMany({
      where,
      orderBy: [
        { category: { sortOrder: "asc" } },
        { sortOrder: "asc" },
        { name: "asc" },
      ],
      take: query.limit,
      skip: query.offset,
      select: menuItemSelect,
    }),
    prisma.menuItem.count({ where }),
  ]);

  const { branchId } = query;

  if (branchId === undefined) {
    return {
      total,
      limit: query.limit,
      offset: query.offset,
      items: items.map((item) => serializeMenuItem(item)),
    };
  }

  const branchItems = await prisma.branchMenuItem.findMany({
    where: {
      branchId,
      menuItemId: { in: items.map((item) => item.id) },
    },
    select: branchItemSelect,
  });

  const branchItemsByMenuItemId = new Map(
    branchItems.map((branchItem) => [branchItem.menuItemId, branchItem]),
  );

  return {
    total,
    limit: query.limit,
    offset: query.offset,
    branchId,
    items: items.map((item) => ({
      ...serializeMenuItem(item),
      ...serializeBranchFields(
        branchItemsByMenuItemId.get(item.id),
        includeCostPrice,
      ),
    })),
  };
}

/**
 * Retrieves a menu item with its price at every branch.
 *
 * @param id - The menu item ID.
 * @param organizationId - The owning organization ID.
 * @param includeCostPrice - Whether branch cost prices may be returned.
 * @returns The menu item with branch prices, or null if not found.
 */
export async function getMenuItem(
  id: string,
  organizationId: string,
  includeCostPrice: boolean,
) {
  const item = await prisma.menuItem.findFirst({
    where: { id, organizationId },
    select: {
      ...menuItemSelect,
      branchItems: {
        orderBy: { createdAt: "asc" },
        select: {
          ...branchItemSelect,
          branchId: true,
          branch: { select: { name: true } },
        },
      },
    },
  });

  if (!item) {
    return null;
  }

  const { branchItems, ...itemData } = item;

  return {
    ...serializeMenuItem(itemData),
    branchPrices: branchItems.map((branchItem) => ({
      branchId: branchItem.branchId,
      branchName: branchItem.branch.name,
      ...serializeBranchFields(branchItem, includeCostPrice),
    })),
  };
}

/**
 * Sets the branch-specific price, availability and ordering channels of a
 * menu item.
 *
 * Creates the branch entry on first use and updates it afterwards.
 * Fields not provided on update are left unchanged.
 *
 * @param branchId - The branch ID.
 * @param itemId - The menu item ID.
 * @param organizationId - The owning organization ID.
 * @param data - The validated branch pricing details.
 * @returns The menu item with its branch price and availability.
 * @throws MenuServiceError If the branch or menu item is not found.
 */
export async function upsertBranchMenuItem(
  branchId: string,
  itemId: string,
  organizationId: string,
  data: UpsertBranchMenuItemInput,
) {
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, organizationId, status: "active" },
    select: { id: true },
  });

  if (!branch) {
    throw new MenuServiceError(
      MenuServiceErrorCode.BRANCH_NOT_FOUND,
      "Active branch not found",
    );
  }

  const item = await prisma.menuItem.findFirst({
    where: { id: itemId, organizationId },
    select: { id: true, name: true },
  });

  if (!item) {
    throw new MenuServiceError(
      MenuServiceErrorCode.MENU_ITEM_NOT_FOUND,
      "Menu item not found",
    );
  }

  const branchItem = await prisma.branchMenuItem.upsert({
    where: {
      branchId_menuItemId: { branchId: branch.id, menuItemId: item.id },
    },
    create: {
      branchId: branch.id,
      menuItemId: item.id,
      price: data.price,
      costPrice: data.costPrice ?? null,
      comparePrice: data.comparePrice ?? null,
      isAvailable: data.isAvailable ?? true,
      dineInAvailable: data.dineInAvailable ?? true,
      parcelAvailable: data.parcelAvailable ?? true,
      deliveryAvailable: data.deliveryAvailable ?? true,
      maxQuantityPerOrder: data.maxQuantityPerOrder ?? null,
    },
    update: {
      price: data.price,
      ...(data.costPrice !== undefined && { costPrice: data.costPrice }),
      ...(data.comparePrice !== undefined && { comparePrice: data.comparePrice }),
      ...(data.isAvailable !== undefined && { isAvailable: data.isAvailable }),
      ...(data.dineInAvailable !== undefined && {
        dineInAvailable: data.dineInAvailable,
      }),
      ...(data.parcelAvailable !== undefined && {
        parcelAvailable: data.parcelAvailable,
      }),
      ...(data.deliveryAvailable !== undefined && {
        deliveryAvailable: data.deliveryAvailable,
      }),
      ...(data.maxQuantityPerOrder !== undefined && {
        maxQuantityPerOrder: data.maxQuantityPerOrder,
      }),
    },
    select: { ...branchItemSelect, updatedAt: true },
  });

  return {
    id: item.id,
    name: item.name,
    branchId: branch.id,
    branchPrice: branchItem.price.toNumber(),
    ...serializeBranchFields(branchItem, true),
    updatedAt: branchItem.updatedAt,
  };
}

/** Timezone used when a branch has an invalid timezone configured. */
const FALLBACK_TIMEZONE = "Asia/Kolkata";

/**
 * Returns the current weekday ("mon".."sun") and time ("HH:mm") in a
 * branch's timezone.
 *
 * @param timezone - The branch's IANA timezone, e.g. "Asia/Kolkata".
 * @param now - The current instant.
 * @returns The local weekday and time of day.
 */
function getBranchClock(timezone: string, now: Date) {
  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    // An unknown timezone throws a RangeError; fall back to the default.
    return getBranchClock(FALLBACK_TIMEZONE, now);
  }

  const parts = formatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";

  return {
    day: part("weekday").toLowerCase(),
    time: `${part("hour")}:${part("minute")}`,
  };
}

/**
 * Checks whether a menu item can be ordered at the given local time.
 * Time windows that end before they start (e.g. 22:00–02:00) run past
 * midnight.
 *
 * @param item - The item's timing settings.
 * @param clock - The branch's current weekday and time.
 * @returns True if the item is orderable now.
 */
function isWithinItemTiming(
  item: {
    timingEnabled: boolean;
    availableDays: string[];
    availableTimeStart: string | null;
    availableTimeEnd: string | null;
  },
  clock: { day: string; time: string },
): boolean {
  if (!item.timingEnabled) {
    return true;
  }

  if (!item.availableDays.includes(clock.day)) {
    return false;
  }

  const { availableTimeStart: start, availableTimeEnd: end } = item;

  if (!start || !end) {
    return true;
  }

  return start <= end
    ? clock.time >= start && clock.time < end
    : clock.time >= start || clock.time < end;
}

/**
 * Retrieves the guest-facing dine-in menu for the branch a table QR code
 * belongs to.
 *
 * Only active categories and active items that are priced, available and
 * dine-in enabled at that branch, and within their timing window, are
 * returned. Categories left without items are omitted.
 *
 * @param qrCode - The table's QR code.
 * @returns The branch, table and categorized menu items.
 * @throws MenuServiceError If the QR code does not map to an active table
 * in an active branch and organization.
 */
export async function getPublicMenu(qrCode: string) {
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
          timezone: true,
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
    throw new MenuServiceError(
      MenuServiceErrorCode.TABLE_NOT_FOUND,
      "Table not found",
    );
  }

  const { branch } = table;

  // A QR order is a dine-in order, so the item must be dine-in enabled.
  const orderableItemWhere = {
    isActive: true,
    branchItems: {
      some: { branchId: branch.id, isAvailable: true, dineInAvailable: true },
    },
  };

  const categories = await prisma.menuCategory.findMany({
    where: {
      organizationId: branch.organizationId,
      isActive: true,
      items: { some: orderableItemWhere },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      items: {
        where: orderableItemWhere,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: {
          id: true,
          name: true,
          description: true,
          imageUrl: true,
          isVeg: true,
          isJain: true,
          isRecommended: true,
          allergens: true,
          preparationTime: true,
          timingEnabled: true,
          availableDays: true,
          availableTimeStart: true,
          availableTimeEnd: true,
          variants: {
            where: { dineInAvailable: true },
            orderBy: { sortOrder: "asc" },
            select: { id: true, name: true, extraPrice: true },
          },
          addons: {
            orderBy: { sortOrder: "asc" },
            select: { id: true, name: true, price: true, isVeg: true },
          },
          branchItems: {
            where: { branchId: branch.id },
            select: {
              price: true,
              comparePrice: true,
              maxQuantityPerOrder: true,
            },
          },
        },
      },
    },
  });

  const clock = getBranchClock(branch.timezone, new Date());

  const menuCategories = categories
    .map((category) => ({
      id: category.id,
      name: category.name,
      items: category.items
        .filter((item) => isWithinItemTiming(item, clock))
        .map((item) => {
          // The where clause guarantees exactly one entry for this branch.
          const branchItem = item.branchItems[0];

          return {
            id: item.id,
            name: item.name,
            description: item.description,
            imageUrl: item.imageUrl,
            price: branchItem ? branchItem.price.toNumber() : null,
            comparePrice: branchItem
              ? decimalToNumber(branchItem.comparePrice)
              : null,
            isVeg: item.isVeg,
            isJain: item.isJain,
            isRecommended: item.isRecommended,
            allergens: item.allergens,
            preparationTime: item.preparationTime,
            maxQuantityPerOrder: branchItem?.maxQuantityPerOrder ?? null,
            variants: item.variants.map((variant) => ({
              ...variant,
              extraPrice: variant.extraPrice.toNumber(),
            })),
            addons: item.addons.map((addon) => ({
              ...addon,
              price: addon.price.toNumber(),
            })),
          };
        }),
    }))
    .filter((category) => category.items.length > 0);

  return {
    branch: { id: branch.id, name: branch.name },
    table: { id: table.id, name: table.name },
    categories: menuCategories,
  };
}

/**
 * Checks whether an unknown value matches a known menu service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value contains a recognized menu service error
 * code and a string message.
 */
export function isMenuServiceError(
  error: unknown,
): error is MenuServiceError {
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
    Object.values(MenuServiceErrorCode).includes(
      error.code as MenuServiceErrorCode,
    )
  );
}
