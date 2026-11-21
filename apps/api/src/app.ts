
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import "@morfikos/auth";
import "@morfikos/types";
import "@morfikos/validation";
import { authRoutes } from "./modules/auth/route.js";
import { organizationRoutes } from "./modules/organizations/routes.js";
import { branchRoutes } from "./modules/branches/routes.js";
import { menuRoutes } from "./modules/menu/routes.js";
import { orderRoutes } from "./modules/orders/routes.js";
import { tableRoutes } from "./modules/tables/routes.js";
import { floorRoutes } from "./modules/floors/routes.js";
import { kitchenRoutes } from "./modules/kitchen/routes.js";
import { billingRoutes } from "./modules/billing/routes.js";
import { shiftRoutes } from "./modules/shifts/routes.js";
import { guestRoutes } from "./modules/guests/routes.js";
import { inventoryRoutes } from "./modules/inventory/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { roleRoutes } from "./modules/roles/routes.js";
import {
  MAX_IMAGE_BYTES,
  UPLOADS_URL_PREFIX,
  ensureUploadsDir,
  getUploadsDir,
} from "./utils/storage.js";
const webDistPath = fileURLToPath(
  new URL("../../web/dist/", import.meta.url),
);

export function buildApp() {
  const app = Fastify({ logger: true });
  const servesWeb = existsSync(webDistPath);

  // Image uploads (one file per request) and serving of uploaded files.
  app.register(fastifyMultipart, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  });

  ensureUploadsDir();
  app.register(fastifyStatic, {
    root: getUploadsDir(),
    prefix: UPLOADS_URL_PREFIX,
    decorateReply: false,
  });

  app.register(organizationRoutes);
  app.register(authRoutes, {
    prefix: "/api/v1/auth",
  });

  app.register(branchRoutes);
  app.register(menuRoutes);
  app.register(orderRoutes);
  app.register(tableRoutes);
  app.register(floorRoutes);
  app.register(kitchenRoutes);
  app.register(billingRoutes);
  app.register(shiftRoutes);
  app.register(guestRoutes);
  app.register(inventoryRoutes);
  app.register(userRoutes);
  app.register(roleRoutes);
  app.get("/api/health", async () => {
    return { ok: true };
  });

  if (servesWeb) {
    app.register(fastifyStatic, {
      root: webDistPath,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi =
      request.url.split("?")[0]?.startsWith("/api") ?? false;

    if (
      isApi ||
      !servesWeb ||
      (request.method !== "GET" && request.method !== "HEAD")
    ) {
      return reply.code(404).send({ message: "Not found" });
    }

    return reply.sendFile("index.html");
  });
  ;


  return app;
}