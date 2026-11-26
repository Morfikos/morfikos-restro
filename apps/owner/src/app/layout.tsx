import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@morfikos/ui/tokens.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Morfikos Owner Portal",
  description: "Overview, Sales, Guests, Marketing, Menu, Inventory, Profit & Super Admin Feature Flags",
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
