import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { MenuItem } from "@morfikos/types";

export const sqlitePath = fileURLToPath(new URL("../../data/local.sqlite", import.meta.url));

mkdirSync(dirname(sqlitePath), { recursive: true });

const db = new Database(sqlitePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    pending INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS menu_sync (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    synced_at TEXT
  );

  INSERT OR IGNORE INTO menu_sync (id, synced_at) VALUES (1, NULL);
`);

const menuColumns = db.prepare("PRAGMA table_info(menu_items)").all() as { name: string }[];
if (!menuColumns.some((column) => column.name === "pending")) {
  db.exec("ALTER TABLE menu_items ADD COLUMN pending INTEGER NOT NULL DEFAULT 0");
}

type MenuRow = {
  id: string;
  name: string;
  priceCents: number;
};

export function listMenuItems(): { items: MenuItem[]; syncedAt: string | null } {
  const items = db
    .prepare(
      "SELECT id, name, price_cents AS priceCents FROM menu_items ORDER BY name COLLATE NOCASE",
    )
    .all() as MenuRow[];
  const row = db.prepare("SELECT synced_at AS syncedAt FROM menu_sync WHERE id = 1").get() as {
    syncedAt: string | null;
  };

  return { items, syncedAt: row.syncedAt };
}

export function insertPendingMenuItem(item: MenuItem) {
  db.prepare("INSERT INTO menu_items (id, name, price_cents, pending) VALUES (?, ?, ?, 1)").run(
    item.id,
    item.name,
    item.priceCents,
  );
}

export function listPendingMenuItems(): MenuItem[] {
  return db
    .prepare(
      "SELECT id, name, price_cents AS priceCents FROM menu_items WHERE pending = 1 ORDER BY name COLLATE NOCASE",
    )
    .all() as MenuRow[];
}

export function markMenuItemSynced(id: string, syncedAt: string) {
  const clearPending = db.prepare("UPDATE menu_items SET pending = 0 WHERE id = ?");
  const stamp = db.prepare("UPDATE menu_sync SET synced_at = ? WHERE id = 1");
  const write = db.transaction(() => {
    clearPending.run(id);
    stamp.run(syncedAt);
  });
  write();
}

export function replaceMenuItems(items: MenuItem[], syncedAt: string) {
  const insert = db.prepare(
    "INSERT INTO menu_items (id, name, price_cents, pending) VALUES (?, ?, ?, 0)",
  );
  const clear = db.prepare("DELETE FROM menu_items");
  const stamp = db.prepare("UPDATE menu_sync SET synced_at = ? WHERE id = 1");

  const write = db.transaction((rows: MenuItem[]) => {
    clear.run();
    for (const item of rows) {
      insert.run(item.id, item.name, item.priceCents);
    }
    stamp.run(syncedAt);
  });

  write(items);
}
