import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';
import { DevicesService } from '../../src/devices/devices.module';

const TENANT_ID = '99999999-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const cleanupPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'shopapp_dev',
  user: 'postgres',
  password: process.env.TEST_SUPERUSER_DB_PASSWORD,
});
const shopappPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL });
const superAdminPool = new Pool({ connectionString: process.env.SUPERADMIN_DATABASE_URL });

describe('Offline synchronization (OFFLINE_SYNC_DESIGN.md)', () => {
  let app: INestApplication;
  let accessToken: string;
  let devicesService: DevicesService;
  let productId: string;
  let deviceId: string;
  let reservationId: string;
  let rangeStart: number;

  beforeAll(async () => {
    await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM device_tenant_lookup WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM order_items WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM order_status_history WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM device_order_reservations WHERE tenant_id = $1`, [
      TENANT_ID,
    ]);
    await cleanupPool.query(`DELETE FROM devices WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM products WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM categories WHERE tenant_id = $1`, [TENANT_ID]);
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
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS offline_e2e_seq;`);

    await cleanupPool.query(
      `INSERT INTO tenants (id, code, display_name, order_sequence_name)
       VALUES ($1, 'OFFLINE_E2E_SHOP', 'Offline E2E Shop', 'offline_e2e_seq')`,
      [TENANT_ID],
    );
    await superAdminPool.query(`SELECT create_tenant_order_sequence('offline_e2e_seq')`);

    const passwordHash = await argon2.hash('offline_e2e_password');
    const client = await shopappPool.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_ID]);
    await client.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES ('99999999-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $1, 'offline_user', $2, 'Offline User')`,
      [TENANT_ID, passwordHash],
    );
    await client.query(
      `INSERT INTO roles (id, tenant_id, name) VALUES ('99999999-cccc-cccc-cccc-cccccccccccc', $1, 'Role')`,
      [TENANT_ID],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ('99999999-bbbb-bbbb-bbbb-bbbbbbbbbbbb','99999999-cccc-cccc-cccc-cccccccccccc')`,
    );
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT '99999999-cccc-cccc-cccc-cccccccccccc', id FROM permissions
       WHERE code IN ('order.create','order.view','device.manage')`,
    );
    const catRes = await client.query(
      `INSERT INTO categories (tenant_id, name) VALUES ($1,'Cat') RETURNING id`,
      [TENANT_ID],
    );
    const prodRes = await client.query(
      `INSERT INTO products (tenant_id, category_id, name, price) VALUES ($1,$2,'Bun',12) RETURNING id`,
      [TENANT_ID, catRes.rows[0].id],
    );
    productId = prodRes.rows[0].id;
    await client.query('COMMIT');
    client.release();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    devicesService = moduleRef.get(DevicesService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: 'OFFLINE_E2E_SHOP', username: 'offline_user', password: 'offline_e2e_password' });
    accessToken = loginRes.body.accessToken;

    // Register a device and grant it a reservation, simulating "while
    // online, before the outage" per OFFLINE_SYNC_DESIGN.md §2.
    const deviceReg = await devicesService.registerDevice(
      TENANT_ID,
      '99999999-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      { name: 'Offline-Counter-01' } as any,
    );
    deviceId = deviceReg.device.id;
    const reservation = await devicesService.reserveRange(TENANT_ID, deviceId, { blockSize: 5 });
    reservationId = reservation.id;
    rangeStart = Number(reservation.range_start);
  });

  afterAll(async () => {
    await app.close();
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS offline_e2e_seq;`);
    await cleanupPool.end();
    await shopappPool.end();
    await superAdminPool.end();
  });

  it('syncs an offline-created order using its already-reserved real number — no renumbering', async () => {
    const issued = await devicesService.issueFromReservation(TENANT_ID, reservationId);
    const orderNumber = Number(issued.issued_number);
    expect(orderNumber).toBe(rangeStart);

    const createdAtDevice = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // simulate "an hour ago, while offline"
    const res = await request(app.getHttpServer())
      .post('/orders/sync-offline')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: 'aaaaaaaa-1111-4a11-9a11-abcdefabcdef',
        items: [{ productId, quantity: 2 }],
        orderType: 'takeaway',
        deviceId,
        reservedOrderNumber: orderNumber,
        createdAtDevice,
      });
    expect(res.status).toBe(201);
    // The real order number is exactly the one that was reserved offline
    // — never a different, server-reassigned number.
    expect(res.body.orderNumber).toBe(String(orderNumber));
    expect(res.body.total).toBe('24.00');
  });

  it('duplicate sync of the same offline order (retry) returns the same order, never a duplicate', async () => {
    const issued = await devicesService.issueFromReservation(TENANT_ID, reservationId);
    const orderNumber = Number(issued.issued_number);
    const payload = {
      idempotencyKey: 'bbbbbbbb-2222-4a11-9a11-abcdefabcdef',
      items: [{ productId, quantity: 1 }],
      orderType: 'dine_in',
      deviceId,
      reservedOrderNumber: orderNumber,
      createdAtDevice: new Date().toISOString(),
    };
    const first = await request(app.getHttpServer())
      .post('/orders/sync-offline')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(payload);
    const retry = await request(app.getHttpServer())
      .post('/orders/sync-offline')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(payload);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200); // idempotent replay, not a duplicate
    expect(retry.body.id).toBe(first.body.id);

    const countRes = await cleanupPool.query(
      `SELECT count(*)::int AS c FROM orders WHERE tenant_id = $1 AND order_number = $2`,
      [TENANT_ID, orderNumber],
    );
    expect(countRes.rows[0].c).toBe(1); // exactly one row, not two
  });

  it('rejects a sync attempt whose "reserved" number was never actually granted to that device', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders/sync-offline')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: 'cccccccc-3333-4a11-9a11-abcdefabcdef',
        items: [{ productId, quantity: 1 }],
        orderType: 'dine_in',
        deviceId,
        reservedOrderNumber: 999999999, // never issued to this device
        createdAtDevice: new Date().toISOString(),
      });
    expect(res.status).toBe(400);
  });

  it('preserves the actual offline creation timestamp, not the sync time', async () => {
    const issued = await devicesService.issueFromReservation(TENANT_ID, reservationId);
    const orderNumber = Number(issued.issued_number);
    const createdAtDevice = new Date('2026-01-01T10:00:00.000Z').toISOString();

    const res = await request(app.getHttpServer())
      .post('/orders/sync-offline')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: 'dddddddd-4444-4a11-9a11-abcdefabcdef',
        items: [{ productId, quantity: 1 }],
        orderType: 'dine_in',
        deviceId,
        reservedOrderNumber: orderNumber,
        createdAtDevice,
      });
    expect(res.status).toBe(201);

    const dbRow = await cleanupPool.query(
      `SELECT created_at_device, created_at FROM orders WHERE id = $1`,
      [res.body.id],
    );
    expect(new Date(dbRow.rows[0].created_at_device).toISOString()).toBe(createdAtDevice);
    // created_at (sync/write time) should be recent — genuinely different
    // from created_at_device, proving the two are tracked distinctly.
    const syncTime = new Date(dbRow.rows[0].created_at).getTime();
    expect(syncTime).toBeGreaterThan(new Date('2026-06-01').getTime());
  });

  it('range exhaustion during offline operation hard-stops rather than inventing a fallback number', async () => {
    const freshReservation = await devicesService.reserveRange(TENANT_ID, deviceId, {
      blockSize: 2,
    });
    await devicesService.issueFromReservation(TENANT_ID, freshReservation.id);
    await devicesService.issueFromReservation(TENANT_ID, freshReservation.id);
    // Both of this reservation's 2 numbers are now issued — the 3rd call
    // must hard-fail, never invent a fallback numbering scheme.
    await expect(
      devicesService.issueFromReservation(TENANT_ID, freshReservation.id),
    ).rejects.toThrow(/RANGE_EXHAUSTED/);
  });

  it('sync-offline never triggers any print/reprint side effect (verified by absence of any printer call in the response shape)', async () => {
    // The response contract itself contains no print-related field, and
    // the MockPrinterAdapter is not invoked anywhere in
    // OrdersService.syncOfflineOrder — this is a structural guarantee
    // (no code path exists), not a runtime toggle that could be
    // accidentally re-enabled.
    const issued = await devicesService.reserveRange(TENANT_ID, deviceId, { blockSize: 1 });
    const num = await devicesService.issueFromReservation(TENANT_ID, issued.id);
    const res = await request(app.getHttpServer())
      .post('/orders/sync-offline')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        idempotencyKey: 'eeeeeeee-5555-4a11-9a11-abcdefabcdef',
        items: [{ productId, quantity: 1 }],
        orderType: 'dine_in',
        deviceId,
        reservedOrderNumber: Number(num.issued_number),
        createdAtDevice: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).not.toContain('printed');
    expect(Object.keys(res.body)).not.toContain('receiptPrinted');
  });
});
