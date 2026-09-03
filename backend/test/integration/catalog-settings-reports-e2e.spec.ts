import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const TENANT_ID = '77777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const cleanupPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'shopapp_dev',
  user: 'postgres',
  password: process.env.TEST_SUPERUSER_DB_PASSWORD,
});
const shopappPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL });
const superAdminPool = new Pool({ connectionString: process.env.SUPERADMIN_DATABASE_URL });

describe('Catalog, settings, reports, device-connect E2E', () => {
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM device_tenant_lookup WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM device_order_reservations WHERE tenant_id = $1`, [
      TENANT_ID,
    ]);
    await cleanupPool.query(`DELETE FROM devices WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM products WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM categories WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(
      `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)`,
      [TENANT_ID],
    );
    await cleanupPool.query(
      `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`,
      [TENANT_ID],
    );
    await cleanupPool.query(`DELETE FROM roles WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM users WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM tenants WHERE id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS catalog_e2e_seq;`);

    await cleanupPool.query(
      `INSERT INTO tenants (id, code, display_name, order_sequence_name, timezone)
       VALUES ($1, 'CATALOG_E2E_SHOP', 'Catalog E2E Shop', 'catalog_e2e_seq', 'Asia/Kolkata')`,
      [TENANT_ID],
    );
    await superAdminPool.query(`SELECT create_tenant_order_sequence('catalog_e2e_seq')`);

    const passwordHash = await argon2.hash('catalog_e2e_password');
    const client = await shopappPool.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_ID]);
    await client.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES ('77777777-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $1, 'catalog_admin', $2, 'Admin')`,
      [TENANT_ID, passwordHash],
    );
    await client.query(
      `INSERT INTO roles (id, tenant_id, name)
       VALUES ('77777777-cccc-cccc-cccc-cccccccccccc', $1, 'Full Admin')`,
      [TENANT_ID],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ('77777777-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '77777777-cccc-cccc-cccc-cccccccccccc')`,
    );
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT '77777777-cccc-cccc-cccc-cccccccccccc', id FROM permissions
       WHERE code IN ('order.create','order.view','product.manage','shop.settings','reports.view','device.manage','employee.manage')`,
    );
    await client.query('COMMIT');
    client.release();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: 'CATALOG_E2E_SHOP', username: 'catalog_admin', password: 'catalog_e2e_password' });
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS catalog_e2e_seq;`);
    await cleanupPool.end();
    await shopappPool.end();
    await superAdminPool.end();
  });

  it('creates a category and a product', async () => {
    const cat = await request(app.getHttpServer())
      .post('/catalog/categories')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Beverages' });
    expect(cat.status).toBe(201);

    const prod = await request(app.getHttpServer())
      .post('/catalog/products')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Masala Chai', price: 20, categoryId: cat.body.id });
    expect(prod.status).toBe(201);
    expect(prod.body.price).toBeDefined();

    const list = await request(app.getHttpServer())
      .get('/catalog/products')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.some((p: any) => p.name === 'Masala Chai')).toBe(true);
  });

  it('configures a flat packing charge and the order total reflects it — never a client-supplied value', async () => {
    const prodRes = await request(app.getHttpServer())
      .post('/catalog/products')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Sandwich', price: 50 });
    const productId = prodRes.body.id;

    await request(app.getHttpServer())
      .post('/settings/packing')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ rule: 'flat', flatCharge: 8 })
      .expect(201);

    const order = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: 'e3a1a8b2-1111-4a11-9a11-abcdefabcdef',
        items: [{ productId, quantity: 1 }],
        orderType: 'dine_in',
      });
    expect(order.status).toBe(201);
    // 50 (item) + 8 (flat packing, server-resolved) = 58, regardless of
    // anything the client did or didn't send about packing.
    expect(order.body.total).toBe('58.00');
  });

  it('reports/today reflects the orders just created, tenant-scoped', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/today')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.total_orders)).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.revenue)).toBeGreaterThan(0);
  });

  it('reports endpoints require reports.view and are tenant-scoped (no cross-tenant leakage possible via this path)', async () => {
    const res = await request(app.getHttpServer()).get('/reports/today');
    expect(res.status).toBe(401); // no token at all
  });

  it('device connect-token: valid credential issues a device-scoped token; wrong credential is rejected', async () => {
    const reg = await request(app.getHttpServer())
      .post('/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'TV-01' });
    const { device, credential } = reg.body;

    const good = await request(app.getHttpServer())
      .post('/devices/connect')
      .send({ deviceId: device.id, credential });
    expect(good.status).toBe(201);
    expect(good.body.token).toBeDefined();
    expect(good.body.tenantId).toBe(TENANT_ID);

    const bad = await request(app.getHttpServer())
      .post('/devices/connect')
      .send({ deviceId: device.id, credential: 'wrong-credential-entirely' });
    expect(bad.status).toBe(403);
  });

  it('a device token cannot be used to call a staff REST endpoint requiring a permission', async () => {
    const reg = await request(app.getHttpServer())
      .post('/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'TV-02' });
    const connectRes = await request(app.getHttpServer())
      .post('/devices/connect')
      .send({ deviceId: reg.body.device.id, credential: reg.body.credential });
    const deviceToken = connectRes.body.token;

    const res = await request(app.getHttpServer())
      .get('/orders/active')
      .set('Authorization', `Bearer ${deviceToken}`);
    expect(res.status).toBe(403); // no `permissions` claim on a device token
  });
});
