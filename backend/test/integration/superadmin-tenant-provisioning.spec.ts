import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';
import { SuperAdminService } from '../../src/superadmin/superadmin.module';
import { DatabaseService } from '../../src/database/database.module';

jest.setTimeout(30000);

describe('Super Admin Tenant Provisioning & Compensation (Integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let superAdminService: SuperAdminService;
  let databaseService: DatabaseService;
  let superAdminToken: string;
  let superAdminUserId: string;

  const cleanupPool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'shopapp_dev',
    user: 'postgres',
    password: process.env.TEST_SUPERUSER_DB_PASSWORD,
  });

  const shopappPool = new Pool({
    connectionString: process.env.RUNTIME_DATABASE_URL,
  });

  const superAdminPool = new Pool({
    connectionString: process.env.SUPERADMIN_DATABASE_URL,
  });

  const createdTenantIds: string[] = [];
  const createdSeqNames: string[] = [];

  beforeAll(async () => {
    // 1. Clean up any previous test super admin fixture
    await cleanupPool.query(
      `DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id IN (
         SELECT id FROM users WHERE tenant_id IS NULL AND username = 'sa_provision_test'
       )`,
    );
    await cleanupPool.query(
      `DELETE FROM users WHERE tenant_id IS NULL AND username = 'sa_provision_test'`,
    );

    // 2. Insert test Super Admin user
    const passwordHash = await argon2.hash('SuperAdminTestPass123!', { type: argon2.argon2id });
    const saRes = await superAdminPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name, status)
       VALUES (gen_random_uuid(), NULL, 'sa_provision_test', $1, 'SA Provision Tester', 'active')
       RETURNING id`,
      [passwordHash],
    );
    superAdminUserId = saRes.rows[0].id;

    // 3. Initialize Nest application
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    superAdminService = moduleRef.get(SuperAdminService);
    databaseService = moduleRef.get(DatabaseService);

    // 4. Authenticate Super Admin to get JWT token
    const loginRes = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: 'sa_provision_test', password: 'SuperAdminTestPass123!' });

    expect(loginRes.status).toBe(200);
    superAdminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    // Clean up created tenants and sequences
    for (const tid of createdTenantIds) {
      await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM tenant_resource_limits WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [tid]);
      await cleanupPool.query(`DELETE FROM users WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)`, [tid]);
      await cleanupPool.query(`DELETE FROM roles WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM tenants WHERE id = $1`, [tid]);
    }

    for (const seq of createdSeqNames) {
      await cleanupPool.query(`DROP SEQUENCE IF EXISTS ${seq};`);
    }

    // Clean up test Super Admin fixture
    await cleanupPool.query(
      `DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id = $1`,
      [superAdminUserId],
    );
    await cleanupPool.query(`DELETE FROM users WHERE id = $1`, [superAdminUserId]);

    await app.close();
    await cleanupPool.end();
    await shopappPool.end();
    await superAdminPool.end();
  });

  it('provisions a new tenant with sequence, default roles, permissions, initial admin, and settings', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        displayName: 'Provisioned Bakery',
        businessType: 'Bakery & Cafe',
        adminUsername: 'bakery_admin',
        adminDisplayName: 'Bakery Main Admin',
      });

    expect(createRes.status).toBe(201);
    const body = createRes.body;

    // Verify response shape
    expect(body.id).toBeDefined();
    expect(body.code).toMatch(/^TENANT_[0-9A-F]{8}$/);
    expect(body.display_name).toBe('Provisioned Bakery');
    expect(body.status).toBe('active');
    expect(body.admin_user.username).toBe('bakery_admin');
    expect(body.admin_user.display_name).toBe('Bakery Main Admin');
    expect(body.initial_credentials.shop_code).toBe(body.code);
    expect(body.initial_credentials.username).toBe('bakery_admin');
    expect(typeof body.initial_credentials.temporary_password).toBe('string');
    expect(body.initial_credentials.temporary_password.length).toBeGreaterThanOrEqual(12);

    const tenantId = body.id;
    const tenantCode = body.code;
    const tempPassword = body.initial_credentials.temporary_password;
    const seqName = `order_seq_${tenantCode.toLowerCase()}`;

    createdTenantIds.push(tenantId);
    createdSeqNames.push(seqName);

    // 1. Verify PostgreSQL sequence creation and shopapp role usage grant
    const seqCheck = await cleanupPool.query(
      `SELECT sequencename FROM pg_sequences WHERE sequencename = $1`,
      [seqName],
    );
    expect(seqCheck.rowCount).toBe(1);

    // Verify shopapp pool can draw nextval from the sequence
    const nextValRes = await shopappPool.query(`SELECT nextval($1) AS num`, [seqName]);
    expect(Number(nextValRes.rows[0].num)).toBe(1);

    // 2. Verify default roles and permissions under tenant RLS
    const client = await shopappPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);

      // Verify roles
      const rolesRes = await client.query(
        `SELECT id, name FROM roles WHERE tenant_id = $1 ORDER BY name`,
        [tenantId],
      );
      const roleNames = rolesRes.rows.map((r) => r.name);
      expect(roleNames).toEqual(
        expect.arrayContaining(['Coordinator Staff', 'Counter Staff', 'Kitchen Staff', 'Shop Admin']),
      );

      // Verify Shop Admin role has expected permissions
      const shopAdminRoleId = rolesRes.rows.find((r) => r.name === 'Shop Admin')?.id;
      const permRes = await client.query(
        `SELECT p.code FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = $1`,
        [shopAdminRoleId],
      );
      const permCodes = permRes.rows.map((p) => p.code);
      expect(permCodes).toEqual(
        expect.arrayContaining([
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
          'receipt.reprint',
        ]),
      );

      // Verify initial admin user and user_roles link
      const userRes = await client.query(
        `SELECT id, username, display_name, status, tenant_id FROM users WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(userRes.rowCount).toBe(1);
      const user = userRes.rows[0];
      expect(user.username).toBe('bakery_admin');
      expect(user.status).toBe('active');
      expect(user.tenant_id).toBe(tenantId);

      const userRoleRes = await client.query(
        `SELECT role_id FROM user_roles WHERE user_id = $1`,
        [user.id],
      );
      expect(userRoleRes.rowCount).toBe(1);
      expect(userRoleRes.rows[0].role_id).toBe(shopAdminRoleId);

      // 3. Verify tenant_settings contain packing_config and workflow_config
      const settingsRes = await client.query(
        `SELECT key, value FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(settingsRes.rowCount).toBe(2);
      const settingsMap = Object.fromEntries(settingsRes.rows.map((r) => [r.key, r.value]));
      expect(settingsMap.packing_config).toEqual({ rule: 'none' });
      expect(settingsMap.workflow_config).toEqual({
        mode: 'direct',
        enabledModules: ['printer'],
      });

      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // 4. Verify login using returned temporary credentials works
    const tenantLoginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        shopCode: tenantCode,
        username: 'bakery_admin',
        password: tempPassword,
      });

    expect(tenantLoginRes.status).toBe(200);
    expect(tenantLoginRes.body.accessToken).toBeDefined();

    // 5. Verify tenant isolation: an unrelated tenant cannot see this tenant's rows
    const otherTenantId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const isoClient = await shopappPool.connect();
    try {
      await isoClient.query('BEGIN');
      await isoClient.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [otherTenantId]);

      const isoUsers = await isoClient.query(`SELECT * FROM users WHERE tenant_id = $1`, [tenantId]);
      expect(isoUsers.rowCount).toBe(0);

      const isoRoles = await isoClient.query(`SELECT * FROM roles WHERE tenant_id = $1`, [tenantId]);
      expect(isoRoles.rowCount).toBe(0);

      const isoSettings = await isoClient.query(`SELECT * FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
      expect(isoSettings.rowCount).toBe(0);

      await isoClient.query('COMMIT');
    } finally {
      isoClient.release();
    }
  });

  it('performs compensating rollback when provisioning fails after sequence creation and checks sequence state', async () => {
    // Intercept withTenant to throw an intentional error during Step 3
    const withTenantSpy = jest
      .spyOn(databaseService, 'withTenant')
      .mockImplementationOnce(async () => {
        throw new Error('Simulated Step 3 failure for compensating rollback test');
      });

    let thrownError: Error | null = null;
    try {
      await superAdminService.createTenant(superAdminUserId, {
        displayName: 'Compensating Rollback Shop',
        businessType: 'Cafe',
      });
    } catch (err: any) {
      thrownError = err;
    } finally {
      withTenantSpy.mockRestore();
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError?.message).toBe('Simulated Step 3 failure for compensating rollback test');

    // 1. Verify tenant was deleted from tenants table (compensating delete succeeded)
    const tenantCheck = await superAdminPool.query(
      `SELECT id, code, order_sequence_name FROM tenants WHERE display_name = 'Compensating Rollback Shop'`,
    );
    expect(tenantCheck.rowCount).toBe(0);

    // 2. Verify that the order sequence created in Step 2 was also cleaned up during compensating rollback
    const orphanCheck = await cleanupPool.query(
      `SELECT s.sequencename FROM pg_sequences s
       WHERE s.sequencename LIKE 'order_seq_tenant_%'
       AND NOT EXISTS (
         SELECT 1 FROM tenants t WHERE t.order_sequence_name = s.sequencename
       )`,
    );

    const orphanedSequences = orphanCheck.rows.map((r) => r.sequencename);
    // Verified: No orphaned sequences remain after compensating rollback!
    expect(orphanedSequences.length).toBe(0);
  });

  it('prevents arbitrary object deletion and validates sequence name format strictly', async () => {
    // 1. Rejects sequence names that do not follow the order_seq_<tenant_code> format
    await expect(
      superAdminPool.query(`SELECT drop_tenant_order_sequence('users')`),
    ).rejects.toThrow(/Invalid tenant order sequence name.*Expected order_seq_<tenant_code> format/);

    await expect(
      superAdminPool.query(`SELECT drop_tenant_order_sequence('order_seq_; DROP TABLE users;--')`),
    ).rejects.toThrow(/Invalid tenant order sequence name.*Expected order_seq_<tenant_code> format/);

    await expect(
      superAdminPool.query(`SELECT drop_tenant_order_sequence('some_arbitrary_seq')`),
    ).rejects.toThrow(/Invalid tenant order sequence name.*Expected order_seq_<tenant_code> format/);

    // 2. Rejects if target object is a table rather than a sequence
    await cleanupPool.query(`CREATE TABLE IF NOT EXISTS public.order_seq_fake_table (id int);`);
    try {
      await expect(
        superAdminPool.query(`SELECT drop_tenant_order_sequence('order_seq_fake_table')`),
      ).rejects.toThrow(/Object order_seq_fake_table is not a sequence/);
    } finally {
      await cleanupPool.query(`DROP TABLE IF EXISTS public.order_seq_fake_table;`);
    }

    // 3. Verifies that ordinary runtime role (shopapp) has NO grant to execute drop_tenant_order_sequence
    await expect(
      shopappPool.query(`SELECT drop_tenant_order_sequence('order_seq_tenant_test')`),
    ).rejects.toThrow(/permission denied for function drop_tenant_order_sequence/);
  });

  it('refuses to drop an order sequence that belongs to an active, existing tenant', async () => {
    // 1. Target the valid, active tenant sequence provisioned in the first test
    const activeTenantSeq = createdSeqNames[0];
    expect(activeTenantSeq).toBeDefined();

    // 2. SuperAdmin attempts to drop the active tenant's sequence
    await expect(
      superAdminPool.query(`SELECT drop_tenant_order_sequence($1)`, [activeTenantSeq]),
    ).rejects.toThrow(/Cannot drop sequence.*assigned to an active tenant/);

    // 3. Verify the sequence still exists in pg_sequences
    const seqCheck = await cleanupPool.query(
      `SELECT sequencename FROM pg_sequences WHERE sequencename = $1`,
      [activeTenantSeq],
    );
    expect(seqCheck.rowCount).toBe(1);

    // 4. Verify nextval still works on the active tenant sequence
    const nextValRes = await shopappPool.query(`SELECT nextval($1) AS num`, [activeTenantSeq]);
    expect(Number(nextValRes.rows[0].num)).toBeGreaterThan(0);
  });
});
