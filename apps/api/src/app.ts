import Fastify from "fastify";

import { authRoutes } from "./modules/auth/auth.routes.js";

const app = Fastify({
  logger: true,
});

app.register(authRoutes);

export default app;