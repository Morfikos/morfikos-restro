import Fastify from "fastify";
import { authRoutes } from "./modules/auth/auth.routes.js";

const app = Fastify({
  logger: true,
});

app.get("/api/health", async () => {
  return {
    status: "ok",
  };
});

app.register(authRoutes, {
  prefix: "/api",
});

export default app;