# TROUBLESHOOTING.md — Operational Runbook (Version 1)

Status: **DESIGN ONLY**, written ahead of implementation so operational
expectations are established alongside the architecture, not invented
during an incident.

---

## 1. "A shop reports seeing another shop's data"

This is the highest-severity possible incident given the blueprint's hard
requirement of tenant isolation. Immediate steps:
1. Identify the exact request/response or screen involved and the
   `correlation_id` from the logs.
2. Check `audit_logs` and application logs for the `tenant_id` resolved
   for that request — confirm whether the leak originated in application
   logic (missing tenant filter) or would have been caught by RLS (if RLS
   is confirmed enabled and not bypassed, this class of leak should be
   structurally impossible — treat any occurrence as also an RLS
   configuration incident, not only an application bug).
3. Confirm the affected DB role does not have `BYPASSRLS`/superuser
   (SECURITY.md §14) — if it does, that is very likely the root cause and
   is itself a deployment-configuration incident.
4. Do not attempt a quick patch without first understanding whether the
   application layer, RLS layer, or WebSocket-room layer failed — each has
   a different fix.

## 2. "Order numbers appear duplicated or reused"

1. Check the tenant's dedicated PostgreSQL sequence (`tenants
   .order_sequence_name`) via `SELECT last_value FROM <sequence>` against
   actual `orders.order_number` values for that tenant — a mismatch
   suggests a code path is constructing `order_number` manually instead of
   calling `nextval()` through the shared allocation service, or is
   reading from an offline device's reserved range incorrectly.
2. If the duplicate involves an offline-synced order, check
   `device_order_reservations` for the device that issued it — confirm
   the number actually fell inside that device's granted
   `[range_start, range_end]` and wasn't reused from an `exhausted` or
   `abandoned` reservation (which would indicate a bug in the device's
   local range-tracking logic, not the server-side allocator).
3. Duplicates should be structurally prevented by `UNIQUE (tenant_id,
   order_number)` — if a duplicate exists, the constraint was either
   missing or bypassed (e.g. direct DB write outside the app, or a
   migration that didn't recreate it).
4. Remember the allocation guarantee comes from `nextval()` being
   non-transactional (DATABASE.md §5.2) — if a reuse is ever observed, it
   is a serious finding and likely means either the constraint above is
   missing, or some code path is *not* going through the tenant's
   sequence at all (e.g. a leftover reference to the old, superseded
   counter-table design). Treat this as a priority-one defect, not a
   one-off data-fix.

## 3. "Customer display shows 000, or display number looks wrong"

1. `display_number` should never be `000` by construction
   (`((order_number - 1) % 999) + 1`) — if it is, check whether it was
   computed with a different (buggy) formula somewhere, or whether a
   stored value has drifted from what re-deriving from `order_number`
   would produce.
2. Recompute from `order_number` directly as the source of truth; treat
   any stored `display_number` that disagrees with the derivation as
   corrupted data to be fixed, not as evidence the formula is wrong.

## 4. "Kitchen/Coordinator/TV display not updating in real time"

1. Confirm the client's WebSocket connection is actually established and
   joined to the correct tenant room (ARCHITECTURE.md §9) — a silently
   failed/expired connection is the most common cause.
2. Confirm the emitting event actually targets that tenant's room (a
   naming mismatch, e.g. wrong tenant ID interpolated into the room
   string, is the next most likely cause).
3. Have the display do a REST-based resync on reconnect rather than
   waiting for a missed event to be redelivered (TESTING.md §13) — this
   should already be the designed behavior, not a manual workaround.

## 5. "Printer failed, is the order lost?"

1. No — per architecture, the order is saved and confirmed **before**
   printing is attempted. Confirm the order exists in `orders` with the
   expected `order_number`.
2. Use the manual "Reprint" action, which must not create a new order or
   a new `idempotency_key`/`order_number` — if a reprint is found to have
   created a duplicate order, that is a bug in the reprint path
   specifically (it should only re-render stored data).
3. **Do not confuse this with a report of "the receipt printed again by
   itself after Wi-Fi came back."** That is a distinct, higher-priority
   defect: automatic reprinting on synchronization/reconnect is explicitly
   disallowed by design (OFFLINE_SYNC_DESIGN.md §7) — an offline order's
   receipt is final at the moment of offline creation, and sync must have
   zero customer-facing print side effects. If this is observed, look for
   a sync-completion handler that was wired to a print action by mistake,
   not for a printer hardware issue.

## 6. "Duplicate order created from a single tap/submission"

1. Check whether the client sent two different `idempotency_key` values
   for what the user experienced as one action (a client bug generating
   a new key per retry instead of reusing one) — the server-side unique
   constraint only protects against a *reused* key.
2. Confirm the unique constraint `(tenant_id, idempotency_key)` exists and
   is enforced — this is the actual backstop, not the pre-request
   existence check alone (DATABASE.md §7).

## 7. "Offline device won't sync" / "orders missing after reconnect"

Once offline sync is implemented per OFFLINE_SYNC_DESIGN.md:
1. Check the device's local sync-state store for orders stuck in a
   `PENDING`/`FAILED_RETRYABLE`/`NEEDS_ATTENTION` state and the specific
   failure reason recorded against each (OFFLINE_SYNC_DESIGN.md §8).
2. Confirm the device is still `status = 'active'` in `devices` — a
   revoked or replaced device is rejected at sync time by design, and its
   pending local orders will need manual Shop Admin review rather than
   syncing automatically (OFFLINE_SYNC_DESIGN.md §11).
3. Never manually re-submit an offline order without its original
   `idempotency_key` — doing so defeats the exact protection meant to
   prevent duplicates during recovery.
4. Confirm the order's `order_number` falls inside the device's granted
   reservation (`device_order_reservations`) — a number outside the
   granted range should never have been issued and indicates a client-side
   bug in the device's local range tracking, not a sync-layer problem.

## 7a. "Device won't take new orders — shows a 'reconnect to continue'
    message" (range exhaustion)

This is **expected, correct behavior**, not a bug, per
OFFLINE_SYNC_DESIGN.md §6:
1. Confirm the device's reservation (`device_order_reservations`) has
   `next_to_issue` at or past `range_end` — if so, the device has
   legitimately used its entire pre-reserved block while still offline,
   and by design it must not fall back to any other numbering scheme.
2. The only correct fix is restoring connectivity so the device can
   request a new reservation — there is no admin override that should
   allow a device to "keep going" past its range while offline, since
   that would reintroduce the exact collision/reuse risk the range
   reservation exists to prevent.
3. If this occurs frequently for a given device/shop, treat it as an
   operational signal to review that device's reservation `block_size`
   (DATABASE.md §14, unresolved default) rather than looking for a
   technical workaround.

## 7b. "A device's receipts look final but the order never appears in
    reports" (lost local storage)

This is the residual risk flagged in OFFLINE_SYNC_DESIGN.md §13 — an
offline order was created (and its receipt printed as final) but the
device's local storage was lost before sync (crash, storage corruption,
device discarded without reconciliation).
1. Check `device_order_reservations` for that device: does `next_to_issue`
   indicate numbers were issued that never appear in `orders`? That gap
   is the signature of this scenario.
2. This is not recoverable from the server side — the order payload only
   ever existed on the device. Treat it as a business/reconciliation
   issue (the shop may need to manually reconstruct what was sold from
   the physical receipt or the customer's memory), not a data-recovery
   task.
3. Preventive/detective measures, not cures: keep an eye on
   `device_order_reservations` for devices that have been `active` far
   longer than expected without new syncs (§ Shop Admin visibility,
   OFFLINE_SYNC_DESIGN.md §13), and review whether that device's
   reservation `block_size` is larger than it needs to be, since block
   size directly bounds how much could be lost in the worst case.

## 8. "A user can perform an action they shouldn't be able to"

1. Check their effective permissions via `user_roles` → `role_permissions`
   for their tenant — confirm the role assignment, not just the
   permission catalog.
2. Confirm the endpoint in question actually declares a
   `@RequirePermission(...)` guard — an endpoint added without one fails
   open under the current design and should be treated as a bug to fix
   immediately, not a one-off exception.

## 9. General incident process

1. Identify correlation ID / affected tenant(s) / time window.
2. Check `audit_logs` for relevant actor/entity activity in that window.
3. Determine whether the issue is isolated to one tenant (likely
   application/data bug) or cross-tenant (treat as a severity-1 isolation
   incident per §1 regardless of apparent cause).
4. Document the incident and its root cause in a post-incident note; if
   it reveals an architectural gap, update the relevant `docs/*.md` file
   per Development Rule 5 ("don't change architecture without documenting
   the change").
