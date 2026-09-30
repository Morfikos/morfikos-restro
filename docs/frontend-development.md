# Frontend development

This guide says how to add a screen in `apps/web` without building the same feature twice. [backend-development.md](./backend-development.md) covers the API those screens call. [project-structure.md](./project-structure.md) maps the folders that exist today. [Readme.md](../Readme.md) records the stack.

POS, KDS, and Admin are three jobs in one React app. They share one API. A name such as `orders` appearing under more than one job means two views of one order, not two implementations.

## The three jobs

| Job | Route | Who it is for | What the screen is for |
| --- | --- | --- | --- |
| POS | `/pos` | Floor staff | Table map, item entry, send the order, close the bill |
| KDS | `/kds` | Kitchen | Tickets, stations, timers |
| Admin | `/admin` | Managers | Setup, users, and reports |

`apps/web/src/app/router.tsx` lazy-loads each job. `/` redirects to `/pos`. Add a route there when you add a screen.

A role decides who may open a route and who may call an endpoint. It does not decide the layout. `orders:read` allows a person to see orders. The POS screen and the admin screen are still different layouts on top of that permission.

## Build the data once

For a business concept such as orders, menu, or tables, add each of these once:

| Piece | Where it goes |
| --- | --- |
| Database model | `packages/database/prisma/schema.prisma` |
| Shared TypeScript type | `packages/types/src/<domain>.ts` |
| Request validation | `packages/validation` |
| HTTP route | `apps/api`. The handler checks the permission. |
| Fetch function and TanStack Query hook | `apps/web/src/features/<domain>/` |

The web app calls the API through the hook. It does not open the database. POS and admin both import that hook. Creating an order on the floor and listing orders in the office are two calls to the same function.

`src/app/providers.tsx` already creates one Query client for the app. Use it for server state. Use the Zustand store in `src/stores/` for UI state that is not on the server yet, such as the selected table or an order draft before it is sent.

Permission checks live in `packages/auth` and run on the API. Hiding a link in the browser is not the check. The endpoint still rejects a role that is not allowed.

## Build a screen per job

Put the layout that belongs to one job under that job:

| Screen | Where it goes |
| --- | --- |
| Floor ordering | `apps/web/src/features/pos/orders/` |
| Kitchen tickets | `apps/web/src/features/kds/tickets/` |
| Order review and filters | `apps/web/src/features/admin/orders/` |

Each screen imports the shared hook and renders only the layout for that job. Shared visual pieces go in `packages/ui` when they are generic controls, or in one shared component under `apps/web/src/features/<domain>/` when they are specific to that concept, such as an order line. Both screens import that component.

```text
features/pos/orders/      floor layout ──┐
                                          ├── features/orders/useOrders() ── /api/orders
features/admin/orders/    office layout ──┘
```

## Orders, as a worked example

1. Add the `Order` model, the `Order` type in `packages/types/src/order.ts`, and the request schema.
2. Add `GET /api/orders` and `POST /api/orders` once. A waiter may create. A manager may list. The handler enforces that.
3. Add `features/orders/api.ts` and `useOrders`. Both screens import `useOrders`.
4. Add the floor screen under `features/pos/orders/`: pick a table, tap items, send the order.
5. Add the office screen under `features/admin/orders/`: filter by date, open a row, read totals.
6. Register any new path in `router.tsx`.

The kitchen does not get an orders copy. It reads the same order after it is sent, through the kitchen types and `features/kds/`.

## Why does the same order use a different screen on POS and in admin?

An order is one record. POS and admin ask different questions about it, so each job gets its own layout. Both layouts call `useOrders` and `/api/orders`.

**POS is the live check.** Floor staff are at a table or the counter and have to finish this order now. The screen shows one table, large item buttons, modifiers, quantity, send to the kitchen, and payment. The useful state is the open order in front of them.

**Admin is the review of many orders.** A manager looks across service: voids, discounts, who did what, daily totals, refunds. The screen is a filterable list and a detail view: date, server, status, totals.

| | POS | Admin |
| --- | --- | --- |
| Scope | This table, this open order | Many orders, over time |
| Main action | Add items and send or pay | Search, inspect, refund, report |
| Shape | Menu and ticket | Table of orders and a detail pane |

The kitchen is a third view of that same order: the items that need to be cooked, not the bill and not the report.

## What goes where

| You are adding | Put it here |
| --- | --- |
| A new business concept (type, fetch, hook) | `packages/types` and `apps/web/src/features/<domain>/` |
| A layout used by one job | `apps/web/src/features/<pos\|kds\|admin>/<domain>/` |
| A control used by every job | `packages/ui` |
| A route | `apps/web/src/app/router.tsx` |
| Server data on a screen | A hook from `features/<domain>/`, via the Query client in `providers.tsx` |
| Local UI state | `apps/web/src/stores/` |

Today the three pages under `features/pos`, `features/kds`, and `features/admin` are starter shells. They read `ready` from `app-store` and do not call the API. The first real screen should follow the split above instead of copying the shell into each job.
