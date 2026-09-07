/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

/**
 * Migration 0017: Shop Lifecycle Management & Password Security Features
 *
 * 1. Add must_change_password flag on users table:
 *    - Defaults to false for existing users.
 *    - Allows Super Admin provisioning to mark temporary passwords.
 *    - Enables forced first-login password change before operational access.
 *
 * 2. Atomic tenant permanent deletion function (delete_tenant_cascade):
 *    - Strictly parameterized by exact tenant UUID.
 *    - Atomic transaction deletes child operational rows strictly scoped
 *      WHERE tenant_id = target_tenant_id, preserving global/shared platform
 *      audit logs (where tenant_id IS NULL) and leaving other tenants untouched.
 *    - Safely drops the tenant-specific sequence.
 *    - Security Definer owned by migrator, restricted solely to shopapp_superadmin.
 */
exports.up = (pgm) => {
  // 1. Add must_change_password column to users
  pgm.sql(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
  `);

  // 2. Create atomic tenant deletion function
  pgm.sql(`
    CREATE OR REPLACE FUNCTION delete_tenant_cascade(target_tenant_id UUID)
    RETURNS VOID AS $$
    DECLARE
      v_seq_name TEXT;
    BEGIN
      -- Validate target_tenant_id is not null
      IF target_tenant_id IS NULL THEN
        RAISE EXCEPTION 'target_tenant_id cannot be null'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      -- Verify target tenant exists and lock the row
      SELECT order_sequence_name INTO v_seq_name
      FROM public.tenants
      WHERE id = target_tenant_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Tenant % not found', target_tenant_id
          USING ERRCODE = 'no_data_found';
      END IF;

      -- Set session local app.current_tenant_id so that FORCE RLS policies
      -- allow deletion of target tenant records while strictly isolating other tenants
      PERFORM set_config('app.current_tenant_id', target_tenant_id::text, true);

      -- Delete tenant-scoped operational child records in proper FK dependency order.
      -- Every deletion is strictly scoped to target_tenant_id.
      DELETE FROM public.order_items WHERE tenant_id = target_tenant_id;
      DELETE FROM public.order_status_history WHERE tenant_id = target_tenant_id;
      DELETE FROM public.orders WHERE tenant_id = target_tenant_id;

      DELETE FROM public.products WHERE tenant_id = target_tenant_id;
      DELETE FROM public.categories WHERE tenant_id = target_tenant_id;

      DELETE FROM public.printers WHERE tenant_id = target_tenant_id;

      DELETE FROM public.device_order_reservations WHERE tenant_id = target_tenant_id;
      DELETE FROM public.device_tenant_lookup WHERE tenant_id = target_tenant_id;
      DELETE FROM public.devices WHERE tenant_id = target_tenant_id;

      DELETE FROM public.counters WHERE tenant_id = target_tenant_id;

      DELETE FROM public.tenant_settings WHERE tenant_id = target_tenant_id;

      -- Delete tenant-scoped audit logs ONLY (tenant_id = target_tenant_id)
      -- before deleting users, because audit_logs.actor_user_id references users(id).
      -- Platform audit logs (tenant_id IS NULL) are NEVER touched!
      DELETE FROM public.audit_logs WHERE tenant_id = target_tenant_id;

      DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM public.users WHERE tenant_id = target_tenant_id);
      DELETE FROM public.users WHERE tenant_id = target_tenant_id;

      DELETE FROM public.role_permissions WHERE role_id IN (SELECT id FROM public.roles WHERE tenant_id = target_tenant_id);
      DELETE FROM public.roles WHERE tenant_id = target_tenant_id;

      DELETE FROM public.tenant_resource_limits WHERE tenant_id = target_tenant_id;

      -- Clear session local app.current_tenant_id
      PERFORM set_config('app.current_tenant_id', '', true);

      -- Delete root tenant record
      DELETE FROM public.tenants WHERE id = target_tenant_id;

      -- Safely drop tenant order sequence if valid format
      IF v_seq_name IS NOT NULL AND v_seq_name ~ '^order_seq_[a-z0-9_]{1,53}$' THEN
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I;', v_seq_name);
      END IF;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp;
  `);

  pgm.sql(`REVOKE ALL ON FUNCTION delete_tenant_cascade(UUID) FROM PUBLIC;`);
  pgm.sql(`GRANT EXECUTE ON FUNCTION delete_tenant_cascade(UUID) TO shopapp_superadmin;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS delete_tenant_cascade(UUID);`);
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS must_change_password;`);
};
