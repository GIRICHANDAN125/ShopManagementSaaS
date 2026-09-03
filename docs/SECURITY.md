# SECURITY.md — Security Strategy (Version 1)

Status: **DESIGN ONLY.** This document defines the security posture to be
implemented and tested; it does not claim any guarantee of invulnerability.

> No system is 100% unhackable. The goal of this document is to reduce
> risk through layered, verifiable controls and to make failure modes
> detectable and recoverable rather than silent.

---

## 1. Authentication

- Passwords hashed with a modern, slow hash (argon2id or bcrypt with a
  suitable cost factor) — never reversible encryption, never plain text.
- Access tokens: short-lived JWTs (e.g. 15 minutes). Refresh tokens:
  longer-lived, stored server-side (or as a rotating, revocable token) so
  they can be invalidated on logout/compromise — a pure stateless refresh
  token with no revocation path is avoided deliberately.
- Login attempts are rate-limited and back off per account/IP (see §9) to
  resist brute force and credential stuffing.
- Super Admin authentication gets additional scrutiny: MFA is called out
  as a required future item (blueprint §32) — flagged as an **unresolved
  timing decision**: whether MFA ships in V1 or immediately after (see
  Unresolved Decisions in the final report).

## 2. Authorization

- Every endpoint declares required permission(s); a global guard denies
  by default (allow-list, not deny-list) — a new endpoint with no
  declared permission requirement should fail closed, not open.
- Authorization is evaluated **after** tenant context resolution, so a
  permission check can never be satisfied against the wrong tenant's data
  (see ARCHITECTURE.md §5).
- Resource ownership is re-verified at the data layer via RLS (§4 below),
  not only trusted from the permission check — this specifically closes
  IDOR/BOLA-class bugs where a user has the *type* of permission needed
  (e.g. `order.view`) but is requesting *someone else's* resource.

## 3. Tenant isolation

Three redundant layers (detailed in ARCHITECTURE.md §6 and DATABASE.md
§8):

1. Application-level tenant filtering on every query.
2. PostgreSQL Row-Level Security, `FORCE`d, with a non-superuser,
   non-`BYPASSRLS` application DB role.
3. Tenant-namespaced WebSocket rooms/Redis channels.

The explicit design assumption is that layer 1 **will** eventually have a
bug. Layers 2 and 3 exist so that a single mistake in application code is
not sufficient, by itself, to leak one tenant's data to another.

## 4. IDOR / BOLA (Insecure Direct Object Reference / Broken Object-Level
   Authorization)

- No endpoint trusts a client-supplied `tenant_id`. Ever. It is derived
  server-side from the authenticated token on every request, including
  WebSocket connections.
- Object lookups (`GET /orders/:id`) verify both "does this permission
  allow viewing orders" and "does this specific order belong to the
  caller's tenant" — the latter enforced redundantly by RLS even if the
  application query forgets the check.
- Sequential/guessable IDs are avoided for anything exposed externally —
  internal primary keys are UUIDs; the human-facing `order_number` is
  tenant-scoped and meaningless outside that tenant's own RLS-protected
  query path.

## 5. Injection (SQL injection, and adjacent)

- All database access goes through a query builder/ORM with parameterized
  queries (NestJS + TypeORM/Prisma or equivalent) — no string-concatenated
  SQL, anywhere, including "just this one report query."
- Any raw SQL (e.g. the order-numbering `UPDATE ... RETURNING`) uses bound
  parameters exclusively and is reviewed as security-sensitive code.

## 6. XSS (Cross-Site Scripting)

- React's default JSX escaping is relied upon; `dangerouslySetInnerHTML`
  (or equivalent) is disallowed by default and requires explicit review
  if ever used (e.g. for rich receipt templates in a later version).
- API responses set `Content-Type` correctly; the frontend does not
  `eval` or otherwise execute server-provided strings as code.
- Content-Security-Policy header set at the edge (see §11).

## 7. CSRF

- Primary API consumption is via bearer tokens over `Authorization`
  headers (not ambient cookies), which structurally avoids classic CSRF
  for the API itself.
- If any cookie-based session is introduced (e.g. for the Next.js
  frontend's own session), `SameSite=Strict` (or `Lax` where a top-level
  navigation flow requires it) plus a CSRF token for state-changing
  requests is required.

## 8. CORS

- API allows only explicitly configured origins (the deployed frontend
  domain(s)), not `*`, especially given bearer tokens/cookies are in play.
- Preflight and credentialed requests are configured deliberately, not
  left at framework defaults.

## 9. Rate limiting & brute-force protection

- Login endpoint: per-account and per-IP rate limiting with exponential
  backoff after repeated failures; failed attempts are logged (without
  logging the attempted password).
- General API: a baseline rate limit per authenticated user/tenant to
  contain abuse or a runaway client, separate from the login-specific
  protection.
- Order-creation endpoint specifically is expected to receive legitimate
  rapid retries (idempotency key reuse) — rate limiting here must key on
  the idempotency mechanism's correctness, not simply throttle order
  creation to a point that breaks retry behavior during printer/network
  hiccups.
- Device reservation and sync endpoints are rate-limited per device
  credential, separate from per-user limits — a compromised or
  malfunctioning device requesting reservations in a tight loop should be
  contained without needing to throttle legitimate employee traffic on
  the same tenant.

## 10. Secrets management

- No secrets (DB credentials, JWT signing keys, Redis auth, third-party
  API keys) in source control. Environment-injected via the deployment
  platform's secrets manager (see DEPLOYMENT.md).
- JWT signing key rotation is a documented capability, not necessarily
  implemented on day one — flagged as an item to confirm before
  production hardening (Phase 10).

## 11. Security headers

- `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `Strict-Transport-Security`, `X-Frame-Options` (or CSP `frame-ancestors`)
  applied at the API/edge layer.

## 12. WebSocket authorization

- WebSocket handshake requires the same access token used for REST;
  unauthenticated upgrade requests are rejected.
- Tenant/room join happens server-side based on the verified token's
  `tenant_id`, never a room name requested by the client.
- Token expiry is enforced on long-lived socket connections (a socket
  opened with a token that later expires is disconnected/forced to
  re-authenticate, not left open indefinitely).

## 13. Input validation

- All request payloads validated against explicit schemas (e.g.
  class-validator/DTOs in NestJS, or Zod) at the API boundary before any
  business logic runs — rejecting unexpected fields rather than silently
  ignoring them.
- Numeric fields relevant to money (`price`, `total`, `packing_charge`,
  `discount`) are validated server-side and **recomputed** server-side
  (per blueprint: backend is authoritative for totals) — a client-supplied
  total is never trusted, only used as a display convenience/consistency
  check.

## 14. Database access controls

- Application DB role: least privilege — CRUD on application tables only,
  no `SUPERUSER`, no `BYPASSRLS`, no DDL rights at runtime.
- Migration/admin DB role: separate credentials, used only for deploys,
  not embedded in the running application.

## 15. Logging & monitoring

- Structured logs with correlation/request IDs, tied to `audit_logs`
  entries via the same correlation ID where applicable.
- Logs explicitly exclude: passwords, password hashes, full tokens,
  full payment details, and any RLS session-variable values beyond the
  tenant ID itself.
- Monitoring/alerting on: authentication failure spikes, RLS policy
  violations (if the DB surfaces them), 5xx rate, WebSocket disconnect
  storms, and order-numbering anomalies (e.g. unexpected gaps size,
  duplicate-key rejections at a high rate, which could indicate a client
  bug or an attack).

## 16. Audit logging

- Schema in DATABASE.md §9. Captures actor, tenant, action, entity,
  timestamp, correlation ID, and redacted metadata.
- Applies to Super Admin actions (shop create/activate/deactivate), Shop
  Admin actions (settings changes, employee management, packing/workflow
  configuration changes), and sensitive employee actions (order
  cancellation, reprint).

## 17. Backup & recovery

- PostgreSQL: automated daily backups plus point-in-time recovery (PITR)
  via WAL archiving, provided by the managed database service (see
  DEPLOYMENT.md).
- Backup restore is periodically tested (not just configured) — a backup
  that has never been restored is unverified. Concrete cadence to be
  decided in Phase 10 (production hardening).
- Redis, when introduced, holds no data that is not reconstructable/
  transient (pub/sub, ephemeral cache) — it is explicitly not a backup
  target because it is explicitly not a source of truth.

## 18. Security testing (pointer)

Full test list in TESTING.md. At minimum before production: automated
tests for tenant isolation, IDOR/BOLA, auth/authz, injection, and a
periodic dependency vulnerability scan (`npm audit` or equivalent) wired
into CI.

## 19. Device identity & credentials (new)

Offline order-number reservation (OFFLINE_SYNC_DESIGN.md) requires a
device to be an independently authenticated actor, not merely something
an employee happens to be logged into.

- **Credential type:** a device-bound credential distinct from any
  employee's password — e.g. a long-lived, per-device secret or client
  certificate provisioned at registration time, stored on the device in
  as tamper-resistant a location as the platform reasonably provides
  (exact mechanism — client cert vs. bound secret token — is an
  implementation decision to finalize before Phase 9, not decided here).
- **Never a shared secret across devices:** each device gets its own
  distinct credential; a leaked credential compromises exactly one
  device's reservation capability, not the tenant's entire fleet.
- **Registration:** requires the `device.manage` permission (Shop Admin
  level) — a device cannot self-register.
- **Revocation:** immediate and independent of employee account status —
  revoking a device does not require touching any employee's account, and
  vice versa. A revoked device's credential must be rejected on its very
  next request (reservation or sync), not merely prevented from *future*
  registration.
- **Compromise handling:** treated with the same urgency as a leaked API
  key — immediate revocation, and any reservation the device held is
  force-closed with unused numbers permanently retired (DATABASE.md §6),
  never reissued to another device.
- **Audit:** device registration, revocation, and reservation grants are
  all audit-logged (DATABASE.md §9), attributed to the acting Shop Admin
  and, for reservation grants, to the device itself.
- **Scope of device credential authority:** a device credential authorizes
  *holding a reservation and syncing orders created under it* — it is
  deliberately **not** a substitute for employee authentication, and does
  not itself grant permission to view reports, manage products, or
  perform any action outside the offline-order-creation/sync path. This
  keeps the blast radius of a compromised device credential bounded.

## 20. Explicit non-claims

- This system is not claimed to be immune to all attacks.
- Security is treated as a continuous process (dependency updates,
  periodic review of RLS policies as new tables are added, periodic
  re-test of tenant isolation as features are added) rather than a
  one-time checklist completed before launch.
