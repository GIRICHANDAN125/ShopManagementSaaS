# TESTING.md — Testing Strategy (Version 1)

Status: **DESIGN ONLY.** Defines what must be tested and why, before any
implementation begins, so tests can be written alongside each phase rather
than bolted on at the end.

---

## 1. Test pyramid

- **Unit tests:** pure logic — order-number/display-number derivation,
  packing-charge calculation, permission-resolution logic, idempotency-key
  handling logic (excluding the DB itself).
- **Integration tests:** real PostgreSQL (test database/container), real
  RLS policies applied — not mocked, because RLS correctness cannot be
  verified against a mock.
- **End-to-end tests:** critical business flows across API + WebSocket
  (order creation → kitchen update → TV update).

## 2. Tenant isolation

- Create two tenants (A, B) with overlapping data shapes (same product
  names, same employee usernames where allowed) to catch isolation bugs
  that only manifest when data looks similar.
- For every tenant-owned entity: authenticate as a Tenant A user, attempt
  to read/update/delete a Tenant B resource by ID → must fail (404, not
  403 — see note below) at both the application layer and, separately, by
  directly exercising the RLS policy in an integration test that bypasses
  the application layer's own tenant filter (to prove RLS is truly the
  backstop, not just redundant with the app check).
- **Note on 404 vs 403:** returning 404 for a cross-tenant resource (rather
  than 403) avoids confirming to an attacker that the resource exists at
  all under a different tenant — a deliberate choice to document and test.

## 3. IDOR / BOLA

- Enumerate every endpoint that takes a resource ID and confirm ownership
  is checked, not just permission type (e.g. having `order.view` must not
  be sufficient to view another tenant's order, or another counter's
  order if counter-level scoping is ever added).

## 4. Authentication & authorization

- Invalid credentials rejected; correct lockout/backoff behavior after
  repeated failures.
- Expired/tampered JWT rejected on both REST and WebSocket paths.
- Permission matrix tests: for each permission code, a user without it is
  denied, a user with it (via role) is allowed, and a user with it **in a
  different tenant** is still denied for the resource in question.

## 5. RLS-specific tests

- Attempt a raw query against a tenant-owned table without setting
  `app.current_tenant_id` → expect zero rows returned (default-deny), not
  an error that could be caught and ignored, and not all rows.
- Attempt with `app.current_tenant_id` set to Tenant A while querying for
  a Tenant B row → zero rows.
- Confirm the application's database role does not have `BYPASSRLS` and
  is not a superuser (a config assertion test, run in CI, not just a
  one-time manual check).

## 6. Order numbering (revised for sequence-based allocation)

- **Concurrent creation:** fire N simultaneous order-creation requests for
  the same tenant; assert all resulting `order_number` values are unique
  and no two are ever equal — this must hold under real concurrent load
  against the actual PostgreSQL sequence, not a mocked allocator.
- **Cross-tenant independence:** concurrent creation across two tenants
  must not affect each other's sequences (Tenant A reaching 1050 must
  have no effect on Tenant B's counter, since each tenant has its own
  dedicated sequence object).
- **No daily reset:** create an order, advance the test clock across a
  simulated day boundary, create another order → number continues
  incrementing, does not reset to 1.
- **No reuse on rollback — the specific regression test this design
  exists to satisfy:** in an integration test, deliberately call
  `nextval()` for a tenant's sequence inside a transaction, then force
  that transaction to roll back (e.g. a subsequent validation failure or
  explicit `ROLLBACK`) → assert that the *next* successful order for that
  tenant receives a number **strictly greater than** the rolled-back
  value, i.e. the rolled-back number is never issued to any order. This
  test must fail against the old transactional-counter design and pass
  against the sequence-based design — it is the direct regression test
  for the correctness gap identified in DATABASE.md §5.1.
- **No reuse on cancellation:** cancel order `1051` → next created order
  is `1052` or higher, never `1051` again.
- **Sequence survives restart:** restart the test database connection
  pool / application process between two order creations for the same
  tenant → numbering continues correctly with no reset and no reuse.

## 6a. Offline range reservation (new)

- **Reservation grants a valid, non-overlapping block:** request a
  reservation of size N for a device → `range_end - range_start + 1 == N`,
  and the granted range does not overlap any other tenant's or device's
  previously granted range.
- **Concurrent reservation requests for the same tenant** (two devices
  requesting a block "at the same time") → both succeed with
  non-overlapping ranges, verified against the advisory-lock-based
  allocation (DATABASE.md §5.3), not merely asserted from the code path.
- **Reservation survives a rolled-back granting transaction:** force the
  reservation-granting transaction to fail after `nextval()` calls have
  been made but before the `device_order_reservations` row commits →
  assert those specific numbers are never granted to any other device or
  order afterward (mirrors the core regression test in §6, applied to the
  block-reservation path specifically).
- **Offline order uses its device's reserved number, unchanged at sync:**
  create an order offline (simulated no-connectivity), assert its
  `order_number`/`display_number` are drawn from the device's active
  reservation; sync it; assert the persisted `order_number`/
  `display_number` in PostgreSQL are **identical** to what was assigned
  offline — this is the direct regression test for "no renumbering after
  sync."
- **Range exhaustion:** simulate a device consuming every number in its
  reservation while offline → the (N+1)th order-creation attempt is
  rejected client-side with the defined staff-facing message (§ range
  exhaustion in OFFLINE_SYNC_DESIGN.md §6), not created with any
  fallback/local number.
- **Device revocation invalidates its reservation for sync:** revoke a
  device that holds an `active` reservation with unsynced local orders →
  attempt to sync those orders → rejected (routed to
  `NEEDS_ATTENTION`/admin review), not silently accepted.
- **Device replacement never reissues the old device's unused range:**
  replace a device with an unexhausted reservation → confirm its unused
  numbers are never subsequently granted to the replacement device or any
  other device.

## 7. Display-number derivation (999 → 001, never 000)

Table-driven test covering at minimum:
```
order_number 999   → display 999
order_number 1000  → display 001   (wrap, skip 000)
order_number 1001  → display 002
order_number 1998  → display 999
order_number 1999  → display 001
```
- Explicit assertion that no input value of `order_number` ever produces
  a `display_number` of `000`.
- Property-based test (e.g. fast-check) generating a wide range of
  `order_number` values and asserting the invariant holds generally, not
  just at the hand-picked boundary values above.

## 8. Idempotency

- Send the same "create order" request twice (same `idempotency_key`,
  same tenant, same payload) sequentially → second response returns the
  same order (`200`), does not create a second row.
- Send the same request **concurrently** (simulating a network race) →
  exactly one order is created; the unique constraint resolves the race,
  not just application-level pre-checking (test this by actually racing
  two requests, not by asserting the code path alone).
- **Reused idempotency key with a different payload (finalized behavior
  — DATABASE.md §7):** send a request with an existing `(tenant_id,
  idempotency_key)` but different order content (e.g. different items or
  total) → API returns **HTTP 409 Conflict**; the original order is
  fetched again immediately afterward and confirmed **unchanged** (same
  items, same total, same `order_number`) — the conflicting request must
  have zero effect on the stored order.

## 9. Cancellation

- Cancel a `CREATED`/`WAITING` order → status transitions correctly,
  audit log entry created, order number is not reused (see §6).
- Attempt to cancel an already-`COLLECTED` order → rejected per the
  tenant's configured status-transition rules (exact allowed transitions
  are data-driven per DATABASE.md §11 — Configuration tables — and should
  be tested against whatever the tenant's `order_statuses` configuration
  actually allows, not a hardcoded pipeline).

## 10. Printer failure / reprint

- Simulate a print failure after order save → order remains in a valid,
  visible state; "Reprint" action is available.
- Reprint action does **not** call the order-creation endpoint and does
  **not** create a second `orders` row or a second `order_number`.
- Reprint after a partially-failed first print produces an identical
  receipt (same order number, same display number, same totals) — no
  recalculation on reprint.

## 10a. No automatic reprint on synchronization (new — final requirement)

- Sync an offline-created order (initial sync attempt) → assert no print
  command/event is issued by the server or triggered client-side as a
  *result* of the sync call itself. The only print that ever happened for
  that order was the one at offline creation time (§5 of
  OFFLINE_SYNC_DESIGN.md).
- Sync a **retried** sync request (e.g. simulating a dropped
  acknowledgement) for an already-synced order → still no print triggered.
- Run a backfill/reconciliation job over previously-synced orders →
  confirm it has no print side effect for any order, past or present.
- This is a distinct assertion from §10 (manual reprint after printer
  failure) — the two must not be conflated: manual reprint is
  staff-triggered and always available; automatic reprint-on-reconnect is
  explicitly disallowed and must never fire on its own.

## 11. Packing charges

- Table-driven tests for each configured rule: none, flat, per-item,
  item-specific, order-type-specific — confirm the backend-computed total
  matches expectation and that a client-supplied packing charge/total is
  never trusted (server recomputes regardless of what the client sent).

## 12. Workflow

- For each of Direct / Coordinator / Kitchen configurations: confirm the
  order's status pipeline only exposes the stages relevant to that
  workflow (e.g. no "kitchen preparing" status surfaced when Kitchen is
  disabled for that tenant).
- Toggling a module (e.g. disabling Kitchen) for a tenant with in-flight
  orders in kitchen-related statuses — behavior must be explicitly defined
  and tested (likely: existing orders complete under the old workflow,
  new orders use the new configuration) — flagged if not yet decided.

## 13. WebSocket tenant isolation

- Open sockets for Tenant A and Tenant B; emit an event scoped to Tenant
  A → assert Tenant B's socket receives nothing.
- Attempt to join a room outside the caller's own tenant (e.g. by
  crafting a room name client-side, if the client ever specifies one) →
  rejected server-side regardless of client-supplied room name.
- Reconnect behavior: disconnect and reconnect a socket mid-order-lifecycle
  → client resyncs current state via a REST fetch, not solely by replaying
  missed WebSocket events (since WebSocket delivery is not guaranteed) —
  test that a missed "READY" event is still reflected after reconnect.
- Duplicate/stale event handling: deliver the same status event twice to
  a display client → resulting UI state is idempotent (no duplicate
  entries, no flicker to a stale prior status).

## 14. RBAC

- Full permission-matrix coverage (see §4) plus specific scenarios: an
  employee with only `order.create` cannot access `reports.view`; a Shop
  Admin's `employee.manage` permission cannot be used to modify a
  different tenant's employees (redundant with §2/§3 but tested at the
  RBAC-module level specifically).

## 15. Reports & calendar/date boundaries

- Order created at 11:59:59 PM shop-local time vs. 12:00:01 AM shop-local
  time must land in the correct calendar day's report **using the
  tenant's configured timezone**, not server/UTC time.
- Explicit test for a tenant configured in a different timezone than the
  server, to catch UTC-vs-local bugs early.
- Custom date-range reports: boundary inclusivity (is the end date
  inclusive?) tested explicitly, not left implicit.

## 16. Future/advance orders

- An advance order's `scheduled_for` date is distinct from its
  `created_at`/order date; reports correctly attribute it to the intended
  bucket (created-date reporting vs. fulfillment-date reporting — confirm
  which the blueprint intends, currently read as "admin can see future
  orders separately," tested as its own view rather than folded into
  daily totals).

## 17. Offline synchronization

Full design in OFFLINE_SYNC_DESIGN.md. The authoritative tests for
offline **numbering** behavior (non-overlapping reservations, concurrent
reservation, device-owned ranges, unused ranges becoming permanent gaps,
range exhaustion, sync using the already-reserved number, no renumbering)
live in **§6a above** — they are not repeated here to avoid two
definitions of the same test drifting apart. Likewise, the authoritative
tests for the no-auto-reprint-on-sync rule live in **§10a above**.

This section covers only the sync-*process* concerns that §6a/§10a don't:

- **Duplicate synchronization prevention:** sync the same locally-stored
  order twice (e.g. a dropped acknowledgement causing a client retry) →
  the second sync attempt is recognized via `(tenant_id, idempotency_key)`
  and returns the existing order; no second row is created and no second
  `order_number` is consumed (this is the same mechanism as §8, applied
  specifically to the sync path rather than initial online creation).
- **Sync interrupted mid-way** (partial network failure between request
  and acknowledgement) → safe to retry with the same `idempotency_key`;
  no duplicate order results (§8, §6a).
- **Validation failure at sync time:** a product referenced by an offline
  order was deleted/deactivated before sync → the sync attempt is
  rejected as `FAILED_VALIDATION` and routed to a Shop Admin "Needs
  Attention" queue (OFFLINE_SYNC_DESIGN.md §12), never silently modified
  or silently dropped.
- **Report timestamp bucketing (flagged, not decided — see DATABASE.md
  §14):** whether an offline order that syncs after midnight appears in
  the "today" report bucketed by `created_at` (sync/write time) or
  `created_at_device` (actual device-local creation time) is an
  unresolved product decision, not a technical one. Until it is decided,
  no test should assert either behavior as correct — write the test only
  once the business rule is finalized, and treat any test currently
  asserting one or the other as encoding an undecided requirement.

## 18. CI integration

- All of the above (excluding manual/exploratory security testing) run in
  CI on every pull request against a real PostgreSQL instance with RLS
  enabled — not an in-memory or mocked database, since RLS is a database-
  enforced control and cannot be meaningfully tested against a mock.
- Dependency vulnerability scan runs on a schedule and on dependency
  changes.
