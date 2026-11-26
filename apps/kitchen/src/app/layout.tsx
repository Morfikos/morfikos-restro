import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@morfikos/ui/tokens.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Morfikos Kitchen Display (KDS)",
  description: "Station-Wise Live Tickets, Prep Timers & Bump Flow (High-Contrast Dark Mode)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
