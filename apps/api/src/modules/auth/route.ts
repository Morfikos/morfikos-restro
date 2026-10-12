import type { FastifyInstance } from "fastify";
import {   refreshController,loginController,  logoutController, } from "./controller.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/login", loginController);
    app.post("/refresh", refreshController);
    
  app.post("/logout", logoutController);

}