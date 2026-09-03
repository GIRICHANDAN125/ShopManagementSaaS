/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Every tenant-owned table gets: ENABLE + FORCE row level security, and a
// policy that only allows rows whose tenant_id matches the session-local
// setting `app.current_tenant_id`. FORCE matters: it also restricts the
// table owner, which closes the common RLS-bypass footgun where a
// migration/admin connection silently skips policies (DATABASE.md §8).
const TENANT_OWNED_TABLES = [
  'users',
  'roles',
  'counters',
  'categories',
  'products',
  'devices',
  'device_order_reservations',
  'orders',
  'order_items',
  'order_status_history',
  'audit_logs',
  'tenant_settings',
];

exports.up = (pgm) => {
  for (const table of TENANT_OWNED_TABLES) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`
      CREATE POLICY tenant_isolation_${table} ON ${table}
        USING (
          tenant_id IS NOT NULL
          AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        )
        WITH CHECK (
          tenant_id IS NOT NULL
          AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        );
    `);
  }

  // Dedicated, narrowly-scoped roles per SECURITY.md §14 / DATABASE.md §7-8.
  // Passwords are set separately via ALTER ROLE in deployment/dev setup,
  // not embedded here. These statements are safe to re-run (IF NOT EXISTS
  // isn't supported for CREATE ROLE pre-PG16 cleanly, so we guard manually).
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp') THEN
        CREATE ROLE shopapp WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END
    $$;
  `);
  pgm.sql(`GRANT USAGE ON SCHEMA public TO shopapp;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shopapp;`);
  pgm.sql(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO shopapp;`);
  pgm.sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shopapp;`);
  pgm.sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO shopapp;`);
};

exports.down = (pgm) => {
  for (const table of TENANT_OWNED_TABLES) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation_${table} ON ${table};`);
    pgm.sql(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
  }
};
