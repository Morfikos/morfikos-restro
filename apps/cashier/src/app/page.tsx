import { apiFetch } from "@morfikos/api-client";
import { StatusCard } from "@/components/StatusCard";

/**
 * Server Component: fetches initial status on the server (zero useEffect CSR fetch),
 * then passes data down to interactive Client Components.
 */
export default async function HomePage() {
  let apiOk = false;
  try {
    const res = await apiFetch<{ ok: boolean }>("/api/health", { cache: "no-store" });
    apiOk = Boolean(res?.ok);
  } catch {
    apiOk = false;
  }

  return (
    <main style={{ maxWidth: "760px", margin: "48px auto", padding: "0 20px" }}>
      <h1 style={{ fontSize: "28px", marginBottom: "8px" }}>Morfikos Cashier POS</h1>
      <p style={{ color: "var(--text-secondary)", margin: 0 }}>Floor Map, Live Ordering, KOT, Billing, Split Bill, UPI/Cash & IndexedDB Offline Sync</p>
      <StatusCard apiOk={apiOk} port={3002} />
    </main>
  );
}
