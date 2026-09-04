/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Allow shopapp_superadmin to manage tenant_resource_limits rows across all shops.
  // shopapp role remains strictly isolated by tenant_isolation_tenant_resource_limits.
  pgm.sql(`
    CREATE POLICY superadmin_tenant_resource_limits ON tenant_resource_limits
      FOR ALL TO shopapp_superadmin
      USING (true)
      WITH CHECK (true);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS superadmin_tenant_resource_limits ON tenant_resource_limits;`);
};
