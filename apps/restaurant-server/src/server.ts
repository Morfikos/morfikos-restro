import { buildApp } from "./app.js";

const port = Number(process.env.RESTAURANT_SERVER_PORT ?? 3000);
const app = buildApp();

await app.listen({ port, host: "0.0.0.0" });
