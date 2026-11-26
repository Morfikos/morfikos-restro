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
      <h1 style={{ fontSize: "28px", marginBottom: "8px" }}>Morfikos Kitchen Display (KDS)</h1>
      <p style={{ color: "var(--text-secondary)", margin: 0 }}>Station-Wise Live Tickets, Prep Timers & Bump Flow (High-Contrast Dark Mode)</p>
      <StatusCard apiOk={apiOk} port={3004} />
    </main>
  );
}
