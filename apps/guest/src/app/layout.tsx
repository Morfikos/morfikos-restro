import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@morfikos/ui/tokens.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Morfikos Guest Ordering",
  description: "Zero-Login QR / NFC Table Menu, Direct Ordering, Games & Entrance TV",
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
