import type { MenuItem } from "@morfikos/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

type MenuResponse = {
  items: MenuItem[];
  syncedAt: string | null;
  sync: null | { ok: true } | { ok: false; message: string };
};

const priceFormat = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});

async function fetchMenu(sync: boolean): Promise<MenuResponse> {
  const response = await fetch(sync ? "/api/menu?sync=1" : "/api/menu");
  if (!response.ok) {
    throw new Error("Restaurant server did not return the menu");
  }
  return response.json() as Promise<MenuResponse>;
}

function priceCentsFromRupees(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const cents = Math.round(Number(trimmed) * 100);
  if (!Number.isInteger(cents) || cents <= 0) return null;
  return cents;
}

export default function PosPage() {
  const queryClient = useQueryClient();
  const [syncResult, setSyncResult] = useState<MenuResponse["sync"]>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const menuQuery = useQuery({
    queryKey: ["menu"],
    queryFn: () => fetchMenu(false),
  });
  const syncMutation = useMutation({
    mutationFn: () => fetchMenu(true),
    onSuccess: (menu) => {
      queryClient.setQueryData(["menu"], menu);
      setSyncResult(menu.sync);
    },
  });
  const addMutation = useMutation({
    mutationFn: (item: { name: string; priceCents: number }) => createMenuItem(item),
    onSuccess: (menu) => {
      queryClient.setQueryData(["menu"], menu);
      setSyncResult(menu.sync);
      setName("");
      setPrice("");
    },
  });

  const menu = menuQuery.data;
  const syncing = syncMutation.isPending;
  const priceCents = priceCentsFromRupees(price);
  const canAdd = name.trim().length > 0 && priceCents !== null && !addMutation.isPending && !menuQuery.isLoading;

  return (
    <main>
      <h1>Morfikos POS</h1>
      <p>This screen reads the menu saved on the restaurant server.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canAdd || priceCents === null) return;
          addMutation.mutate({ name: name.trim(), priceCents });
        }}
      >
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Price (₹)
          <input value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} />
        </label>
        <button type="submit" disabled={!canAdd}>
          {addMutation.isPending ? "Adding..." : "Add item"}
        </button>
      </form>
      {price.trim() && priceCents === null ? <p>Enter a price in rupees, such as 30 or 30.50.</p> : null}
      {addMutation.isError ? <p>The restaurant server did not save the item.</p> : null}
      <button
        type="button"
        onClick={() => syncMutation.mutate()}
        disabled={syncing || menuQuery.isLoading}
      >
        {syncing ? "Syncing..." : "Sync from cloud"}
      </button>
      <Status menu={menu} syncResult={syncResult} loading={menuQuery.isLoading} failed={menuQuery.isError} />
      <MenuList menu={menu} loading={menuQuery.isLoading} failed={menuQuery.isError} />
    </main>
  );
}

async function createMenuItem(item: { name: string; priceCents: number }): Promise<MenuResponse> {
  const response = await fetch("/api/menu", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(item),
  });
  if (!response.ok) {
    throw new Error("Restaurant server did not save the item");
  }
  return response.json() as Promise<MenuResponse>;
}

function Status({
  menu,
  syncResult,
  loading,
  failed,
}: {
  menu: MenuResponse | undefined;
  syncResult: MenuResponse["sync"];
  loading: boolean;
  failed: boolean;
}) {
  if (loading) return <p>Loading the saved menu...</p>;
  if (failed) return <p>The restaurant server is not reachable.</p>;
  if (!menu) return null;
  if (syncResult && !syncResult.ok) {
    return <p>Cloud unreachable — showing the menu saved on this restaurant server.</p>;
  }
  if (menu.syncedAt) {
    return <p>Last synced {new Date(menu.syncedAt).toLocaleString()}</p>;
  }
  return null;
}

function MenuList({
  menu,
  loading,
  failed,
}: {
  menu: MenuResponse | undefined;
  loading: boolean;
  failed: boolean;
}) {
  if (loading || failed || !menu) return null;
  if (menu.items.length === 0) {
    return <p>No menu saved on this restaurant yet.</p>;
  }

  return (
    <ul>
      {menu.items.map((item) => (
        <li key={item.id}>
          {item.name} — {priceFormat.format(item.priceCents / 100)}
        </li>
      ))}
    </ul>
  );
}
