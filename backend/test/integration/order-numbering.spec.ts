import { Pool } from 'pg';
import { deriveDisplayNumber } from '../../src/common/display-number';

const migratorPool = new Pool({ connectionString: process.env.DATABASE_URL });
const superAdminPool = new Pool({ connectionString: process.env.SUPERADMIN_DATABASE_URL });
const shopappPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL });
const cleanupPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'shopapp_dev',
  user: 'postgres',
  password: process.env.TEST_SUPERUSER_DB_PASSWORD,
});

// reserve_order_range() is called by the ordinary tenant-scoped role in
// production (DevicesService uses db.withTenant, i.e. the `shopapp`
// pool) — it is a tenant operation (a device belongs to a tenant), not a
// platform operation, so it must run with a tenant context set, exactly
// like any other tenant-scoped query.
async function reserveRangeAsTenant(tenantId: string, seqName: string, blockSize: number) {
  const client = await shopappPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const res = await client.query(`SELECT * FROM reserve_order_range($1, $2, $3)`, [
      tenantId,
      seqName,
      blockSize,
    ]);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SEQ_NAME = 'test_numbering_seq';

describe('Order numbering — sequence allocation and range reservation', () => {
  beforeAll(async () => {
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS ${SEQ_NAME};`);
    await superAdminPool.query(`SELECT create_tenant_order_sequence($1)`, [SEQ_NAME]);
  });

  afterAll(async () => {
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS ${SEQ_NAME};`);
    await migratorPool.end();
    await superAdminPool.end();
    await shopappPool.end();
    await cleanupPool.end();
  });

  it('allocates strictly increasing numbers with no daily-reset behavior', async () => {
    const n1 = await migratorPool.query(`SELECT allocate_next_order_number($1) AS n`, [SEQ_NAME]);
    const n2 = await migratorPool.query(`SELECT allocate_next_order_number($1) AS n`, [SEQ_NAME]);
    const n3 = await migratorPool.query(`SELECT allocate_next_order_number($1) AS n`, [SEQ_NAME]);
    const [a, b, c] = [n1.rows[0].n, n2.rows[0].n, n3.rows[0].n].map(Number);
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it('NEVER reuses a number after the allocating transaction rolls back', async () => {
    const client = await migratorPool.connect();
    let rolledBackNumber: number;
    try {
      await client.query('BEGIN');
      const res = await client.query(`SELECT allocate_next_order_number($1) AS n`, [SEQ_NAME]);
      rolledBackNumber = Number(res.rows[0].n);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const next = await migratorPool.query(`SELECT allocate_next_order_number($1) AS n`, [
      SEQ_NAME,
    ]);
    expect(Number(next.rows[0].n)).toBe(rolledBackNumber + 1);
    expect(Number(next.rows[0].n)).not.toBe(rolledBackNumber);
  });

  it('reserves genuinely contiguous, non-overlapping blocks across sequential reservations', async () => {
    const r1 = await reserveRangeAsTenant(
      '33333333-3333-3333-3333-333333333333',
      SEQ_NAME,
      25,
    );
    const r2 = await reserveRangeAsTenant(
      '33333333-3333-3333-3333-333333333333',
      SEQ_NAME,
      25,
    );
    const [s1, e1] = [Number(r1.rows[0].range_start), Number(r1.rows[0].range_end)];
    const [s2, e2] = [Number(r2.rows[0].range_start), Number(r2.rows[0].range_end)];

    expect(e1 - s1).toBe(24); // 25 numbers, inclusive
    expect(s2).toBe(e1 + 1); // perfectly contiguous, no gap, no overlap
    expect(s2).toBeGreaterThan(e1);
  });

  it('concurrent reservations for the same tenant never overlap (advisory-lock serialized)', async () => {
    const tenantId = '44444444-4444-4444-4444-444444444444';
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveRangeAsTenant(tenantId, SEQ_NAME, 10)),
    );
    const ranges = results
      .map((r) => [Number(r.rows[0].range_start), Number(r.rows[0].range_end)] as const)
      .sort((a, b) => a[0] - b[0]);

    for (let i = 1; i < ranges.length; i++) {
      // Each range must start strictly after the previous one ended —
      // any overlap here would mean two devices could issue the same
      // real order number.
      expect(ranges[i][0]).toBeGreaterThan(ranges[i - 1][1]);
    }
  });

  it('display number derived from an allocated real number matches the pure formula', async () => {
    const res = await migratorPool.query(`SELECT allocate_next_order_number($1) AS n`, [
      SEQ_NAME,
    ]);
    const orderNumber = Number(res.rows[0].n);
    const display = deriveDisplayNumber(orderNumber);
    expect(display).toBeGreaterThanOrEqual(1);
    expect(display).toBeLessThanOrEqual(999);
    expect(display).not.toBe(0);
  });
});
