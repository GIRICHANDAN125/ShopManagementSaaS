/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Bug found during implementation: create_tenant_order_sequence() runs
// `CREATE SEQUENCE`, which requires CREATE privilege on the schema.
// shopapp_superadmin was deliberately NOT granted schema-level CREATE
// (that would broaden its footprint well beyond "tenants + platform-level
// rows"). Rather than widening the superadmin role's grants, this
// function is made SECURITY DEFINER, owned by shopapp_migrator (which
// already has CREATE via its schema ownership) — so it executes with the
// definer's privilege regardless of which role calls it. This is safe
// specifically because the function's only actions are a scoped
// CREATE SEQUENCE and a GRANT USAGE on that one new sequence — it does
// not touch any RLS-protected table, so the SECURITY DEFINER pitfall
// found earlier (RLS evaluated against the wrong role) does not apply
// here.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION create_tenant_order_sequence(seq_name TEXT)
    RETURNS VOID AS $$
    BEGIN
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1 INCREMENT 1;', seq_name);
      EXECUTE format('GRANT USAGE ON SEQUENCE %I TO shopapp;', seq_name);
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER;
  `);
  // Only shopapp_superadmin (tenant provisioning) and shopapp_migrator
  // itself should ever call this — not the ordinary tenant-facing role,
  // which has no legitimate reason to create sequences at request time.
  pgm.sql(`REVOKE ALL ON FUNCTION create_tenant_order_sequence(TEXT) FROM PUBLIC;`);
  pgm.sql(`GRANT EXECUTE ON FUNCTION create_tenant_order_sequence(TEXT) TO shopapp_superadmin;`);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION create_tenant_order_sequence(seq_name TEXT)
    RETURNS VOID AS $$
    BEGIN
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1 INCREMENT 1;', seq_name);
      EXECUTE format('GRANT USAGE ON SEQUENCE %I TO shopapp;', seq_name);
    END;
    $$ LANGUAGE plpgsql;
  `);
};
