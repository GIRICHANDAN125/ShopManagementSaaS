/**
 * Test Fixture Cleanup Utility
 * 
 * STRICT ISOLATION POLICY:
 * - NEVER deletes tenants by display_name, shop name, or pattern matching.
 * - Only deletes tenants when explicitly provided with exact primary key UUIDs as CLI arguments.
 * - If run without arguments, performs a safe no-op.
 */
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'shopapp_dev',
  user: 'postgres',
  password: process.env.TEST_SUPERUSER_DB_PASSWORD || 'postgres',
});

async function deleteTenantById(client, tenantId) {
  if (!UUID_REGEX.test(tenantId)) {
    console.warn(`Skipping invalid tenant UUID: ${tenantId}`);
    return;
  }

  const tRes = await client.query('SELECT id, order_sequence_name, display_name FROM tenants WHERE id = $1', [tenantId]);
  if (tRes.rowCount === 0) {
    return;
  }
  const t = tRes.rows[0];

  await client.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM order_items WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM order_status_history WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM orders WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM categories WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM printers WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM device_order_reservations WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM device_tenant_lookup WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM devices WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM counters WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM tenant_resource_limits WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)', [tenantId]);
  await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)', [tenantId]);
  await client.query('DELETE FROM roles WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);

  if (t.order_sequence_name) {
    await client.query(`DROP SEQUENCE IF EXISTS ${t.order_sequence_name}`);
  }
  console.log(`Cleaned up test tenant ID: ${tenantId} (${t.display_name})`);
}

async function main() {
  const targetIds = process.argv.slice(2).filter(arg => UUID_REGEX.test(arg));

  if (targetIds.length === 0) {
    console.log('No specific tenant UUIDs provided. No tenants were deleted.');
    console.log('Usage: node scripts/cleanup-test-fixtures.js <tenant-uuid-1> <tenant-uuid-2>');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    for (const tid of targetIds) {
      await deleteTenantById(client, tid);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Cleanup error:', err);
    process.exit(1);
  });
}

module.exports = { deleteTenantById };
