import { buildApp } from "./app.js";
import { loadRepoEnv } from "./env.js";

loadRepoEnv();

const port = Number(process.env.CLOUD_API_PORT ?? 4000);
const app = buildApp();

await app.listen({ port, host: "0.0.0.0" });
