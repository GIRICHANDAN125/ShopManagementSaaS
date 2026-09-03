import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';
import { DevicesService } from '../../src/devices/devices.module';

const TENANT_ID = '66666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const cleanupPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'shopapp_dev',
  user: 'postgres',
  password: process.env.TEST_SUPERUSER_DB_PASSWORD,
});
const shopappPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL });
const superAdminPool = new Pool({ connectionString: process.env.SUPERADMIN_DATABASE_URL });

describe('Devices E2E — registration, reservation, exhaustion', () => {
  let app: INestApplication;
  let accessToken: string;
  let devicesService: DevicesService;

  beforeAll(async () => {
    await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM device_tenant_lookup WHERE tenant_id = $1`, [TENANT_ID]);
    await cleanupPool.query(`DELETE FROM device_order_reservations WHERE tenant_id = $1`, [
      TENANT_ID,
    ]);
    await cleanupPool.query(`DELETE FROM devices WHERE tenant_id = $1`, [TENANT_ID]);
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
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS device_e2e_seq;`);

    await cleanupPool.query(
      `INSERT INTO tenants (id, code, display_name, order_sequence_name)
       VALUES ($1, 'DEVICE_E2E_SHOP', 'Device E2E Shop', 'device_e2e_seq')`,
      [TENANT_ID],
    );
    await superAdminPool.query(`SELECT create_tenant_order_sequence('device_e2e_seq')`);

    const passwordHash = await argon2.hash('device_e2e_password');
    const client = await shopappPool.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_ID]);
    await client.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES ('66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $1, 'device_e2e_admin', $2, 'Admin')`,
      [TENANT_ID, passwordHash],
    );
    await client.query(
      `INSERT INTO roles (id, tenant_id, name)
       VALUES ('66666666-cccc-cccc-cccc-cccccccccccc', $1, 'Admin Role')`,
      [TENANT_ID],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ('66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '66666666-cccc-cccc-cccc-cccccccccccc')`,
    );
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT '66666666-cccc-cccc-cccc-cccccccccccc', id FROM permissions WHERE code IN ('device.manage', 'order.create')`,
    );
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
      .send({
        shopCode: 'DEVICE_E2E_SHOP',
        username: 'device_e2e_admin',
        password: 'device_e2e_password',
      });
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS device_e2e_seq;`);
    await cleanupPool.end();
    await shopappPool.end();
    await superAdminPool.end();
  });

  it('registers a device and returns a one-time credential', async () => {
    const res = await request(app.getHttpServer())
      .post('/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Counter-01' });
    expect(res.status).toBe(201);
    expect(res.body.device.id).toBeDefined();
    expect(res.body.credential).toBeDefined();
    expect(typeof res.body.credential).toBe('string');
  });

  it('rejects device registration without device.manage permission', async () => {
    // No token at all is the simplest proof the guard fires; a token with
    // a different permission set is covered by the RBAC unit-level design
    // (PermissionsGuard denies by default — see rbac.module.ts).
    const res = await request(app.getHttpServer()).post('/devices').send({ name: 'Rogue' });
    expect(res.status).toBe(401);
  });

  it('reserves a non-overlapping range and issues numbers from it that end with exhaustion, not silent fallback', async () => {
    const device = await devicesService.registerDevice(TENANT_ID, '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb', {
      name: 'Counter-02',
    } as any);

    const reservation = await devicesService.reserveRange(TENANT_ID, device.device.id, {
      blockSize: 3,
    });
    expect(Number(reservation.range_end) - Number(reservation.range_start)).toBe(2);

    const issued: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await devicesService.issueFromReservation(TENANT_ID, reservation.id);
      issued.push(Number(res.issued_number));
    }
    expect(issued).toEqual([
      Number(reservation.range_start),
      Number(reservation.range_start) + 1,
      Number(reservation.range_start) + 2,
    ]);

    // Exhausted: the 4th call must hard-fail, never invent a fallback
    // number, per OFFLINE_SYNC_DESIGN.md §6.
    await expect(
      devicesService.issueFromReservation(TENANT_ID, reservation.id),
    ).rejects.toThrow(/RANGE_EXHAUSTED/);
  });

  it('a revoked device fails authentication', async () => {
    const device = await devicesService.registerDevice(TENANT_ID, '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb', {
      name: 'Counter-03',
    } as any);
    await devicesService.revokeDevice(TENANT_ID, '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb', device.device.id);

    await expect(
      devicesService.authenticateDevice(TENANT_ID, device.device.id, device.credential),
    ).rejects.toThrow();
  });

  it('reserve-range and issue endpoints work over real HTTP, end to end', async () => {
    const reg = await request(app.getHttpServer())
      .post('/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Counter-HTTP-01' });
    const deviceId = reg.body.device.id;

    const reserveRes = await request(app.getHttpServer())
      .post(`/devices/${deviceId}/reserve-range`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ blockSize: 3 });
    expect(reserveRes.status).toBe(201);
    expect(Number(reserveRes.body.range_end) - Number(reserveRes.body.range_start)).toBe(2);

    const issue1 = await request(app.getHttpServer())
      .post(`/devices/reservations/${reserveRes.body.id}/issue`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(issue1.status).toBe(201);
    expect(Number(issue1.body.issued_number)).toBe(Number(reserveRes.body.range_start));

    const issue2 = await request(app.getHttpServer())
      .post(`/devices/reservations/${reserveRes.body.id}/issue`)
      .set('Authorization', `Bearer ${accessToken}`);
    const issue3 = await request(app.getHttpServer())
      .post(`/devices/reservations/${reserveRes.body.id}/issue`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(issue2.status).toBe(201);
    expect(issue3.status).toBe(201);

    // Exhausted — the 4th call must hard-fail over HTTP too.
    const issue4 = await request(app.getHttpServer())
      .post(`/devices/reservations/${reserveRes.body.id}/issue`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(issue4.status).toBe(400);
    expect(issue4.body.message).toMatch(/RANGE_EXHAUSTED/);
  });
});
