# Project structure

This guide is the map of the repository as it exists today. [Readme.md](../Readme.md) records the architecture decisions. This file says which folders and files are real, which are empty placeholders, and where to put the next feature.

POS, KDS, and Admin are starter screens. They do not call the API. The only HTTP route is `GET /api/health`.

## Start here

From the repository root:

```bash
pnpm install
pnpm dev
```

Node 20 or newer is required. The package manager is pnpm.

| Command | What it starts |
| --- | --- |
| `pnpm dev` | Web app and API |
| `pnpm dev:frontend` | Web app only |
| `pnpm dev:backend` | API only |
| `pnpm dev:api` | API only |
| `pnpm build` | Production build of every package that defines `build` |

| Surface | URL |
| --- | --- |
| POS | http://localhost:5173/pos |
| KDS | http://localhost:5173/kds |
| Admin | http://localhost:5173/admin |
| API health | http://localhost:3000/api/health |

`/` redirects to `/pos`. During development, Vite proxies `/api` to port 3000, so http://localhost:5173/api/health is the same check.

Copy `.env.example` to `.env` when you connect Neon. The API starts without `DATABASE_URL`. After `pnpm build`, the API also serves the built web app at http://localhost:3000/pos, http://localhost:3000/kds, and http://localhost:3000/admin.

```text
Browser
  │
  ├─ /pos /kds /admin  →  apps/web (Vite, port 5173)
  │
  └─ /api/*            →  proxied to apps/api (Fastify, port 3000)
                              GET /api/health  →  { ok: true }
```

## Where the next feature goes

| You are adding | Put it here |
| --- | --- |
| A screen | `apps/web/src/features/<area>/` and a route in `apps/web/src/app/router.tsx` |
| An HTTP route | `apps/api/src/app.ts`, or a module imported from there |
| A shared TypeScript type | `packages/types/src/` |
| A database table | `packages/database/prisma/schema.prisma`, then use `createPrismaClient` from `@morfikos/database` |
| Request validation | `packages/validation` (placeholder today) |
| Password, JWT, or permission checks | `packages/auth` (placeholder today) |

The web app should call the API. It should not open the database itself.

## Repository root

| File | Role |
| --- | --- |
| `package.json` | Root scripts. `dev` runs the web app and the API through Turborepo. |
| `pnpm-workspace.yaml` | Declares `apps/*` and `packages/*` as workspace packages, and allows Prisma and esbuild install scripts. |
| `pnpm-lock.yaml` | Locked dependency tree. Update it by running `pnpm install`. Do not edit it by hand. |
| `turbo.json` | `dev` is a long-running uncached task. `build` depends on dependency builds and writes `dist/`. |
| `Readme.md` | Architecture decisions and the intended stack. |
| `.env.example` | `DATABASE_URL` and `API_PORT=3000`. Copy to `.env` when connecting Neon. |
| `.gitignore` | Ignores `node_modules`, `dist`, `.turbo`, `.env`, SQLite files, and `.DS_Store`. |

## `apps/web`

Package name: `@morfikos/web`. This is the React app staff open in the browser. Vite serves it on port 5173 in development.

| File | Role |
| --- | --- |
| `package.json` | Scripts `dev` (`vite`) and `build` (`tsc --noEmit && vite build`). Depends on React, React Router, TanStack Query, Zustand, `@morfikos/types`, and `@morfikos/ui`. |
| `index.html` | HTML shell. The title is Morfikos. The React tree mounts on `#root` from `/src/main.tsx`. |
| `tsconfig.json` | Extends `packages/config/typescript/react.json`. Typecheck only (`noEmit`). Includes `src` and `vite.config.ts`. |
| `vite.config.ts` | Dev server on port 5173. Proxies `/api` to `http://127.0.0.1:3000`. |
| `src/vite-env.d.ts` | Vite client types for TypeScript. |
| `src/main.tsx` | Creates the React root, wraps the router in `Providers`, and imports `@morfikos/types` and `@morfikos/ui`. |
| `src/app/providers.tsx` | One TanStack Query client for the app. Screens do not use it yet. |
| `src/app/router.tsx` | `/` redirects to `/pos`. `/pos`, `/kds`, and `/admin` are lazy-loaded. The fallback text is "Loading...". |
| `src/stores/app-store.ts` | Zustand store. The only state is `ready: true`. |
| `src/features/pos/pos-page.tsx` | POS shell. Shows "Morfikos POS" and whether the store is ready. |
| `src/features/kds/kds-page.tsx` | Kitchen display shell. Same pattern as POS. |
| `src/features/admin/admin-page.tsx` | Admin shell. Same pattern as POS. |

`dist/` appears after `pnpm build`. It is gitignored. The API serves that folder when it exists.

## `apps/api`

Package name: `@morfikos/api`. This is the only server. Fastify listens on `API_PORT`, which defaults to 3000.

| File | Role |
| --- | --- |
| `package.json` | Scripts `dev` (`tsx watch src/server.ts`), `build` (`tsc`), and `start` (`node dist/server.js`). Depends on Fastify, `@fastify/static`, `@morfikos/auth`, `@morfikos/types`, and `@morfikos/validation`. |
| `tsconfig.json` | Extends `packages/config/typescript/node.json`. Compiles `src` to `dist`. |
| `src/env.ts` | If a `.env` file exists at the repo root, loads it. Does not override variables already set in the shell. |
| `src/server.ts` | Loads `.env`, builds the Fastify app, and listens on `0.0.0.0`. |
| `src/app.ts` | `GET /api/health` returns `{ ok: true }`. If `apps/web/dist` exists, static files are served from there, and unknown GET/HEAD requests receive `index.html` so `/pos`, `/kds`, and `/admin` work after a production build. Unknown `/api` paths return 404. |

The imported auth, types, and validation packages are placeholders. Importing them does not add behavior.

## `packages/database`

Package name: `@morfikos/database`. Prisma and Neon live here. The schema has no models yet, and the API does not call this package yet.

| File | Role |
| --- | --- |
| `package.json` | Exports `./src/index.ts`. Scripts `generate` (`prisma generate`) and `seed` (`tsx prisma/seed.ts`). |
| `prisma/schema.prisma` | PostgreSQL datasource using `DATABASE_URL`. No models yet. |
| `prisma/seed.ts` | Opens a Prisma client and disconnects. It does not insert rows. |
| `src/client.ts` | `createPrismaClient()` returns a new `PrismaClient`. |
| `src/index.ts` | Re-exports `createPrismaClient`. |

Add a model to `schema.prisma`, run `pnpm --filter @morfikos/database generate`, and use the client from the API. Do not query Postgres from `apps/web`.

## `packages/types`

Package name: `@morfikos/types`. Shared types for the web app and the API. Every file is an empty `export {}`.

| File | Reserved for |
| --- | --- |
| `src/index.ts` | Public exports of this package. |
| `src/auth.ts` | Auth request and session types. |
| `src/organization.ts` | Organization types. |
| `src/restaurant.ts` | Restaurant types. |
| `src/user.ts` | User types. |
| `src/table.ts` | Table and section types. |
| `src/menu.ts` | Menu types. |
| `src/order.ts` | Order types. |
| `src/kitchen.ts` | Kitchen ticket and station types. |
| `src/billing.ts` | Invoice types. |
| `src/payment.ts` | Payment types. |

## `packages/auth`

Package name: `@morfikos/auth`. Reserved for custom authentication. Every file is an empty `export {}`. None of this runs today.

| File | Reserved for |
| --- | --- |
| `src/password.ts` | Argon2id hashing and verification. |
| `src/jwt.ts` | Access-token creation and verification. |
| `src/refresh-token.ts` | Refresh-token generation, rotation, and revocation. |
| `src/session.ts` | User and device sessions. |
| `src/permissions.ts` | Role and permission checks. |
| `src/index.ts` | Public exports. |

## `packages/validation`

Package name: `@morfikos/validation`. Reserved for Zod schemas shared by the API and, where useful, the web app. Every file is an empty `export {}`.

| File | Reserved for |
| --- | --- |
| `src/auth.ts` | Auth payloads. |
| `src/users.ts` | User payloads. |
| `src/menu.ts` | Menu payloads. |
| `src/orders.ts` | Order payloads. |
| `src/billing.ts` | Invoice payloads. |
| `src/payments.ts` | Payment payloads. |
| `src/index.ts` | Public exports. |

## `packages/ui`

Package name: `@morfikos/ui`. Reserved for shared React components. Every file is an empty `export {}`. The screens do not render these components yet. `apps/web` imports the package from `main.tsx` so the workspace link stays in place.

| File | Reserved for |
| --- | --- |
| `src/Button.tsx` | Button. |
| `src/Input.tsx` | Text input. |
| `src/Select.tsx` | Select. |
| `src/Modal.tsx` | Modal. |
| `src/Dialog.tsx` | Dialog. |
| `src/index.ts` | Public exports. |

## `packages/printer`

Package name: `@morfikos/printer`. Reserved for ESC/POS printing. Every file is an empty `export {}`.

| File | Reserved for |
| --- | --- |
| `src/printer.service.ts` | Print entry point. |
| `src/adapters/network.ts` | Network printer. |
| `src/adapters/usb.ts` | USB printer. |
| `src/adapters/bluetooth.ts` | Bluetooth printer. |
| `src/templates/kot.ts` | Kitchen order ticket. |
| `src/templates/receipt.ts` | Receipt. |
| `src/templates/invoice.ts` | Invoice. |
| `src/index.ts` | Public exports. |

## `packages/realtime`

Package name: `@morfikos/realtime`. Reserved for WebSocket events between the API and the kitchen or POS screens. Every file is an empty `export {}`.

| File | Reserved for |
| --- | --- |
| `src/events.ts` | Event names and payloads. |
| `src/server.ts` | Server-side socket helpers. |
| `src/client.ts` | Browser socket helpers. |
| `src/index.ts` | Public exports. |

## `packages/config`

Package name: `@morfikos/config`. Shared TypeScript settings. There is no runtime code.

| File | Role |
| --- | --- |
| `typescript/base.json` | Strict TypeScript defaults used by the other configs. |
| `typescript/node.json` | Extends `base.json` for Node apps. `@morfikos/api` uses this. |
| `typescript/react.json` | Extends `base.json` for React. `@morfikos/web` uses this. |
| `package.json` | Publishes the `typescript` directory as package files. |
