# Backend development

This guide says how to add a feature on the server without building it once per screen. [frontend-development.md](./frontend-development.md) covers the screens that call these routes. [project-structure.md](./project-structure.md) maps the folders that exist today. [Readme.md](../Readme.md) records the stack.

POS, KDS, and Admin all call one API, `@morfikos/api`. The browser does not open the database. A domain such as orders is one set of routes under `/api/orders`. It is not split into `/api/pos/orders` and `/api/admin/orders`.

## One API

`apps/api` is the only server. Fastify listens on `API_PORT`, which defaults to 3000. During development, Vite proxies `/api` to that port.

`buildApp` in `apps/api/src/app.ts` registers routes. Today the only route is `GET /api/health`, which returns `{ ok: true }`. Unknown `/api` paths return 404. A new domain gets its own module, imported from `app.ts`. The health handler stays a health check.

## Request path

Each request follows the same path:

```text
Browser
  │
  ▼
/api/<domain>          apps/api route module
  │
  ├─ Zod schema        packages/validation
  ├─ Role check        packages/auth
  ├─ Prisma            packages/database  createPrismaClient()
  │
  ▼
Response body          packages/types
```

Validate the body and query before any write. Check the role in the handler. Read and write only through `createPrismaClient()` from `@morfikos/database`. Return a value that matches the shared type in `@morfikos/types`. The web app imports that same type for its hook.

Hiding a button in POS or admin is not the permission check. The handler still rejects a role that is not allowed.

## What is built once

For a business concept such as orders, menu, or tables, add each of these once:

| Piece | Where it goes |
| --- | --- |
| Database model | `packages/database/prisma/schema.prisma` |
| Shared TypeScript type | `packages/types/src/<domain>.ts`, re-exported from `src/index.ts` |
| Zod schema | `packages/validation/src/<domain>.ts`, re-exported from `src/index.ts` |
| Permission check | `packages/auth/src/permissions.ts` |
| HTTP routes | A module under `apps/api/src/`, registered from `app.ts` |

After a schema change, run `pnpm --filter @morfikos/database generate` and use the client from the API.

POS creates an order and admin lists orders by calling those same routes. The screen layouts live in the web app. They do not get their own handlers.

## Orders, as a worked example

1. Add the `Order` model to `schema.prisma`, then generate the Prisma client.
2. Define the `Order` type in `packages/types/src/order.ts` and export it from `packages/types/src/index.ts`.
3. Define the create and list payloads in `packages/validation/src/orders.ts`.
4. Add `GET /api/orders` and `POST /api/orders` in one orders module, and register it from `app.ts`.
5. In the handlers, allow a waiter to create and a manager to list. Reject everyone else.
6. Return the `Order` type. The web app's `useOrders` hook calls these two routes.

The kitchen does not get a second order table or a second create route. After an order is sent, kitchen tickets read that same order. Ticket updates belong on the kitchen routes, backed by `packages/types/src/kitchen.ts`.

## Why do POS and admin share the same order routes?

The screens differ. The record and the endpoints stay one.

POS asks "what does this table want right now?" and calls `POST /api/orders`. Admin asks "what happened across service?" and calls `GET /api/orders` with filters such as date, server, and status. Both hit the same `Order` rows through `createPrismaClient()`.

A filter changes which rows come back. A permission changes who may call the route. Neither one is a reason to add `/api/pos/orders` or `/api/admin/orders`. A second handler would drift: one path would forget a status, a tax field, or a void.

| | POS | Admin |
| --- | --- | --- |
| Call | `POST /api/orders` | `GET /api/orders` |
| Who | Waiter, checked in the handler | Manager, checked in the handler |
| Result | The open order for this table | The orders that match the filters |

The kitchen is a third caller of the same order. It reads the items that were sent. It does not create a parallel order.

## What goes where

| You are adding | Put it here |
| --- | --- |
| A new table or column | `packages/database/prisma/schema.prisma` |
| A response or domain type | `packages/types/src/<domain>.ts` |
| A request body or query schema | `packages/validation/src/<domain>.ts` |
| A role or permission rule | `packages/auth/src/permissions.ts` |
| A route | A module under `apps/api/src/`, registered from `app.ts` |
| A screen that calls the route | The web app. See [frontend-development.md](./frontend-development.md). |

Today `GET /api/health` is the only route, and the auth, types, validation, and database packages are empty placeholders. The first real feature should follow the path above. Leave the health route as it is.
