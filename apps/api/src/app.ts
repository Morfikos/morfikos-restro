// import { existsSync } from "node:fs";
// import { fileURLToPath } from "node:url";
// import fastifyStatic from "@fastify/static";
// import Fastify from "fastify";
// import "@morfikos/auth";
// import "@morfikos/types";
// import "@morfikos/validation";

// const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));

// export function buildApp() {
//   const app = Fastify({ logger: true });
//   const servesWeb = existsSync(webDist);

//   app.get("/api/health", async () => {
//     return { ok: true };
//   });

//   if (servesWeb) {
//     app.register(fastifyStatic, {
//       root: webDist,
//     });
//   }

//   app.setNotFoundHandler((request, reply) => {
//     const isApi = request.url.split("?")[0]?.startsWith("/api") ?? false;

//     if (isApi || !servesWeb || (request.method !== "GET" && request.method !== "HEAD")) {
//       return reply.code(404).send({ message: "Not found" });
//     }

//     return reply.sendFile("index.html");
//   });

//   return app;
// }
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import "@morfikos/auth";
import "@morfikos/types";
import "@morfikos/validation";

import { organizationRoutes } from "./modules/organizations/routes.js";

const webDist = fileURLToPath(
  new URL("../../web/dist/", import.meta.url),
);

export function buildApp() {
  const app = Fastify({ logger: true });
  const servesWeb = existsSync(webDist);

  app.register(organizationRoutes);

  app.get("/api/health", async () => {
    return { ok: true };
  });

  if (servesWeb) {
    app.register(fastifyStatic, {
      root: webDist,
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

  return app;
}