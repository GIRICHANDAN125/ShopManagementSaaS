/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Application-layer audit logging is still expected (richer metadata,
// correlation IDs, etc.) — but the *fact* that a Super Admin action on
// the tenant registry gets an audit row is additionally guaranteed at the
// database level via trigger, so it cannot be silently skipped by an
// application bug. The trigger fires only when the writing role is
// literally `shopapp_superadmin` (checked via session_user, which cannot
// be spoofed by a connection authenticated as a different role).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_super_admin_tenant_write()
    RETURNS TRIGGER AS $$
    BEGIN
      IF session_user = 'shopapp_superadmin' THEN
        INSERT INTO audit_logs (tenant_id, action, entity_type, entity_id, metadata)
        VALUES (
          NULL,
          TG_OP || '.tenant',
          'tenant',
          NEW.id,
          jsonb_build_object('code', NEW.code, 'status', NEW.status)
        );
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER;
  `);

  // SECURITY DEFINER so the function can insert into audit_logs even
  // though shopapp_superadmin has no direct policy allowing tenant_id
  // NULL writes triggered indirectly like this to differ from its own
  // direct-insert policy — in this case it's the same NULL-tenant shape
  // it's already allowed to write, so this is a convenience, not a
  // privilege escalation: the function only ever inserts the fixed shape
  // above, never arbitrary caller-supplied rows.
  pgm.sql(`
    CREATE TRIGGER trg_audit_super_admin_tenant_write
    AFTER INSERT OR UPDATE ON tenants
    FOR EACH ROW
    EXECUTE FUNCTION audit_super_admin_tenant_write();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_audit_super_admin_tenant_write ON tenants;`);
  pgm.sql(`DROP FUNCTION IF EXISTS audit_super_admin_tenant_write();`);
};
