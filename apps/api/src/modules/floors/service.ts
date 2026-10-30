import type { FastifyBaseLogger } from "fastify";

import { createPrismaClient } from "@morfikos/database";
import {
  FLOOR_OBJECT_TYPES,
  TABLE_SHAPES,
  floorLayoutDraftSchema,
  type ApplyLayoutImportInput,
  type CreateFloorInput,
  type FloorLayoutDraft,
  type ListFloorsQuery,
  type SaveFloorLayoutInput,
  type UpdateFloorInput,
} from "@morfikos/validation";

import { FloorServiceErrorCode } from "@morfikos/auth";

import { isPrismaUniqueConstraintError } from "../../utils/prisma-errors.js";
import {
  deleteUpload,
  detectImageType,
  readUpload,
  saveUpload,
} from "../../utils/storage.js";
import { ACTIVE_ORDER_STATUSES } from "../orders/constants.js";
import { serializeTable, tableSelect } from "../tables/service.js";
import { detectFloorLayout, isLayoutDetectorConfigured } from "./layout-detector.js";

const prisma = createPrismaClient();

/** Upload folder for floor background images. */
const BACKGROUND_FOLDER = "floors";

/** Upload folder for photos sent for floor-map import. */
const IMPORT_FOLDER = "floor-imports";

/** Photo imports allowed per branch in 24 hours (protects the free AI quota). */
const MAX_LAYOUT_IMPORTS_PER_DAY = 10;

/** Most tables or objects accepted from one detected layout. */
const MAX_DETECTED_ITEMS = 300;

/** Size used when the AI gives no usable table size. */
const DEFAULT_TABLE_SIZE = 80;

/** Smallest size kept for a detected item, so it stays visible on the map. */
const MIN_ITEM_SIZE = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Message shown when the AI could not produce a layout. */
const IMPORT_FAILED_MESSAGE =
  "Couldn't read a floor layout from this photo. Try a clearer top-down photo or a sketch of the floor.";

/**
 * Represents errors that can occur during floor operations.
 */
export class FloorServiceError extends Error {
  /**
   * Creates a floor service error.
   *
   * @param code - The standardized error code.
   * @param message - A description of the error.
   */
  constructor(
    public readonly code: FloorServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FloorServiceError";
  }
}

/**
 * Fields returned for floors in API responses.
 */
const floorSelect = {
  id: true,
  branchId: true,
  name: true,
  sortOrder: true,
  width: true,
  height: true,
  backgroundImageUrl: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { tables: { where: { isActive: true } } } },
} as const;

/**
 * Fields returned when a floor is deactivated.
 */
const floorStatusSelect = {
  id: true,
  isActive: true,
  updatedAt: true,
} as const;

/**
 * Fields returned for floor objects (walls, counters, entrances...).
 */
const floorObjectSelect = {
  id: true,
  type: true,
  label: true,
  positionX: true,
  positionY: true,
  width: true,
  height: true,
  rotation: true,
} as const;

/**
 * Fields returned for photo imports.
 */
const layoutImportSelect = {
  id: true,
  floorId: true,
  imageUrl: true,
  status: true,
  proposedLayout: true,
  error: true,
  appliedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/**
 * Serializes a floor with its active table count.
 *
 * @param floor - A floor record selected with {@link floorSelect}.
 * @returns The floor as returned by the API.
 */
function serializeFloor<T extends { _count: { tables: number } }>(floor: T) {
  const { _count, ...floorData } = floor;

  return { ...floorData, tableCount: _count.tables };
}

/**
 * Builds the filter for a floor that belongs to the organization and to
 * one of the branches the user can access.
 *
 * @param id - The floor ID.
 * @param organizationId - The organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The Prisma where clause.
 */
function accessibleFloorWhere(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  return {
    id,
    branchId: { in: branchIds },
    branch: { organizationId },
  };
}

/**
 * Throws if any active table on the floor has an open or billed order.
 *
 * @param floorId - The floor ID.
 * @param message - The error message.
 * @throws FloorServiceError If an order is still open on the floor.
 */
async function assertNoOpenOrdersOnFloor(floorId: string, message: string) {
  const openOrders = await prisma.order.count({
    where: {
      status: { in: ACTIVE_ORDER_STATUSES },
      table: { floorId },
    },
  });

  if (openOrders > 0) {
    throw new FloorServiceError(
      FloorServiceErrorCode.FLOOR_HAS_OPEN_ORDERS,
      `${message} (${openOrders} open order${openOrders === 1 ? "" : "s"})`,
    );
  }
}

/**
 * Detects and checks an uploaded image.
 *
 * @param image - The uploaded file contents.
 * @returns The image type.
 * @throws FloorServiceError If the file is not a JPEG, PNG or WebP image.
 */
function assertImage(image: Buffer) {
  const imageType = detectImageType(image);

  if (!imageType) {
    throw new FloorServiceError(
      FloorServiceErrorCode.INVALID_IMAGE,
      "Upload a JPG, PNG or WebP image",
    );
  }

  return imageType;
}

/**
 * Deletes an uploaded image unless a floor background or a photo import
 * still uses it.
 *
 * @param url - The image URL, or null.
 */
async function deleteUnusedImage(url: string | null) {
  if (!url) {
    return;
  }

  const [floors, imports] = await Promise.all([
    prisma.floor.count({ where: { backgroundImageUrl: url } }),
    prisma.floorLayoutImport.count({
      where: { imageUrl: url, status: { not: "DISCARDED" } },
    }),
  ]);

  if (floors === 0 && imports === 0) {
    await deleteUpload(url);
  }
}

/**
 * Creates a floor in an active branch of the organization.
 *
 * @param data - The validated floor details.
 * @param organizationId - The owning organization ID.
 * @returns The created floor.
 * @throws FloorServiceError If the branch is not found or the name is taken.
 */
export async function createFloor(
  data: CreateFloorInput,
  organizationId: string,
) {
  const branch = await prisma.branch.findFirst({
    where: { id: data.branchId, organizationId, status: "active" },
    select: { id: true },
  });

  if (!branch) {
    throw new FloorServiceError(
      FloorServiceErrorCode.BRANCH_NOT_FOUND,
      "Active branch not found",
    );
  }

  try {
    const floor = await prisma.floor.create({
      data: {
        branchId: branch.id,
        name: data.name,
        sortOrder: data.sortOrder,
        width: data.width,
        height: data.height,
      },
      select: floorSelect,
    });

    return serializeFloor(floor);
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new FloorServiceError(
        FloorServiceErrorCode.FLOOR_NAME_CONFLICT,
        "A floor with this name already exists in this branch",
      );
    }

    throw error;
  }
}

/**
 * Lists a branch's floors in display order.
 *
 * @param organizationId - The owning organization ID.
 * @param query - Validated filters.
 * @returns The floors.
 */
export async function listFloors(
  organizationId: string,
  query: ListFloorsQuery,
) {
  const floors = await prisma.floor.findMany({
    where: {
      branchId: query.branchId,
      branch: { organizationId },
      ...(query.isActive !== undefined && { isActive: query.isActive }),
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: floorSelect,
  });

  return { floors: floors.map((floor) => serializeFloor(floor)) };
}

/**
 * Retrieves a floor.
 *
 * @param id - The floor ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The floor, or null if not found or not accessible.
 */
export async function getFloor(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  const floor = await prisma.floor.findFirst({
    where: accessibleFloorWhere(id, organizationId, branchIds),
    select: floorSelect,
  });

  return floor ? serializeFloor(floor) : null;
}

/**
 * Updates the provided fields of a floor. A floor with open orders cannot
 * be deactivated.
 *
 * @param id - The floor ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @param data - The validated fields to update.
 * @returns The updated floor, or null if not found.
 * @throws FloorServiceError If the name is taken or orders are still open.
 */
export async function updateFloor(
  id: string,
  organizationId: string,
  branchIds: string[],
  data: UpdateFloorInput,
) {
  const existing = await prisma.floor.findFirst({
    where: accessibleFloorWhere(id, organizationId, branchIds),
    select: { id: true },
  });

  if (!existing) {
    return null;
  }

  if (data.isActive === false) {
    await assertNoOpenOrdersOnFloor(
      existing.id,
      "A floor with open orders can't be deactivated",
    );
  }

  try {
    const floor = await prisma.floor.update({
      where: { id: existing.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.width !== undefined && { width: data.width }),
        ...(data.height !== undefined && { height: data.height }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      select: floorSelect,
    });

    return serializeFloor(floor);
  } catch (error: unknown) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new FloorServiceError(
        FloorServiceErrorCode.FLOOR_NAME_CONFLICT,
        "A floor with this name already exists in this branch",
      );
    }

    throw error;
  }
}

/**
 * Soft-deactivates a floor. Its tables keep their floor and order history.
 *
 * @param id - The floor ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The floor status details, or null if not found.
 * @throws FloorServiceError If orders are still open on the floor.
 */
export async function deactivateFloor(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  const existing = await prisma.floor.findFirst({
    where: accessibleFloorWhere(id, organizationId, branchIds),
    select: floorStatusSelect,
  });

  if (!existing) {
    return null;
  }

  if (!existing.isActive) {
    return existing;
  }

  await assertNoOpenOrdersOnFloor(
    existing.id,
    "A floor with open orders can't be deactivated",
  );

  return prisma.floor.update({
    where: { id: existing.id },
    data: { isActive: false },
    select: floorStatusSelect,
  });
}

/**
 * Sets (or replaces) a floor's background photo. The previous photo file
 * is deleted when nothing else uses it.
 *
 * @param id - The floor ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @param image - The uploaded image contents.
 * @returns The updated floor, or null if not found.
 * @throws FloorServiceError If the file is not a supported image.
 */
export async function setFloorBackground(
  id: string,
  organizationId: string,
  branchIds: string[],
  image: Buffer,
) {
  const existing = await prisma.floor.findFirst({
    where: accessibleFloorWhere(id, organizationId, branchIds),
    select: { id: true, backgroundImageUrl: true },
  });

  if (!existing) {
    return null;
  }

  const imageType = assertImage(image);
  const imageUrl = await saveUpload(image, BACKGROUND_FOLDER, imageType.extension);

  const floor = await prisma.floor.update({
    where: { id: existing.id },
    data: { backgroundImageUrl: imageUrl },
    select: floorSelect,
  });

  await deleteUnusedImage(existing.backgroundImageUrl);

  return serializeFloor(floor);
}

/**
 * Removes a floor's background photo.
 *
 * @param id - The floor ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The updated floor, or null if not found.
 */
export async function removeFloorBackground(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  const existing = await prisma.floor.findFirst({
    where: accessibleFloorWhere(id, organizationId, branchIds),
    select: { id: true, backgroundImageUrl: true },
  });

  if (!existing) {
    return null;
  }

  const floor = await prisma.floor.update({
    where: { id: existing.id },
    data: { backgroundImageUrl: null },
    select: floorSelect,
  });

  await deleteUnusedImage(existing.backgroundImageUrl);

  return serializeFloor(floor);
}

/**
 * Retrieves the floor map: the floor, its active tables with position and
 * live status, its objects, and the branch's tables not placed on any floor
 * yet (for the editor's sidebar).
 *
 * @param id - The floor ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The floor layout, or null if not found.
 */
export async function getFloorLayout(
  id: string,
  organizationId: string,
  branchIds: string[],
) {
  const floor = await prisma.floor.findFirst({
    where: accessibleFloorWhere(id, organizationId, branchIds),
    select: {
      ...floorSelect,
      objects: { orderBy: { createdAt: "asc" }, select: floorObjectSelect },
    },
  });

  if (!floor) {
    return null;
  }

  const [tables, unplacedTables] = await Promise.all([
    prisma.diningTable.findMany({
      where: { floorId: floor.id, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: tableSelect,
    }),
    prisma.diningTable.findMany({
      where: { branchId: floor.branchId, floorId: null, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: tableSelect,
    }),
  ]);

  const { objects, ...floorData } = floor;

  return {
    floor: serializeFloor(floorData),
    tables: tables.map((table) => serializeTable(table)),
    objects,
    unplacedTables: unplacedTables.map((table) => serializeTable(table)),
  };
}

/**
 * Saves the floor map editor in one transaction: the canvas size, the
 * position of each listed table (placing it on this floor), and — when sent —
 * the full list of floor objects.
 *
 * @param id - The floor ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @param data - The validated layout.
 * @returns The saved floor layout, or null if not found.
 * @throws FloorServiceError If a listed table is not an active table of the branch.
 */
export async function saveFloorLayout(
  id: string,
  organizationId: string,
  branchIds: string[],
  data: SaveFloorLayoutInput,
) {
  const floor = await prisma.floor.findFirst({
    where: accessibleFloorWhere(id, organizationId, branchIds),
    select: { id: true, branchId: true },
  });

  if (!floor) {
    return null;
  }

  const tableIds = data.tables.map((table) => table.id);
  const knownTables = await prisma.diningTable.count({
    where: { id: { in: tableIds }, branchId: floor.branchId, isActive: true },
  });

  if (knownTables !== tableIds.length) {
    throw new FloorServiceError(
      FloorServiceErrorCode.TABLE_NOT_FOUND,
      "One or more tables were not found in this branch",
    );
  }

  await prisma.$transaction(async (tx) => {
    if (data.width !== undefined || data.height !== undefined) {
      await tx.floor.update({
        where: { id: floor.id },
        data: {
          ...(data.width !== undefined && { width: data.width }),
          ...(data.height !== undefined && { height: data.height }),
        },
      });
    }

    for (const table of data.tables) {
      await tx.diningTable.update({
        where: { id: table.id },
        data: {
          floorId: floor.id,
          positionX: table.positionX,
          positionY: table.positionY,
          width: table.width,
          height: table.height,
          rotation: table.rotation,
          ...(table.shape !== undefined && { shape: table.shape }),
        },
      });
    }

    if (data.objects !== undefined) {
      await tx.floorObject.deleteMany({ where: { floorId: floor.id } });
      await tx.floorObject.createMany({
        data: data.objects.map((object) => ({
          floorId: floor.id,
          type: object.type,
          label: object.label ?? null,
          positionX: object.positionX,
          positionY: object.positionY,
          width: object.width,
          height: object.height,
          rotation: object.rotation,
        })),
      });
    }
  });

  return getFloorLayout(floor.id, organizationId, branchIds);
}

/**
 * Converts a value to a finite number.
 *
 * @param value - The value to convert.
 * @param fallback - Returned when the value is not a finite number.
 * @returns The number.
 */
function toFiniteNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Limits a number to a range.
 *
 * @param value - The number.
 * @param min - The lowest allowed value.
 * @param max - The highest allowed value.
 * @returns The clamped number.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Returns the object entries of an unknown array.
 *
 * @param value - The value to read.
 * @returns The array's object items, or an empty array.
 */
function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
    : [];
}

/**
 * Reads an item's box from AI output and fits it inside the canvas.
 *
 * @param item - The raw item.
 * @param floorWidth - Canvas width.
 * @param floorHeight - Canvas height.
 * @param defaultSize - Size used when the AI gives none.
 * @returns The position, size and rotation.
 */
function normalizeBox(
  item: Record<string, unknown>,
  floorWidth: number,
  floorHeight: number,
  defaultSize: number,
) {
  // Zero, negative or missing sizes fall back to the default size.
  const rawWidth = toFiniteNumber(item.width, defaultSize);
  const rawHeight = toFiniteNumber(item.height, defaultSize);
  const width = clamp(rawWidth > 0 ? rawWidth : defaultSize, MIN_ITEM_SIZE, floorWidth);
  const height = clamp(rawHeight > 0 ? rawHeight : defaultSize, MIN_ITEM_SIZE, floorHeight);
  const rotation = ((toFiniteNumber(item.rotation, 0) % 360) + 360) % 360;

  return {
    positionX: clamp(toFiniteNumber(item.positionX, 0), 0, floorWidth - width),
    positionY: clamp(toFiniteNumber(item.positionY, 0), 0, floorHeight - height),
    width,
    height,
    rotation,
  };
}

/**
 * Turns raw AI output into a valid floor layout draft. The model's answer
 * is never trusted as-is: items are fitted inside the canvas, names are
 * made unique, unknown shapes/types fall back to safe defaults, and the
 * result is validated with the same schema the apply API uses.
 *
 * @param raw - The parsed JSON returned by the model.
 * @param floorWidth - Canvas width.
 * @param floorHeight - Canvas height.
 * @returns The layout draft.
 */
export function normalizeDetectedLayout(
  raw: unknown,
  floorWidth: number,
  floorHeight: number,
): FloorLayoutDraft {
  const root =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const usedNames = new Set<string>();

  const tables = asRecords(root.tables)
    .slice(0, MAX_DETECTED_ITEMS)
    .map((item, index) => {
      const baseName =
        (typeof item.name === "string" ? item.name.trim() : "").slice(0, 30) ||
        `T${index + 1}`;
      let name = baseName;

      for (let suffix = 2; usedNames.has(name.toLowerCase()); suffix += 1) {
        name = `${baseName.slice(0, 26)}-${suffix}`;
      }

      usedNames.add(name.toLowerCase());

      const shape = (TABLE_SHAPES as readonly string[]).includes(String(item.shape))
        ? (item.shape as (typeof TABLE_SHAPES)[number])
        : "SQUARE";

      return {
        name,
        seats: clamp(Math.round(toFiniteNumber(item.seats, 2)), 1, 50),
        shape,
        ...normalizeBox(item, floorWidth, floorHeight, DEFAULT_TABLE_SIZE),
      };
    });

  const objects = asRecords(root.objects)
    .slice(0, MAX_DETECTED_ITEMS)
    .map((item) => {
      const type = (FLOOR_OBJECT_TYPES as readonly string[]).includes(String(item.type))
        ? (item.type as (typeof FLOOR_OBJECT_TYPES)[number])
        : "OTHER";
      const label =
        typeof item.label === "string" && item.label.trim()
          ? item.label.trim().slice(0, 50)
          : undefined;

      return {
        type,
        label,
        ...normalizeBox(item, floorWidth, floorHeight, DEFAULT_TABLE_SIZE),
      };
    });

  return floorLayoutDraftSchema.parse({ tables, objects });
}

/**
 * Runs the AI detection for an import in the background and stores the
 * proposed layout, or marks the import as failed.
 *
 * @param importId - The import ID.
 * @param logger - Logger for failures.
 */
async function processLayoutImport(importId: string, logger: FastifyBaseLogger) {
  try {
    const layoutImport = await prisma.floorLayoutImport.update({
      where: { id: importId },
      data: { status: "PROCESSING" },
      select: {
        imageUrl: true,
        floor: { select: { width: true, height: true } },
      },
    });

    const image = await readUpload(layoutImport.imageUrl);
    const imageType = detectImageType(image);

    if (!imageType) {
      throw new Error("Stored import image is not a supported image");
    }

    const { width, height } = layoutImport.floor;
    const raw = await detectFloorLayout({
      image,
      mimeType: imageType.mimeType,
      floorWidth: width,
      floorHeight: height,
    });

    const proposedLayout = normalizeDetectedLayout(raw, width, height);

    // Only finish imports still processing, so a discard made meanwhile wins.
    await prisma.floorLayoutImport.updateMany({
      where: { id: importId, status: "PROCESSING" },
      data: {
        status: "READY_FOR_REVIEW",
        proposedLayout,
        error: null,
      },
    });
  } catch (error: unknown) {
    logger.error({ err: error, importId }, "Floor layout import failed");

    await prisma.floorLayoutImport
      .updateMany({
        where: { id: importId, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "FAILED", error: IMPORT_FAILED_MESSAGE },
      })
      .catch((updateError: unknown) => {
        logger.error({ err: updateError, importId }, "Failed to mark layout import as failed");
      });
  }
}

/**
 * Starts a photo → floor map import. The photo is saved and the AI runs in
 * the background; poll {@link getLayoutImport} until it is ready.
 *
 * @param floorId - The floor ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @param userId - The user starting the import.
 * @param image - The uploaded photo contents.
 * @param logger - Logger for the background job.
 * @returns The created import (status PENDING), or null if the floor is not found.
 * @throws FloorServiceError If AI is not configured, the daily limit is
 * reached or the file is not a supported image.
 */
export async function createLayoutImport(
  floorId: string,
  organizationId: string,
  branchIds: string[],
  userId: string,
  image: Buffer,
  logger: FastifyBaseLogger,
) {
  if (!isLayoutDetectorConfigured()) {
    throw new FloorServiceError(
      FloorServiceErrorCode.AI_NOT_CONFIGURED,
      "Photo import is not set up. Add GEMINI_API_KEY to the server environment.",
    );
  }

  const floor = await prisma.floor.findFirst({
    where: { ...accessibleFloorWhere(floorId, organizationId, branchIds), isActive: true },
    select: { id: true, branchId: true },
  });

  if (!floor) {
    return null;
  }

  const importsToday = await prisma.floorLayoutImport.count({
    where: {
      floor: { branchId: floor.branchId },
      createdAt: { gte: new Date(Date.now() - MS_PER_DAY) },
    },
  });

  if (importsToday >= MAX_LAYOUT_IMPORTS_PER_DAY) {
    throw new FloorServiceError(
      FloorServiceErrorCode.IMPORT_LIMIT_REACHED,
      `A branch can import at most ${MAX_LAYOUT_IMPORTS_PER_DAY} photos per day. Try again later.`,
    );
  }

  const imageType = assertImage(image);
  const imageUrl = await saveUpload(image, IMPORT_FOLDER, imageType.extension);

  const layoutImport = await prisma.floorLayoutImport.create({
    data: { floorId: floor.id, imageUrl, createdById: userId },
    select: layoutImportSelect,
  });

  // Runs after the response is sent; failures are stored on the import.
  void processLayoutImport(layoutImport.id, logger);

  return layoutImport;
}

/**
 * Retrieves a photo import with its status and proposed layout.
 *
 * @param importId - The import ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The import, or null if not found or not accessible.
 */
export async function getLayoutImport(
  importId: string,
  organizationId: string,
  branchIds: string[],
) {
  return prisma.floorLayoutImport.findFirst({
    where: {
      id: importId,
      floor: { branchId: { in: branchIds }, branch: { organizationId } },
    },
    select: layoutImportSelect,
  });
}

/**
 * Applies a reviewed photo import to its floor in one transaction. Each
 * layout table is matched to an existing branch table by name (case
 * insensitive) and moved onto the floor; unmatched names become new tables.
 * The floor's objects are replaced, and the photo can become the floor's
 * background.
 *
 * @param importId - The import ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @param input - The owner's corrected layout (or none to use the proposal).
 * @returns The floor layout after applying, or null if the import is not found.
 * @throws FloorServiceError If the import is not ready for review.
 */
export async function applyLayoutImport(
  importId: string,
  organizationId: string,
  branchIds: string[],
  input: ApplyLayoutImportInput,
) {
  const layoutImport = await prisma.floorLayoutImport.findFirst({
    where: {
      id: importId,
      floor: { branchId: { in: branchIds }, branch: { organizationId } },
    },
    select: {
      id: true,
      status: true,
      imageUrl: true,
      proposedLayout: true,
      floor: { select: { id: true, branchId: true, backgroundImageUrl: true } },
    },
  });

  if (!layoutImport) {
    return null;
  }

  if (layoutImport.status !== "READY_FOR_REVIEW") {
    throw new FloorServiceError(
      FloorServiceErrorCode.IMPORT_NOT_READY,
      `This import is ${layoutImport.status.toLowerCase().replaceAll("_", " ")} and can't be applied`,
    );
  }

  const layout = input.layout ?? floorLayoutDraftSchema.parse(layoutImport.proposedLayout);
  const { floor } = layoutImport;

  const branchTables = await prisma.diningTable.findMany({
    where: { branchId: floor.branchId },
    select: { id: true, name: true },
  });
  const tablesByName = new Map(
    branchTables.map((table) => [table.name.toLowerCase(), table.id]),
  );

  await prisma.$transaction(
    async (tx) => {
      for (const table of layout.tables) {
        const placement = {
          floorId: floor.id,
          seats: table.seats,
          shape: table.shape,
          positionX: table.positionX,
          positionY: table.positionY,
          width: table.width,
          height: table.height,
          rotation: table.rotation,
          isActive: true,
        };
        const existingId = tablesByName.get(table.name.toLowerCase());

        if (existingId) {
          await tx.diningTable.update({ where: { id: existingId }, data: placement });
        } else {
          await tx.diningTable.create({
            data: { ...placement, branchId: floor.branchId, name: table.name },
          });
        }
      }

      await tx.floorObject.deleteMany({ where: { floorId: floor.id } });
      await tx.floorObject.createMany({
        data: layout.objects.map((object) => ({
          floorId: floor.id,
          type: object.type,
          label: object.label ?? null,
          positionX: object.positionX,
          positionY: object.positionY,
          width: object.width,
          height: object.height,
          rotation: object.rotation,
        })),
      });

      if (input.setAsBackground) {
        await tx.floor.update({
          where: { id: floor.id },
          data: { backgroundImageUrl: layoutImport.imageUrl },
        });
      }

      await tx.floorLayoutImport.update({
        where: { id: layoutImport.id },
        data: { status: "APPLIED", appliedAt: new Date() },
      });
    },
    { maxWait: 10_000, timeout: 30_000 },
  );

  if (input.setAsBackground) {
    await deleteUnusedImage(floor.backgroundImageUrl);
  }

  return getFloorLayout(floor.id, organizationId, branchIds);
}

/**
 * Discards a photo import that was not applied and deletes its photo when
 * nothing else uses it.
 *
 * @param importId - The import ID.
 * @param organizationId - The owning organization ID.
 * @param branchIds - The branches the user can access.
 * @returns The import's status, or null if not found.
 * @throws FloorServiceError If the import was already applied.
 */
export async function discardLayoutImport(
  importId: string,
  organizationId: string,
  branchIds: string[],
) {
  const layoutImport = await prisma.floorLayoutImport.findFirst({
    where: {
      id: importId,
      floor: { branchId: { in: branchIds }, branch: { organizationId } },
    },
    select: { id: true, status: true, imageUrl: true },
  });

  if (!layoutImport) {
    return null;
  }

  if (layoutImport.status === "APPLIED") {
    throw new FloorServiceError(
      FloorServiceErrorCode.IMPORT_NOT_READY,
      "An applied import can't be discarded",
    );
  }

  const discarded = await prisma.floorLayoutImport.update({
    where: { id: layoutImport.id },
    data: { status: "DISCARDED" },
    select: { id: true, status: true, updatedAt: true },
  });

  await deleteUnusedImage(layoutImport.imageUrl);

  return discarded;
}

/**
 * Checks whether an unknown value matches a known floor service error.
 *
 * @param error - The unknown value to validate.
 * @returns True if the value contains a recognized floor service error
 * code and a string message.
 */
export function isFloorServiceError(
  error: unknown,
): error is FloorServiceError {
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
    Object.values(FloorServiceErrorCode).includes(
      error.code as FloorServiceErrorCode,
    )
  );
}
