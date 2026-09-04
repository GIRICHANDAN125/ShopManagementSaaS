const { Pool } = require('pg');
const argon2 = require('argon2');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.TEST_SUPERUSER_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/shopapp_dev',
});

const DEFAULT_SHOP_ROLES = [
  {
    name: 'Shop Admin',
    permissions: [
      'employee.manage',
      'shop.settings',
      'product.manage',
      'inventory.manage',
      'reports.view',
      'device.manage',
      'order.view',
      'order.create',
      'order.cancel',
      'receipt.print',
    ],
  },
  {
    name: 'Counter Staff',
    permissions: ['order.view', 'order.create', 'order.cancel', 'receipt.print'],
  },
  {
    name: 'Kitchen Display',
    permissions: ['order.view'],
  },
  {
    name: 'Order Coordinator',
    permissions: ['order.view', 'order.cancel'],
  },
];

async function main() {
  const client = await pool.connect();
  try {
    const tenantId = 'fe7d5e62-8441-4fe5-9ff2-a2389cb8fd07';
    const code = 'TENANT_561C7344';
    const displayName = 'Giri Bakery';
    const seqName = 'order_seq_tenant_561c7344';
    const userId = '5308b3fa-6b92-4485-8fbe-c84841d88619';
    const username = 'giriadmin';

    console.log(`Restoring manual tenant ${displayName} (${tenantId})...`);

    // 1. Order sequence
    await client.query(`SELECT create_tenant_order_sequence($1)`, [seqName]);

    // 2. Tenant
    await client.query(
      `INSERT INTO tenants (id, code, display_name, business_type, status, order_sequence_name, timezone)
       VALUES ($1, $2, $3, 'Bakery', 'active', $4, 'Asia/Kolkata')
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

    // 4. Set RLS context for tenant rows
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);

    // 5. Default roles & permissions
    let adminRoleId = null;
    for (const roleDef of DEFAULT_SHOP_ROLES) {
      const roleRes = await client.query(
        `INSERT INTO roles (tenant_id, name) VALUES ($1, $2)
         ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenantId, roleDef.name],
      );
      const roleId = roleRes.rows[0].id;
      if (roleDef.name === 'Shop Admin') adminRoleId = roleId;

      for (const permCode of roleDef.permissions) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT $1, p.id FROM permissions p WHERE p.code = $2
           ON CONFLICT DO NOTHING`,
          [roleId, permCode],
        );
      }
    }

    // 6. Initial admin user
    const passwordHash = await argon2.hash('Password123!', { type: argon2.argon2id });
    const userRes = await client.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name, status)
       VALUES ($1, $2, $3, $4, 'Giri Admin', 'active')
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [userId, tenantId, username, passwordHash],
    );

    if (adminRoleId) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, adminRoleId],
      );
    }

    // 7. Tenant settings
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, key, value)
       VALUES ($1, 'packing_config', $2),
              ($1, 'workflow_config', $3)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [
        tenantId,
        JSON.stringify({ rule: 'none' }),
        JSON.stringify({ mode: 'direct', enabledModules: ['printer'] }),
      ],
    );

    console.log(`Successfully restored ${displayName} (ID: ${tenantId}, Code: ${code})`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Error restoring tenant:', err);
  process.exit(1);
});
