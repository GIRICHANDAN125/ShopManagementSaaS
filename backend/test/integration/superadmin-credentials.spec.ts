import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

jest.setTimeout(30000);

describe('Super Admin Credentials & Account Security (Integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let superAdminToken: string;
  let superAdminUserId: string;

  const cleanupPool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'shopapp_dev',
    user: 'postgres',
    password: process.env.TEST_SUPERUSER_DB_PASSWORD || 'postgres',
  });

  const superAdminPool = new Pool({
    connectionString: process.env.SUPERADMIN_DATABASE_URL,
  });

  const originalUsername = 'sa_cred_test';
  const updatedUsername = 'sa_cred_updated';
  const originalPassword = 'InitialSAPassword123!';
  const updatedPassword = 'NewSuperSecureSAPass456!';

  beforeAll(async () => {
    // 1. Clean up fixtures from previous runs
    await cleanupPool.query(
      `DELETE FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id IN (
         SELECT id FROM users WHERE tenant_id IS NULL AND username IN ($1, $2)
       )`,
      [originalUsername, updatedUsername],
    );
    await cleanupPool.query(
      `DELETE FROM users WHERE tenant_id IS NULL AND username IN ($1, $2)`,
      [originalUsername, updatedUsername],
    );

    // 2. Insert test Super Admin user
    const passwordHash = await argon2.hash(originalPassword, { type: argon2.argon2id });
    const saRes = await superAdminPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name, status)
       VALUES (gen_random_uuid(), NULL, $1, $2, 'SA Credential Tester', 'active')
       RETURNING id`,
      [originalUsername, passwordHash],
    );
    superAdminUserId = saRes.rows[0].id;

    // 3. Initialize NestJS app
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // 4. Authenticate to obtain token
    const loginRes = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: originalUsername, password: originalPassword });

    expect(loginRes.status).toBe(200);
    superAdminToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
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

  it('GET /super-admin/account/me returns profile without sensitive data', async () => {
    const res = await request(app.getHttpServer())
      .get('/super-admin/account/me')
      .set('Authorization', `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(superAdminUserId);
    expect(res.body.username).toBe(originalUsername);
    expect(res.body.display_name).toBe('SA Credential Tester');
    expect(res.body.status).toBe('active');
    expect(res.body.password_hash).toBeUndefined();
  });

  it('PUT /super-admin/account/username rejects mismatched current username', async () => {
    const res = await request(app.getHttpServer())
      .put('/super-admin/account/username')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        currentUsername: 'wrong_username',
        newUsername: updatedUsername,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Current username does not match');
  });

  it('PUT /super-admin/account/username rejects invalid username format', async () => {
    const res = await request(app.getHttpServer())
      .put('/super-admin/account/username')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        currentUsername: originalUsername,
        newUsername: 'invalid username with spaces!',
      });

    expect(res.status).toBe(400);
  });

  it('PUT /super-admin/account/username successfully changes username and records audit log', async () => {
    const res = await request(app.getHttpServer())
      .put('/super-admin/account/username')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        currentUsername: originalUsername,
        newUsername: updatedUsername,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify DB update
    const dbUser = await superAdminPool.query(
      `SELECT username FROM users WHERE id = $1`,
      [superAdminUserId],
    );
    expect(dbUser.rows[0].username).toBe(updatedUsername);

    // Verify Audit Log
    const auditRes = await superAdminPool.query(
      `SELECT action, metadata FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id = $1 AND action = 'superadmin.change_username'`,
      [superAdminUserId],
    );
    expect(auditRes.rowCount).toBeGreaterThan(0);
    expect(auditRes.rows[0].metadata.oldUsername).toBe(originalUsername);
    expect(auditRes.rows[0].metadata.newUsername).toBe(updatedUsername);
  });

  it('Super Admin can authenticate with the new username and old password is unchanged yet', async () => {
    // Old username rejected
    const oldLogin = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: originalUsername, password: originalPassword });
    expect(oldLogin.status).toBe(401);

    // New username accepted
    const newLogin = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: updatedUsername, password: originalPassword });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.accessToken).toBeDefined();

    // Update token to freshly issued one
    superAdminToken = newLogin.body.accessToken;
  });

  it('PUT /super-admin/account/password rejects mismatched confirm password', async () => {
    const res = await request(app.getHttpServer())
      .put('/super-admin/account/password')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        currentPassword: originalPassword,
        newPassword: updatedPassword,
        confirmPassword: 'MismatchPassword123!',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('do not match');
  });

  it('PUT /super-admin/account/password rejects identical new password', async () => {
    const res = await request(app.getHttpServer())
      .put('/super-admin/account/password')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        currentPassword: originalPassword,
        newPassword: originalPassword,
        confirmPassword: originalPassword,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('must be different');
  });

  it('PUT /super-admin/account/password rejects incorrect current password', async () => {
    const res = await request(app.getHttpServer())
      .put('/super-admin/account/password')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        currentPassword: 'IncorrectOldPassword123!',
        newPassword: updatedPassword,
        confirmPassword: updatedPassword,
      });

    expect(res.status).toBe(401);
    expect(res.body.message).toContain('Current password is incorrect');
  });

  it('PUT /super-admin/account/password successfully changes password, stores Argon2id hash, and audit logs', async () => {
    const res = await request(app.getHttpServer())
      .put('/super-admin/account/password')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        currentPassword: originalPassword,
        newPassword: updatedPassword,
        confirmPassword: updatedPassword,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify DB hash is valid Argon2id and matches new password
    const dbUser = await superAdminPool.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [superAdminUserId],
    );
    const hash = dbUser.rows[0].password_hash;
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2.verify(hash, updatedPassword)).toBe(true);

    // Verify audit log exists with no sensitive data
    const auditRes = await superAdminPool.query(
      `SELECT action, metadata FROM audit_logs WHERE tenant_id IS NULL AND actor_user_id = $1 AND action = 'superadmin.change_password'`,
      [superAdminUserId],
    );
    expect(auditRes.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(auditRes.rows[0].metadata)).not.toContain(originalPassword);
    expect(JSON.stringify(auditRes.rows[0].metadata)).not.toContain(updatedPassword);
  });

  it('Super Admin can authenticate with the new username and new password; old password fails', async () => {
    // Old password rejected
    const oldPassLogin = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: updatedUsername, password: originalPassword });
    expect(oldPassLogin.status).toBe(401);

    // New password accepted
    const newPassLogin = await request(app.getHttpServer())
      .post('/auth/super-admin/login')
      .send({ username: updatedUsername, password: updatedPassword });
    expect(newPassLogin.status).toBe(200);
    expect(newPassLogin.body.accessToken).toBeDefined();
  });
});
