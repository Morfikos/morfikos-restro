import fp from "fastify-plugin";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import { AppError } from "./errors.js";

export const securityPlugin = fp(async (app) => {
  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET || undefined,
  });

  // CSP is off until the web build is checked against it; the other headers are safe now.
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });

  // global: false -> only routes that set config.rateLimit are limited.
  await app.register(fastifyRateLimit, { global: false });

  // CSRF guard: browsers cannot add a custom header to a cross-site form post,
  // so requiring one blocks forged requests that ride on our cookies.
  app.addHook("onRequest", async (request) => {
    const isApi = request.url.startsWith("/api/");
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (isApi && isWrite && request.headers["x-requested-with"] !== "morfikos") {
      throw new AppError("FORBIDDEN", 403, "Missing x-requested-with header");
    }
  });
});
