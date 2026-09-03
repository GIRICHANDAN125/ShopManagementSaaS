/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Bug found during verification: SECURITY DEFINER made this function run
// as its owning role (the migrator), not the actual connecting role
// (shopapp_superadmin), so the insert it performs was evaluated against
// the migrator's RLS permissions — which don't include the
// superadmin_platform_audit_logs policy — and was rejected.
// shopapp_superadmin already has its own direct GRANT + policy allowing
// exactly this insert shape, so SECURITY DEFINER was unnecessary; the
// function should run as SECURITY INVOKER (the default) so it executes
// as whichever role actually called it.
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
    $$ LANGUAGE plpgsql SECURITY INVOKER;
  `);
};

exports.down = (pgm) => {
  // No-op: 0006's down() already removes the trigger/function entirely.
};
