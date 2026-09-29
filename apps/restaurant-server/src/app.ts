import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import "@morfikos/auth";
import "@morfikos/types";
import "@morfikos/validation";
import { createLocalMenuItem, getLocalMenu, parseCreateMenu } from "./menu.js";

const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));

export function buildApp() {
  const app = Fastify({ logger: true });
  const servesWeb = existsSync(webDist);

  app.get("/api/health", async () => {
    return { ok: true };
  });

  app.get("/api/menu", async (request) => {
    const query = request.query as { sync?: string };
    return getLocalMenu(query.sync === "1");
  });

  app.post("/api/menu", async (request, reply) => {
    const input = parseCreateMenu(request.body);
    if (!input) {
      return reply.code(400).send({ message: "Invalid menu item" });
    }

    const menu = await createLocalMenuItem(input);
    return reply.code(201).send(menu);
  });

  if (servesWeb) {
    app.register(fastifyStatic, {
      root: webDist,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.split("?")[0]?.startsWith("/api") ?? false;

    if (isApi || !servesWeb || (request.method !== "GET" && request.method !== "HEAD")) {
      return reply.code(404).send({ message: "Not found" });
    }

    return reply.sendFile("index.html");
  });

  return app;
}
