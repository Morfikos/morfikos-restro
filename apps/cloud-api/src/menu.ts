import { menuSeed, readMenuItems, upsertMenuItem } from "@morfikos/database";
import type { MenuItem } from "@morfikos/types";

const databaseTimeoutMs = 8000;

let seedCatalog: MenuItem[] | null = null;

function seedItems(): MenuItem[] {
  if (!seedCatalog) {
    seedCatalog = menuSeed.map((item) => ({ ...item }));
  }

  return seedCatalog;
}

function upsertSeedItem(item: MenuItem) {
  const items = seedItems();
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) {
    items.push(item);
    return;
  }

  items[index] = item;
}

function withDatabaseTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Database connection timed out")), databaseTimeoutMs);
    }),
  ]);
}

export function parseCloudMenuItem(value: unknown): MenuItem | null {
  if (!value || typeof value !== "object") return null;

  const body = value as MenuItem;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!id || !name || !Number.isInteger(body.priceCents) || body.priceCents <= 0) return null;

  return { id, name, priceCents: body.priceCents };
}

export async function listCloudMenu(): Promise<{
  items: MenuItem[];
  persistence: "seed" | "database";
}> {
  if (!process.env.DATABASE_URL) {
    return { items: seedItems().map((item) => ({ ...item })), persistence: "seed" };
  }

  try {
    const items = await withDatabaseTimeout(readMenuItems());
    return { items, persistence: "database" };
  } catch {
    return { items: seedItems().map((item) => ({ ...item })), persistence: "seed" };
  }
}

export async function saveCloudMenuItem(item: MenuItem): Promise<{
  item: MenuItem;
  persistence: "seed" | "database";
}> {
  if (!process.env.DATABASE_URL) {
    upsertSeedItem(item);
    return { item, persistence: "seed" };
  }

  try {
    const saved = await withDatabaseTimeout(upsertMenuItem(item));
    return { item: saved, persistence: "database" };
  } catch {
    upsertSeedItem(item);
    return { item, persistence: "seed" };
  }
}
