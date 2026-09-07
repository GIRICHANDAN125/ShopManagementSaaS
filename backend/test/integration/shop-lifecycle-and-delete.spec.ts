import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { AppModule } from '../../src/app.module';

jest.setTimeout(60000);

describe('Shop Lifecycle Management & Password Security (Integration)', () => {
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

  const shopappPool = new Pool({
    connectionString: process.env.RUNTIME_DATABASE_URL,
  });

  const runId = crypto.randomUUID().slice(0, 8);
  const saUsername = `sa_lifecycle_${runId}`;

  // Safe UUID-only tracking for test fixtures
  const createdTenantIds: string[] = [];
  const createdSeqNames: string[] = [];

  let tenantA: { id: string; code: string; name: string; adminUser: string; adminPass: string };
  let tenantB: { id: string; code: string; name: string; adminUser: string; adminPass: string };

  beforeAll(async () => {
    // 1. Create dedicated Super Admin test user
    const passwordHash = await argon2.hash('SuperAdminTestPass123!', { type: argon2.argon2id });
    const saRes = await superAdminPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name, status)
       VALUES (gen_random_uuid(), NULL, $1, $2, 'SA Lifecycle Tester', 'active')
       RETURNING id`,
      [saUsername, passwordHash],
    );
    superAdminUserId = saRes.rows[0].id;

    // 2. Initialize Nest app
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    // 3. Authenticate Super Admin
    const saLoginRes = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: saUsername, password: 'SuperAdminTestPass123!' });
    expect(saLoginRes.status).toBe(200);
    superAdminToken = saLoginRes.body.accessToken;

    // 4. Provision Tenant A
    const nameA = `Shop_A_${runId}`;
    const userA = `admin_a_${runId}`;
    const passA = 'TempPassA123!';
    const resA = await request(app.getHttpServer())
      .post('/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ displayName: nameA, businessType: 'Bakery', adminUsername: userA, adminPassword: passA });
    expect(resA.status).toBe(201);
    tenantA = { id: resA.body.id, code: resA.body.code, name: nameA, adminUser: userA, adminPass: passA };
    createdTenantIds.push(tenantA.id);

    // 5. Provision Tenant B
    const nameB = `Shop_B_${runId}`;
    const userB = `admin_b_${runId}`;
    const passB = 'TempPassB123!';
    const resB = await request(app.getHttpServer())
      .post('/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ displayName: nameB, businessType: 'Cafe', adminUsername: userB, adminPassword: passB });
    expect(resB.status).toBe(201);
    tenantB = { id: resB.body.id, code: resB.body.code, name: nameB, adminUser: userB, adminPass: passB };
    createdTenantIds.push(tenantB.id);

    // Track sequences
    const seqRows = await cleanupPool.query(
      `SELECT order_sequence_name FROM tenants WHERE id IN ($1, $2)`,
      [tenantA.id, tenantB.id],
    );
    for (const r of seqRows.rows) {
      if (r.order_sequence_name) createdSeqNames.push(r.order_sequence_name);
    }
  });

  afterAll(async () => {
    // Exact UUID cleanup only - never deletes by display name
    for (const tid of createdTenantIds) {
      try {
        await superAdminPool.query(`SELECT delete_tenant_cascade($1)`, [tid]);
      } catch {
        // Fallback cleanup if delete_tenant_cascade fails
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
        await cleanupPool.query(`DELETE FROM tenants WHERE id = $1`, [tid]);
      }
    }

    for (const seq of createdSeqNames) {
      await cleanupPool.query(`DROP SEQUENCE IF EXISTS ${seq};`);
    }

    if (superAdminUserId) {
      await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id = $1`, [superAdminUserId]);
      await cleanupPool.query(`DELETE FROM users WHERE id = $1`, [superAdminUserId]);
    }

    if (app) await app.close();
    await cleanupPool.end();
    await superAdminPool.end();
    await shopappPool.end();
  });

  describe('1. Shop Deactivation and Reactivation', () => {
    let tenantAToken: string;

    beforeAll(async () => {
      // Login to Tenant A and create a product while active
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ shopCode: tenantA.code, username: tenantA.adminUser, password: tenantA.adminPass });
      expect(loginRes.status).toBe(200);
      tenantAToken = loginRes.body.accessToken;

      // Complete initial forced password change so we can test normal operational access
      const changeRes = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ currentPassword: tenantA.adminPass, newPassword: 'PermanentPassA123!' });
      expect(changeRes.status).toBe(200);
      tenantAToken = changeRes.body.accessToken;
      tenantA.adminPass = 'PermanentPassA123!';

      // Create a test product
      const prodRes = await request(app.getHttpServer())
        .post('/catalog/products')
        .set('Authorization', `Bearer ${tenantAToken}`)
        .send({ name: 'Croissant', price: 45.0 });
      expect(prodRes.status).toBe(201);
    });

    it('Super Admin can deactivate an active shop', async () => {
      const deactRes = await request(app.getHttpServer())
        .post('/super-admin/tenants/status')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ tenantId: tenantA.id, status: 'inactive' });

      expect(deactRes.status).toBe(201);
      expect(deactRes.body.status).toBe('inactive');

      // Verify in DB
      const dbRes = await cleanupPool.query(`SELECT status FROM tenants WHERE id = $1`, [tenantA.id]);
      expect(dbRes.rows[0].status).toBe('inactive');
    });

    it('Deactivated shop rejects new logins for Shop Admin', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ shopCode: tenantA.code, username: tenantA.adminUser, password: tenantA.adminPass });

      expect(loginRes.status).toBe(401);
      expect(loginRes.body.message).toMatch(/inactive shop|Invalid shop code/i);
    });

    it('Deactivated shop immediately rejects existing JWT tokens via JwtStrategy', async () => {
      // Calling an authenticated endpoint with the pre-issued token must fail with 401
      const apiRes = await request(app.getHttpServer())
        .get('/catalog/products')
        .set('Authorization', `Bearer ${tenantAToken}`);

      expect(apiRes.status).toBe(401);
      expect(apiRes.body.message).toMatch(/Shop is inactive or does not exist/i);
    });

    it('Deactivating a shop does NOT delete tenant data', async () => {
      // Verify products, categories, users, roles remain in PostgreSQL
      const prodCount = await cleanupPool.query(`SELECT count(*) FROM products WHERE tenant_id = $1`, [tenantA.id]);
      expect(Number(prodCount.rows[0].count)).toBeGreaterThanOrEqual(1);

      const userCount = await cleanupPool.query(`SELECT count(*) FROM users WHERE tenant_id = $1`, [tenantA.id]);
      expect(Number(userCount.rows[0].count)).toBeGreaterThanOrEqual(1);

      const roleCount = await cleanupPool.query(`SELECT count(*) FROM roles WHERE tenant_id = $1`, [tenantA.id]);
      expect(Number(roleCount.rows[0].count)).toBeGreaterThanOrEqual(1);
    });

    it('Super Admin can reactivate the shop and restore normal access', async () => {
      const actRes = await request(app.getHttpServer())
        .post('/super-admin/tenants/status')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ tenantId: tenantA.id, status: 'active' });

      expect(actRes.status).toBe(201);
      expect(actRes.body.status).toBe('active');

      // Now login succeeds again
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ shopCode: tenantA.code, username: tenantA.adminUser, password: tenantA.adminPass });

      expect(loginRes.status).toBe(200);
      const newToken = loginRes.body.accessToken;

      // API access works normally
      const apiRes = await request(app.getHttpServer())
        .get('/catalog/products')
        .set('Authorization', `Bearer ${newToken}`);

      expect(apiRes.status).toBe(200);
      expect(Array.isArray(apiRes.body)).toBe(true);
      expect(apiRes.body.some((p: any) => p.name === 'Croissant')).toBe(true);
    });
  });

  describe('2. Non-Super-Admin Authorization & Isolation Protection', () => {
    let tenantBToken: string;

    beforeAll(async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ shopCode: tenantB.code, username: tenantB.adminUser, password: tenantB.adminPass });
      tenantBToken = loginRes.body.accessToken;
    });

    it('Shop Admin cannot deactivate a shop', async () => {
      const res = await request(app.getHttpServer())
        .post('/super-admin/tenants/status')
        .set('Authorization', `Bearer ${tenantBToken}`)
        .send({ tenantId: tenantA.id, status: 'inactive' });

      expect(res.status).toBe(403);
    });

    it('Shop Admin cannot delete a shop', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/super-admin/tenants/${tenantA.id}`)
        .set('Authorization', `Bearer ${tenantBToken}`);

      expect(res.status).toBe(403);
    });

    it('Unauthenticated request cannot deactivate or delete a shop', async () => {
      const deact = await request(app.getHttpServer())
        .post('/super-admin/tenants/status')
        .send({ tenantId: tenantA.id, status: 'inactive' });
      expect(deact.status).toBe(401);

      const del = await request(app.getHttpServer())
        .delete(`/super-admin/tenants/${tenantA.id}`);
      expect(del.status).toBe(401);
    });
  });

  describe('3. Permanent Deletion and Cascade Isolation', () => {
    beforeAll(async () => {
      // Ensure Tenant B has products and counters so we can prove they survive Tenant A deletion
      // Complete Tenant B initial password change
      const bLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ shopCode: tenantB.code, username: tenantB.adminUser, password: tenantB.adminPass });
      const bChange = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${bLogin.body.accessToken}`)
        .send({ currentPassword: tenantB.adminPass, newPassword: 'PermanentPassB123!' });
      const bToken = bChange.body.accessToken;

      await request(app.getHttpServer())
        .post('/catalog/products')
        .set('Authorization', `Bearer ${bToken}`)
        .send({ name: 'Espresso Roast', price: 120.0 });
    });

    it('Permanent deletion requires valid UUID and rejects non-UUID strings', async () => {
      const res = await request(app.getHttpServer())
        .delete('/super-admin/tenants/invalid-non-uuid-string')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/UUID/i);
    });

    it('Permanent deletion returns 404 for non-existent UUID', async () => {
      const fakeUuid = crypto.randomUUID();
      const res = await request(app.getHttpServer())
        .delete(`/super-admin/tenants/${fakeUuid}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(404);
    });

    it('Super Admin can permanently delete target shop (Tenant A) by exact UUID', async () => {
      const deleteRes = await request(app.getHttpServer())
        .delete(`/super-admin/tenants/${tenantA.id}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // Verify Tenant A is completely removed from tenants table
      const tenantCheck = await cleanupPool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantA.id]);
      expect(tenantCheck.rowCount).toBe(0);

      // Verify Tenant A child records were cascaded
      const prodA = await cleanupPool.query(`SELECT id FROM products WHERE tenant_id = $1`, [tenantA.id]);
      expect(prodA.rowCount).toBe(0);

      const usersA = await cleanupPool.query(`SELECT id FROM users WHERE tenant_id = $1`, [tenantA.id]);
      expect(usersA.rowCount).toBe(0);

      const limitsA = await cleanupPool.query(`SELECT tenant_id FROM tenant_resource_limits WHERE tenant_id = $1`, [tenantA.id]);
      expect(limitsA.rowCount).toBe(0);
    });

    it('CRITICAL REGRESSION: Deleting Tenant A leaves Tenant B completely untouched', async () => {
      // Tenant B still exists in tenants table
      const tenantBCheck = await cleanupPool.query(
        `SELECT id, code, display_name, status FROM tenants WHERE id = $1`,
        [tenantB.id],
      );
      expect(tenantBCheck.rowCount).toBe(1);
      expect(tenantBCheck.rows[0].display_name).toBe(tenantB.name);

      // Tenant B products still exist
      const prodB = await cleanupPool.query(
        `SELECT id, name, price FROM products WHERE tenant_id = $1 AND name = 'Espresso Roast'`,
        [tenantB.id],
      );
      expect(prodB.rowCount).toBe(1);

      // Tenant B users still exist
      const usersB = await cleanupPool.query(
        `SELECT id, username FROM users WHERE tenant_id = $1 AND username = $2`,
        [tenantB.id, tenantB.adminUser],
      );
      expect(usersB.rowCount).toBe(1);
    });

    it('Platform-level audit record for deletion survives with tenant_id NULL', async () => {
      const auditRes = await cleanupPool.query(
        `SELECT id, tenant_id, actor_user_id, action, entity_type, entity_id, metadata
         FROM audit_logs
         WHERE tenant_id IS NULL AND action = 'tenant.delete' AND entity_id = $1`,
        [tenantA.id],
      );

      expect(auditRes.rowCount).toBeGreaterThanOrEqual(1);
      const log = auditRes.rows[0];
      expect(log.tenant_id).toBeNull();
      expect(log.entity_id).toBe(tenantA.id);
      expect(log.metadata?.code).toBe(tenantA.code);
      expect(log.metadata?.result).toBe('success');
    });
  });

  describe('4. Shop Admin Password Security & Forced First-Login Change', () => {
    let tenantC: { id: string; code: string; name: string; adminUser: string; adminPass: string };
    let tempToken: string;

    beforeAll(async () => {
      const nameC = `Shop_C_${runId}`;
      const userC = `admin_c_${runId}`;
      const resC = await request(app.getHttpServer())
        .post('/super-admin/tenants')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ displayName: nameC, businessType: 'Bakery', adminUsername: userC });
      expect(resC.status).toBe(201);

      tenantC = {
        id: resC.body.id,
        code: resC.body.code,
        name: nameC,
        adminUser: userC,
        adminPass: resC.body.initial_credentials.temporary_password,
      };
      createdTenantIds.push(tenantC.id);

      const seqRow = await cleanupPool.query(`SELECT order_sequence_name FROM tenants WHERE id = $1`, [tenantC.id]);
      if (seqRow.rows[0]?.order_sequence_name) createdSeqNames.push(seqRow.rows[0].order_sequence_name);
    });

    it('New Shop Admin is flagged with must_change_password = true in database', async () => {
      const dbUser = await cleanupPool.query(
        `SELECT must_change_password FROM users WHERE tenant_id = $1 AND username = $2`,
        [tenantC.id, tenantC.adminUser],
      );
      expect(dbUser.rowCount).toBe(1);
      expect(dbUser.rows[0].must_change_password).toBe(true);
    });

    it('Login with temporary password returns mustChangePassword: true in user and token', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ shopCode: tenantC.code, username: tenantC.adminUser, password: tenantC.adminPass });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.mustChangePassword).toBe(true);
      tempToken = loginRes.body.accessToken;
    });

    it('Backend blocks operational endpoints when mustChangePassword is true', async () => {
      // Attempting to access operational endpoints before changing password must return 403
      const orderRes = await request(app.getHttpServer())
        .get('/catalog/products')
        .set('Authorization', `Bearer ${tempToken}`);

      expect(orderRes.status).toBe(403);
      expect(orderRes.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('Calling /auth/change-password with invalid current password fails', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${tempToken}`)
        .send({ currentPassword: 'WrongTemporaryPassword!', newPassword: 'NewSecurePass999!' });

      expect(res.status).toBe(401);
    });

    it('Calling /auth/change-password with same password fails with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${tempToken}`)
        .send({ currentPassword: tenantC.adminPass, newPassword: tenantC.adminPass });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/different/i);
    });

    it('Changing password successfully clears must_change_password and unblocks operational access', async () => {
      const newPermanentPass = 'NewPermanentPassword123!';
      const changeRes = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${tempToken}`)
        .send({ currentPassword: tenantC.adminPass, newPassword: newPermanentPass });

      expect(changeRes.status).toBe(200);
      expect(changeRes.body.success).toBe(true);
      const permToken = changeRes.body.accessToken;

      // Verify DB has must_change_password = false
      const dbUser = await cleanupPool.query(
        `SELECT must_change_password FROM users WHERE tenant_id = $1 AND username = $2`,
        [tenantC.id, tenantC.adminUser],
      );
      expect(dbUser.rows[0].must_change_password).toBe(false);

      // Verify operational access is now unblocked
      const catalogRes = await request(app.getHttpServer())
        .get('/catalog/products')
        .set('Authorization', `Bearer ${permToken}`);

      expect(catalogRes.status).toBe(200);

      // Self-service: Shop Admin can later change password again at will
      const laterChange = await request(app.getHttpServer())
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${permToken}`)
        .send({ currentPassword: newPermanentPass, newPassword: 'EvenNewerPassword456!' });

      expect(laterChange.status).toBe(200);
      expect(laterChange.body.success).toBe(true);
    });
  });
});
