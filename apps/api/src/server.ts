import { buildApp } from "./app.js";
import { loadRepoEnv } from "./env.js";

loadRepoEnv();

const port = Number(process.env.API_PORT ?? 3000);
const app = await buildApp();

await app.listen({ port, host: "0.0.0.0" });
