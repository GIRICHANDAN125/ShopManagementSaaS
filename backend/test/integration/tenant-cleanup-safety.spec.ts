import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { AppModule } from '../../src/app.module';

jest.setTimeout(40000);

describe('Tenant Cleanup Safety & Preservation Regression (Integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let superAdminToken: string;
  let superAdminUserId: string;

  const cleanupPool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'shopapp_dev',
    user: 'postgres',
    password: process.env.TEST_SUPERUSER_DB_PASSWORD,
  });

  const superAdminPool = new Pool({
    connectionString: process.env.SUPERADMIN_DATABASE_URL,
  });

  const runId = crypto.randomUUID().slice(0, 8);
  const saUsername = `sa_safety_${runId}`;

  let testTenantId: string;
  let testTenantCode: string;

  beforeAll(async () => {
    // Ensure test superadmin is cleanly created
    const passwordHash = await argon2.hash('SuperAdminTestPass123!', { type: argon2.argon2id });
    const saRes = await superAdminPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name, status)
       VALUES (gen_random_uuid(), NULL, $1, $2, 'SA Safety Tester', 'active')
       RETURNING id`,
      [saUsername, passwordHash],
    );
    superAdminUserId = saRes.rows[0].id;

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const saLoginRes = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: saUsername, password: 'SuperAdminTestPass123!' });
    expect(saLoginRes.status).toBe(200);
    superAdminToken = saLoginRes.body.accessToken;
  });

  afterAll(async () => {
    // Clean up test superadmin user
    if (superAdminUserId) {
      await cleanupPool.query(
        `DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id = $1`,
        [superAdminUserId],
      );
      await cleanupPool.query(`DELETE FROM users WHERE id = $1`, [superAdminUserId]);
    }

    if (app) await app.close();
    await cleanupPool.end();
    await superAdminPool.end();
  });

  it('preserves pre-existing tenants (Giri Bakery, Test Coffee Shop) while test cleanup only removes test-created fixtures by exact ID', async () => {
    // 1. Verify pre-existing tenants exist BEFORE test fixture creation
    const giriBefore = await cleanupPool.query(
      `SELECT id, code, display_name, status FROM tenants WHERE display_name = 'Giri Bakery'`,
    );
    expect(giriBefore.rowCount).toBeGreaterThanOrEqual(1);
    const giriId = giriBefore.rows[0].id;

    const coffeeBefore = await cleanupPool.query(
      `SELECT id, code, display_name, status FROM tenants WHERE display_name = 'Test Coffee Shop'`,
    );
    expect(coffeeBefore.rowCount).toBeGreaterThanOrEqual(1);
    const coffeeId = coffeeBefore.rows[0].id;

    // 2. Create an isolated test tenant during this test run
    const testTenantName = `Safety_Test_Shop_${runId}`;
    const testAdminUser = `safety_admin_${runId}`;

    const createRes = await request(app.getHttpServer())
      .post('/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        displayName: testTenantName,
        businessType: 'Bakery',
        adminUsername: testAdminUser,
        adminPassword: 'Password123!',
        maxEmployees: 5,
        maxCounters: 1,
        maxCustomerDisplays: 1,
        maxPrinters: 1,
      });

    expect(createRes.status).toBe(201);
    testTenantId = createRes.body.id;
    testTenantCode = createRes.body.code;
    expect(testTenantId).toBeDefined();

    // Verify both pre-existing tenants and the new test tenant exist in PostgreSQL
    const allTenantsDuring = await cleanupPool.query(
      `SELECT id, display_name FROM tenants WHERE id IN ($1, $2, $3)`,
      [giriId, coffeeId, testTenantId],
    );
    expect(allTenantsDuring.rowCount).toBe(3);

    // 3. Perform ID-based test cleanup on the test-created tenant ONLY
    const tid = testTenantId;
    await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM order_items WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM order_status_history WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM products WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM categories WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM printers WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM device_order_reservations WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM device_tenant_lookup WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM devices WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM counters WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM tenant_resource_limits WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [tid]);
    await cleanupPool.query(`DELETE FROM users WHERE tenant_id = $1`, [tid]);
    await cleanupPool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)`, [tid]);
    await cleanupPool.query(`DELETE FROM roles WHERE tenant_id = $1`, [tid]);
    const tRow = await cleanupPool.query(`SELECT order_sequence_name FROM tenants WHERE id = $1`, [tid]);
    if (tRow.rowCount && tRow.rows[0].order_sequence_name) {
      await cleanupPool.query(`DROP SEQUENCE IF EXISTS ${tRow.rows[0].order_sequence_name}`);
    }
    await cleanupPool.query(`DELETE FROM tenants WHERE id = $1`, [tid]);

    // 4. Verify test tenant was completely removed
    const testTenantAfter = await cleanupPool.query(
      `SELECT id FROM tenants WHERE id = $1`,
      [testTenantId],
    );
    expect(testTenantAfter.rowCount).toBe(0);

    // 5. CRITICAL VERIFICATION: "Giri Bakery" and "Test Coffee Shop" STILL EXIST unharmed
    const giriAfter = await cleanupPool.query(
      `SELECT id, code, display_name, status FROM tenants WHERE id = $1`,
      [giriId],
    );
    expect(giriAfter.rowCount).toBe(1);
    expect(giriAfter.rows[0].display_name).toBe('Giri Bakery');
    expect(giriAfter.rows[0].status).toBe('active');

    const coffeeAfter = await cleanupPool.query(
      `SELECT id, code, display_name, status FROM tenants WHERE id = $1`,
      [coffeeId],
    );
    expect(coffeeAfter.rowCount).toBe(1);
    expect(coffeeAfter.rows[0].display_name).toBe('Test Coffee Shop');
    expect(coffeeAfter.rows[0].status).toBe('active');
  });
});
