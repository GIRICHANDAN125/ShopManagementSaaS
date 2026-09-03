import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const TENANT_ID = '55555555-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const cleanupPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'shopapp_dev',
  user: 'postgres',
  password: process.env.TEST_SUPERUSER_DB_PASSWORD,
});
const shopappPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL });
const superAdminPool = new Pool({ connectionString: process.env.SUPERADMIN_DATABASE_URL });

describe('Orders E2E (real HTTP, real Postgres)', () => {
  let app: INestApplication;
  let accessToken: string;
  let productId: string;

  beforeAll(async () => {
    await cleanupPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM products WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM categories WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [TENANT_ID]);
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
    await cleanupPool.query(
      `INSERT INTO tenants (id, code, display_name, order_sequence_name)
       VALUES ($1, 'E2E_JEST_SHOP', 'E2E Jest Shop', 'e2e_jest_seq')`,
      [TENANT_ID],
    );
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS e2e_jest_seq;`);
    await superAdminPool.query(`SELECT create_tenant_order_sequence('e2e_jest_seq')`);

    const passwordHash = await argon2.hash('e2e_password');
    const client = await shopappPool.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_ID]);
    await client.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES ('55555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $1, 'e2e_user', $2, 'E2E User')`,
      [TENANT_ID, passwordHash],
    );
    await client.query(
      `INSERT INTO roles (id, tenant_id, name)
       VALUES ('55555555-cccc-cccc-cccc-cccccccccccc', $1, 'E2E Role')`,
      [TENANT_ID],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ('55555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '55555555-cccc-cccc-cccc-cccccccccccc')`,
    );
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT '55555555-cccc-cccc-cccc-cccccccccccc', id FROM permissions
       WHERE code IN ('order.create','order.cancel','receipt.reprint')`,
    );
    const categoryRes = await client.query(
      `INSERT INTO categories (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'Snacks') RETURNING id`,
      [TENANT_ID],
    );
    const productRes = await client.query(
      `INSERT INTO products (id, tenant_id, category_id, name, price)
       VALUES (gen_random_uuid(), $1, $2, 'Samosa', 15.00) RETURNING id`,
      [TENANT_ID, categoryRes.rows[0].id],
    );
    productId = productRes.rows[0].id;
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
      .send({ shopCode: 'E2E_JEST_SHOP', username: 'e2e_user', password: 'e2e_password' });
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS e2e_jest_seq;`);
    await cleanupPool.end();
    await shopappPool.end();
    await superAdminPool.end();
  });

  it('logs in and receives a valid access token', () => {
    expect(accessToken).toBeDefined();
  });

  it('creates an order with a backend-computed total', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: 'ea1330f5-02aa-415b-9c9d-04061ba84714',
        items: [{ productId, quantity: 3 }],
        orderType: 'dine_in',
      });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe('45.00'); // 3 x 15.00, server-computed
    expect(res.body.orderNumber).toBeDefined();
    expect(res.body.displayNumber).toBeGreaterThanOrEqual(1);
  });

  it('returns the SAME order (200) for a retried request with the same idempotency key + payload', async () => {
    const first = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: 'beaaba34-7013-4ea3-a2ec-ffcc0fe41b0f',
        items: [{ productId, quantity: 1 }],
        orderType: 'takeaway',
      });
    const retry = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: 'beaaba34-7013-4ea3-a2ec-ffcc0fe41b0f',
        items: [{ productId, quantity: 1 }],
        orderType: 'takeaway',
      });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.orderNumber).toBe(first.body.orderNumber);
  });

  it('rejects (409) a reused idempotency key with a different payload, without altering the original', async () => {
    const key = 'b821c277-b9d2-429b-b7ce-51ad02ab1397';
    const original = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ idempotencyKey: key, items: [{ productId, quantity: 2 }], orderType: 'dine_in' });

    const conflict = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ idempotencyKey: key, items: [{ productId, quantity: 5 }], orderType: 'dine_in' });
    expect(conflict.status).toBe(409);

    const recheck = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ idempotencyKey: key, items: [{ productId, quantity: 2 }], orderType: 'dine_in' });
    expect(recheck.status).toBe(200);
    expect(recheck.body.total).toBe(original.body.total); // untouched by the conflicting attempt
  });

  it('rejects requests with no auth token', async () => {
    const res = await request(app.getHttpServer()).post('/orders').send({
      idempotencyKey: 'a10c31ae-b1db-4dd6-9060-eac89c1f523a',
      items: [{ productId, quantity: 1 }],
      orderType: 'dine_in',
    });
    expect(res.status).toBe(401);
  });

  it('cancel then manual reprint works; reprint never creates a new order', async () => {
    const created = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: '3ed0da47-1638-440b-ab40-240edaf8c891',
        items: [{ productId, quantity: 1 }],
        orderType: 'dine_in',
      });
    const cancelRes = await request(app.getHttpServer())
      .post(`/orders/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(cancelRes.status).toBe(201); // default Nest status for POST with no @HttpCode override
    expect(cancelRes.body.status).toBe('CANCELLED');

    const reprintRes = await request(app.getHttpServer())
      .post(`/orders/${created.body.id}/reprint`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(reprintRes.status).toBe(201);
    expect(reprintRes.body.order.id).toBe(created.body.id);
    expect(reprintRes.body.order.order_number).toBe(created.body.orderNumber);
  });
});
