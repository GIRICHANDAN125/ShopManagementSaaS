# DEPLOYMENT.md — Deployment & Operations Strategy (Version 1)

Status: **DESIGN ONLY.** No infrastructure has been provisioned yet.

---

## 1. Deployment model (V1)

- **Frontend:** Next.js app, containerized (Docker), deployed behind a
  CDN/edge for static assets.
- **Backend:** Node.js/NestJS API, containerized (Docker), deployed as a
  **single instance** for Version 1 (per blueprint §34 — don't overbuild).
  Architecture (ARCHITECTURE.md §9) already accounts for scaling to
  multiple instances later without a redesign.
- **Database:** managed PostgreSQL (e.g. RDS/Aurora on AWS, per blueprint
  stack choice) with automated backups and PITR enabled from day one —
  this is not deferred, since it's cheap to enable up front and expensive
  to have skipped if ever needed.
- **Redis:** not provisioned for V1 unless/until a second API instance is
  introduced (see ARCHITECTURE.md §9). Documented as a near-term addition,
  not built speculatively.
- **Cloud provider:** AWS, per blueprint's technology stack decision.

## 2. Environments

- At minimum: `development` (local, Docker Compose), `staging`
  (production-like, used for pre-release verification including RLS and
  tenant-isolation test runs), `production`.
- Each environment has its own PostgreSQL instance and its own secrets —
  no environment shares credentials with another, including staging
  reusing production database credentials for "convenience."

## 3. Configuration & secrets

- Environment variables injected via the cloud provider's secrets manager
  (e.g. AWS Secrets Manager / Parameter Store), not committed to source
  control, not baked into container images.
- Required secrets at minimum: PostgreSQL connection string, JWT signing
  key(s), Redis connection string (once introduced).
- **Device credentials (new):** per-device credentials issued at
  registration (SECURITY.md §19) are generated server-side and delivered
  to the counter device once, at provisioning time. The server-side
  credential material required by the approved device credential
  mechanism — whichever of client certificate vs. bound secret token is
  chosen per SECURITY.md §19 before Phase 9 — is itself a secret, managed
  the same way as other platform secrets, and is never reused as the JWT
  signing key (separate key material for separate credential types, so
  rotating one does not require rotating the other). This document does
  not choose between the two mechanisms; that decision remains open per
  SECURITY.md §19.

## 4. Migrations

- Schema migrations are versioned and applied via a dedicated migration
  step in the deploy pipeline, using a distinct DB role from the
  application's runtime role (DATABASE.md §8, SECURITY.md §14).
- **No production migrations exist yet** — this document only establishes
  that migrations will be reviewed against DATABASE.md before being
  written, per the explicit instruction not to create them at this stage.
- RLS policy creation/alteration is treated as a reviewed, security-
  sensitive migration category, not a routine schema change.
- **Per-tenant sequence provisioning (new):** each tenant requires its own
  dedicated PostgreSQL sequence (DATABASE.md §5.2), created at
  tenant-creation time via a server-side, parameterized DDL call (never
  client-supplied identifiers — see DATABASE.md §5.2 for the injection
  concern this addresses). This is an application-triggered operation at
  tenant onboarding, not a one-time migration, and must run under a role
  with `CREATE` privilege scoped narrowly enough that it cannot be used
  for arbitrary DDL beyond sequence creation for this purpose.

## 5. CI/CD

- Pull requests run: lint, unit tests, integration tests against a real
  ephemeral PostgreSQL (with RLS enabled — see TESTING.md §18), and a
  dependency vulnerability scan.
- Merge to main triggers a staging deploy; production deploy is a
  separate, explicit promotion step (not automatic on every merge),
  consistent with "do not deploy anything" at this design stage and, once
  implementation begins, with keeping production changes deliberate.

## 6. Monitoring & alerting

- Application logs and metrics shipped to a centralized location (exact
  tool — e.g. CloudWatch, or a hosted APM — to be selected during Phase
  10, not decided speculatively here).
- Alerting thresholds per SECURITY.md §15 (auth failure spikes, 5xx rate,
  WebSocket disconnect storms, order-numbering anomalies).

## 7. Backup & disaster recovery

- Automated PostgreSQL backups + PITR (SECURITY.md §17).
- Documented, periodically tested restore procedure — "backup exists" is
  not treated as equivalent to "recovery works."
- Recovery time/point objectives (RTO/RPO) to be explicitly agreed before
  Phase 10 rather than left implicit.

## 8. Scaling path (future, documented not built)

1. Single API instance + single Postgres (V1 — current target).
2. Multiple API instances behind a load balancer + Redis pub/sub
   backplane for WebSockets (ARCHITECTURE.md §9) — triggered by actual
   load, not built preemptively.
3. Read replicas for PostgreSQL if reporting/analytics load grows enough
   to contend with transactional order traffic.
4. Revisit shared-schema-with-RLS vs. schema-per-tenant only if tenant
   count or per-tenant data volume grows to a point where RLS overhead or
   noisy-neighbor effects become measurable — not a default assumption,
   since it would be a significant migration.

## 9. Explicit non-goals for V1 deployment

No multi-region deployment, no database-per-tenant provisioning, no
autoscaling configuration beyond what the cloud provider does by default
for a single instance, no blue/green or canary deployment tooling (a
straightforward staged rollout is sufficient at this scale).
