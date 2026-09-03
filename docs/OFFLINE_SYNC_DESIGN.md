# OFFLINE_SYNC_DESIGN.md — Offline Fallback & Synchronization Design

Status: **DESIGN ONLY.** Nothing in this document has been implemented.

**Revision note:** this supersedes the earlier "provisional number, real
number assigned after sync" design. The finalized approach (Option B) is
**pre-reserved real order-number ranges**, granted to an authorized device
while online, consumed offline, with no renumbering and no automatic
reprint at sync time. This document also resolves the four points
previously left open, per the final business clarification: range
exhaustion behavior, device identity, no-auto-reprint, and the
internet-vs-power-vs-local-network distinction.

Guiding constraints (unchanged, carried from the blueprint and reaffirmed
in the final clarification):
- PostgreSQL is the permanent source of truth, always.
- Local device storage is temporary only.
- Real order numbers are never reused; gaps are acceptable.
- The number on the receipt and the number derived for the TV/coordinator
  display are the same number, online or offline, before and after sync.
- There is no renumbering after synchronization, and no automatic
  reprinting when connectivity returns.

---

## 1. Scope: what "offline" means here

Per the final clarification (§5, §15, §16 of the requirement), three
distinct failure conditions are **not the same thing** and must not be
conflated in the design or in the code:

| Condition | Counter PC | Printer | Local shop network | Internet | System behavior |
|---|---|---|---|---|---|
| **A. Internet outage only** | ON | ON | ON | OFF | **This document's scope.** Counter operates using its pre-reserved range; TV/Kitchen/Coordinator continue working over the local network if they communicate via it, or show a "last known state" if they depend on the cloud for real-time fan-out (see §9). |
| **B. Internet + local network outage** | ON | ON | OFF | OFF | Counter can still create orders using its reserved range (this does not depend on any network). TV/Kitchen/Coordinator **cannot** receive updates from the counter if their communication path is the local network that is also down — this must not be silently assumed to work. Whether these devices communicate directly over a local network (independent of internet) or only ever via the cloud is an **explicit architecture decision to confirm during Phase 4 implementation**, flagged here as unresolved (see §14). |
| **C. Power failure** | OFF | OFF | (moot) | (moot) | Out of scope by design. The blueprint's own distinction (§15 of the clarification) is explicit: the system is not expected to create orders on devices that have no power. When power returns, the counter resumes using its still-valid reservation (unconsumed range is untouched by a power cycle, since it is stored durably — see §5) and continues from wherever its local pointer left off. |

The remainder of this document addresses **condition A** (and, for the
counter device specifically, is also correct under condition B — the
counter's own order creation has no local-network dependency, only the
*display fan-out* does).

## 2. Identifiers

- **`device_id`** — the authorized device's own identity (see §3), never
  an employee identity. Every offline-created order records which device
  created it.
- **`idempotency_key`** — generated on-device at the moment of order
  creation (online or offline, no distinction in how this is generated).
  This is the **primary** duplicate-prevention mechanism for sync
  (DATABASE.md §7), unchanged from the online design.
- **`local_order_id`** — a device-local UUID for the device's own
  bookkeeping before the order has been written to PostgreSQL. Distinct
  from `idempotency_key` (the local ID never leaves the device; the
  idempotency key does).
- **`order_number`** — under this design, the **real, final** order
  number, drawn from the device's pre-reserved range **at the moment of
  offline creation**. It is not provisional and is never replaced.

## 3. Device identity (new — required by this design)

A device must be registered and authorized before it can hold a
reservation. See DATABASE.md §6 for the schema (`devices`,
`device_order_reservations`).

- **Registration:** performed by a Shop Admin (`device.manage`
  permission) — associates a physical/logical device with the tenant and
  optionally a specific counter. Produces a device credential (see
  SECURITY.md §19 for the credential mechanism itself).
- **Authentication:** the device presents its credential on every request
  it makes directly (reservation requests, sync requests) — this is
  separate from, and in addition to, whichever employee is logged in and
  operating the device at the time. An order created offline records
  **both** `device_id` (which device created it) and `created_by_user_id`
  (which employee was logged in) — losing either fact loses real
  operational/audit information.
- **Authorization:** only a device with `status = 'active'` may request
  or hold a reservation. A `revoked` or `replaced` device is rejected at
  the reservation-request and sync endpoints alike, not only at
  reservation-request time — a device revoked *after* it already holds a
  reservation must not be able to sync orders using that reservation
  either (see §11).
- **Revocation:** an explicit, audited Shop Admin action (e.g. device
  lost/stolen/decommissioned). Any reservation the device held moves to
  `abandoned`; its unused numbers are permanently retired (§5 of
  DATABASE.md — this falls directly out of the sequence-based allocation,
  no special-case cleanup logic needed).
- **Replacement:** registering a new device is a separate action from
  revoking the old one; the new device gets its own fresh reservation
  when it next comes online. There is no "transfer" of a reservation
  between devices — a reservation belongs to the device it was granted
  to, permanently.
- **Compromised device:** treated identically to revocation. Because the
  device's own credential (not an employee password) is what a
  compromise would expose, the credential itself must be revocable
  independently of any employee's login credentials (SECURITY.md §19).

## 4. What happens while online (reservation)

1. While a device is online and authenticated, it (or the counter
   application running on it) requests a reservation of a block of real
   order numbers from the API.
2. The API grants a block using the advisory-lock + sequence mechanism in
   DATABASE.md §5.3, and records it in `device_order_reservations` with
   `status = 'active'`, `range_start`, `range_end`, `next_to_issue =
   range_start`.
3. The device persists the full reservation (`range_start`, `range_end`,
   `next_to_issue`) to **durable local storage**, not memory only (see
   §5), so it survives an app/device restart.
4. A device may hold only one `active` reservation at a time in this V1
   design (§6 of DATABASE.md) — a device that already has an active,
   unexhausted reservation does not request another.

## 5. What happens while offline (consumption)

1. Employee creates an order with no connectivity.
2. Device assigns `order_number = next_to_issue` from its active
   reservation, computes `display_number` deterministically
   (`((order_number - 1) % 999) + 1`), and increments its **local**
   `next_to_issue` pointer.
3. The order (full payload, `order_number`, `display_number`, `device_id`,
   `created_by_user_id`, `idempotency_key`, `created_at_device` timestamp)
   is written to **durable local storage** with `sync_state = PENDING`.
4. The receipt is printed **immediately, as the final receipt** — showing
   the full real `order_number` and the derived `display_number`/token —
   because, per the finalized design, this number is real and will never
   change. There is no "provisional" language on this receipt.
5. If the shop's TV/Coordinator/Kitchen displays are reachable over the
   **local network** (condition A in §1), the device broadcasts the new
   order/status directly over the local network so those displays can
   show the real token immediately, without depending on the cloud. If
   only cloud-based WebSocket fan-out exists (no local-network path).
   these displays will not reflect new offline orders until sync — this
   gap is explicitly called out in §9 as a decision to finalize in Phase 4,
   not assumed away.

## 6. Range exhaustion (finalized behavior)

If the device's local `next_to_issue` pointer reaches `range_end` while
still offline:

- The device does **not** create a provisional number.
- The device does **not** reuse an already-issued number.
- The device does **not** invent a separate/local numbering scheme.
- The device **stops accepting new order creation** and shows a clear,
  specific staff-facing message (e.g. "Reserved order numbers used up —
  reconnect to the internet to continue taking orders"), distinct from a
  generic error, so staff understand exactly what to do.
- This is a hard stop, not a degraded mode — there is no fallback
  numbering path by design, because any fallback path reintroduces the
  exact correctness risk (possible collision or reuse) that pre-
  reservation exists to eliminate.
- The moment connectivity returns, the device requests a new reservation
  (§4) and resumes taking orders.

## 7. Synchronization

1. On reconnection, the device syncs each `PENDING` order to the API,
   using its existing `idempotency_key` and its existing `order_number`
   (unchanged from creation time).
2. The API validates the device is still `active` (§3) and the referenced
   reservation is still valid, then inserts the order using the exact
   `order_number` supplied (this is safe/non-conflicting by construction,
   since that number was permanently retired from the shared sequence the
   moment it was drawn for this device — see DATABASE.md §5.3).
3. **No renumbering occurs at sync.** The order's `order_number` and
   `display_number` in PostgreSQL are identical to what was printed on
   the receipt at creation time. This was the central requirement driving
   the redesign and is treated as non-negotiable.
4. **No automatic reprint occurs at sync**, per the final clarification.
   The customer already has their receipt; sync is a backend
   reconciliation event with no customer-facing side effect. This applies
   uniformly to: initial sync, sync retries, and any backfill/reconciliation
   job — none of these ever trigger a print.
5. `orders.created_at` (write time) is set to the actual sync time;
   `orders.created_at_device` (DATABASE.md §4) preserves the original
   device-local creation time — both are retained, not collapsed into one
   field, because reporting needs to distinguish "when this happened" from
   "when the cloud found out."

## 8. Reservation/order state machines

**Reservation (`device_order_reservations.status`):**
```
active → exhausted   (next_to_issue reaches range_end)
active → abandoned   (device revoked/replaced while range still has unused numbers)
```

**Individual offline order (local device storage, `sync_state`):**
```
PENDING → SYNCING → SYNCED
                  ↘ FAILED_RETRYABLE → SYNCING (retry, same idempotency_key)
                  ↘ FAILED_VALIDATION → NEEDS_ATTENTION (manual resolution)
```

This mirrors the state machine from the prior design (retry/duplicate
handling is unchanged — see §10, §11) but the **numbering** half of the
old design (provisional → real) is removed entirely: `order_number` is
fixed at local-creation time and never revised by any state transition.

## 9. Local network vs. cloud-only real-time fan-out (unresolved,
   flagged per final clarification §16)

Two architectures are possible for how Kitchen/Coordinator/TV displays
learn about an offline-created order **before** sync completes:

- **(a) Cloud-only:** displays only ever receive updates via the cloud
  WebSocket gateway (ARCHITECTURE.md §9). Under condition A (internet
  down, local network up), this means offline orders are invisible to
  those displays until sync — a real customer-experience gap during every
  outage, since the whole point of the token system is a live queue.
- **(b) Local-network fallback:** the counter device also broadcasts
  directly to Kitchen/Coordinator/TV over the shop's local network
  (e.g. local mDNS/WebSocket server on the counter device, or a local
  message broker) when the cloud path is unavailable, so the live-queue
  experience continues during an internet-only outage. This requires
  those display devices to also run client logic capable of listening on
  the local network, not only the cloud — additional implementation
  scope not yet in ARCHITECTURE.md.

**This is not decided in this document.** Given the blueprint's own
emphasis on the token system being usable live at the counter and on the
TV, (b) is the direction that actually satisfies "shop should continue
taking and printing orders during a temporary internet outage" in spirit,
not merely in the sense of "the counter alone still works." This is
flagged as a decision to make explicitly before Phase 4 (Token/Display),
because it affects the Kitchen/Coordinator/TV client architecture, not
just the counter and backend.

## 10. Retry behavior (unchanged from prior design)

- Exponential backoff, uncapped retry count for `FAILED_RETRYABLE`.
- Retries always resend the identical `idempotency_key` and identical
  order payload captured at creation time.
- Device restart mid-retry resumes from persisted local state (§5, §12).

## 11. Duplicate prevention

- Server-side: `UNIQUE (tenant_id, idempotency_key)` remains the primary
  mechanism (DATABASE.md §7); `UNIQUE (tenant_id, order_number)` is a
  secondary defense-in-depth check, now backed by sequence-based
  allocation rather than a rollback-prone counter (DATABASE.md §5.2).
- A sync attempt from a device that has since been revoked (§3) is
  rejected outright, regardless of idempotency key validity — a revoked
  device's in-flight/pending local orders require Shop Admin review
  (moved to `NEEDS_ATTENTION`) rather than being silently synced, since
  the revocation may have been *because* the device was compromised.

## 12. Validation failures at sync time

Unchanged in mechanism from the prior design: a referenced product
deleted/deactivated between offline creation and sync produces
`FAILED_VALIDATION`, surfaced to a Shop Admin "Needs Attention" queue, and
is never silently modified or auto-healed. The order is synced with the
data captured at creation time if resolved to proceed, never at
re-queried current-time values.

**Unresolved (unchanged from prior revision):** exact rule-by-rule
classification of which validation issues are hard-fail vs. auto-heal
needs product sign-off before Phase 9.

## 13. Device restart / crash recovery

- Reservation state (`range_start`, `range_end`, `next_to_issue`) and all
  `PENDING`/`FAILED_RETRYABLE` orders are persisted to durable on-device
  storage, not memory only — a crash or restart must not lose the
  device's place in its own reserved range, nor any not-yet-synced order.
- On restart, any order left in `SYNCING` is treated as unknown-outcome
  and re-attempted with its existing idempotency key (safe by
  construction — a duplicate re-attempt is a no-op if the original
  request actually succeeded server-side before the crash).
- If local storage is lost entirely despite the durability measures above
  (e.g. disk failure) — this is the scenario flagged as the residual risk
  in the prior architectural review: any not-yet-synced orders are lost,
  **and their receipts, already in the customer's hand, claimed
  finality.** This risk is inherent to the chosen design (Option B) and
  is not eliminated by any mechanism described here — it is mitigated
  operationally by:
  - keeping reservation block sizes conservative (smaller blocks bound
    the maximum possible loss window — see DATABASE.md §14 unresolved
    default block size),
  - Shop Admin visibility into `device_order_reservations` with status
    `active`/`exhausted` and their `next_to_issue` progress, so a device
    that has gone dark for an unusual length of time is noticeable rather
    than silently discovered at reconciliation, and
  - (implementation-time decision, not yet made) whether counter devices
    should use storage with stronger durability guarantees than a default
    browser/local-app storage layer, given what is now riding on that
    storage's reliability.

## 14. Partial synchronization

Unchanged from prior design in mechanism: orders sync independently, one
failure does not block others. Sequential (oldest-first) syncing remains
the tentative recommendation to keep `created_at` (write-time) ordering
close to `created_at_device` (creation-time) ordering, though — as noted
in the prior revision — the real order number was already fixed at
creation time under this design, so sync ordering **no longer affects
numbering at all** (a genuine simplification versus the prior design,
where sync order affected which device's orders got which numbers).

## 15. Cleanup after successful synchronization

Unchanged: synced orders are retained locally for a short troubleshooting
window (exact duration still **unresolved**, deferred to implementation)
before deletion from device storage. PostgreSQL remains sole source of
truth throughout and after this window.

## 16. Explicit summary of unresolved decisions in this document

1. **Local-network fallback for displays during internet-only outages**
   (§9) — whether Kitchen/Coordinator/TV get real-time updates during an
   outage via a local-network path, or only see offline orders after
   sync. This has real customer-experience consequences and should be
   decided before Phase 4.
2. Exact validation-failure classification rules (auto-heal vs. human
   review) — unchanged from prior revision (§12).
3. Local retention window for synced orders before on-device cleanup
   (§15) — unchanged from prior revision.
4. Default/maximum reservation `block_size` and whether it's a platform
   default or per-tenant configurable (DATABASE.md §14) — directly
   affects the residual data-loss exposure described in §13.
5. Whether counter devices require stronger local-storage durability
   guarantees than a default implementation would provide, given that a
   printed, "final" receipt now depends on that storage surviving until
   sync (§13).

These remain genuinely open and are not answered here, consistent with
the instruction not to invent offline-sync behavior casually. They should
be resolved with the product owner before Phase 9 implementation begins.
