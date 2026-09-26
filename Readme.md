# Restaurant POS Architecture

Based on the decisions made so far, freeze the architecture at this level and avoid adding more infrastructure until the MVP proves it is needed.

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
| `pnpm dev` | POS, KDS, Admin, cloud API, and restaurant server |
| `pnpm dev:frontend` | POS, KDS, and Admin |
| `pnpm dev:backend` | Cloud API and restaurant server |

| App | URL |
| --- | --- |
| POS | http://localhost:5173 |
| KDS | http://localhost:5174 |
| Admin | http://localhost:5175 |
| Cloud API | http://localhost:3000/health |
| Restaurant server | http://localhost:3001/health |

Single-app scripts: `pnpm dev:pos`, `pnpm dev:kds`, `pnpm dev:admin`, `pnpm dev:cloud-api`, and `pnpm dev:restaurant-server`.

Copy `.env.example` to `.env` when you connect Neon. Both servers start without `DATABASE_URL`.

## Final Tech Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Frontend | React + TypeScript | POS, KDS, and Admin interfaces |
| Backend | Node.js + TypeScript | Application/backend services |
| Backend Framework | Fastify | Cloud API and restaurant server |
| Cloud Database | Neon PostgreSQL | Central source of truth |
| ORM | Prisma | Database access and migrations |
| Local Database | SQLite | Offline restaurant operations |
| Authentication | Custom Auth | Full control over online/offline authentication |
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
| Containerization | Docker | Cloud API and restaurant server deployment |
| Cloud Deployment | Docker-compatible hosting | Cloud API |
| Testing | Not in scope | As decided |
| Monitoring | Not in scope | As decided |
| Redis | Not required | Add only if a demonstrated need appears |
| Neon Auth | Not used | Custom auth instead |

## Final Architecture

The system has two environments.

### Cloud

```text
                    INTERNET
                       │
                       ▼
              ┌─────────────────┐
              │   Cloud API     │
              │ Node + Fastify  │
              └────────┬────────┘
                       │
                    Prisma
                       │
                       ▼
              ┌─────────────────┐
              │ Neon PostgreSQL │
              └─────────────────┘
```

### Restaurant

```text
                RESTAURANT LAN
                       │
              ┌────────▼─────────┐
              │ Restaurant Server │
              │   Node + Fastify  │
              └────────┬─────────┘
                       │
                    SQLite
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
         POS          KDS        Printers
        React        React        ESC/POS
```

### Synchronization

```text
Neon PostgreSQL
      ▲
      │
      │ Sync
      │
Restaurant Server
      │
    SQLite
      │
 ┌────┼────┐
 POS  KDS  Billing
```

The restaurant server is the operational authority when the restaurant is offline.

The Neon database is the central cloud source of truth when connectivity is available.

## Final Monorepo Structure

```text
restaurant-pos/
│
├── apps/
│   │
│   ├── pos/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── router.tsx
│   │   │   │   ├── providers.tsx
│   │   │   │   └── app.tsx
│   │   │   │
│   │   │   ├── features/
│   │   │   │   ├── auth/
│   │   │   │   ├── tables/
│   │   │   │   ├── menu/
│   │   │   │   ├── orders/
│   │   │   │   ├── billing/
│   │   │   │   ├── payments/
│   │   │   │   └── customers/
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
│   ├── kds/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   ├── features/
│   │   │   │   ├── kitchen/
│   │   │   │   ├── tickets/
│   │   │   │   ├── stations/
│   │   │   │   └── timers/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   ├── stores/
│   │   │   ├── lib/
│   │   │   └── main.tsx
│   │   │
│   │   └── package.json
│   │
│   ├── admin/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   ├── features/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── restaurants/
│   │   │   │   ├── users/
│   │   │   │   ├── roles/
│   │   │   │   ├── menu/
│   │   │   │   ├── tables/
│   │   │   │   ├── orders/
│   │   │   │   ├── payments/
│   │   │   │   └── reports/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   └── main.tsx
│   │   │
│   │   └── package.json
│   │
│   ├── cloud-api/
│   │   ├── src/
│   │   │   ├── app.ts
│   │   │   ├── server.ts
│   │   │
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── organizations/
│   │   │   │   ├── restaurants/
│   │   │   │   ├── users/
│   │   │   │   ├── roles/
│   │   │   │   ├── tables/
│   │   │   │   ├── menu/
│   │   │   │   ├── orders/
│   │   │   │   ├── kitchen/
│   │   │   │   ├── billing/
│   │   │   │   ├── payments/
│   │   │   │   ├── printers/
│   │   │   │   ├── reports/
│   │   │   │   └── sync/
│   │   │   │
│   │   │   ├── middleware/
│   │   │   ├── plugins/
│   │   │   ├── websocket/
│   │   │   └── config/
│   │   │
│   │   └── package.json
│   │
│   └── restaurant-server/
│       ├── src/
│       │   ├── app.ts
│       │   ├── server.ts
│       │   │
│       │   ├── modules/
│       │   │   ├── auth/
│       │   │   ├── users/
│       │   │   ├── tables/
│       │   │   ├── menu/
│       │   │   ├── orders/
│       │   │   ├── kitchen/
│       │   │   ├── billing/
│       │   │   ├── payments/
│       │   │   ├── printers/
│       │   │   └── sync/
│       │   │
│       │   ├── database/
│       │   │   ├── sqlite.ts
│       │   │   └── migrations/
│       │   │
│       │   ├── websocket/
│       │   └── config/
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
│   │   ├── cloud-api.Dockerfile
│   │   └── restaurant-server.Dockerfile
│   │
│   └── deployment/
│
├── docs/
│   ├── architecture/
│   │   ├── overview.md
│   │   ├── offline-first.md
│   │   ├── synchronization.md
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

The cloud API and restaurant server both consume this package, but the persistence layer remains environment-specific.

## Cloud vs Local Database

Keep this distinction very clear in the codebase.

### Cloud

```text
packages/database/
└── prisma/
    └── schema.prisma
```

Prisma → Neon PostgreSQL

### Local

```text
apps/restaurant-server/
└── src/database/
    ├── sqlite.ts
    └── migrations/
```

Restaurant server → SQLite

The restaurant server should not directly use the cloud Prisma client for normal POS operations.

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
- SyncRecord

Then add inventory, loyalty, online ordering, multi-branch functionality, and similar features in their respective releases.

## Final Decision

The architecture is:

> React + TypeScript + Node.js + Fastify + Prisma + Neon PostgreSQL + SQLite + custom JWT/refresh-token authentication + RBAC + WebSockets + Zod + TanStack Query + Zustand + ESC/POS + pnpm/Turborepo + Docker.

Deliberately excluded:

- Neon Auth
- Better Auth
- Redis
- Automated testing infrastructure
- Monitoring infrastructure

The most important architectural principle is:

> Cloud-first data management, local-first restaurant operations.
