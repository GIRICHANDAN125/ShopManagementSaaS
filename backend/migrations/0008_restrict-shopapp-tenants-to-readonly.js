/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Bug found during verification: migration 0002's blanket
// "GRANT ... ON ALL TABLES IN SCHEMA public TO shopapp" (issued before
// the Super Admin split existed) left the ordinary tenant-facing runtime
// role able to INSERT/UPDATE/DELETE tenants directly. That's broader than
// it needs to be — ordinary tenant-scoped requests only ever need to READ
// their own tenant's metadata (branding, timezone); writing the tenant
// registry (create/activate/deactivate) is exclusively a Super Admin
// operation and should only be reachable through shopapp_superadmin.
exports.up = (pgm) => {
  pgm.sql(`REVOKE INSERT, UPDATE, DELETE ON tenants FROM shopapp;`);
  // SELECT is retained — the application still needs to read a tenant's
  // own row (e.g. resolving a shop code to a tenant_id at login, reading
  // branding/timezone). This table has no RLS (it never was tenant-owned)
  // so read access alone does not weaken isolation; ordinary application
  // code additionally still only ever fetches by the tenant_id/code
  // relevant to the current request, at the query level.
};

exports.down = (pgm) => {
  pgm.sql(`GRANT INSERT, UPDATE, DELETE ON tenants TO shopapp;`);
};
