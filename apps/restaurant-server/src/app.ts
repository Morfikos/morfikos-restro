import Fastify from "fastify";
import "@morfikos/auth";
import "@morfikos/types";
import "@morfikos/validation";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    return { ok: true };
  });

  return app;
}
