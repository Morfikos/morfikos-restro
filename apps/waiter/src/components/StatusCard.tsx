"use client";

import { useState } from "react";
import { Button } from "@morfikos/ui";

export function StatusCard({
  apiOk,
  port,
}: {
  apiOk: boolean;
  port: number;
}) {
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  return (
    <div
      style={{
        marginTop: "20px",
        padding: "16px",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border-secondary)",
        backgroundColor: "var(--bg-secondary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      }}
    >
      <div>
        <div style={{ fontWeight: 600 }}>
          API Connection:{" "}
          <span style={{ color: apiOk ? "var(--success-600)" : "var(--error-600)" }}>
            {apiOk ? "Online (/api/health OK)" : "API not running on :3000"}
          </span>
        </div>
        <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px" }}>
          Running on localhost:{port} {checkedAt ? `• Pinged at ${checkedAt}` : ""}
        </div>
      </div>
      <Button onClick={() => setCheckedAt(new Date().toLocaleTimeString())}>
        Test Client Action
      </Button>
    </div>
  );
}
