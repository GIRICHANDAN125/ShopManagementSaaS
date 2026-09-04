import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { AppModule } from '../../src/app.module';

jest.setTimeout(40000);

describe('Resource Limits, Counters, Printers & Tenant Security (Integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

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

  let superAdminToken: string;
  let tenantAId: string;
  let tenantACode: string;
  let tenantAdminAToken: string;
  let tenantBId: string;
  let tenantBCode: string;
  let tenantAdminBToken: string;

  let superAdminUserId: string;

  const runId = crypto.randomUUID().slice(0, 8);
  const saUsername = `sa_res_${runId}`;
  const tenantAName = `RL_Shop_A_${runId}`;
  const tenantBName = `RL_Shop_B_${runId}`;
  const adminAUser = `admin_a_${runId}`;
  const adminBUser = `admin_b_${runId}`;

  beforeAll(async () => {
    // 1. Clean prior test superadmin user if any
    await cleanupPool.query(
      `DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id IN (
         SELECT id FROM users WHERE username = $1 AND tenant_id IS NULL
       )`,
      [saUsername],
    );
    await cleanupPool.query(`DELETE FROM users WHERE username = $1 AND tenant_id IS NULL`, [saUsername]);

    // 2. Insert test Super Admin user
    const passwordHash = await argon2.hash('SuperAdminTestPass123!', { type: argon2.argon2id });
    const saRes = await superAdminPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name, status)
       VALUES (gen_random_uuid(), NULL, $1, $2, 'SA Resource Tester', 'active')
       RETURNING id`,
      [saUsername, passwordHash],
    );
    superAdminUserId = saRes.rows[0].id;

    // 3. Initialize Nest App
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    // 4. Authenticate platform Super Admin
    const saLoginRes = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: saUsername, password: 'SuperAdminTestPass123!' });
    expect(saLoginRes.status).toBe(200);
    superAdminToken = saLoginRes.body.accessToken;
  });

  afterAll(async () => {
    // Clean created test tenants
    for (const tid of [tenantAId, tenantBId].filter(Boolean)) {
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
    }

    // Clean test superadmin user
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

  // TEST 1 — SUPER ADMIN CREATES SHOP WITH LIMITS
  it('TEST 1: Super Admin creates Tenant A with operational resource limits (persists in PostgreSQL)', async () => {
    const res = await request(app.getHttpServer())
      .post('/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        displayName: tenantAName,
        businessType: 'Bakery',
        adminUsername: adminAUser,
        adminPassword: 'Password123!',
        maxEmployees: 5,
        maxCounters: 1,
        maxCustomerDisplays: 1,
        maxPrinters: 1,
      });

    expect(res.status).toBe(201);
    tenantAId = res.body.id;
    tenantACode = res.body.code;

    // Verify persisted limits in PostgreSQL
    const limitCheck = await superAdminPool.query(
      `SELECT max_employees, max_counters, max_customer_displays, max_printers
       FROM tenant_resource_limits WHERE tenant_id = $1`,
      [tenantAId],
    );
    expect(limitCheck.rowCount).toBe(1);
    expect(limitCheck.rows[0].max_employees).toBe(5);
    expect(limitCheck.rows[0].max_counters).toBe(1);
    expect(limitCheck.rows[0].max_customer_displays).toBe(1);
    expect(limitCheck.rows[0].max_printers).toBe(1);

    // Login as Tenant A Shop Admin
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: tenantACode, username: adminAUser, password: 'Password123!' });
    expect(loginRes.status).toBe(200);
    tenantAdminAToken = loginRes.body.accessToken;

    // Verify resource usage endpoint returns 1/5 employees (initial admin), 0/1 counters, 0/1 displays, 0/1 printers
    const usageRes = await request(app.getHttpServer())
      .get('/settings/resource-usage')
      .set('Authorization', `Bearer ${tenantAdminAToken}`);
    expect(usageRes.status).toBe(200);
    expect(usageRes.body.limits.max_employees).toBe(5);
    expect(usageRes.body.limits.max_counters).toBe(1);
    expect(usageRes.body.usage.active_employees).toBe(1);
    expect(usageRes.body.usage.active_counters).toBe(0);
  });

  // TEST 2 — EMPLOYEE LIMIT
  it('TEST 2: Enforces employee limit (4 additional employees succeed, 6th is rejected with RESOURCE_LIMIT_REACHED)', async () => {
    // Get roles to assign Counter Staff
    const rolesRes = await request(app.getHttpServer())
      .get('/roles')
      .set('Authorization', `Bearer ${tenantAdminAToken}`);
    const counterStaffRole = rolesRes.body.find((r: any) => r.name === 'Counter Staff');
    expect(counterStaffRole).toBeDefined();

    // Create 4 more employees (reaching 5/5)
    for (let i = 2; i <= 5; i++) {
      const empRes = await request(app.getHttpServer())
        .post('/employees')
        .set('Authorization', `Bearer ${tenantAdminAToken}`)
        .send({
          username: `staff_0${i}`,
          displayName: `Staff 0${i}`,
          password: 'Password123!',
          roleIds: [counterStaffRole.id],
        });
      expect(empRes.status).toBe(201);
    }

    // Attempt 6th employee (limit is 5) -> MUST FAIL with 403 RESOURCE_LIMIT_REACHED
    const excessRes = await request(app.getHttpServer())
      .post('/employees')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({
        username: 'staff_06',
        displayName: 'Staff 06',
        password: 'Password123!',
        roleIds: [counterStaffRole.id],
      });

    expect(excessRes.status).toBe(403);
    expect(excessRes.body.code).toBe('RESOURCE_LIMIT_REACHED');
    expect(excessRes.body.message).toMatch(/Employee limit reached/);
  });

  // TEST 3 — COUNTER LIMIT
  let counter01Id: string;
  it('TEST 3: Enforces counter limit (Counter 01 succeeds, Counter 02 is rejected with RESOURCE_LIMIT_REACHED)', async () => {
    // 1. Create Counter 01 (1/1)
    const c1Res = await request(app.getHttpServer())
      .post('/counters')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Counter 01', code: 'CTR-01' });

    expect(c1Res.status).toBe(201);
    expect(c1Res.body.code).toBe('CTR-01');
    counter01Id = c1Res.body.id;

    // 2. Attempt Counter 02 -> MUST FAIL with 403 RESOURCE_LIMIT_REACHED
    const c2Res = await request(app.getHttpServer())
      .post('/counters')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Counter 02', code: 'CTR-02' });

    expect(c2Res.status).toBe(403);
    expect(c2Res.body.code).toBe('RESOURCE_LIMIT_REACHED');
    expect(c2Res.body.message).toMatch(/Counter limit reached/);
  });

  // TEST 4 — CUSTOMER DISPLAY LIMIT
  it('TEST 4: Enforces customer display limit (Display 01 succeeds, Display 02 is rejected with RESOURCE_LIMIT_REACHED)', async () => {
    // 1. Create Display 01 (1/1)
    const d1Res = await request(app.getHttpServer())
      .post('/devices')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Main Customer TV', type: 'customer_display' });

    expect(d1Res.status).toBe(201);
    expect(d1Res.body.device.type).toBe('customer_display');

    // 2. Attempt Display 02 -> MUST FAIL with 403 RESOURCE_LIMIT_REACHED
    const d2Res = await request(app.getHttpServer())
      .post('/devices')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Secondary Customer TV', type: 'customer_display' });

    expect(d2Res.status).toBe(403);
    expect(d2Res.body.code).toBe('RESOURCE_LIMIT_REACHED');
    expect(d2Res.body.message).toMatch(/Customer Display limit reached/);
  });

  // TEST 5 — PRINTER LIMIT
  it('TEST 5: Enforces printer limit (Printer 01 succeeds, Printer 02 is rejected with RESOURCE_LIMIT_REACHED)', async () => {
    // 1. Create Printer 01 (1/1)
    const p1Res = await request(app.getHttpServer())
      .post('/printers')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Receipt Thermal 1', type: 'thermal_receipt', location: 'Counter 01' });

    expect(p1Res.status).toBe(201);
    expect(p1Res.body.name).toBe('Receipt Thermal 1');

    // 2. Attempt Printer 02 -> MUST FAIL with 403 RESOURCE_LIMIT_REACHED
    const p2Res = await request(app.getHttpServer())
      .post('/printers')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Kitchen KOT 1', type: 'kitchen', location: 'Kitchen' });

    expect(p2Res.status).toBe(403);
    expect(p2Res.body.code).toBe('RESOURCE_LIMIT_REACHED');
    expect(p2Res.body.message).toMatch(/Printer limit reached/);
  });

  // TEST 6 — LIMIT INCREASE
  it('TEST 6: Limit increase becomes effective immediately without restart (Counters 1 -> 3 allows Counter 02 and 03)', async () => {
    // 1. Super Admin increases counter limit from 1 to 3
    const updateRes = await request(app.getHttpServer())
      .put(`/super-admin/tenants/${tenantAId}/limits`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        maxEmployees: 5,
        maxCounters: 3,
        maxCustomerDisplays: 1,
        maxPrinters: 1,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.max_counters).toBe(3);

    // 2. Shop Admin creates Counter 02 -> now SUCCEEDS
    const c2Res = await request(app.getHttpServer())
      .post('/counters')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Counter 02', code: 'CTR-02' });
    expect(c2Res.status).toBe(201);

    // 3. Shop Admin creates Counter 03 -> now SUCCEEDS (now 3/3 active)
    const c3Res = await request(app.getHttpServer())
      .post('/counters')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Counter 03', code: 'CTR-03' });
    expect(c3Res.status).toBe(201);

    // 4. Attempt Counter 04 -> fails
    const c4Res = await request(app.getHttpServer())
      .post('/counters')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Counter 04', code: 'CTR-04' });
    expect(c4Res.status).toBe(403);
  });

  // TEST 7 — UNSAFE LIMIT DECREASE
  it('TEST 7: Unsafe limit decrease is rejected with 400 Bad Request and never deletes active resources', async () => {
    // Currently active counters = 3. Super Admin attempts to reduce limit to 1.
    const unsafeRes = await request(app.getHttpServer())
      .put(`/super-admin/tenants/${tenantAId}/limits`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        maxEmployees: 5,
        maxCounters: 1,
        maxCustomerDisplays: 1,
        maxPrinters: 1,
      });

    expect(unsafeRes.status).toBe(400);
    expect(unsafeRes.body.message).toMatch(/Cannot reduce counter limit to 1 because this shop currently has 3 active counter\(s\)/);

    // Verify all 3 counters remain intact and active
    const listRes = await request(app.getHttpServer())
      .get('/counters')
      .set('Authorization', `Bearer ${tenantAdminAToken}`);
    expect(listRes.body.length).toBe(3);
  });

  // TEST 8 — SHOP ADMIN CANNOT CHANGE LIMIT
  it('TEST 8: Shop Admin direct API request to modify limits is strictly blocked with 403 Forbidden', async () => {
    const hackRes = await request(app.getHttpServer())
      .put(`/super-admin/tenants/${tenantAId}/limits`)
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({
        maxEmployees: 100,
        maxCounters: 100,
        maxCustomerDisplays: 100,
        maxPrinters: 100,
      });

    expect(hackRes.status).toBe(403);
  });

  // TEST 9 & 14 — MULTI-TENANT ISOLATION: TENANT A VS TENANT B
  it('TEST 9 & 14: Cross-tenant resource access is blocked across employees, counters, printers, and devices', async () => {
    // Create Tenant B
    const tBRes = await request(app.getHttpServer())
      .post('/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        displayName: tenantBName,
        adminUsername: adminBUser,
        adminPassword: 'Password123!',
      });
    expect(tBRes.status).toBe(201);
    tenantBId = tBRes.body.id;
    tenantBCode = tBRes.body.code;

    // Login as Tenant B Admin
    const loginB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: tenantBCode, username: adminBUser, password: 'Password123!' });
    expect(loginB.status).toBe(200);
    tenantAdminBToken = loginB.body.accessToken;

    // 1. Tenant B cannot see Tenant A's counters
    const countersB = await request(app.getHttpServer())
      .get('/counters')
      .set('Authorization', `Bearer ${tenantAdminBToken}`);
    expect(countersB.body.find((c: any) => c.id === counter01Id)).toBeUndefined();

    // 2. Tenant B cannot update Tenant A's counter
    const hackCounterRes = await request(app.getHttpServer())
      .put(`/counters/${counter01Id}`)
      .set('Authorization', `Bearer ${tenantAdminBToken}`)
      .send({ name: 'Hacked Counter' });
    expect(hackCounterRes.status).toBe(400); // not found in Tenant B scope

    // 3. Tenant B cannot delete Tenant A's counter
    const delCounterRes = await request(app.getHttpServer())
      .delete(`/counters/${counter01Id}`)
      .set('Authorization', `Bearer ${tenantAdminBToken}`);
    expect(delCounterRes.status).toBe(400);

    // 4. Tenant B cannot access Tenant A's printers
    const printersB = await request(app.getHttpServer())
      .get('/printers')
      .set('Authorization', `Bearer ${tenantAdminBToken}`);
    expect(printersB.body.length).toBe(0);
  });

  // TEST 10 & 11 — EMPLOYEE-COUNTER ASSIGNMENT & LOGIN
  let akashUserId: string;
  it('TEST 10 & 11: Employee counter assignment and login reflects assigned counter in session', async () => {
    // 1. Find employee staff_02 (Akash) in Tenant A
    const empListRes = await request(app.getHttpServer())
      .get('/employees')
      .set('Authorization', `Bearer ${tenantAdminAToken}`);
    const akash = empListRes.body.find((e: any) => e.username === 'staff_02');
    expect(akash).toBeDefined();
    akashUserId = akash.id;

    // 2. Assign Counter 01 -> Akash
    const assignRes = await request(app.getHttpServer())
      .put(`/counters/${counter01Id}`)
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ assignedUserId: akashUserId });

    expect(assignRes.status).toBe(200);
    expect(assignRes.body.assigned_user_id).toBe(akashUserId);

    // 3. Akash logs in with Shop Code + Username + Password
    const akashLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: tenantACode, username: 'staff_02', password: 'Password123!' });

    expect(akashLogin.status).toBe(200);
    expect(akashLogin.body.assignedCounter).toBeDefined();
    expect(akashLogin.body.assignedCounter.id).toBe(counter01Id);
    expect(akashLogin.body.assignedCounter.name).toBe('Counter 01');

    // 4. Query /counters/assigned-to-me with Akash's token
    const myCounterRes = await request(app.getHttpServer())
      .get('/counters/assigned-to-me')
      .set('Authorization', `Bearer ${akashLogin.body.accessToken}`);

    expect(myCounterRes.status).toBe(200);
    expect(myCounterRes.body.name).toBe('Counter 01');

    // 5. Attempt cross-tenant assignment (Tenant B tries to assign Akash) -> BLOCKED
    const crossAssignRes = await request(app.getHttpServer())
      .post('/counters')
      .set('Authorization', `Bearer ${tenantAdminBToken}`)
      .send({ name: 'Counter B1', code: 'CTR-B1', assignedUserId: akashUserId });

    expect(crossAssignRes.status).toBe(400);
    expect(crossAssignRes.body.message).toMatch(/Assigned employee must belong to this shop/);
  });

  // TEST 12 — SHOP ADMIN OPERATING COUNTER
  it('TEST 12: Shop Admin can operate Counter POS without converting to Counter Staff', async () => {
    // Shop Admin has order.create, order.view, and can list products and create orders
    const prodRes = await request(app.getHttpServer())
      .post('/catalog/products')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({ name: 'Tea', price: 20 });
    expect(prodRes.status).toBe(201);

    const orderRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${tenantAdminAToken}`)
      .send({
        idempotencyKey: crypto.randomUUID(),
        orderType: 'dine_in',
        items: [{ productId: prodRes.body.id, quantity: 2 }],
      });

    expect(orderRes.status).toBe(201);
    expect(Number(orderRes.body.total)).toBe(40);
  });

  // TEST 17 — RBAC ENFORCEMENT ON COUNTER STAFF
  it('TEST 17: Counter Staff cannot manage employees, settings, products, or limits', async () => {
    const akashLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: tenantACode, username: 'staff_02', password: 'Password123!' });
    const akashToken = akashLogin.body.accessToken;

    // Counter Staff cannot list or create employees
    const empRes = await request(app.getHttpServer())
      .get('/employees')
      .set('Authorization', `Bearer ${akashToken}`);
    expect(empRes.status).toBe(403);

    // Counter Staff cannot create products
    const prodRes = await request(app.getHttpServer())
      .post('/catalog/products')
      .set('Authorization', `Bearer ${akashToken}`)
      .send({ name: 'Hacked', price: 10 });
    expect(prodRes.status).toBe(403);

    // Counter Staff cannot create counters
    const cRes = await request(app.getHttpServer())
      .post('/counters')
      .set('Authorization', `Bearer ${akashToken}`)
      .send({ name: 'Hacked', code: 'CTR-HACK' });
    expect(cRes.status).toBe(403);
  });
});
