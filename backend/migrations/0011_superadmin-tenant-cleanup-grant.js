/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Super Admin creates tenants via shopapp_superadmin. If subsequent steps
// (sequence provisioning, initial Shop Admin provisioning, or default role setup)
// fail, the system needs the ability to roll back the tenant insertion
// transactionally or via compensating delete, ensuring no half-provisioned
// orphaned tenants are left in the database.
exports.up = (pgm) => {
  pgm.sql(`GRANT DELETE ON tenants TO shopapp_superadmin;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE DELETE ON tenants FROM shopapp_superadmin;`);
};
