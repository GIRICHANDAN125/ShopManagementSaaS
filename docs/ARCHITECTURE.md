# ARCHITECTURE.md — System Design (Version 1)

Status: **DESIGN ONLY — not yet implemented.** No code has been written
against this document. Requires explicit approval before Phase 1 begins.

Source of truth: `docs/PROJECT_BLUEPRINT.md` + 23 finalized architectural
decisions (this document operationalizes them).

---

## 1. High-level component diagram

```
                          INTERNET
                              │
                    ┌─────────┴─────────┐
                    │   Web Frontend    │  React / Next.js
                    │  (Admin, Counter, │
                    │  Kitchen, TV UIs) │
                    └─────────┬─────────┘
                              │ HTTPS (REST) + WSS (WebSocket)
                              ↓
                    ┌───────────────────┐
                    │   Node.js API     │  NestJS, TypeScript
                    │  - Auth module    │
                    │  - Tenant context │
                    │  - RBAC guard     │
                    │  - Order module   │
                    │  - Realtime gate  │
                    └────────┬──────────┘
                     ┌────────┴────────┐
                     ↓                 ↓
            ┌──────────────┐   ┌──────────────┐
            │ PostgreSQL   │   │    Redis     │
            │ (source of   │   │ (pub/sub     │
            │  truth, RLS) │   │  backplane,  │
            └──────────────┘   │  future)     │
                                └──────────────┘
```

For Version 1 with a single application instance, Redis is optional (a
single Node process can broadcast WebSocket events in-memory). It becomes
required the moment there is more than one API instance behind a load
balancer (see §9).

## 2. Frontend

- **Stack:** React / Next.js.
- Distinct role-based views share the same codebase: Super Admin console,
  Shop Admin console, Counter POS, Kitchen Display, Coordinator Display,
  Customer TV.
- The frontend never makes tenant-isolation decisions. It only renders
  what the backend returns for the authenticated user's tenant context. No
  tenant ID is ever accepted from the client and trusted — it is always
  derived server-side from the authenticated session (see §4).
- TV/Kitchen/Coordinator displays are unauthenticated-by-device or
  device-scoped (see §9) but still tenant-scoped.
- Per-interface UX requirements (Super Admin, Shop Admin, Counter,
  Coordinator, Kitchen, Customer TV) are specified in
  `UI_UX_GUIDELINES.md` — this section covers the technical frontend
  architecture only, not visual/interaction design.

## 3. Backend

- **Stack:** Node.js + TypeScript, NestJS.
- Modular boundaries mirror the blueprint's code structure: `auth`,
  `tenants`, `users`, `roles`, `products`, `categories`, `orders`,
  `order-items`, `tokens`, `inventory`, `recipes`, `payments`, `packing`,
  `workflows`, `displays`, `printers`, `reports`, `analytics`, `realtime`.
- Cross-cutting concerns (tenant context, RBAC, audit logging, request
  correlation IDs) are implemented as NestJS guards/interceptors applied
  globally, not re-implemented per module — this is what keeps Rule 2
  ("never mix tenant data") and Rule 4 ("don't scatter business rules")
  actually enforceable rather than aspirational.

## 4. Authentication and tenant context

1. User authenticates (username/password to start; MFA is a documented
   future item for Super Admin, SECURITY.md §1).
2. On success, the API issues a short-lived access token (JWT) and a
   longer-lived refresh token. The access token's claims include: `user_id`,
   `tenant_id`, and a `roles`/`permissions` snapshot or a permissions
   version number (to allow revocation without waiting for token expiry).
3. **Every request** passes through a `TenantContextMiddleware`/guard that:
   - Resolves `tenant_id` **only** from the verified token — never from a
     header, query param, or request body supplied by the client.
   - Sets the tenant context for the duration of the request (e.g. an
     async-local-storage-backed request context in Node, mirrored to a
     Postgres session variable — see DATABASE.md §8).
4. Super Admin sessions are tenant-less (they operate across tenants by
   design) and are handled by a **separate, explicitly-audited code path**,
   never the same guard that scopes shop-level requests. This prevents a
   bug in tenant resolution from accidentally granting cross-tenant access
   through the "admin" door.

## 5. Authorization (RBAC)

See DATABASE.md for the schema. At the architecture level:

- Every mutating (and most reading) endpoint declares required
  permission(s) via a decorator, e.g. `@RequirePermission('order.create')`.
- A `PermissionsGuard` checks the resolved user's permissions (loaded from
  `RolePermissions` for their `Role` within their `tenant_id`) before the
  handler executes.
- Authorization checks happen **after** tenant context is established and
  **before** any data access — this ordering matters: a permission check
  performed without tenant scoping can approve an action against the wrong
  tenant's resource (classic IDOR/BOLA class of bug — see SECURITY.md).
- Resource-level checks (e.g. "does this order actually belong to this
  user's tenant") are enforced by RLS as a second, independent layer (see
  DATABASE.md), not only by the application query.

## 6. Tenant isolation — architectural summary

Three independent layers, deliberately redundant:

1. **Application layer:** every repository/query method requires a tenant
   context and is generated/reviewed to include `tenant_id` in its
   `WHERE`/`INSERT` clauses.
2. **Database layer (primary defense):** PostgreSQL Row-Level Security
   policies on every tenant-owned table, keyed off a session variable set
   per-request. Full mechanism in DATABASE.md.
3. **Transport layer:** WebSocket connections and Redis channels are
   namespaced per tenant (see §9) so a message can't even be delivered
   to the wrong tenant's socket, regardless of application logic.

The design principle: **a bug in any single layer must not be sufficient
to leak data.** RLS exists specifically so that a forgotten `WHERE
tenant_id = ?` in application code is not enough to cause a cross-tenant
leak — the database itself would refuse the row.

## 7. Order numbering (architecture-level) — revised

- Each tenant owns a **dedicated PostgreSQL sequence** (not a
  transactional counter table). This is a deliberate correction: a
  transactional `UPDATE ... RETURNING` counter can have its increment
  rolled back if the surrounding transaction fails, which risks reissuing
  a number that may already have been printed on a receipt. PostgreSQL
  sequences advance non-transactionally — `nextval()` is never undone by
  a rollback — which is what actually guarantees "never reused" rather
  than merely making reuse unlikely. Full mechanism in DATABASE.md §5.
- The **customer display number** is a pure, stateless derivation from the
  real order number (`((order_number - 1) % 999) + 1`, zero-padded to 3
  digits) — it is **not** stored as an independent counter, which
  eliminates an entire class of "the two numbers drifted apart" bugs.
- Because the derivation is deterministic, kitchen displays, receipts, and
  the customer TV can each recompute it independently rather than trusting
  a value passed over the wire, which also closes a class of spoofing/
  tampering concerns.
- **Offline range reservation** (new): an authorized device may, while
  online, reserve a contiguous block of real order numbers drawn from the
  same tenant sequence, to consume while offline. The number a device
  issues offline is final and real from the moment it's issued — there is
  no separate offline numbering scheme and no renumbering at sync. Full
  design in OFFLINE_SYNC_DESIGN.md; schema in DATABASE.md §5.3–§6.

## 8. Idempotency (architecture-level)

- The client (Counter POS) generates a client-side `idempotency_key`
  (UUID) once per logical "create order" user action and resends the same
  key on retry (network timeout, double-tap, printer-triggered retry).
- The API treats `(tenant_id, idempotency_key)` as a uniqueness boundary
  (unique constraint — see DATABASE.md). A retried request with the same
  key returns the original order rather than creating a duplicate.
- This mechanism is also the join point with offline sync: locally-created
  orders carry their idempotency key from the moment of local creation, so
  sync is naturally idempotent (see OFFLINE_SYNC_DESIGN.md).

## 8a. Device identity (new)

A **device** (specific counter hardware/software installation) is a first-
class identity, separate from a user/employee login:

- A device is registered by a Shop Admin and issued its own credential,
  independent of any employee's password (SECURITY.md §19).
- A device must authenticate with its own credential before it may
  request or hold an offline order-number reservation (DATABASE.md §6) —
  this is in addition to, not a replacement for, the employee login and
  RBAC check already required to actually create an order.
- An offline-created order therefore always records **two** distinct
  actors: `device_id` (which device issued the number and stored the
  order) and `created_by_user_id` (which employee was logged in and
  operating it) — collapsing these into one field would lose real
  operational and audit information.
- Device lifecycle (registration, revocation, replacement, compromise
  handling) is detailed in OFFLINE_SYNC_DESIGN.md §3 and SECURITY.md §19.

## 9. Real-time (WebSockets) and Redis

- WebSocket gateway authenticates the same way as REST (token in the
  connection handshake), resolves `tenant_id` server-side, and joins the
  socket to a **tenant-scoped room** (e.g. `tenant:{tenant_id}:orders`).
  A connection is never joined to more than one tenant's rooms.
- Sub-rooms for device roles where useful, e.g.
  `tenant:{id}:kitchen`, `tenant:{id}:tv`, `tenant:{id}:coordinator`, all
  nested under the tenant namespace so a bug in room naming can't cross
  the tenant boundary (namespace prefix is enforced by a helper, never
  string-concatenated ad hoc at call sites).
- **Version 1 / single instance:** the Node process can emit events
  in-process; no backplane required.
- **Future / multiple instances:** Redis pub/sub becomes the backplane
  (e.g. via `socket.io`'s Redis adapter or an equivalent), so an event
  published on any instance reaches sockets connected to any other
  instance, still scoped to the tenant room/channel. This is documented
  now but **not implemented** until multiple instances are actually
  introduced, per blueprint §34 (don't overbuild V1).
- Reconnect/duplicate/stale-event handling: see TESTING.md and
  OFFLINE_SYNC_DESIGN.md — displays are designed to be idempotent
  consumers (applying a status event twice must be a no-op), not
  assumed to receive each event exactly once.

## 10. Printer communication

- Printing is **local to the shop's counter device**, not routed through
  the cloud in real time for the print job itself. The API's
  responsibility ends at "order saved and confirmed"; the client device
  is responsible for sending the ESC/POS (or equivalent) job to the
  locally-connected/networked thermal printer.
- Sequencing (per blueprint §29): `Save Order → Confirm Order → Print
  Receipt`. A print failure is a **client-side, recoverable** event — the
  order already exists server-side. The client offers a manual "Reprint,"
  which re-renders the same stored order/receipt data and **must not**
  call the order-creation endpoint again (enforced by idempotency key
  reuse if it did, as a backstop).
- **Printer failure vs. connectivity recovery are handled differently, by
  design:** a failed print offers a manual, staff-triggered reprint using
  the same order number. Wi-Fi/internet reconnection and offline order
  synchronization **never** trigger an automatic reprint — the customer
  already has whatever receipt was printed at creation time (final, under
  this design — see OFFLINE_SYNC_DESIGN.md), and reprinting it again
  without being asked would be confusing and is explicitly disallowed.

## 11. Temporary offline layer (pointer)

Full design lives in `OFFLINE_SYNC_DESIGN.md`. At the architecture level,
the hard rules of Version 1:

- Local storage is never treated as a data store the rest of the system
  reads from — it exists solely to survive a connectivity gap and is
  drained via synchronization.
- PostgreSQL remains the single permanent source of truth at all times.
- **Internet failure, local-network failure, and power failure are three
  distinct conditions and must not be conflated:**
  - *Internet down, power and local network up* — the scenario this
    document and OFFLINE_SYNC_DESIGN.md actually design for. The counter
    keeps taking orders using its pre-reserved number range.
  - *Internet and local network both down* — the counter can still
    create orders (its reservation has no network dependency at all), but
    whether Kitchen/Coordinator/TV displays can still receive live
    updates depends on whether they have a local-network fallback path
    independent of the cloud — this is an explicitly **unresolved**
    design question (OFFLINE_SYNC_DESIGN.md §9), not an assumed
    capability.
  - *Power failure* — explicitly out of scope for offline order creation.
    A device with no power cannot create or print orders, and the system
    is not designed to pretend otherwise. When power returns, the device
    resumes from its persisted local state (reservation pointer, pending
    sync queue) as if it had simply been offline.

## 12. Cloud deployment (pointer)

Full detail in `DEPLOYMENT.md`. Summary: containerized (Docker) Node.js
API and Next.js frontend, managed PostgreSQL, managed Redis (introduced
when needed), deployed to a cloud provider (AWS per blueprint), fronted by
a load balancer once more than one API instance exists.

## 13. Explicit non-goals for Version 1

Per blueprint §34/§15/§14: no GST/e-invoicing, no branches, no
WhatsApp/SMS, no loyalty, no AI forecasting, no advanced accounting, no
delivery tracking, no database-per-tenant, no full offline implementation
yet (design only), no multi-instance deployment yet (design only).
