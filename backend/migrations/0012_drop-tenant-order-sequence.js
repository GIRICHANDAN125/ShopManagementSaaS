/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

// Compensating cleanup: when tenant provisioning fails midway (after sequence
// creation but before full tenant setup completes), the sequence created
// for that tenant must be safely dropped to avoid leaving orphaned sequence
// objects in the database.
//
// Like create_tenant_order_sequence(), this is made SECURITY DEFINER owned by
// shopapp_migrator (schema owner) with strict parameter validation and a fixed
// search_path, granted only to shopapp_superadmin.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION drop_tenant_order_sequence(seq_name TEXT)
    RETURNS VOID AS $$
    BEGIN
      -- 1. Strict validation of format: must match application's expected order_seq_<tenant_code> format
      IF seq_name IS NULL OR seq_name !~ '^order_seq_[a-z0-9_]{1,53}$' THEN
        RAISE EXCEPTION 'Invalid tenant order sequence name: %. Expected order_seq_<tenant_code> format.', seq_name
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      -- 2. Verify the target object is strictly a sequence in the public schema if it exists
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind != 'S'
          AND c.relname = seq_name
      ) THEN
        RAISE EXCEPTION 'Object % is not a sequence', seq_name
          USING ERRCODE = 'wrong_object_type';
      END IF;

      -- 3. Invariant: An order sequence can ONLY be dropped if it is orphaned.
      -- If the sequence is actively bound to a record in tenants, deletion is strictly forbidden.
      IF EXISTS (
        SELECT 1 FROM public.tenants WHERE order_sequence_name = seq_name
      ) THEN
        RAISE EXCEPTION 'Cannot drop sequence %: sequence is currently assigned to an active tenant.', seq_name
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;

      -- 4. Safely drop the sequence in public schema using quote_ident
      EXECUTE format('DROP SEQUENCE IF EXISTS public.%I;', seq_name);
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp;
  `);

  pgm.sql(`REVOKE ALL ON FUNCTION drop_tenant_order_sequence(TEXT) FROM PUBLIC;`);
  pgm.sql(`GRANT EXECUTE ON FUNCTION drop_tenant_order_sequence(TEXT) TO shopapp_superadmin;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS drop_tenant_order_sequence(TEXT);`);
};
