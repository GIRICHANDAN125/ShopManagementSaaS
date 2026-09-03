import { Pool } from 'pg';

// Real PostgreSQL, real RLS — per TESTING.md §18, this must never be
// mocked. Uses the same three roles the application uses in production:
// shopapp_migrator (schema owner, used here only for seeding),
// shopapp (ordinary runtime role), shopapp_superadmin (platform role).

const migratorPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const shopappPool = new Pool({
  connectionString: process.env.RUNTIME_DATABASE_URL,
});
const superAdminPool = new Pool({
  connectionString: process.env.SUPERADMIN_DATABASE_URL,
});
// Test-only cleanup connection. Production code never uses postgres
// superuser credentials — this exists solely so this test file can reset
// fixture data between runs without needing DELETE grants that the real
// application roles correctly do not have (audit_logs is append-only by
// design; shopapp_superadmin has no DELETE grant on it either).
const cleanupPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'shopapp_dev',
  user: 'postgres',
  password: process.env.TEST_SUPERUSER_DB_PASSWORD,
});

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

async function seedTenants() {
  await migratorPool.query(
    `INSERT INTO tenants (id, code, display_name, order_sequence_name)
     VALUES ($1,'TEST_TENANT_A','Test Tenant A','test_seq_a'),
            ($2,'TEST_TENANT_B','Test Tenant B','test_seq_b')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await superAdminPool.query(`SELECT create_tenant_order_sequence('test_seq_a')`);
  await superAdminPool.query(`SELECT create_tenant_order_sequence('test_seq_b')`);
}

async function cleanup() {
  // Deliberately scoped to ONLY this file's own two test tenants — a
  // blanket "DELETE FROM users WHERE tenant_id IS NOT NULL" here would
  // (and, when first written, did) unsafely delete other test files'
  // fixture data when integration tests run concurrently against the
  // same shared database, breaking their FK-referenced audit_logs rows.
  await cleanupPool.query(
    `DELETE FROM order_status_history WHERE tenant_id IN ($1,$2)`,
    [TENANT_A, TENANT_B],
  );
  await cleanupPool.query(`DELETE FROM order_items WHERE tenant_id IN ($1,$2)`, [
    TENANT_A,
    TENANT_B,
  ]);
  await cleanupPool.query(`DELETE FROM orders WHERE tenant_id IN ($1,$2)`, [TENANT_A, TENANT_B]);
  await cleanupPool.query(
    `DELETE FROM device_order_reservations WHERE tenant_id IN ($1,$2)`,
    [TENANT_A, TENANT_B],
  );
  await cleanupPool.query(`DELETE FROM devices WHERE tenant_id IN ($1,$2)`, [TENANT_A, TENANT_B]);
  await cleanupPool.query(
    `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id IN ($1,$2))`,
    [TENANT_A, TENANT_B],
  );
  await cleanupPool.query(`DELETE FROM users WHERE tenant_id IN ($1,$2)`, [TENANT_A, TENANT_B]);
  // This file's own platform-level (tenant_id IS NULL) fixture users —
  // delete their audit rows first, then the users, to satisfy the FK.
  await cleanupPool.query(
    `DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id IN (
       SELECT id FROM users WHERE tenant_id IS NULL AND username IN ('proof3_admin', 'super_admin_1')
     )`,
  );
  await cleanupPool.query(
    `DELETE FROM users WHERE tenant_id IS NULL AND username IN ('proof3_admin', 'super_admin_1')`,
  );
  await cleanupPool.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [TENANT_A, TENANT_B]);
}

describe('Row-Level Security — tenant isolation and Super Admin scope', () => {
  beforeAll(async () => {
    await cleanup();
    await seedTenants();
  });

  afterAll(async () => {
    await cleanup();
    await migratorPool.end();
    await shopappPool.end();
    await superAdminPool.end();
    await cleanupPool.end();
  });

  async function asTenant<T>(tenantId: string, fn: (client: any) => Promise<T>) {
    const client = await shopappPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } finally {
      client.release();
    }
  }

  it('PROOF 1: a normal tenant user cannot read another tenant\'s rows', async () => {
    await migratorPool.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [TENANT_B],
    );
    // Seed via superadmin isn't right for tenant-owned rows; use a
    // transaction-scoped migrator insert instead, matching production's
    // own constraint that even the schema owner must set tenant context.
    await migratorPool.query('BEGIN');
    await migratorPool.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_B]);
    await migratorPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES ('33333333-0000-0000-0000-000000000001', $1, 'b_user', 'x', 'B User')
       ON CONFLICT DO NOTHING`,
      [TENANT_B],
    );
    await migratorPool.query('COMMIT');

    const rows = await asTenant(TENANT_A, (client) =>
      client
        .query(`SELECT username FROM users WHERE tenant_id = $1`, [TENANT_B])
        .then((r: any) => r.rows),
    );
    expect(rows).toHaveLength(0);
  });

  it('PROOF 2: an ordinary tenant connection cannot activate Super Admin scope', async () => {
    const client = await shopappPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_A]);
      // Setting an arbitrary "is_super_admin"-style GUC has no effect —
      // there is no policy anywhere keyed on such a flag; the only thing
      // that matters is which DB role the connection actually is.
      await client.query(`SELECT set_config('app.is_super_admin', 'true', true)`);
      const res = await client.query(`SELECT username FROM users WHERE tenant_id IS NULL`);
      expect(res.rows).toHaveLength(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // And the shopapp credential simply cannot authenticate as the
    // superadmin role at all — there is no shared secret to guess into.
    const wrongCredentialPool = new Pool({
      host: 'localhost',
      port: 5432,
      database: 'shopapp_dev',
      user: 'shopapp_superadmin',
      password: process.env.TEST_RUNTIME_DB_PASSWORD, // shopapp's own password, deliberately wrong role
    });
    await expect(wrongCredentialPool.query('SELECT 1')).rejects.toThrow();
    await wrongCredentialPool.end();
  });

  it('PROOF 3: authorized Super Admin sees only platform-level rows, never shop-operational data', async () => {
    await superAdminPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES ('44444444-0000-0000-0000-000000000001', NULL, 'proof3_admin', 'x', 'Proof3 Admin')
       ON CONFLICT DO NOTHING`,
    );

    const platformUsers = await superAdminPool.query(
      `SELECT username FROM users WHERE tenant_id IS NULL AND username = 'proof3_admin'`,
    );
    expect(platformUsers.rows).toHaveLength(1);

    const tenantScoped = await superAdminPool.query(
      `SELECT username FROM users WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(tenantScoped.rows).toHaveLength(0);

    await expect(superAdminPool.query(`SELECT * FROM orders`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(superAdminPool.query(`SELECT * FROM products`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('PROOF 4: a Super Admin write to tenants is automatically audited by the DB trigger', async () => {
    const before = await superAdminPool.query(
      `SELECT count(*)::int AS c FROM audit_logs WHERE action = 'UPDATE.tenant'`,
    );
    await superAdminPool.query(`UPDATE tenants SET status = 'inactive' WHERE id = $1`, [TENANT_B]);
    const after = await superAdminPool.query(
      `SELECT count(*)::int AS c FROM audit_logs WHERE action = 'UPDATE.tenant'`,
    );
    expect(after.rows[0].c).toBe(before.rows[0].c + 1);

    await superAdminPool.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TENANT_B]);
  });

  it('PROOF 5: RLS cannot accidentally default-allow (missing or empty tenant context => zero rows)', async () => {
    const client = await shopappPool.connect();
    try {
      await client.query('BEGIN');
      // No SET at all.
      const noContext = await client.query(`SELECT count(*)::int AS c FROM orders`);
      expect(noContext.rows[0].c).toBe(0);

      // Empty string — a common bug pattern.
      await client.query(`SELECT set_config('app.current_tenant_id', '', true)`);
      const emptyContext = await client.query(`SELECT count(*)::int AS c FROM orders`);
      expect(emptyContext.rows[0].c).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('cross-tenant write is rejected by RLS WITH CHECK, not just filtered on read', async () => {
    const client = await shopappPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_A]);
      await expect(
        client.query(
          `INSERT INTO users (tenant_id, username, password_hash, display_name)
           VALUES ($1, 'sneaky', 'x', 'Sneaky')`,
          [TENANT_B],
        ),
      ).rejects.toThrow(/row-level security/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
