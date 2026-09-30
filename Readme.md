# Restaurant POS Architecture

- Based on the decisions made so far, freeze the architecture at this level and avoid adding more infrastructure until the MVP proves it is needed.

## Getting Started

Install dependencies, then start the apps you need from the repo root:

```bash
pnpm install
pnpm dev
pnpm dev:frontend
pnpm dev:backend
```

| Command | What it starts |
| --- | --- |
| `pnpm dev` | Web app and API |
| `pnpm dev:frontend` | Web app |
| `pnpm dev:backend` | API |
| `pnpm dev:api` | API |

| Surface | URL |
| --- | --- |
| POS | http://localhost:5173/pos |
| KDS | http://localhost:5173/kds |
| Admin | http://localhost:5173/admin |
| API | http://localhost:3000/api/health |

`/` redirects to `/pos`. The Vite dev server proxies `/api` to the API, so http://localhost:5173/api/health is the same check.

After `pnpm build`, the API also serves the web app at http://localhost:3000/pos, http://localhost:3000/kds, and http://localhost:3000/admin.

Copy `.env.example` to `.env` when you connect Neon. The API exposes `GET /api/health`. POS, KDS, and admin are empty screens.

## Final Tech Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Frontend | React + TypeScript | POS, KDS, and Admin interfaces |
| Backend | Node.js + TypeScript | Application/backend services |
| Backend Framework | Fastify | API |
| Database | Neon PostgreSQL | Source of truth |
| ORM | Prisma | Database access and migrations |
| Authentication | Custom Auth | Full control over authentication |
| Password Hashing | Argon2id | Secure password storage |
| Access Tokens | JWT | Short-lived API authentication |
| Refresh Tokens | Database-backed refresh sessions | Session renewal/revocation |
| Authorization | Custom RBAC | Roles and permissions |
| Validation | Zod | Request/data validation |
| Frontend Server State | TanStack Query | API/server state |
| Frontend Local State | Zustand | POS/UI state |
| Real-time | WebSockets | KDS/order/table updates |
| Printing | ESC/POS | Thermal printers/KOT/receipts |
| Monorepo | pnpm Workspaces | Workspace/package management |
| Build System | Turborepo | Monorepo builds/tasks |
| Containerization | Docker | API deployment |
| Deployment | Docker-compatible hosting | API |
| Testing | Not in scope | As decided |
| Monitoring | Not in scope | As decided |
| Redis | Not required | Add only if a demonstrated need appears |
| Neon Auth | Not used | Custom auth instead |

## Final Architecture

Staff use one web app. It calls one API. The API is the source of truth, backed by Neon when `DATABASE_URL` is set.

```text
        POS   KDS   Admin
              │
              ▼
┌─────────────────┐
│       API       │
│  Node + Fastify │
│  /api/*         │
└────────┬────────┘
         │
      Prisma
         │
         ▼
┌─────────────────┐
│ Neon PostgreSQL │
└─────────────────┘
```

The screens are empty shells. Feature routes are not wired yet.

## Final Monorepo Structure

```text
restaurant-pos/
│
├── apps/
│   │
│   ├── web/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── router.tsx
│   │   │   │   └── providers.tsx
│   │   │   │
│   │   │   ├── features/
│   │   │   │   ├── pos/
│   │   │   │   │   ├── auth/
│   │   │   │   │   ├── tables/
│   │   │   │   │   ├── menu/
│   │   │   │   │   ├── orders/
│   │   │   │   │   ├── billing/
│   │   │   │   │   ├── payments/
│   │   │   │   │   └── customers/
│   │   │   │   ├── kds/
│   │   │   │   │   ├── kitchen/
│   │   │   │   │   ├── tickets/
│   │   │   │   │   ├── stations/
│   │   │   │   │   └── timers/
│   │   │   │   └── admin/
│   │   │   │       ├── dashboard/
│   │   │   │       ├── restaurants/
│   │   │   │       ├── users/
│   │   │   │       ├── roles/
│   │   │   │       ├── menu/
│   │   │   │       ├── tables/
│   │   │   │       ├── orders/
│   │   │   │       ├── payments/
│   │   │   │       └── reports/
│   │   │   │
│   │   │   ├── components/
│   │   │   │   ├── ui/
│   │   │   │   ├── layout/
│   │   │   │   └── common/
│   │   │   │
│   │   │   ├── stores/
│   │   │   ├── hooks/
│   │   │   ├── lib/
│   │   │   └── main.tsx
│   │   │
│   │   └── package.json
│   │
│   └── api/
│       ├── src/
│       │   ├── app.ts
│       │   ├── server.ts
│       │   └── env.ts
│       │
│       └── package.json
│
├── packages/
│   │
│   ├── database/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── seed.ts
│   │   │
│   │   └── src/
│   │       ├── client.ts
│   │       └── index.ts
│   │
│   ├── auth/
│   │   ├── src/
│   │   │   ├── password.ts
│   │   │   ├── jwt.ts
│   │   │   ├── refresh-token.ts
│   │   │   ├── session.ts
│   │   │   ├── permissions.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── types/
│   │   ├── src/
│   │   │   ├── auth.ts
│   │   │   ├── organization.ts
│   │   │   ├── restaurant.ts
│   │   │   ├── user.ts
│   │   │   ├── table.ts
│   │   │   ├── menu.ts
│   │   │   ├── order.ts
│   │   │   ├── kitchen.ts
│   │   │   ├── billing.ts
│   │   │   ├── payment.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── validation/
│   │   ├── src/
│   │   │   ├── auth.ts
│   │   │   ├── users.ts
│   │   │   ├── menu.ts
│   │   │   ├── orders.ts
│   │   │   ├── billing.ts
│   │   │   ├── payments.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── ui/
│   │   ├── src/
│   │   │   ├── Button.tsx
│   │   │   ├── Input.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── Dialog.tsx
│   │   │   ├── Select.tsx
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── printer/
│   │   ├── src/
│   │   │   ├── escpos/
│   │   │   ├── commands/
│   │   │   ├── adapters/
│   │   │   │   ├── network.ts
│   │   │   │   ├── usb.ts
│   │   │   │   └── bluetooth.ts
│   │   │   ├── templates/
│   │   │   │   ├── kot.ts
│   │   │   │   ├── receipt.ts
│   │   │   │   └── invoice.ts
│   │   │   ├── printer.service.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── realtime/
│   │   ├── src/
│   │   │   ├── events.ts
│   │   │   ├── client.ts
│   │   │   ├── server.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── config/
│       ├── eslint/
│       ├── typescript/
│       └── package.json
│
├── infrastructure/
│   ├── docker/
│   │   └── api.Dockerfile
│   │
│   └── deployment/
│
├── docs/
│   ├── architecture/
│   │   ├── overview.md
│   │   ├── authentication.md
│   │   └── realtime.md
│   │
│   ├── database/
│   │   └── data-model.md
│   │
│   └── api/
│       └── conventions.md
│
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

## Authentication Structure

The custom authentication package is deliberately separated:

```text
packages/auth/
│
├── password.ts
├── jwt.ts
├── refresh-token.ts
├── session.ts
├── permissions.ts
└── index.ts
```

The responsibilities are:

| Module | Responsibility |
| --- | --- |
| `password.ts` | Argon2id hashing/verification |
| `jwt.ts` | Access-token creation/verification |
| `refresh-token.ts` | Refresh-token generation/rotation/revocation |
| `session.ts` | User/device sessions |
| `permissions.ts` | RBAC/permission checks |

The API consumes this package.

## Database

```text
packages/database/
└── prisma/
    └── schema.prisma
```

Prisma → Neon PostgreSQL

The schema has no models yet. Add them when a feature needs persisted data.

## Core MVP Data Model

Don't overbuild the database on day one. Start with:

**Identity and access**

- Organization
- Restaurant
- User
- Role
- Permission

**Floor**

- Table
- TableSection

**Menu**

- MenuCategory
- MenuItem
- MenuModifier

**Orders**

- Order
- OrderItem
- OrderItemModifier

**Kitchen**

- KitchenTicket
- KitchenStation

**Billing**

- Invoice
- Payment
- PaymentMethod

**Operations**

- Printer
- Session
- RefreshToken
- AuditLog

Then add inventory, loyalty, online ordering, multi-branch functionality, and similar features in their respective releases.

## Final Decision

The architecture is:

> React + TypeScript + Node.js + Fastify + Prisma + Neon PostgreSQL + custom JWT/refresh-token authentication + RBAC + WebSockets + Zod + TanStack Query + Zustand + ESC/POS + pnpm/Turborepo + Docker.

Deliberately excluded:

- Neon Auth
- Better Auth
- Redis
- Automated testing infrastructure
- Monitoring infrastructure

The most important architectural principle is:

> The POS, kitchen, and admin screens work through the online API.
