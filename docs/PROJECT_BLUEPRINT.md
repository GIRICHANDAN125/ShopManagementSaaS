# MULTI-TENANT SHOP MANAGEMENT SaaS — Master Project Blueprint (Version 1)

> This file is the business/functional source of truth. Architectural and
> technical decisions derived from it are recorded in the companion documents
> in this `docs/` folder. If a proposed feature conflicts with this document,
> the conflict must be resolved and documented before code is written.

## 1. Objective
Build a cloud-based, multi-tenant SaaS platform for shops that manage
customer orders via an order/token system. Multi-tenant from Day 1, even
though the first real customer is a single shop.

## 2. Multi-tenant model
Each shop is a Tenant with its own users, employees, products, categories,
orders, order numbering sequence, inventory, recipes, counters, workflow,
packing rules, reports, analytics, and settings. Tenant data must never mix,
and isolation is enforced in the backend, not just hidden in the UI.

## 3. Super Admin
Platform owner. Creates/edits/activates/deactivates shops. Each shop gets a
permanent, immutable tenant identifier independent of its display name.

## 4. Shop Admin
Configures only their own shop: settings, branding, products, categories,
pricing, employees, roles/permissions, counters, and order workflow.

## 5. Order workflow (configurable per tenant)
- **Direct**: Counter → Customer
- **Coordinator**: Counter → Coordinator → Ready → Customer
- **Kitchen**: Counter → Kitchen → Ready → Customer

## 6. Kitchen is optional
Kitchen, Coordinator, Kitchen Display, Customer TV, Printer, and
Notifications are all independently toggleable modules per tenant.

## 7–8. Orders and order numbering
Orders carry number, tenant, employee, date/time, type, items, quantities,
pricing, packing charge, discount, total, and status. Each tenant has its
own continuously increasing order-number sequence with **no daily reset**
and **no reuse of numbers** (gaps are acceptable).

## 9. Customer display number
Derived from the last 3 digits of the real order number, printed in full on
the receipt. `000` is never shown — it wraps to `001` while the underlying
order number continues incrementing normally. The approved deterministic
formula is `((order_number - 1) % 999) + 1`.

Worked example at a large order number (verified against the approved
formula, not an illustrative guess):

```text
999      → 999
1000     → 001
1001     → 002
1000999  → 001
1001000  → 002
1001001  → 003
```

## 10–11. Receipt and employee attribution
Receipt shows shop name, full order number, display number, date/time,
served-by employee and username, line items, packing charge, discount, and
total. Every order records which employee/user created and handled it.

## 12. Packing / parcel charges
A separate line item, never folded into product price. Configurable as: no
charge, flat per order, per item, item-specific, or order-type-specific.

## 13. Order types
Configurable per tenant: Dine-in, Takeaway, Pickup, Delivery,
Advance/Scheduled — enable only what a given shop uses.

## 14. Advance / future orders
Scheduled orders with a distinct order date vs. pickup date/time, visible
separately to the admin.

## 15. Order status
Configurable pipeline, e.g. Created → Waiting → Preparing → Ready →
Collected, plus optional Cancelled / Skipped / No-show / Recalled.

## 16–18. Displays
Customer TV shows "now serving" and updates in real time with no manual
refresh. Coordinator display lists active orders with status controls.
Kitchen display shows new/preparing/ready orders with item breakdown.

## 19–20. Inventory and recipes
Per-tenant ingredient stock (current stock, units, minimum stock,
adjustments). Products can have recipes; ingredient usage can later be
calculated from completed orders. Treated as a separate module.

## 21–23. Analytics, search, calendar
Today/historical/period dashboards (orders, revenue, cancellations,
completion rate, best sellers, prep time). Order search by number, and
extensible to date/employee/status/type. Calendar view for day-by-day
comparison.

## 24. Database architecture (conceptual entities)
Tenants, Users, Roles, Permissions, Branches (future-ready), Counters,
Products, Categories, Ingredients, Recipes, Inventory, Orders, OrderItems,
OrderStatuses, OrderCharges, Payments, Displays, Printers, Workflows,
Reports, Settings. Every tenant-owned record must be associated with the
correct tenant, enforced by the backend.

## 25–26. Cloud and real-time
Cloud-first: Web app → Node.js API → PostgreSQL (permanent) + Redis
(real-time/temporary). Real-time updates (Counter → Kitchen → Coordinator →
TV) via WebSockets, no manual refresh required.

## 27–28. Internet and offline fallback
Limited offline fallback: temporary local storage while internet is down,
synchronized to PostgreSQL once it returns. Local storage is never the
system of record. **Finalized design (see `OFFLINE_SYNC_DESIGN.md` for
full detail):** an authorized counter device pre-reserves a contiguous
block of real, final order numbers from the tenant's sequence while
online, and consumes them offline — order numbers are never invented
locally and never renumbered at sync. Numbers are never reused, gaps are
acceptable (both from unused reserved numbers and from rolled-back
allocations), and the allocation/sync mechanism is documented in detail
rather than improvised.

## 29–30. Printer and power failure
Order is saved and confirmed before printing; a failed print never loses
the order and offers reprint. Cloud data is unaffected by shop-side power
loss; local UPS can keep counter/printer/TV running briefly.

## 31–32. Security
HTTPS, secure auth, password hashing, RBAC, tenant isolation, input
validation, SQLi/XSS/CSRF protection, rate limiting, secure session/token
handling, secrets out of source, DB access controls, encryption, audit
logs, monitoring, dependency hygiene. No claim of being unhackable. Super
Admin gets extra scrutiny: strong auth, MFA (future), session management,
login monitoring, audit logs, restricted sensitive operations.

## 33–34. Out of scope for V1
GST/e-invoicing, WhatsApp/SMS integration, loyalty, AI forecasting,
advanced accounting, delivery tracking, complex offline architecture,
large-scale infra, multi-branch as a full feature. Architecture stays
future-ready; implementation targets only current requirements. Billing is
structured so GST can be added later without an order-system rewrite.

## 35. Technology stack
Frontend: React/Next.js. Backend: Node.js + TypeScript (NestJS
recommended). Database: PostgreSQL. Real-time: WebSockets. Cache/queue:
Redis. Deployment: Cloud/AWS. Containers: Docker.

## 36. Recommended code structure
Modular boundaries: auth, tenants, users, roles, products, categories,
orders, order-items, tokens, inventory, recipes, payments, packing,
workflows, displays, printers, reports, analytics, realtime.

## 37. Development rules
1. Never hard-code a shop's name/products/type in logic — use tenant
   configuration.
2. Never mix tenant data — every tenant-aware operation verifies tenant
   ownership.
3. No per-shop code forks — core functionality + tenant configuration.
4. Keep business rules modular, not scattered.
5. Don't change architecture without documenting the change.
6. Critical features require tests: auth, tenant isolation, order
   creation/numbering, offline sync, receipt generation, permissions.

## 38. Critical test cases (from blueprint)
Tenant isolation, order-number wraparound (999→001), day-to-day
continuity, printer failure + reprint, offline creation + sync,
cancellation without reuse of the number.

## 39. Development phases (blueprint-level)
1. Foundation (auth, tenant architecture, Super Admin)
2. Shop management (tenant creation, Shop Admin, employees, permissions)
3. Products & orders (categories, products, order creation/number/status)
4. Token/display (customer display number, coordinator, TV, WebSockets)
5. Printing (thermal receipt, reprint, printer config)
6. Packing & billing (packing charges, discounts, order types, totals)
7. Inventory (ingredients, stock, recipes, movements)
8. Reports (daily/calendar/weekly/monthly/custom, search, analytics)
9. Offline fallback (local storage, offline creation, numbering, sync,
   conflict handling)
10. Production hardening (security, tenant-isolation testing, backup,
    monitoring, error handling, performance, deployment)

## 40. Core business flow
Super Admin creates a Shop → Shop Admin configures it → Employee creates an
Order → Order Number assigned → Receipt printed (full number + display
number) → Order moves through the configured workflow (Direct /
Coordinator / Kitchen) → Ready → shown on Customer TV → Collected →
captured in Reports.

## Final definition
A cloud-based multi-tenant SaaS platform where independent shops run their
own order/token business on one shared application, with isolated data and
configuration, per-tenant order sequences, configurable workflow, optional
kitchen/coordinator/display/printer modules, packing charges, inventory,
and reporting. Cloud-first with a limited, carefully-designed offline
fallback.

**Governing principle:** build the platform once, configure it per tenant.
Never fork the codebase per shop.
