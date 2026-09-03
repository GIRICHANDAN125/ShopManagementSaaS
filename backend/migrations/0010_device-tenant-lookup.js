/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Device auth has a bootstrap problem: to verify a device's credential we
// need its tenant_id first, but devices.tenant_id lives behind RLS, and
// we don't have a tenant context yet (chicken-and-egg — the same class
// of problem tenants.id solves by simply not being RLS'd at all, since a
// tenant's existence/id is not itself sensitive).
//
// Solution: a tiny table containing ONLY device_id -> tenant_id, with NO
// RLS at all. This deliberately reveals nothing sensitive (not the
// credential hash, not the status, not any operational data) — knowing
// "device X belongs to tenant Y" is not exploitable without also having
// the correct credential, which IS verified afterward against the real,
// RLS-protected `devices` table inside that tenant's context. This
// avoids BYPASSRLS or SECURITY-DEFINER-around-RLS entirely, unlike an
// earlier draft of this migration.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE device_tenant_lookup (
      device_id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id)
    );
  `);
  pgm.sql(`GRANT SELECT, INSERT, DELETE ON device_tenant_lookup TO shopapp;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS device_tenant_lookup;`);
};
