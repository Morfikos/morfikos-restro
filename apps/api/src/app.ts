
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import "@morfikos/auth";
import "@morfikos/types";
import "@morfikos/validation";
import { authRoutes } from "./modules/auth/route.js";
import { organizationRoutes } from "./modules/organizations/routes.js";
import { branchRoutes } from "./modules/branches/routes.js";
import { menuRoutes } from "./modules/menu/routes.js";
const webDistPath = fileURLToPath(
  new URL("../../web/dist/", import.meta.url),
);

export function buildApp() {
  const app = Fastify({ logger: true });
  const servesWeb = existsSync(webDistPath);

  app.register(organizationRoutes);
 app.register(authRoutes, {
    prefix: "/api/v1/auth",
  });

  app.register(branchRoutes);
  app.register(menuRoutes);
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