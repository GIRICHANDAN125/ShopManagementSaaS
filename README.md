# Multi-Tenant Shop Order / Token SaaS

A cloud-based, multi-tenant SaaS platform for shops that manage
customer orders via an order/token system — one platform, many
independent shops, each fully data-driven and tenant-isolated.

Full requirements and design live in [`docs/`](./docs): start with
`PROJECT_BLUEPRINT.md`, then `ARCHITECTURE.md`, `DATABASE.md`,
`SECURITY.md`, `TESTING.md`, `DEPLOYMENT.md`, `TROUBLESHOOTING.md`,
`OFFLINE_SYNC_DESIGN.md`, and `UI_UX_GUIDELINES.md`.

**Read this section before anything else:** [Status & known
limitations](#status--known-limitations). This is a working, tested
core, not a finished, fully-featured product — the sections below are
explicit about what's implemented, what's stubbed, and what isn't
built yet.

---

## Architecture overview

```
React/Next.js frontend  →  Node.js/NestJS API  →  PostgreSQL (source of truth)
                                    │
                                    └─→  Socket.IO (tenant-scoped, real-time)
```

- **Tenant isolation** is enforced at three independent layers:
  application-level filtering, PostgreSQL Row-Level Security (forced,
  not just enabled), and tenant-scoped WebSocket rooms. See
  `docs/ARCHITECTURE.md` §6 and `docs/DATABASE.md` §8.
- **Super Admin** access is a structurally separate, narrowly-scoped
  database role (`shopapp_superadmin`) — never `BYPASSRLS`, never the
  ordinary runtime role. See `docs/DATABASE.md` §6 and the migration
  files under `backend/migrations/000{5,6,7,9}*`.
- **Order numbering** uses a genuine PostgreSQL sequence per tenant.
  `nextval()` is non-transactional, so a number is never reissued even
  if the transaction that allocated it rolls back. See
  `docs/DATABASE.md` §5.
- **Offline order-number ranges** are pre-reserved, contiguous,
  non-overlapping blocks granted to a device while online — never
  provisional numbers, never renumbered after sync. See
  `docs/OFFLINE_SYNC_DESIGN.md`.

## Technology stack

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Backend:** Node.js, NestJS, TypeScript
- **Database:** PostgreSQL 16, plain `pg` driver + hand-written SQL
  migrations (`node-pg-migrate`) — not an ORM. This was originally
  planned as Prisma, but Prisma's engine binaries could not be fetched
  in this build environment; `pg` + raw SQL is arguably the better fit
  anyway, since RLS policies, per-tenant sequences, and advisory locks
  are Postgres-native features an ORM abstraction fights against. See
  `docs/DATABASE.md` for why this substitution doesn't change the
  approved architecture.
- **Auth:** JWT (access + refresh), argon2 password hashing
- **Real-time:** Socket.IO, tenant-scoped rooms, no Redis backplane yet
  (single-instance V1, per `docs/DEPLOYMENT.md`)

## Project structure

```
project/
├── backend/
│   ├── src/
│   │   ├── auth/          # login (tenant + super admin), JWT strategy
│   │   ├── database/      # two connection pools (runtime, superadmin)
│   │   ├── orders/        # order creation, idempotency, numbering, status, offline sync
│   │   ├── devices/       # device registration, range reservation, connect-token auth
│   │   ├── catalog/       # product and category CRUD
│   │   ├── employees/     # employee, role, and permission management
│   │   ├── settings/      # packing-charge and workflow configuration
│   │   ├── reports/       # today/previous-day/weekly/monthly totals
│   │   ├── superadmin/    # tenant CRUD (superadmin pool only)
│   │   ├── rbac/          # permission guard, fails closed by default
│   │   ├── audit/         # single call-site audit log writer
│   │   ├── realtime/      # tenant-scoped WebSocket gateway
│   │   ├── printer/       # printer abstraction + mock adapter
│   │   └── common/        # display-number derivation (pure function)
│   ├── migrations/        # hand-written SQL migrations, numbered
│   ├── test/integration/  # tests against REAL PostgreSQL, never mocked
│   └── scripts/bootstrap-db.sh
├── frontend/
│   └── app/
│       ├── login/, counter/, coordinator/, kitchen/, tv/, reports/
│       ├── admin/          # Shop Admin (tabbed: catalog, employees,
│       │                   #   roles, packing, workflow, devices)
│       └── super-admin/
└── docs/                   # the approved architecture/design documents
```

## Local development setup

### 1. Database

Requires PostgreSQL 16+.

```bash
cd backend
# One-time: creates the three DB roles (migrator/runtime/superadmin) and
# the database. Uses placeholder passwords — set real ones via env vars
# or edit the script. See docs/SECURITY.md §14 for why three roles exist.
MIGRATOR_PASSWORD=... RUNTIME_PASSWORD=... SUPERADMIN_PASSWORD=... \
  ./scripts/bootstrap-db.sh

cp .env.example .env
# Edit .env with the passwords you used above.

npm install
npm run migrate:up
```

### 2. Backend

```bash
cd backend
npm install
npm run start:dev     # http://localhost:3001
```

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev            # http://localhost:3000
```

### 4. Seed a tenant to actually use the app

There is no onboarding UI yet for the very first tenant/employee
(chicken-and-egg: Super Admin creates the tenant, but a Super Admin
user itself must be seeded once). For local development:

```sql
-- As the migrator role:
INSERT INTO tenants (id, code, display_name, order_sequence_name)
VALUES (gen_random_uuid(), 'MY_SHOP', 'My Shop', 'my_shop_seq');
SELECT create_tenant_order_sequence('my_shop_seq'); -- run as shopapp_superadmin

-- Create a Super Admin user (as shopapp_superadmin, tenant_id NULL):
INSERT INTO users (tenant_id, username, password_hash, display_name)
VALUES (NULL, 'admin', '<argon2 hash>', 'Platform Owner');
```

Generate an argon2 hash with `node -e "require('argon2').hash('yourpassword').then(console.log)"`.

## Testing

```bash
cd backend
npm test                 # unit tests (fast, no DB required)
npm run test:integration # integration + e2e tests — REQUIRES a running
                          # PostgreSQL with migrations applied; never
                          # mocks RLS, per docs/TESTING.md §18
```

**51 tests currently pass** (14 unit, 37 integration/e2e), across 7 test
files:
- `rls-superadmin.spec.ts` — tenant isolation + all 5 Super Admin scope proofs
- `order-numbering.spec.ts` — sequence allocation, never-reuse-after-rollback, range reservation
- `orders-e2e.spec.ts` — idempotency (200/409), cancel, manual reprint, over real HTTP
- `devices-e2e.spec.ts` — registration, reservation, exhaustion, revocation, reserve-range/issue over HTTP
- `catalog-settings-reports-e2e.spec.ts` — product/category CRUD, packing-config-driven totals, reports, device connect-token auth
- `websocket-tenant-isolation.spec.ts` — real Socket.IO connections, cross-tenant event isolation, auth rejection
- `offline-sync.spec.ts` — offline order sync, duplicate-sync prevention, invalid-reservation rejection, timestamp preservation, range exhaustion

## Build

```bash
cd backend && npm run build   # -> dist/
cd frontend && npm run build  # -> .next/
```

Both have been verified to build cleanly and to actually boot/serve
requests from their compiled output, not just compile without error.

## Security notes

- Passwords: argon2, never reversible, never logged.
- Tokens: short-lived JWT access tokens + separate refresh tokens.
  Device tokens (TV/realtime) are a structurally smaller claim shape —
  no `permissions`, rejected by every REST endpoint that requires one.
- Every endpoint requires an explicit `@RequirePermission(...)` —
  an endpoint with none is denied by default (fail-closed).
- RLS is `FORCE`d on every tenant-owned table; the runtime DB role has
  no `BYPASSRLS`, no `SUPERUSER`.
- Super Admin uses a structurally separate, narrowly-scoped DB role —
  see `docs/DATABASE.md` §6 for the full design and
  `backend/test/integration/rls-superadmin.spec.ts` for the five
  automated proofs of its boundaries.
- Reports queries are fully parameterized, including the tenant
  timezone — an earlier draft string-interpolated the timezone value
  directly into SQL; even though that value only ever came from trusted
  server data, it was an injection-shaped pattern found and fixed during
  this build's own security review.
- **Dependency audit:** 23 known vulnerabilities remain, all confirmed
  confined to development-only tooling (`@nestjs/cli`'s own bundled
  schematics/webpack/inquirer chain — verified by inspecting the actual
  compiled `dist/` output, which references none of them). Three
  runtime-relevant vulnerabilities (`express`, `body-parser`, `qs`) were
  fixed via `package.json` `overrides` to their latest same-major patch
  versions, without any breaking NestJS upgrade. The remaining runtime
  advisory (`multer`, via `@nestjs/platform-express`) has no exploitable
  surface here — this application never registers a file-upload route.
  Fully resolving the rest requires a NestJS v10→v12 major upgrade,
  which was deliberately NOT forced — that's a significant breaking
  change warranting its own dedicated regression pass, not something to
  bundle into this build.
- This system is not claimed to be unhackable — see `docs/SECURITY.md`
  §20 for an explicit statement of that.

## Offline behavior

Implemented end-to-end and tested: device registration, range reservation
(contiguous, non-overlapping, advisory-lock-serialized), a genuine
offline-capable Counter client (`frontend/lib/offline-queue.ts`) that
caches a reservation in `localStorage`, issues real order numbers
locally with zero network calls while offline, queues orders for sync,
and drains the queue automatically on reconnect via `POST
/orders/sync-offline`. Hard-stop exhaustion behavior (no fallback
numbering) is implemented and tested both at the service layer and over
HTTP.

**Simplifications, stated plainly:** the offline queue lives in
`localStorage`, not IndexedDB — adequate for this build's scope but less
robust for very large queues. The device that reserves ranges and syncs
orders is authenticated via the logged-in staff member's session, not
its own long-lived device credential the way the TV's realtime
connection is — a fully rigorous build would extend device-credential
auth to this path too. Validation-failure classification during sync
(auto-heal vs. human review, OFFLINE_SYNC_DESIGN.md §8) is a documented
open product decision, not implemented as a "Needs Attention" UI queue.

## Reports

Implemented: today, previous day, last 7 days, this month — order
counts by status, revenue, average order value — all tenant-scoped and
bucketed using the tenant's configured timezone (not server/UTC time).
A `/reports/range` endpoint accepts custom date ranges. Not implemented:
best-selling products, preparation-time metrics, and a calendar
day-by-day comparison view (blueprint §21/§23) beyond what these
endpoints already provide.

## Printer configuration

`backend/src/printer/printer.module.ts` defines a `PrinterAdapter`
interface and a `MockPrinterAdapter` that logs what would be printed.
**No physical thermal printer was available in this environment** — a
real deployment implements `PrinterAdapter` against the shop's actual
printer protocol (e.g. ESC/POS) behind the same interface. The mock is
explicitly labeled as such in its own file; it has not been exercised
against real hardware and must not be presented as if it had.

## Deployment overview

See `docs/DEPLOYMENT.md` for the full plan (single instance for V1,
managed PostgreSQL with PITR, Redis introduced only when a second app
instance is needed). This repository has been run and tested locally
only; it has not been deployed to any cloud environment as part of
this build.

---

## Status & known limitations

This section exists because of an explicit project rule: don't claim
something works, is tested, or is production-ready unless it actually
is. See the final delivery report for the complete, itemized
breakdown. In summary:

**Solid and tested:** tenant isolation/RLS, the Super Admin role
split, order numbering (including the never-reuse-after-rollback
guarantee), idempotency (200/409 behavior), device
registration/reservation/exhaustion/revocation, manual reprint vs.
no-auto-reprint, backend-authoritative totals (including packing
charges resolved server-side from tenant configuration), product/
category CRUD, employee/role/permission management, reports (today/
previous-day/weekly/monthly, tenant-scoped, timezone-aware), device
connect-token authentication for the realtime/TV path, WebSocket
tenant isolation (proven via real Socket.IO connections, not just code
review), and offline order sync (reservation-based numbering, duplicate
prevention, exhaustion, timestamp preservation).

**Implemented but with stated simplifications:** the offline-capable
Counter client (works, tested, but uses localStorage not IndexedDB, and
authenticates via staff session rather than its own device credential
for the reservation/sync path specifically — see "Offline behavior"
above).

**Not implemented:** GST (out of scope for V1 by design), a "Needs
Attention" UI queue for offline sync validation failures, multi-instance/
Redis backplane (also out of scope for V1 by design), employee
password-reset flow, order-type/workflow enforcement in the UI beyond
configuration storage (the workflow mode is saved but Coordinator/
Kitchen screens don't yet branch their displayed stages based on it).

**Stubbed:** the printer adapter (mock, clearly labeled in its own file
as never hardware-tested).

**Dependency vulnerabilities:** 23 remain, all confirmed dev-tooling-only
or requiring a deliberately-deferred NestJS major upgrade — see
"Security notes" above for the full accounting.
