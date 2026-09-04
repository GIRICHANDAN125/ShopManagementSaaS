/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

/**
 * Grant shopapp_superadmin SELECT-only on counters and devices so that
 * updateTenantLimits can safely count active resources across all tenants
 * before allowing a limit decrease (Requirement 18 — Safe Limit Decrease).
 *
 * Security rationale:
 * - shopapp_superadmin is NOT granted INSERT/UPDATE/DELETE on these tables.
 * - This role is already used only for platform management (not runtime ops).
 * - The runtime shopapp role continues to be strictly isolated by RLS.
 * - No RLS bypass is added; these SELECT grants allow reads regardless of RLS
 *   only when called from the Super Admin path (withSuperAdmin context).
 */
exports.up = (pgm) => {
  pgm.sql(`GRANT SELECT ON counters TO shopapp_superadmin;`);
  pgm.sql(`GRANT SELECT ON devices TO shopapp_superadmin;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE SELECT ON counters FROM shopapp_superadmin;`);
  pgm.sql(`REVOKE SELECT ON devices FROM shopapp_superadmin;`);
};
