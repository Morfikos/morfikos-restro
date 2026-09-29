import Fastify from "fastify";
import "@morfikos/auth";
import "@morfikos/types";
import "@morfikos/validation";
import { listCloudMenu, parseCloudMenuItem, saveCloudMenuItem } from "./menu.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return { ok: true };
  });

  app.get("/menu", async () => {
    return listCloudMenu();
  });

  app.post("/menu", async (request, reply) => {
    const item = parseCloudMenuItem(request.body);
    if (!item) {
      return reply.code(400).send({ message: "Invalid menu item" });
    }

    return saveCloudMenuItem(item);
  });

  return app;
}
