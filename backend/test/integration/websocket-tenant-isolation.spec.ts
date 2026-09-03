import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../../src/app.module';

const TENANT_A = '88888888-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = '88888888-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const cleanupPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'shopapp_dev',
  user: 'postgres',
  password: process.env.TEST_SUPERUSER_DB_PASSWORD,
});
const shopappPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL });
const superAdminPool = new Pool({ connectionString: process.env.SUPERADMIN_DATABASE_URL });

async function seedTenantWithUser(tenantId: string, code: string, seqName: string, username: string) {
  await cleanupPool.query(
    `INSERT INTO tenants (id, code, display_name, order_sequence_name) VALUES ($1,$2,$3,$4)`,
    [tenantId, code, code, seqName],
  );
  await superAdminPool.query(`SELECT create_tenant_order_sequence($1)`, [seqName]);
  const passwordHash = await argon2.hash('ws_test_password');
  const client = await shopappPool.connect();
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
  const userRes = await client.query(
    `INSERT INTO users (tenant_id, username, password_hash, display_name)
     VALUES ($1,$2,$3,'WS Test User') RETURNING id`,
    [tenantId, username, passwordHash],
  );
  const roleRes = await client.query(
    `INSERT INTO roles (tenant_id, name) VALUES ($1,'WS Role') RETURNING id`,
    [tenantId],
  );
  await client.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [
    userRes.rows[0].id,
    roleRes.rows[0].id,
  ]);
  await client.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, id FROM permissions WHERE code IN ('order.create','order.view')`,
    [roleRes.rows[0].id],
  );
  const catRes = await client.query(
    `INSERT INTO categories (tenant_id, name) VALUES ($1,'Cat') RETURNING id`,
    [tenantId],
  );
  const prodRes = await client.query(
    `INSERT INTO products (tenant_id, category_id, name, price) VALUES ($1,$2,'Item',10) RETURNING id`,
    [tenantId, catRes.rows[0].id],
  );
  await client.query('COMMIT');
  client.release();
  return { productId: prodRes.rows[0].id };
}

describe('WebSocket tenant isolation (real Socket.IO, real listening server)', () => {
  let app: INestApplication;
  let tokenA: string;
  let tokenB: string;
  let productIdA: string;
  let port: number;

  beforeAll(async () => {
    for (const [id, seq] of [
      [TENANT_A, 'ws_seq_a'],
      [TENANT_B, 'ws_seq_b'],
    ]) {
      await cleanupPool.query(`DROP SEQUENCE IF EXISTS ${seq};`);
    }
    for (const id of [TENANT_A, TENANT_B]) {
      await cleanupPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [id]);
      await cleanupPool.query(`DELETE FROM products WHERE tenant_id = $1`, [id]);
      await cleanupPool.query(`DELETE FROM categories WHERE tenant_id = $1`, [id]);
      await cleanupPool.query(
        `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)`,
        [id],
      );
      await cleanupPool.query(
        `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`,
        [id],
      );
      await cleanupPool.query(`DELETE FROM roles WHERE tenant_id = $1`, [id]);
      await cleanupPool.query(`DELETE FROM users WHERE tenant_id = $1`, [id]);
      await cleanupPool.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    }

    const seededA = await seedTenantWithUser(TENANT_A, 'WS_TENANT_A', 'ws_seq_a', 'ws_user_a');
    await seedTenantWithUser(TENANT_B, 'WS_TENANT_B', 'ws_seq_b', 'ws_user_b');
    productIdA = seededA.productId;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0); // real listening socket — required for Socket.IO
    const address = app.getHttpServer().address();
    port = typeof address === 'object' && address ? address.port : 0;

    const loginA = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: 'WS_TENANT_A', username: 'ws_user_a', password: 'ws_test_password' });
    tokenA = loginA.body.accessToken;
    const loginB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: 'WS_TENANT_B', username: 'ws_user_b', password: 'ws_test_password' });
    tokenB = loginB.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS ws_seq_a;`);
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS ws_seq_b;`);
    await cleanupPool.end();
    await shopappPool.end();
    await superAdminPool.end();
  });

  function connectSocket(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(`http://localhost:${port}`, { auth: { token }, reconnection: false });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 5000);
    });
  }

  it('a Tenant A order-status event is received by Tenant A socket but NEVER by Tenant B socket', async () => {
    const socketA = await connectSocket(tokenA);
    const socketB = await connectSocket(tokenB);

    const receivedByA: unknown[] = [];
    const receivedByB: unknown[] = [];
    socketA.on('order.status_changed', (p) => receivedByA.push(p));
    socketB.on('order.status_changed', (p) => receivedByB.push(p));

    // Create and advance a Tenant A order — this triggers
    // RealtimeGateway.emitOrderStatusChanged(TENANT_A, ...) via
    // OrdersService.updateStatus.
    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        idempotencyKey: 'f1a1a8b2-2222-4a11-9a11-abcdefabcdef',
        items: [{ productId: productIdA, quantity: 1 }],
        orderType: 'dine_in',
      });
    await request(app.getHttpServer())
      .post(`/orders/${orderRes.body.id}/status`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'PREPARING' });

    // Give the event loop a moment to deliver the socket event.
    await new Promise((r) => setTimeout(r, 500));

    expect(receivedByA.length).toBeGreaterThanOrEqual(1);
    expect(receivedByB.length).toBe(0); // the entire point of tenant-scoped rooms

    socketA.disconnect();
    socketB.disconnect();
  }, 15000);

  it('a connection with no token is rejected (disconnected) rather than joined to any room', async () => {
    const socket = io(`http://localhost:${port}`, { auth: {}, reconnection: false });
    const disconnected = new Promise<void>((resolve) => {
      socket.on('disconnect', () => resolve());
      socket.on('connect', () => {
        // If it connects at all without a token, that is itself the
        // failure this test exists to catch.
      });
    });
    await Promise.race([
      disconnected,
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    expect(socket.connected).toBe(false);
  }, 8000);

  it('a connection with an invalid/garbage token is rejected', async () => {
    const socket = io(`http://localhost:${port}`, {
      auth: { token: 'not-a-real-jwt' },
      reconnection: false,
    });
    await new Promise((r) => setTimeout(r, 1000));
    expect(socket.connected).toBe(false);
  }, 8000);
});
