# Morfikos POS — Frontend Architecture & Data Layer Presentation

> **Presenter:** Sanskar  
> **Stack:** Next.js (App Router) · TypeScript · Untitled UI + `next-themes` · TanStack Query · Zustand · IndexedDB (Dexie.js) · SSE + Redis Pub/Sub · Fastify + Neon PostgreSQL  
> **Scope:** Complete frontend architecture covering all 8 finalized action items — ready for team walkthrough and timeline sign-off.

---

## Slide 1: High-Level System & 5-App Separate Monorepo Architecture

Morfikos POS uses a **5-App Separate Model inside one Turborepo Monorepo** — giving **zero blast radius** across roles, isolated sessions per subdomain/port, and **100% shared packages** (`packages/ui`, `packages/access`, `packages/api-client`, `packages/validation`, `packages/types`, `packages/realtime`).
*(MVP launches with **QR ordering**; **NFC tap** plugs cleanly into `apps/guest` post-MVP at ~₹20–₹50/tag.)*

```mermaid
flowchart TD
    subgraph Apps["5 Separate Next.js Apps (Turborepo Monorepo)"]
        Owner["1. apps/owner (:3001)\nOwner & Manager Portal + Super Admin\n(Sales, Menu, Inventory, Campaigns, Flags)"]
        Cashier["2. apps/cashier (:3002)\nCashier POS\n(Floor Map, Billing, Split, UPI, IndexedDB Offline)"]
        Waiter["3. apps/waiter (:3003)\nWaiter Mobile PWA\n(Tables, Quick Orders, KOT, Service Requests)"]
        Kitchen["4. apps/kitchen (:3004)\nKitchen Display System (KDS)\n(Dark Mode, Station Tickets, Bump Timers)"]
        Guest["5. apps/guest (:3005)\nCustomer QR / NFC Ordering + Entrance TV\n(Zero Login, Ultra-Light, Lazy Games)"]
    end

    subgraph Shared["Shared Workspace Packages (Zero Code Duplication)"]
        UI["packages/ui (Untitled UI + next-themes)"]
        Access["packages/access (Permissions, Roles, Feature Flags)"]
        Client["packages/api-client (Typed apiFetch + Query Keys)"]
        Val["packages/validation (Shared Zod Schemas)"]
        RT["packages/realtime (SSE / WS Event Types)"]
    end

    subgraph Backend["Backend & Infrastructure"]
        API["Fastify REST API (:3000 /api/v1)"]
        SSE["SSE / Realtime Gateway"]
        PubSub[("Redis Pub/Sub\n(Multi-Node Event Bus)")]
        DB[("Neon PostgreSQL\n(Prisma ORM)")]
        R2[("Cloudflare R2 / S3\n(Menu & Floor Media)")]
    end

    Owner & Cashier & Waiter & Kitchen & Guest --> UI & Access & Client & Val & RT
    Client -->|"RSC Fetch + REST Mutations"| API
    RT <-->|"Live Push"| SSE
    API --> DB & R2
    API --> PubSub <--> SSE
```

---

## Slide 2: Server Components (RSC) vs. Client Components

**Core Rule across every page & module:**
- **Old Pattern (Rejected):** `useEffect` → `fetch()` → `useState()` → loading spinner flash on every page.
- **New Pattern (Standard):** **Server Components** fetch & dehydrate initial data on the server; **Client Components (`"use client"`)** handle interactivity, optimistic mutations, and live updates.

```mermaid
sequenceDiagram
    actor User as Owner / Cashier
    participant MW as Next.js Middleware
    participant RSC as Server Component (page.tsx)
    participant API as Fastify API
    participant CC as Client Component ("use client")

    User->>MW: Navigate to /admin/invoices
    MW->>MW: Verify HttpOnly Session Cookie
    MW->>RSC: Forward authenticated request
    RSC->>API: Check Org Feature Flags + RBAC + Fetch Invoices
    API-->>RSC: Initial Invoices JSON
    RSC->>RSC: dehydrate(queryClient)
    RSC-->>User: Stream pre-rendered HTML + HydrationBoundary
    Note over User,CC: Instant first paint (Zero useEffect fetch flash)
    CC->>CC: Hydrate TanStack Query Cache
    User->>CC: Click "Generate Invoice" (Interactive UI)
    CC->>API: POST /api/v1/invoices (with Idempotency-Key)
    API-->>CC: 201 Created -> Update TanStack Query Cache
```

---

## Slide 3: Frontend Data Layer Architecture

No component calls raw `fetch()`. Every screen goes through one centralized **Data Layer** (`packages/api-client`) with built-in auth refresh, idempotency, caching, offline storage, and live sync.

```mermaid
flowchart TD
    UI["React UI Components\n(Owner / POS / KDS / Waiter / Guest / TV)"]

    subgraph DataLayer["Centralized Frontend Data Layer"]
        TQ["TanStack Query\n(Server State Cache & Optimistic Updates)"]
        ZS["Zustand Store\n(Ephemeral & Persisted Client UI State)"]
        IDB["IndexedDB (Dexie.js)\n(Offline Server Mirror + Outbox Queue)"]
        SSEClient["SSE Live Listener\n(Auto-Invalidates / Patches Cache)"]
        Client["Typed apiFetch Client\n• HttpOnly Cookie Auth + 401 Refresh Lock\n• UUID Idempotency-Key on Mutations\n• Shared Zod Validation + Error Normalizer"]
    end

    API["Fastify API (/api/v1) + SSE Stream"]

    UI --> TQ & ZS
    TQ <--> Client --> API
    TQ <--> IDB
    SSEClient <--> API
    SSEClient -->|"setQueryData / invalidateQueries"| TQ
    IDB -->|"FIFO Replay on Reconnect"| Client
```

### TanStack Query Caching Policy

| Data Domain | `staleTime` | `gcTime` | Refresh / Invalidation Trigger |
| :--- | :--- | :--- | :--- |
| **Auth, RBAC & Org Feature Flags** | `5 min` | `30 min` | Login, branch switch, or `org.features.updated` SSE |
| **Menu, Categories, Floors, Tables** | `5 min` | `30 min` | Menu/floor mutation or `menu.updated` SSE |
| **Live Orders, KDS, Payments** | `0` (always live) | `10 min` | Instant SSE patch/invalidation + optimistic updates |
| **Invoices & Analytics Reports** | `2 min` | `15 min` | Filter change or `invoice.issued` SSE |

---

## Slide 4: Client State vs. Server State vs. Derived State

A clear decision flowchart every developer follows before creating any state variable:

```mermaid
flowchart TD
    Q1{"Does this data come from\nthe Backend DB or get shared\nacross users/devices?"}
    Q1 -->|"YES\n(Orders, Menu, Bills,\nPermissions, Flags)"| Server["SERVER STATE\nRSC + TanStack Query\n(+ IndexedDB offline cache)"]
    Q1 -->|"NO"| Q2{"Can it be calculated\nfrom existing state?\n(Cart total, GST preview,\n% growth)"}
    Q2 -->|"YES"| Derived["DERIVED DATA\nuseMemo / Selectors\n(Never store in state!)"]
    Q2 -->|"NO"| Q3{"Should it be shareable\nor survive link copy?\n(Page, Date range, Search)"}
    Q3 -->|"YES"| URL["URL STATE\nNext.js searchParams"]
    Q3 -->|"NO"| Q4{"Should it persist when\nuser returns later?\n(Sidebar open/closed,\nTheme, Active Branch)"}
    Q4 -->|"YES"| Persist["CLIENT PERSISTED STATE\nZustand persist (localStorage/cookie)\n(Never store JWTs or PII!)"]
    Q4 -->|"NO\n(Open modal, Draft cart,\nSound mute)"| Ephemeral["CLIENT EPHEMERAL STATE\nZustand (In-Memory)"]
```

---

## Slide 5: Offline Sync Engine Flow (IndexedDB + TanStack Query)

If restaurant Wi-Fi drops — or if the browser is closed and reopened days later — **IndexedDB** preserves all local data in the **exact same structure as the server** and syncs automatically when internet returns.

```mermaid
sequenceDiagram
    actor Cashier as Cashier POS
    participant TQ as TanStack Query
    participant IDB as IndexedDB (Dexie.js)
    participant Sync as Sync Worker
    participant API as Fastify API

    Note over Cashier,API: 1. Online Hydration
    API-->>TQ: Menu, Floors, Tables, Open Orders
    TQ->>IDB: Persist 1:1 Server DTO Mirror

    Note over Cashier,API: 2. Internet Disconnects (Offline Mode)
    Cashier->>TQ: Create Order / Add Items / Cash Payment
    TQ->>TQ: Optimistic UI Update ("Pending Sync" badge)
    TQ->>IDB: Save Order (_syncStatus: "pending")
    TQ->>IDB: Push to Outbox Queue (with UUID Idempotency-Key)

    Note over Cashier,API: 3. Internet Returns (Auto-Reconnect)
    Sync->>API: GET /api/health -> 200 OK
    loop FIFO Outbox Replay
        Sync->>IDB: Read next pending mutation
        Sync->>API: POST /orders (Header: Idempotency-Key)
        API-->>Sync: 200/201 Created (Server ID & Timestamp)
        Sync->>IDB: Replace temp ID & mark synced
    end
    Sync->>API: GET /branches/:id/sync?since=lastSyncedAt
    API-->>Sync: Delta Updates
    Sync->>IDB: Update Mirror
    Sync->>TQ: Invalidate & Refresh UI
```

---

## Slide 6: IndexedDB Server-Mirrored Schema

Mirroring backend DTOs **1:1** inside IndexedDB means **zero data transformation** is required during offline reads or online sync.

```mermaid
erDiagram
    BRANCH ||--o{ FLOOR : has
    FLOOR ||--o{ DINING_TABLE : contains
    BRANCH ||--o{ MENU_ITEM : serves
    DINING_TABLE ||--o{ ORDER : hosts
    ORDER ||--o| BILL : generates
    BILL ||--o{ PAYMENT : receives

    ORDER {
        string id PK
        string branchId
        string tableId
        string status
        int totalPaise
        string updatedAt
        string _syncStatus
    }

    BILL {
        string id PK
        string orderId FK
        string status
        int totalPaise
        string _syncStatus
    }

    OUTBOX_QUEUE {
        int seq PK
        string idempotencyKey UK
        string method
        string endpoint
        string entityType
        string entityId
        string status
        string createdAt
    }

    SYNC_META {
        string key PK
        string lastSyncedAt
    }
```

- **Works Offline:** Browse Menu & Floor Map, Create/Edit Orders, Record Tentative Cash Payments.
- **Requires Online (Disabled with badge):** UPI QR Verification, Final GST Invoice Numbering, Credit Notes, Super Admin Feature Toggles.

---

## Slide 7: Real-Time Updates Flow (SSE + Redis Pub/Sub)

**Scenario:** Cashier takes an order or payment on Table 5 → **Owner's screen** and **KDS** update instantly **without refreshing**.

**Why SSE + Pub/Sub instead of WebSockets?**
- **SSE (Server-Sent Events)** is lightweight HTTP streaming (no heavy full-duplex socket overhead when writes already use REST) with built-in browser auto-reconnect.
- **Redis Pub/Sub** is the **backend message broker** that broadcasts events across multiple API servers so SSE scales horizontally.
- **Security Fix:** SSE connects via Next.js cookie-authenticated proxy (`/api/stream/branch/[id]`) — never leaks `?accessToken=` in URLs.

```mermaid
sequenceDiagram
    actor Cashier as Cashier POS (Table 5)
    participant API1 as Fastify API #1
    participant DB as Neon Postgres
    participant Redis as Redis Pub/Sub\n(branch:{id})
    participant API2 as Fastify API #2\n(SSE Stream)
    actor Owner as Owner Dashboard & KDS

    Note over Owner,API2: Connected via Cookie-Auth SSE Stream
    Cashier->>API1: POST /api/v1/payments (Order Paid)
    API1->>DB: Commit Payment + Update Bill
    API1->>Redis: PUBLISH branch:{id} { event: "payment.confirmed", billId }
    Redis-->>API2: Broadcast Event to all API Instances
    API2-->>Owner: SSE Push -> event: payment.confirmed
    Owner->>Owner: queryClient.invalidateQueries(["branch", id, "orders"])
    Note over Owner: Owner Dashboard & KDS update live (Zero Refresh!)
```

---

## Slide 8: Lazy Loading, Streaming & Prefetching Pipeline

Prevents heavy modules (Charts, Floor Canvas, PDF Invoices, Games) from slowing down initial POS or Owner load.

```mermaid
flowchart LR
    subgraph T1["Tier 1: Instant First Paint (< 1.5s)"]
        Shell["App Shell + Shared Sidebar\n(Server Rendered)"]
        KPI["Core KPI Cards / Active Tables\n(Hydrated RSC Data)"]
    end

    subgraph T2["Tier 2: Streaming (<Suspense>)"]
        Charts["Sales Charts & Heatmaps"]
        Tables["Paginated Order / Invoice Tables"]
    end

    subgraph T3["Tier 3: On-Demand (next/dynamic)"]
        Floor["Floor Plan Canvas\n(ssr: false)"]
        PDF["Invoice PDF / Print Preview"]
        Modals["Split Bill & Manager PIN Modals"]
    end

    subgraph Prefetch["Proactive Prefetching"]
        Hover["Sidebar / Card Hover\n-> queryClient.prefetchQuery()"]
        PostLogin["Post-Login Role Prefetch\n-> Cashier: Menu + Floors + Orders"]
        LinkPre["Next.js <Link prefetch>\n-> Preload Route Chunks"]
    end

    T1 --> T2 --> T3
    Prefetch -.->|"Zero Perceived Lag"| T1 & T2
```

---

## Slide 9: Unified 4-Layer Security Pipeline (Pilot: Payments & Invoices)

**Authentication + Super Admin Feature Flags + RBAC Authorization + Audit Logging** built together as one reusable pipeline — piloted end-to-end on the **Payments & Invoice Generation** module.

```mermaid
flowchart TD
    SA["Super Admin Settings\nToggle Org Features ON/OFF\n(module.payments, module.invoices, payments.upi_qr)"]
    SA -->|"Pub/Sub: org.features.updated"| DB[("OrganizationFeatureFlag\n+ RBAC Tables")]

    Req["User Action: Open /admin/invoices\nor Click 'Generate GST Invoice'"] --> L1

    L1["Layer 1: Authentication\nNext.js Middleware verifies HttpOnly Session Cookie"]
    L1 -->|"Invalid"| Deny1["Redirect /login"]
    L1 -->|"Valid"| L2

    L2["Layer 2: Feature Flag Gate\nIs 'module.invoices' enabled for this Org?\n(RSC Gate + <FeatureGate>)"]
    L2 -->|"Disabled"| Deny2["Hide UI / Show 'Upgrade Plan' Screen"]
    L2 -->|"Enabled"| L3

    L3["Layer 3: RBAC Authorization\nDoes user have 'invoices.generate'?\n(RSC Gate + <Can permission=...>)"]
    L3 -->|"No Permission"| Deny3["403 Forbidden / Manager PIN Modal"]
    L3 -->|"Allowed"| L4

    L4["Layer 4: Fastify API Enforcement\nRe-verifies JWT + Feature Flag + RBAC\nExecutes Action + Writes Immutable AuditLog"]
```

### Pilot Module Permissions & Flags Matrix

| Module | Super Admin Feature Flags | RBAC Permissions |
| :--- | :--- | :--- |
| **Payments** | `module.payments`, `payments.upi_qr`, `payments.split_bill` | `payments.view`, `payments.collect`, `payments.refund` |
| **Invoices** | `module.invoices`, `invoices.credit_notes` | `invoices.view`, `invoices.generate`, `invoices.credit_note` |

---

## Slide 10: Untitled UI Theming & Implementation Timeline

### Theming Architecture (Untitled UI + `next-themes`)

```mermaid
flowchart LR
    Tokens["Untitled UI Semantic CSS Tokens\n(--bg-primary, --text-primary, --brand-600)"] --> ThemeProvider["next-themes Provider\n(Zero SSR Hydration Flicker)"]
    ThemeProvider --> OwnerPOS["Owner & Cashier POS\nLight Default + Dark Toggle"]
    ThemeProvider --> KDSTheme["Kitchen Display (KDS)\nHigh-Contrast Dark Default"]
    ThemeProvider --> GuestTheme["Guest QR Menu\nPer-Restaurant Brand Accent Override"]
```

### Delivery Roadmap & Time Estimate (15 – 21 Working Days)

```mermaid
flowchart LR
    subgraph S1["Sprint 1: Core Foundation (~10–12 Days)"]
        D1["1. Untitled UI + next-themes\n(1–2 days)"]
        D2["2. Data Layer\nRSC + TanStack + Zustand\n(3–4 days)"]
        D3["3. Auth + RBAC + Feature Flags\nPilot: Payments & Invoices\n(4–5 days)"]
        D4["4. Lazy Load & Prefetch\n(1–2 days)"]
        D1 --> D2 --> D3 --> D4
    end

    subgraph S2["Sprint 2: Live & Resilient POS (~6–9 Days)"]
        D5["5. SSE + Redis Pub/Sub\nCashier -> Owner/KDS Live Sync\n(2–3 days)"]
        D6["6. IndexedDB Offline Sync\nDexie Mirror + Outbox Queue\n(4–5 days)"]
        D5 --> D6
    end

    S1 --> S2
```

| # | Workstream | Estimate |
| :--- | :--- | :--- |
| 1 | **Theming (Untitled UI + `next-themes`)** | 1 – 2 days |
| 2 | **Core Data Layer (RSC + TanStack Query + Zustand + Client/Server Split)** | 3 – 4 days |
| 3 | **Unified Auth + RBAC + Super Admin Feature Flags (Payments/Invoices Pilot)** | 4 – 5 days |
| 4 | **Lazy Loading & Prefetching (`next/dynamic`, `<Suspense>`, `prefetchQuery`)** | 1 – 2 days |
| 5 | **Real-Time Sync (SSE + Redis Pub/Sub)** | 2 – 3 days |
| 6 | **Offline Sync Engine (IndexedDB / Dexie + Outbox + Conflict UI)** | 4 – 5 days |
| | **Total Foundation Timeline** | **15 – 21 working days (~3 – 4 weeks)** |

---

## Open Points to Confirm in Today's Meeting
1. Confirm the second theming helper package alongside **Untitled UI** (proposed: **`next-themes`** for SSR-safe dark/light switching).
2. Confirm whether the pilot module for Auth + RBAC + Feature Flags should be **Payments**, **Invoice Generation**, or **both together**.
3. Sign off on the **Sprint 1 (~2 weeks) + Sprint 2 (~1.5 weeks)** timeline so implementation can start immediately.
