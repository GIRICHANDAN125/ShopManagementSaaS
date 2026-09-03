/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Design: Super Admin never uses BYPASSRLS and the ordinary application
// role (`shopapp`) is never granted platform-level access. Instead, a
// SEPARATE, distinctly-credentialed role (`shopapp_superadmin`) exists.
// It is:
//   - NOSUPERUSER, NOBYPASSRLS (same hard constraint as `shopapp`)
//   - granted table-level access to ONLY `tenants` (never had per-tenant
//     RLS — it's the root registry, not tenant-owned) and the
//     platform-level rows of `users` and `audit_logs` (tenant_id IS NULL)
//   - granted NO access at all to any shop-operational table (orders,
//     products, inventory, etc.) — Super Admin's application role cannot
//     read shop-level data even if a bug tried to make it, because there
//     is no GRANT for it to do so, independent of RLS.
// This role's credentials are held only by a dedicated Super Admin
// connection pool in the application, never exposed to, derived from, or
// settable by an ordinary tenant user's request — an ordinary user's
// session never touches this role's credentials at all, so there is no
// session variable or client input that could "activate" it.
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp_superadmin') THEN
        CREATE ROLE shopapp_superadmin WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END
    $$;
  `);

  // Full read/write on the tenant registry itself — this table was never
  // tenant-owned and has no RLS, so this is Super Admin's core, approved
  // capability (create/activate/deactivate shops).
  pgm.sql(`GRANT USAGE ON SCHEMA public TO shopapp_superadmin;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON tenants TO shopapp_superadmin;`);

  // Platform-level rows only, on the two tables that legitimately have
  // NULL-tenant rows. Table-level GRANT is necessary but not sufficient —
  // the policies below are what actually restrict this to tenant_id IS NULL.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON users TO shopapp_superadmin;`);
  pgm.sql(`GRANT SELECT, INSERT ON audit_logs TO shopapp_superadmin;`);

  // Second PERMISSIVE policy, scoped explicitly `TO shopapp_superadmin`.
  // Postgres OR's multiple permissive policies together for the same
  // role/command, so this ADDS a narrow allowance on top of (not instead
  // of) the existing tenant_isolation policy — it never weakens isolation
  // for the `shopapp` role, which this policy does not apply to at all.
  pgm.sql(`
    CREATE POLICY superadmin_platform_users ON users
      FOR ALL TO shopapp_superadmin
      USING (tenant_id IS NULL)
      WITH CHECK (tenant_id IS NULL);
  `);

  pgm.sql(`
    CREATE POLICY superadmin_platform_audit_logs ON audit_logs
      FOR ALL TO shopapp_superadmin
      USING (tenant_id IS NULL)
      WITH CHECK (tenant_id IS NULL);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS superadmin_platform_audit_logs ON audit_logs;`);
  pgm.sql(`DROP POLICY IF EXISTS superadmin_platform_users ON users;`);
  pgm.sql(`REVOKE ALL ON audit_logs FROM shopapp_superadmin;`);
  pgm.sql(`REVOKE ALL ON users FROM shopapp_superadmin;`);
  pgm.sql(`REVOKE ALL ON tenants FROM shopapp_superadmin;`);
};
