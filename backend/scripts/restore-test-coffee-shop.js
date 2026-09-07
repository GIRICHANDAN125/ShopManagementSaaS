const { Pool } = require('pg');
const argon2 = require('argon2');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.SUPERADMIN_DATABASE_URL,
});

async function main() {
  const client = await pool.connect();
  try {
    const existing = await client.query("SELECT id FROM tenants WHERE display_name = 'Test Coffee Shop'");
    if (existing.rowCount > 0) {
      console.log('Test Coffee Shop already exists with ID:', existing.rows[0].id);
      return;
    }

    const tenantId = '11111111-2222-3333-4444-555555555555';
    const code = 'TEST_COFFEE_01';
    const displayName = 'Test Coffee Shop';
    const seqName = 'order_seq_test_coffee_01';

    console.log(`Seeding manual tenant ${displayName}...`);

    // 1. Order sequence
    await client.query('SELECT create_tenant_order_sequence($1)', [seqName]);

    // 2. Tenant
    await client.query(
      `INSERT INTO tenants (id, code, display_name, business_type, status, order_sequence_name, timezone)
       VALUES ($1, $2, $3, 'Cafe', 'active', $4, 'Asia/Kolkata')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, code, displayName, seqName],
    );

    // 3. Resource limits
    await client.query(
      `INSERT INTO tenant_resource_limits (tenant_id, max_employees, max_counters, max_customer_displays, max_printers)
       VALUES ($1, 5, 1, 1, 1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );

    console.log(`Successfully seeded ${displayName} (ID: ${tenantId}, Code: ${code})`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error seeding Test Coffee Shop:', err);
  process.exit(1);
});
