import { createPrismaClient } from "@morfikos/database";
import type {
  CreateCategoryInput,
  CreateCuisineInput,
  CreateMenuItemInput,
  ListMenuQuery,
  UpdateCategoryInput,
  UpdateCuisineInput,
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
  categoryId: true,
  name: true,
  description: true,
  gst: true,
  hsn: true,
  isVeg: true,
  allergens: true,
  preparationTime: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * A Prisma Decimal value, typed structurally so the Prisma namespace
 * does not need to be imported.
 */
type DecimalValue = { toNumber(): number };

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
 * Serializes a menu item by converting its GST rate to a number.
 *
 * @param item - A menu item record containing a Decimal GST rate.
 * @returns The menu item with a numeric GST rate.
 */
function serializeMenuItem<T extends { gst: DecimalValue }>(item: T) {
  return {
    ...item,
    gst: item.gst.toNumber(),
  };
}

/**
 * Creates a menu item under an active category of the organization.
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
    const item = await prisma.menuItem.create({
      data: {
        organizationId: data.organizationId,
        categoryId: data.categoryId,
        name: data.name,
        description: data.description || null,
        gst: data.gst,
        hsn: data.hsn,
        isVeg: data.isVeg,
        allergens: data.allergens,
        preparationTime: data.preparationTime ?? null,
        isActive: data.isActive,
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
          branchId: true,
          price: true,
          costPrice: true,
          isAvailable: true,
          maxQuantityPerOrder: true,
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
      price: branchItem.price.toNumber(),
      // Cost price is margin data, so only owners and managers see it.
      ...(includeCostPrice && {
        costPrice: decimalToNumber(branchItem.costPrice),
      }),
      isAvailable: branchItem.isAvailable,
      maxQuantityPerOrder: branchItem.maxQuantityPerOrder,
    })),
  };
}

/**
 * Sets the branch-specific price and availability of a menu item.
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
      isAvailable: data.isAvailable ?? true,
      maxQuantityPerOrder: data.maxQuantityPerOrder ?? null,
    },
    update: {
      price: data.price,
      ...(data.costPrice !== undefined && { costPrice: data.costPrice }),
      ...(data.isAvailable !== undefined && { isAvailable: data.isAvailable }),
      ...(data.maxQuantityPerOrder !== undefined && {
        maxQuantityPerOrder: data.maxQuantityPerOrder,
      }),
    },
    select: {
      price: true,
      costPrice: true,
      isAvailable: true,
      maxQuantityPerOrder: true,
      updatedAt: true,
    },
  });

  return {
    id: item.id,
    name: item.name,
    branchId: branch.id,
    branchPrice: branchItem.price.toNumber(),
    costPrice: decimalToNumber(branchItem.costPrice),
    isAvailable: branchItem.isAvailable,
    maxQuantityPerOrder: branchItem.maxQuantityPerOrder,
    updatedAt: branchItem.updatedAt,
  };
}

/**
 * Retrieves the guest-facing menu for the branch a table QR code belongs to.
 *
 * Only active categories and active items that are priced and available
 * at that branch are returned. Categories without such items are omitted.
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

  // An item is orderable when it is active and available at this branch.
  const orderableItemWhere = {
    isActive: true,
    branchItems: { some: { branchId: branch.id, isAvailable: true } },
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
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          isVeg: true,
          allergens: true,
          preparationTime: true,
          branchItems: {
            where: { branchId: branch.id },
            select: { price: true, maxQuantityPerOrder: true },
          },
        },
      },
    },
  });

  return {
    branch: { id: branch.id, name: branch.name },
    table: { id: table.id, name: table.name },
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      items: category.items.map(({ branchItems, ...item }) => ({
        ...item,
        // The where clause guarantees exactly one entry for this branch.
        price: branchItems[0]?.price.toNumber() ?? null,
        maxQuantityPerOrder: branchItems[0]?.maxQuantityPerOrder ?? null,
      })),
    })),
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
