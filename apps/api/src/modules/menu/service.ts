import { createPrismaClient } from "@morfikos/database";
import type {
  CreateCategoryInput,
  CreateCuisineInput,
  ListMenuQuery,
  UpdateCategoryInput,
  UpdateCuisineInput,
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
