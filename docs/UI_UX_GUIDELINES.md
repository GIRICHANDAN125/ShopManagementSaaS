# UI_UX_GUIDELINES.md — Interface Design Requirements (Version 1)

Status: **DESIGN ONLY.** No screens have been built. This document
captures the functional/UX intent for each of the system's six distinct
interfaces so that visual design and frontend implementation (Phase 4
onward) have a settled target rather than being invented ad hoc per
screen.

Source of truth for underlying data/behavior: `PROJECT_BLUEPRINT.md`,
`ARCHITECTURE.md` §2 (frontend), `OFFLINE_SYNC_DESIGN.md`. This document
is UX-only — it does not introduce new data model or backend behavior.

---

## 0. Cross-cutting principles (apply to all six interfaces)

- **One codebase, six views.** All six interfaces are built from the same
  React/Next.js frontend (ARCHITECTURE.md §2), differentiated by
  role/device context — not six separate apps. Shared design tokens
  (spacing, color, type scale) live in one place so a change to, say,
  the brand color updates every interface consistently.
- **Data-driven, not tenant-specific.** No interface hard-codes a shop's
  product set, workflow, or branding — every screen renders from that
  tenant's configuration (Development Rule 1). A different shop using the
  same interface should be able to look and behave differently (logo,
  enabled order types, enabled workflow stages) purely from configuration.
- **Tenant isolation is invisible, not a UI feature.** No interface ever
  displays a tenant switcher, a "which shop am I in" picker, or any control
  implying cross-tenant navigation for shop-level roles — the backend
  already scopes everything (ARCHITECTURE.md §4), and the UI reinforces
  this by simply never presenting the option.
- **Connectivity state is visible where it matters.** Counter, Coordinator,
  Kitchen, and TV all depend on real-time data (WebSocket) or, for
  Counter specifically, an offline reservation (OFFLINE_SYNC_DESIGN.md).
  Each of these interfaces needs a small, unobtrusive but honest
  connectivity indicator — staff should never have to guess whether what
  they're looking at is live.
- **Accessibility is a baseline, not a stretch goal.** Sufficient color
  contrast, readable type sizes appropriate to viewing distance (much
  larger for TV/Kitchen than for Admin), and touch targets sized for real
  use (gloved/wet hands at a counter, quick taps in a kitchen) — detailed
  per-interface below.

---

## 1. Super Admin — professional management dashboard

**Purpose:** platform-wide oversight across tenants (ARCHITECTURE.md §4 —
tenant-less session, separate audited code path).

- Tone: professional, information-dense, similar to a standard SaaS admin
  console — this is the one interface where density is appropriate,
  since the user is a platform operator, not shop floor staff.
- Core views: shop list (create/activate/deactivate), shop detail,
  platform-wide audit log, and — later — subscription/billing status
  (out of scope for V1 per blueprint §34, but the layout should not
  preclude adding it).
- Every action that mutates state (create shop, activate, deactivate,
  revoke) requires a visible confirmation step and is reflected in the
  audit log the same session (DATABASE.md §9) — Super Admin actions carry
  real consequences and the UI should not make them feel casual.
- No shop-level operational data (orders, products, inventory) is ever
  browsable in bulk from here beyond what's needed for support/oversight
  — this interface manages tenants, it does not operate them.

## 2. Shop Admin — clear business-management dashboard

**Purpose:** configure and monitor a single shop.

- Tone: clear and approachable rather than dense — the audience is a
  shop owner/manager, not necessarily a technical operator.
- Core areas: shop settings (branding, hours), products/categories,
  employees/roles, counters, workflow configuration (Direct/Coordinator/
  Kitchen and which optional modules are enabled), packing-charge rules,
  order types, devices (registration/revocation — DATABASE.md §6), and
  reports/analytics.
- Configuration screens should make the *consequence* of a toggle visible
  — e.g. turning Kitchen off should show, before saving, that
  kitchen-related order statuses will no longer appear for new orders —
  since these are exactly the settings TESTING.md §12 flags as needing
  defined in-flight-order behavior.
- Device management (new, from the offline design) needs its own clear
  screen: list of registered devices, their status (active/revoked/
  replaced), and — critically — visibility into any device's outstanding
  reserved-but-unsynced order-number range (OFFLINE_SYNC_DESIGN.md §13),
  since this is the Shop Admin's main tool for catching a lost/crashed
  device early.
- Reports/analytics should default to "today" and make switching to
  calendar/custom-range views a small number of clicks, not a separate
  buried section — this is a workflow the blueprint expects to be used
  daily (blueprint §21–23).

## 3. Counter — fast POS-style interface

**Purpose:** the highest-frequency, highest-pressure interface in the
system — an employee uses this dozens or hundreds of times a shift.

- **Large, obvious controls** for the three things done constantly:
  select product, confirm order, print. These are not buried in menus —
  they are the primary visual weight of the screen.
- **Minimum unnecessary navigation.** No multi-step wizards for a normal
  order. Category → product → quantity → confirm should be reachable in
  as few taps as the product catalog structurally allows, and nothing
  else competes for attention on the main order screen.
- Order-type selection (Dine-in/Takeaway/etc.) and packing-charge
  consequence should be visible before confirming, not discovered on the
  receipt — the total the employee sees before pressing "confirm" must
  match what prints, since backend-computed totals are authoritative
  (SECURITY.md §13) and the UI should never let the employee be surprised
  by a mismatch.
- **Offline/reservation state indicator (new):** while online, the screen
  need show nothing special. The moment the device is operating offline,
  a persistent, unmissable (but not alarming) banner should indicate
  offline mode, and — as the device's reserved range depletes — a
  low-numbers warning before hard exhaustion (OFFLINE_SYNC_DESIGN.md §6)
  so staff aren't blindsided by the "reconnect to continue" stop. This is
  a UX requirement that follows directly from the architecture: since
  range exhaustion is a hard stop by design (no fallback numbering), the
  UI's job is to make that stop predictable rather than surprising.
- Reprint is a clearly-labeled, deliberately secondary action (not
  visually competing with "confirm/print" for a new order) — it exists
  for the printer-failure case (TROUBLESHOOTING.md §5), not as a routine
  action.
- Touch targets sized generously — this interface is often used quickly,
  sometimes one-handed, sometimes by staff wearing gloves.

## 4. Coordinator — large, highly readable queue/status interface

**Purpose:** manage the live order queue between Counter and Customer
when the tenant's workflow includes a Coordinator stage (blueprint §5).

- Large, legible list of active orders with current status, designed to
  be scanned quickly, not read line by line — status should be
  distinguishable by more than color alone (shape/icon/position) for
  accessibility and for readability under variable shop lighting.
- Status changes (mark preparing/ready/collected) are large tap targets,
  reachable directly from the list — no drill-down required for the
  common action of advancing an order's status.
- Real-time by design: this screen must reflect Kitchen/Counter activity
  without manual refresh (ARCHITECTURE.md §9), and per TESTING.md §13
  must behave correctly on reconnect (resync via REST, not only rely on
  replayed WebSocket events) and be idempotent against duplicate/stale
  events — invisibly to the coordinator using it; they should never see
  a flicker or a duplicate row from either condition.
- Connectivity indicator present but unobtrusive (§0) — a coordinator
  needs to know if the screen might be stale, without it distracting from
  the queue itself.

## 5. Kitchen — large order cards, touch-friendly

**Purpose:** show incoming orders to kitchen staff and let them advance
status with minimal friction, hands often busy/dirty.

- Large order cards, one clear focal point per order: item names,
  quantities, and any item-level notes — nothing smaller or more
  peripheral competing for attention.
- Clear item quantities specifically called out — multi-item orders must
  never be ambiguous about "2× Chapati" vs. "1× Chapati" at a glance from
  typical kitchen viewing distance (further than a desk, closer than a TV).
- Status changes (Start → Ready) are large, touch-friendly, and forgiving
  of imprecise taps (bigger hit area than the visual button itself) —
  this interface should assume less-than-ideal touch conditions (wet or
  gloved hands, quick taps between other tasks).
- Same real-time/idempotent-event requirements as Coordinator (§4 above,
  TESTING.md §13) — a duplicate "new order" event must never produce a
  duplicate card.
- Only shows what's relevant to preparation — no pricing, no payment
  information, no admin controls. This is a deliberate scope limitation,
  not an oversight: kitchen staff need what's needed to cook, not the
  full order record.

## 6. Customer TV — very large token numbers, extremely simple

**Purpose:** the one interface a customer looks at directly, often from
several meters away, with zero training or context.

- **Extremely large token number display** — the single dominant visual
  element on the screen, legible from typical queueing distance. Nothing
  else on the screen should compete with it for visual weight.
- **No admin controls, no navigation, no interactive elements at all.**
  This is a passive display, full stop — there is no legitimate reason
  for a customer-facing screen to expose any control surface, and doing
  so would also be an unnecessary attack/tampering surface for a device
  sitting in a public space.
- Minimal supporting information only if it adds clarity without adding
  clutter — e.g. a short "Now Serving" label above the number — never
  order contents, prices, or any information not needed to identify one's
  turn.
- Must update the moment the underlying order's status changes,
  reflecting the real-time design in ARCHITECTURE.md §9, and must handle
  reconnect/stale-event scenarios identically to Coordinator/Kitchen
  (§4/§5) — a customer-facing screen showing a stale or duplicate number
  is a worse failure mode than an internal tool doing the same, since the
  customer has no way to know it's wrong.
- Should degrade gracefully and visibly (e.g. "Reconnecting…", never a
  frozen or blank screen with no explanation) if it loses its data
  source — silence on a public display reads as broken, not idle.

## 7. Unresolved / to confirm before Phase 4

- Whether the low-numbers warning threshold on Counter (§3) is a fixed
  percentage of the reservation `block_size` or a fixed absolute count —
  needs to be decided alongside the `block_size` default itself
  (DATABASE.md §14, OFFLINE_SYNC_DESIGN.md §16).
- Whether Kitchen/Coordinator/TV need a **local-network** data path in
  addition to the cloud WebSocket path, per the still-open decision in
  OFFLINE_SYNC_DESIGN.md §9 — this materially affects whether these
  three interfaces need their own local-network client logic, which is a
  frontend-architecture question, not just a backend one, and should be
  settled before these screens are built.
- Exact visual treatment for "stale/reconnecting" states across
  Coordinator/Kitchen/TV — functionally specified above (must be visible,
  must not be alarming, must not be silent) but not yet designed.
