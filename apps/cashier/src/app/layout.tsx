import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@morfikos/ui/tokens.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Morfikos Cashier POS",
  description: "Floor Map, Live Ordering, KOT, Billing, Split Bill, UPI/Cash & IndexedDB Offline Sync",
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
