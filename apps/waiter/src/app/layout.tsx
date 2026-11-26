import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@morfikos/ui/tokens.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Morfikos Waiter App",
  description: "Mobile-First Table Ordering, KOT Fire, Table Transfers & Guest Service Requests",
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
