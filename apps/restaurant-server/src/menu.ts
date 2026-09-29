import { randomUUID } from "node:crypto";
import type { MenuItem } from "@morfikos/types";
import {
  insertPendingMenuItem,
  listMenuItems,
  listPendingMenuItems,
  markMenuItemSynced,
  replaceMenuItems,
} from "./database/sqlite.js";

export type MenuSyncResult = null | { ok: true } | { ok: false; message: string };

export type LocalMenu = {
  items: MenuItem[];
  syncedAt: string | null;
  sync: MenuSyncResult;
};

export type CreateMenuInput = {
  name: string;
  priceCents: number;
};

export function parseCreateMenu(value: unknown): CreateMenuInput | null {
  if (!value || typeof value !== "object") return null;

  const body = value as CreateMenuInput;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || !Number.isInteger(body.priceCents) || body.priceCents <= 0) return null;

  return { name, priceCents: body.priceCents };
}

export async function getLocalMenu(sync: boolean): Promise<LocalMenu> {
  if (!sync) {
    return { ...listMenuItems(), sync: null };
  }

  const push = await pushPendingMenuItems();
  if (!push.ok) {
    return { ...listMenuItems(), sync: push };
  }

  const pull = await pullMenuFromCloud();
  return { ...listMenuItems(), sync: pull };
}

export async function createLocalMenuItem(input: CreateMenuInput): Promise<LocalMenu> {
  const item: MenuItem = {
    id: randomUUID(),
    name: input.name,
    priceCents: input.priceCents,
  };
  insertPendingMenuItem(item);

  const push = await pushMenuItem(item);
  if (push.ok) {
    markMenuItemSynced(item.id, new Date().toISOString());
  }

  return { ...listMenuItems(), sync: push };
}

async function pushPendingMenuItems(): Promise<Exclude<MenuSyncResult, null>> {
  for (const item of listPendingMenuItems()) {
    const push = await pushMenuItem(item);
    if (!push.ok) return push;
    markMenuItemSynced(item.id, new Date().toISOString());
  }

  return { ok: true };
}

async function pushMenuItem(item: MenuItem): Promise<Exclude<MenuSyncResult, null>> {
  const cloudApiUrl = process.env.CLOUD_API_URL ?? "http://127.0.0.1:4000";

  try {
    const response = await fetch(`${cloudApiUrl}/menu`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { ok: false, message: `Cloud API returned ${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloud API unreachable";
    return { ok: false, message };
  }
}

async function pullMenuFromCloud(): Promise<Exclude<MenuSyncResult, null>> {
  const cloudApiUrl = process.env.CLOUD_API_URL ?? "http://127.0.0.1:4000";

  try {
    const response = await fetch(`${cloudApiUrl}/menu`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return { ok: false, message: `Cloud API returned ${response.status}` };
    }

    const body: unknown = await response.json();
    const items = readMenuItems(body);
    if (!items) {
      return { ok: false, message: "Cloud API returned an invalid menu" };
    }

    const remoteIds = new Set(items.map((item) => item.id));
    const keptLocally = listMenuItems().items.filter((item) => !remoteIds.has(item.id));
    replaceMenuItems(items, new Date().toISOString());

    for (const item of keptLocally) {
      insertPendingMenuItem(item);
      const push = await pushMenuItem(item);
      if (!push.ok) return push;
      markMenuItemSynced(item.id, new Date().toISOString());
    }

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloud API unreachable";
    return { ok: false, message };
  }
}

function readMenuItems(body: unknown): MenuItem[] | null {
  if (!body || typeof body !== "object" || !("items" in body) || !Array.isArray(body.items)) {
    return null;
  }

  const items: MenuItem[] = [];
  for (const item of body.items) {
    if (!isMenuItem(item)) return null;
    items.push({ id: item.id, name: item.name, priceCents: item.priceCents });
  }

  return items;
}

function isMenuItem(value: unknown): value is MenuItem {
  if (!value || typeof value !== "object") return false;

  const item = value as MenuItem;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.name === "string" &&
    Number.isInteger(item.priceCents) &&
    item.priceCents > 0
  );
}
