/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Creates a tenant's dedicated order-number sequence. The identifier is
  // built with format(%I) — never string concatenation — so this is safe
  // even though the sequence name is dynamic (DATABASE.md §5.2 explicitly
  // calls out this injection concern).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION create_tenant_order_sequence(seq_name TEXT)
    RETURNS VOID AS $$
    BEGIN
      EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1 INCREMENT 1;', seq_name);
      -- Runtime role only needs USAGE (nextval), never ownership/DDL rights
      -- over sequences at request time.
      EXECUTE format('GRANT USAGE ON SEQUENCE %I TO shopapp;', seq_name);
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Allocates exactly one real order number for online order creation.
  // nextval() is non-transactional: if the caller's transaction later
  // rolls back, this value is still permanently retired (DATABASE.md §5.2).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION allocate_next_order_number(seq_name TEXT)
    RETURNS BIGINT AS $$
    DECLARE
      result BIGINT;
    BEGIN
      EXECUTE format('SELECT nextval(%L)', seq_name) INTO result;
      RETURN result;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Reserves a contiguous block of `block_size` real order numbers for a
  // device. Takes a transaction-scoped advisory lock keyed on the tenant
  // so concurrent reservation requests for the SAME tenant serialize
  // against each other (and only each other — ordinary online order
  // creation via allocate_next_order_number() never takes this lock and
  // is not slowed by it). See DATABASE.md §5.3.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION reserve_order_range(
      p_tenant_id UUID,
      seq_name TEXT,
      block_size INT
    )
    RETURNS TABLE(range_start BIGINT, range_end BIGINT) AS $$
    DECLARE
      first_val BIGINT;
      last_val BIGINT;
      i INT;
      v BIGINT;
    BEGIN
      IF block_size < 1 THEN
        RAISE EXCEPTION 'block_size must be >= 1';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtext(p_tenant_id::text));

      FOR i IN 1..block_size LOOP
        EXECUTE format('SELECT nextval(%L)', seq_name) INTO v;
        IF i = 1 THEN
          first_val := v;
        END IF;
        last_val := v;
      END LOOP;

      RETURN QUERY SELECT first_val, last_val;
    END;
    $$ LANGUAGE plpgsql;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS reserve_order_range(UUID, TEXT, INT);`);
  pgm.sql(`DROP FUNCTION IF EXISTS allocate_next_order_number(TEXT);`);
  pgm.sql(`DROP FUNCTION IF EXISTS create_tenant_order_sequence(TEXT);`);
};
