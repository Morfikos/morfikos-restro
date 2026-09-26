import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@morfikos/types";
import "@morfikos/ui";
import { Providers } from "./app/providers";
import { Router } from "./app/router";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>
    <Providers>
      <Router />
    </Providers>
  </StrictMode>,
);
