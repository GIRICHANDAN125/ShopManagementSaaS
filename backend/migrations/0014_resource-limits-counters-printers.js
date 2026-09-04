/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. Tenant resource limits (Super Admin controlled, per-tenant operational quotas)
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS tenant_resource_limits (
      tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      max_employees INT NOT NULL DEFAULT 5 CHECK (max_employees >= 1),
      max_counters INT NOT NULL DEFAULT 1 CHECK (max_counters >= 1),
      max_customer_displays INT NOT NULL DEFAULT 1 CHECK (max_customer_displays >= 1),
      max_printers INT NOT NULL DEFAULT 1 CHECK (max_printers >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Seed limits for any existing tenants BEFORE enabling RLS
  pgm.sql(`
    INSERT INTO tenant_resource_limits (tenant_id, max_employees, max_counters, max_customer_displays, max_printers)
    SELECT id, 5, 1, 1, 1 FROM tenants
    ON CONFLICT (tenant_id) DO NOTHING;
  `);

  pgm.sql(`ALTER TABLE tenant_resource_limits ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE tenant_resource_limits FORCE ROW LEVEL SECURITY;`);

  pgm.sql(`
    CREATE POLICY tenant_isolation_tenant_resource_limits ON tenant_resource_limits
      FOR ALL
      USING (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
      )
      WITH CHECK (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
      );
  `);

  // Ordinary shopapp runtime role can ONLY SELECT limits; Super Admin has full management
  pgm.sql(`GRANT SELECT ON tenant_resource_limits TO shopapp;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_resource_limits TO shopapp_superadmin;`);

  // 2. Extend existing counters table
  pgm.sql(`ALTER TABLE counters ADD COLUMN IF NOT EXISTS code TEXT;`);
  pgm.sql(`UPDATE counters SET code = 'CTR-' || substr(id::text, 1, 8) WHERE code IS NULL;`);
  pgm.sql(`ALTER TABLE counters ALTER COLUMN code SET NOT NULL;`);
  pgm.sql(`ALTER TABLE counters ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL;`);
  pgm.sql(`ALTER TABLE counters ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
  pgm.sql(`ALTER TABLE counters ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_counters_tenant_code ON counters (tenant_id, code);`);

  // 3. Extend existing devices table with device type (counter vs customer_display)
  pgm.sql(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'counter' CHECK (type IN ('counter', 'customer_display'));`);

  // 4. Create printers table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS printers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'thermal_receipt',
      location TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, name)
    );
  `);

  pgm.sql(`ALTER TABLE printers ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE printers FORCE ROW LEVEL SECURITY;`);

  pgm.sql(`
    CREATE POLICY tenant_isolation_printers ON printers
      FOR ALL
      USING (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
      )
      WITH CHECK (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
      );
  `);

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON printers TO shopapp;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON printers TO shopapp_superadmin;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS printers CASCADE;`);
  pgm.sql(`ALTER TABLE devices DROP COLUMN IF EXISTS type;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_counters_tenant_code;`);
  pgm.sql(`ALTER TABLE counters DROP COLUMN IF EXISTS updated_at;`);
  pgm.sql(`ALTER TABLE counters DROP COLUMN IF EXISTS created_at;`);
  pgm.sql(`ALTER TABLE counters DROP COLUMN IF EXISTS assigned_user_id;`);
  pgm.sql(`ALTER TABLE counters DROP COLUMN IF EXISTS code;`);
  pgm.sql(`DROP TABLE IF EXISTS tenant_resource_limits CASCADE;`);
};
