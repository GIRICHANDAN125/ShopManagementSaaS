# DATABASE.md — Schema & Data Architecture (Version 1)

Status: **DESIGN ONLY.** No migrations exist yet. This document defines the
target schema so migrations can be written and reviewed against it.

Engine: PostgreSQL, single shared database, shared schema, Row-Level
Security. No database-per-tenant, no schema-per-tenant, for Version 1.

**Revision note:** §5 (order numbering) and §6 (device identity /
reservation) were revised to adopt PostgreSQL sequence-based allocation
and the pre-reserved real-range offline design. This supersedes the
earlier "transactional UPDATE counter" mechanism, which had a genuine
correctness gap (see §5).

---

## 1. Tenancy model

`tenants` is the root entity. Every other tenant-owned table carries a
`tenant_id UUID NOT NULL REFERENCES tenants(id)` and is protected by RLS
(see §8). Global tables that are **not** tenant-owned: `tenants` itself,
`super_admins`, and any platform-wide lookup tables.

```
tenants
├── id                  UUID PK
├── code                TEXT UNIQUE NOT NULL   -- immutable tenant identifier,
│                                                  e.g. "TENANT_001", never
│                                                  changes if display name does
├── display_name        TEXT NOT NULL
├── business_type       TEXT                    -- data-driven label, not a code branch
├── status              TEXT NOT NULL CHECK (status IN ('active','inactive'))
├── timezone            TEXT NOT NULL DEFAULT 'Asia/Kolkata'
├── order_sequence_name TEXT UNIQUE NOT NULL     -- name of this tenant's
│                                                    dedicated PostgreSQL
│                                                    sequence (see §5)
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
└── updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

## 2. Users, Roles, Permissions (RBAC)

Flexible RBAC, not a fixed enum — matches decision #3.

```
users
├── id            UUID PK
├── tenant_id     UUID NULL REFERENCES tenants(id)  -- NULL only for super admins
├── username      TEXT NOT NULL
├── password_hash TEXT NOT NULL
├── display_name  TEXT NOT NULL
├── status        TEXT NOT NULL CHECK (status IN ('active','disabled'))
├── created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
└── UNIQUE (tenant_id, username)     -- usernames unique per tenant, not globally

roles
├── id          UUID PK
├── tenant_id   UUID NOT NULL REFERENCES tenants(id)
├── name        TEXT NOT NULL         -- e.g. "Counter Staff", "Kitchen"
└── UNIQUE (tenant_id, name)

permissions                            -- global catalog, not tenant-owned
├── id     UUID PK
└── code   TEXT UNIQUE NOT NULL        -- e.g. order.create, receipt.reprint

role_permissions
├── role_id        UUID REFERENCES roles(id)
├── permission_id  UUID REFERENCES permissions(id)
└── PRIMARY KEY (role_id, permission_id)

user_roles
├── user_id  UUID REFERENCES users(id)
├── role_id  UUID REFERENCES roles(id)
└── PRIMARY KEY (user_id, role_id)
```

Seed permission codes (extend during implementation, per decision #3):
`order.create`, `order.view`, `order.cancel`, `receipt.print`,
`receipt.reprint`, `product.manage`, `inventory.manage`,
`employee.manage`, `shop.settings`, `reports.view`, `device.manage`
(new — see §6).

A user's effective permissions = union of permissions granted by all
roles assigned to them, always evaluated **within their own tenant_id**
(a role row itself is tenant-scoped, so cross-tenant role assignment is
structurally impossible, not just checked at runtime).

## 3. Counters, Products, Categories

```
counters
├── id         UUID PK
├── tenant_id  UUID NOT NULL REFERENCES tenants(id)
├── name       TEXT NOT NULL
└── status     TEXT NOT NULL CHECK (status IN ('active','inactive'))

categories
├── id         UUID PK
├── tenant_id  UUID NOT NULL REFERENCES tenants(id)
├── name       TEXT NOT NULL
└── UNIQUE (tenant_id, name)

products
├── id           UUID PK
├── tenant_id    UUID NOT NULL REFERENCES tenants(id)
├── category_id  UUID REFERENCES categories(id)
├── name         TEXT NOT NULL
├── price        NUMERIC(12,2) NOT NULL
├── active       BOOLEAN NOT NULL DEFAULT true
└── created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

Variants/add-ons: a `product_variants` / `product_addons` table following
the same `tenant_id` pattern — deferred to implementation detail, not
architecturally significant beyond "still tenant-owned, still RLS'd."

## 4. Orders — the central object

```
orders
├── id                  UUID PK                       -- internal surrogate key
├── tenant_id           UUID NOT NULL REFERENCES tenants(id)
├── order_number        BIGINT NOT NULL                -- the real, permanent number
├── display_number      SMALLINT NOT NULL              -- derived, stored for
│                                                          convenience/audit, NOT
│                                                          the source of truth
├── idempotency_key     UUID NOT NULL
├── counter_id          UUID REFERENCES counters(id)
├── device_id           UUID NULL REFERENCES devices(id)  -- set when the order
│                                                             originated from an
│                                                             authorized device
│                                                             (offline or online); see §6
├── created_by_user_id  UUID NOT NULL REFERENCES users(id)
├── order_type          TEXT NOT NULL                  -- data-driven, from
│                                                          tenant order-type config
├── status              TEXT NOT NULL                  -- data-driven pipeline,
│                                                          from tenant workflow config
├── origin              TEXT NOT NULL CHECK (origin IN ('online','offline_reserved'))
│                                                       -- see §5; audit/reporting only,
│                                                          never affects numbering logic
├── subtotal            NUMERIC(12,2) NOT NULL
├── packing_charge      NUMERIC(12,2) NOT NULL DEFAULT 0
├── discount            NUMERIC(12,2) NOT NULL DEFAULT 0
├── total               NUMERIC(12,2) NOT NULL          -- authoritative, backend-computed
├── scheduled_for       TIMESTAMPTZ NULL                -- advance/future orders
├── created_at_device   TIMESTAMPTZ NOT NULL            -- when the order was actually
│                                                          created (device-local clock
│                                                          for offline orders) — distinct
│                                                          from created_at below
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now() -- when the row was written
│                                                             to PostgreSQL (sync time,
│                                                             for offline orders)
├── updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
│
├── UNIQUE (tenant_id, order_number)
├── UNIQUE (tenant_id, idempotency_key)
└── INDEX  (tenant_id, created_at)
└── INDEX  (tenant_id, status)
└── INDEX  (tenant_id, created_at_device)

order_items
├── id          UUID PK
├── order_id    UUID NOT NULL REFERENCES orders(id)
├── tenant_id   UUID NOT NULL REFERENCES tenants(id)   -- denormalized for RLS
├── product_id  UUID NOT NULL REFERENCES products(id)
├── quantity    INT NOT NULL
├── unit_price  NUMERIC(12,2) NOT NULL                  -- price at time of order
└── line_total  NUMERIC(12,2) NOT NULL

order_status_history
├── id           UUID PK
├── order_id     UUID NOT NULL REFERENCES orders(id)
├── tenant_id    UUID NOT NULL REFERENCES tenants(id)
├── status       TEXT NOT NULL
├── changed_by   UUID REFERENCES users(id)
└── changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

`tenant_id` is intentionally denormalized onto child tables
(`order_items`, `order_status_history`) rather than requiring a join back
to `orders` to know the tenant. This is what makes RLS on the child tables
possible without a subquery per row (see §8), and is a standard, accepted
tradeoff in RLS-based multi-tenant schemas.

`created_at_device` vs `created_at` is a new distinction required by
offline reservation: an offline order is *created* (by device-local time)
before it is *written to PostgreSQL* (at sync time). Reports/analytics
must be explicit about which of the two they bucket by — flagged as an
implementation decision in §14.

## 5. Order numbering strategy — PostgreSQL sequences (revised)

### 5.1 The correctness gap in the previous design

The originally proposed mechanism was a transactional counter table:

```sql
UPDATE tenant_order_counters
SET last_number = last_number + 1
WHERE tenant_id = $1
RETURNING last_number;
```

This guarantees **no two transactions get the same number**, but it does
**not** guarantee "never reused" in the strict sense required, because the
increment lives inside the same transaction as the order insert. If that
transaction is rolled back **after** the number has already been
committed to something outside the transaction (most importantly: already
printed on a physical receipt handed to a customer), the rollback would
also revert the counter, and the very next order — in a **different,
successful** transaction — would receive that same already-printed
number. This is a real, not theoretical, risk given receipts print before
the surrounding request necessarily reaches its final success state in
every code path (e.g. a post-allocation validation or downstream failure).

### 5.2 The fix: dedicated PostgreSQL sequence per tenant

PostgreSQL sequences have a documented property that solves this exactly:
**`nextval()` is not transactional.** If a transaction that called
`nextval()` is rolled back, the sequence's advancement is **not** undone —
the value already handed out is never reissued. This is the built-in
database mechanism for exactly the "gaps allowed, reuse forbidden"
requirement, rather than something the application has to reconstruct.

Design:

```sql
-- One sequence created per tenant at tenant-provisioning time,
-- named per tenants.order_sequence_name, e.g.:
CREATE SEQUENCE tenant_ord_<tenant_uuid_no_dashes> START 1 INCREMENT 1;
```

- The sequence name is generated server-side at tenant creation (never
  client-supplied) and stored in `tenants.order_sequence_name`.
- All references to the sequence go through `quote_ident()` /
  parameterized identifier lookup from that stored column — **never**
  string-concatenated from any client-facing input, to close any
  SQL-injection surface around dynamic identifiers.
- **Online order creation:** `SELECT nextval(quote_ident(seq_name))` is
  called once, at the moment the order is being created, and the returned
  value becomes `order_number`. Even if the surrounding transaction later
  fails and rolls back, that number is gone from the pool permanently —
  exactly the required "gap allowed, never reused" behavior, guaranteed by
  Postgres itself rather than by application discipline.
- **Concurrency:** `nextval()` calls are inherently safe under concurrent
  access — Postgres serializes sequence advancement internally without
  needing an explicit row lock or `SELECT ... FOR UPDATE`, and without
  blocking concurrent transactions against each other the way the old
  counter-table `UPDATE` did (a minor performance improvement as a side
  effect of fixing the correctness issue).
- **No daily reset, survives restart:** sequences are ordinary persistent
  database objects; they do not reset on application restart and have no
  concept of "day" at all — daily reset was never wired in and remains
  not wired in.

### 5.3 Offline range reservation, built on the same primitive

To grant an authorized device (see §6) a contiguous block of real order
numbers while it is online, before an outage:

```sql
-- Reservation is granted inside a per-tenant advisory lock, so that
-- concurrent reservation requests for the same tenant cannot interleave
-- and fragment what should be a contiguous block:
SELECT pg_advisory_xact_lock(hashtext(tenant_id::text));

SELECT nextval(quote_ident(seq_name))
FROM generate_series(1, :block_size);
-- take MIN() and MAX() of the returned values as the reserved range
```

- The advisory lock is **transaction-scoped** (`pg_advisory_xact_lock`,
  automatically released at commit/rollback) and only serializes
  *reservation* requests for the same tenant against each other — it has
  no effect on ordinary online order creation, which does not take this
  lock and is not slowed by it.
- Because each `nextval()` call inside the loop is still individually
  non-transactional, the same rollback-safety property from §5.2 applies:
  even if the reservation-granting transaction itself later fails (e.g.
  device-authorization check fails after numbers were drawn), those
  numbers are still permanently retired, never reissued to a different
  device. This directly satisfies the requirement that unused reserved
  numbers become permanent gaps rather than being returned to the pool.
- The block boundaries (`block_start`, `block_end`) are recorded in
  `device_order_reservations` (§6), owned by the specific `device_id` that
  requested them.

### 5.4 Customer display number

`display_number` is computed at order-creation time (online) or at
device-local order-creation time (offline, using the device's already-
reserved number) as:

```
display_number = ((order_number - 1) % 999) + 1
```

Stored for fast reads (receipts, history) but always re-derivable from
`order_number` alone — never an independent counter, and never
recalculated or changed after synchronization (the real number does not
change at sync time, so neither does its derived display number — see
OFFLINE_SYNC_DESIGN.md).

## 6. Device identity & offline range reservation

New in this revision, per the finalized offline design. A **device** is a
first-class identity distinct from a **user**: a user logs in with
credentials; a device is a specific piece of counter hardware/software
installation that is separately registered, authenticated, and authorized
before it may hold a reserved number range.

```
devices
├── id                  UUID PK
├── tenant_id           UUID NOT NULL REFERENCES tenants(id)
├── counter_id          UUID REFERENCES counters(id)     -- which physical
│                                                            counter this device
│                                                            is normally attached to
├── name                TEXT NOT NULL                     -- e.g. "Counter-01"
├── device_credential_id UUID NOT NULL UNIQUE             -- reference to the
│                                                             device's own credential
│                                                             (certificate / device-bound
│                                                             secret — see SECURITY.md §19)
├── status              TEXT NOT NULL CHECK (status IN
│                          ('active','revoked','replaced'))
├── registered_at       TIMESTAMPTZ NOT NULL DEFAULT now()
├── revoked_at          TIMESTAMPTZ NULL
└── UNIQUE (tenant_id, name)

device_order_reservations
├── id             UUID PK
├── tenant_id      UUID NOT NULL REFERENCES tenants(id)
├── device_id      UUID NOT NULL REFERENCES devices(id)
├── range_start    BIGINT NOT NULL
├── range_end      BIGINT NOT NULL
├── next_to_issue  BIGINT NOT NULL           -- device's local pointer into its
│                                                own range, mirrored to the
│                                                server on reconnect for
│                                                admin visibility (§ TESTING.md)
├── status         TEXT NOT NULL CHECK (status IN
│                     ('active','exhausted','abandoned'))
├── granted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
├── closed_at      TIMESTAMPTZ NULL
├── UNIQUE (tenant_id, range_start, range_end)
└── INDEX (tenant_id, device_id, status)
```

- A device must be `status = 'active'` and present a valid device
  credential before it may request a reservation — this check happens in
  addition to, not instead of, the employee's own login/permission check
  (`device.manage` / `order.create` are separate concerns: a device being
  authorized to *hold numbers* is not the same as an employee being
  authorized to *create orders*, though in practice both must hold for an
  offline order to be created).
- Exactly one `device_order_reservations` row per granted block; a device
  may hold at most one `active` reservation at a time in the simplest V1
  model (requesting a new one while exhausted transitions the old row to
  `exhausted` and creates a new one — see §8 of OFFLINE_SYNC_DESIGN.md for
  the full state machine).
- **Device replacement:** the old device's row moves to `status =
  'replaced'`; any reservation it held that was not fully consumed moves
  to `status = 'abandoned'` and its unused numbers are permanently retired
  (never reassigned to the replacement device or any other).
- **Compromised device:** `status = 'revoked'`; any active reservation is
  force-closed the same way as replacement. Revocation is an audited
  action (`audit_logs`, entity_type `device`).

## 7. Idempotency strategy (revised: explicit conflict behavior)

- `orders.idempotency_key` + `UNIQUE (tenant_id, idempotency_key)` remains
  the **primary** duplicate-prevention mechanism, including for offline
  sync — this is unchanged from the prior design.
- Request flow: API receives a create/sync request with an
  `idempotency_key` generated client-side (or device-side, for offline
  orders) once per logical order.
- Before inserting, the API checks for an existing row with that
  `(tenant_id, idempotency_key)`. If found **and the payload matches**, it
  returns the existing order (`200`) instead of inserting again.
- **If found and the payload differs** (e.g. different items/total under
  the same key — a client bug or tampering, not a legitimate retry): the
  API returns **HTTP 409 Conflict** and does **not** overwrite the
  original order. The original order remains exactly as first recorded;
  resolving the discrepancy is a manual/admin action, never an automatic
  overwrite.
- The race between check and insert is still closed by the `UNIQUE`
  constraint itself, not the pre-check, exactly as before.
- `UNIQUE (tenant_id, order_number)` is retained as a **secondary**
  defense-in-depth check (§5.2 already makes number collision extremely
  unlikely via sequences, but the constraint costs nothing and catches any
  scenario the sequence design didn't anticipate).

## 8. Row-Level Security (RLS) strategy

This is the primary, database-enforced tenant-isolation layer.

1. Every tenant-owned table (including the new `devices` and
   `device_order_reservations`) has `ENABLE ROW LEVEL SECURITY` and
   `FORCE ROW LEVEL SECURITY` (the latter matters — it also restricts the
   table owner, closing a common RLS bypass footgun where migrations run
   as a superuser silently skip policies).
2. A policy is created per table, of the form:

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_orders ON orders
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

3. The Node API sets `app.current_tenant_id` as a **transaction-local**
   Postgres session variable (`SET LOCAL app.current_tenant_id = $1`) at
   the start of every request's database transaction, using the
   `tenant_id` resolved from the verified auth token (user token for
   online requests, device credential for device-originated requests —
   never from client-supplied fields — see ARCHITECTURE.md §4).
4. The database connection pool must not let a connection be reused
   across requests without resetting/re-setting this variable — achieved
   by using `SET LOCAL` (scoped to the transaction, auto-reset at
   commit/rollback) rather than `SET` (session-scoped, which would leak
   across pooled connections).
5. The application's own database user for the API is **not** a
   superuser and has no `BYPASSRLS` attribute — RLS cannot be silently
   bypassed by the connection the API actually uses.
6. Super Admin operations that legitimately need cross-tenant access use
   a distinct, narrowly-scoped path — either a separate DB role with
   explicit, audited permission, or explicit per-tenant iteration that
   sets the session variable per tenant rather than a blanket bypass.
7. RLS is a **second, independent layer** on top of application-level
   `tenant_id` filtering, not a replacement for it.

## 9. Audit log structure

```
audit_logs
├── id               UUID PK
├── tenant_id        UUID NULL REFERENCES tenants(id)  -- NULL for platform-level/Super Admin actions
├── actor_user_id    UUID REFERENCES users(id)          -- NULL for device-originated actions
├── actor_device_id  UUID REFERENCES devices(id)        -- NULL for user-originated actions
├── action           TEXT NOT NULL          -- e.g. "order.cancel", "shop.activate",
│                                               "device.reservation.granted",
│                                               "device.revoked"
├── entity_type      TEXT NOT NULL          -- e.g. "order", "tenant", "product", "device"
├── entity_id        UUID
├── metadata         JSONB                  -- structured, non-sensitive context
├── correlation_id   UUID                   -- ties to a single request/trace
├── created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
└── INDEX (tenant_id, created_at)
└── INDEX (entity_type, entity_id)
```

Hard rule: `metadata` must never contain passwords, tokens, secrets,
device credentials, or full card/payment details. Device-related audit
events (registration, revocation, reservation grant/exhaustion/abandon)
are treated with the same rigor as employee-permission audit events.

## 10. Payments (placeholder, V1 scope)

```
payments
├── id          UUID PK
├── order_id    UUID NOT NULL REFERENCES orders(id)
├── tenant_id   UUID NOT NULL REFERENCES tenants(id)
├── method      TEXT NOT NULL         -- cash / card / UPI etc., data-driven
├── amount      NUMERIC(12,2) NOT NULL
└── created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

## 11. Configuration tables (data-driven behavior)

```
tenant_settings          -- key/value or structured JSONB per tenant
├── tenant_id  UUID REFERENCES tenants(id)
├── key        TEXT
├── value      JSONB
└── PRIMARY KEY (tenant_id, key)

order_types (per tenant)
workflow_config (per tenant: direct | coordinator | kitchen, plus which
                  optional modules are enabled: kitchen_display, tv,
                  coordinator_display, printer)
packing_charge_rules (per tenant: none | flat | per_item | item_specific,
                       optionally scoped by order_type)
order_statuses (per tenant: which statuses in the pipeline, in what order)
```

Exact column shapes deferred to Phase 2/3; the architectural constraint —
no service class may branch on a tenant's name or type — is unchanged.

## 12. Inventory & recipes (pointer)

`ingredients`, `inventory_levels`, `recipes`, `recipe_ingredients` — all
`tenant_id`-owned, RLS'd identically to the tables above. Deferred to
Phase 7.

## 13. Indexing summary

- `orders (tenant_id, order_number)` — unique, primary lookup path.
- `orders (tenant_id, created_at)` and `orders (tenant_id,
  created_at_device)` — reporting/date-range queries; kept distinct per §4.
- `orders (tenant_id, status)` — active-order dashboards.
- `orders (tenant_id, idempotency_key)` — unique, dedup lookups.
- `device_order_reservations (tenant_id, device_id, status)` — admin
  visibility into outstanding/active reservations (TESTING.md,
  TROUBLESHOOTING.md).
- `audit_logs (tenant_id, created_at)`, `audit_logs (entity_type,
  entity_id)`.
- All foreign keys get a supporting index explicitly (Postgres does not
  auto-index FK columns).

## 14. Unresolved / deferred schema decisions

- Exact shape of `tenant_settings` (flat key/value JSONB vs. dedicated
  tables per config type) — deferred to Phase 2/3 implementation.
- Multi-currency support — not mentioned in the blueprint; assumed
  single-currency (INR) for V1.
- Soft-delete vs. hard-delete convention for products/categories.
- **Unresolved (product decision, not a technical one):** whether reports
  bucket by `created_at` (sync/write time) or `created_at_device` (actual
  device-local creation time) for orders created offline and synced
  later — affects how an offline order appears in "today's" report if it
  syncs after midnight. This must be finalized with the product owner
  before Phase 8 (Reports) and before offline reporting is implemented.
  No default is assumed here, and no test should encode either behavior
  as correct until this is decided (see TESTING.md §17).
- **New:** default/maximum `block_size` for offline reservations, and
  whether it is a fixed platform default or a per-tenant configurable
  setting — needs product input (ties to DEPLOYMENT.md / operational
  guidance, not purely a schema question).
