import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from '../../src/app.module';

jest.setTimeout(30000);

describe('Product Images, Catalog & Tenant Isolation (Integration)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  const TENANT_A = '77777777-1111-1111-1111-111111111111';
  const TENANT_B = '77777777-2222-2222-2222-222222222222';

  let tokenAdminA: string;
  let tokenCounterA: string;
  let tokenAdminB: string;

  let categoryIdA: string;
  let productIdA: string;

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

  // Valid image buffers for testing magic byte detection
  // Minimal 1x1 PNG
  const validPngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

  // Minimal JPEG header
  const validJpgBuffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
    0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  ]);

  // Invalid fake file
  const invalidTextBuffer = Buffer.from('This is a text file not an image');

  beforeAll(async () => {
    // 1. Clean fixtures
    for (const tid of [TENANT_A, TENANT_B]) {
      await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM order_items WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM products WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM categories WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [tid]);
      await cleanupPool.query(`DELETE FROM users WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)`, [tid]);
      await cleanupPool.query(`DELETE FROM roles WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM tenants WHERE id = $1`, [tid]);
    }

    // 2. Seed Tenants
    await cleanupPool.query(
      `INSERT INTO tenants (id, code, display_name, order_sequence_name)
       VALUES ($1, 'IMG_SHOP_A', 'Image Shop A', 'order_seq_img_shop_a'),
              ($2, 'IMG_SHOP_B', 'Image Shop B', 'order_seq_img_shop_b')`,
      [TENANT_A, TENANT_B],
    );
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS order_seq_img_shop_a;`);
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS order_seq_img_shop_b;`);
    await superAdminPool.query(`SELECT create_tenant_order_sequence('order_seq_img_shop_a')`);
    await superAdminPool.query(`SELECT create_tenant_order_sequence('order_seq_img_shop_b')`);

    // 3. Seed Users & Roles for Tenant A (Admin + Counter) and Tenant B (Admin)
    const hash = await argon2.hash('TestPass123!', { type: argon2.argon2id });

    // Permissions
    const allPerms = await cleanupPool.query(`SELECT id, code FROM permissions`);
    const permMap = new Map(allPerms.rows.map((r) => [r.code, r.id]));

    // Tenant A Admin
    const roleAdminARes = await cleanupPool.query(
      `INSERT INTO roles (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'Shop Admin') RETURNING id`,
      [TENANT_A],
    );
    const roleAdminAId = roleAdminARes.rows[0].id;
    for (const code of ['product.manage', 'order.view', 'order.create', 'shop.settings']) {
      await cleanupPool.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleAdminAId, permMap.get(code)],
      );
    }
    const userAdminARes = await cleanupPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES (gen_random_uuid(), $1, 'admin_a', $2, 'Admin A') RETURNING id`,
      [TENANT_A, hash],
    );
    await cleanupPool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [userAdminARes.rows[0].id, roleAdminAId],
    );

    // Tenant A Counter Staff
    const roleCounterARes = await cleanupPool.query(
      `INSERT INTO roles (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'Counter Staff') RETURNING id`,
      [TENANT_A],
    );
    const roleCounterAId = roleCounterARes.rows[0].id;
    for (const code of ['order.view', 'order.create', 'receipt.print']) {
      await cleanupPool.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleCounterAId, permMap.get(code)],
      );
    }
    const userCounterARes = await cleanupPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES (gen_random_uuid(), $1, 'counter_a', $2, 'Counter A') RETURNING id`,
      [TENANT_A, hash],
    );
    await cleanupPool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [userCounterARes.rows[0].id, roleCounterAId],
    );

    // Tenant B Admin
    const roleAdminBRes = await cleanupPool.query(
      `INSERT INTO roles (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'Shop Admin') RETURNING id`,
      [TENANT_B],
    );
    const roleAdminBId = roleAdminBRes.rows[0].id;
    for (const code of ['product.manage', 'order.view', 'order.create', 'shop.settings']) {
      await cleanupPool.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleAdminBId, permMap.get(code)],
      );
    }
    const userAdminBRes = await cleanupPool.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name)
       VALUES (gen_random_uuid(), $1, 'admin_b', $2, 'Admin B') RETURNING id`,
      [TENANT_B, hash],
    );
    await cleanupPool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [userAdminBRes.rows[0].id, roleAdminBId],
    );

    // Initialize Nest App
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    // Authenticate users
    const resA = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: 'IMG_SHOP_A', username: 'admin_a', password: 'TestPass123!' });
    tokenAdminA = resA.body.accessToken;

    const resCounterA = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: 'IMG_SHOP_A', username: 'counter_a', password: 'TestPass123!' });
    tokenCounterA = resCounterA.body.accessToken;

    const resB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ shopCode: 'IMG_SHOP_B', username: 'admin_b', password: 'TestPass123!' });
    tokenAdminB = resB.body.accessToken;
  });

  afterAll(async () => {
    // Clean uploads directory for test tenants
    for (const tid of [TENANT_A, TENANT_B]) {
      const tenantDir = path.join(process.cwd(), 'uploads', 'products', tid);
      if (fs.existsSync(tenantDir)) {
        fs.rmSync(tenantDir, { recursive: true, force: true });
      }
    }

    // Clean fixtures
    for (const tid of [TENANT_A, TENANT_B]) {
      await cleanupPool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM order_items WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM products WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM categories WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [tid]);
      await cleanupPool.query(`DELETE FROM users WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)`, [tid]);
      await cleanupPool.query(`DELETE FROM roles WHERE tenant_id = $1`, [tid]);
      await cleanupPool.query(`DELETE FROM tenants WHERE id = $1`, [tid]);
    }

    await cleanupPool.query(`DROP SEQUENCE IF EXISTS order_seq_img_shop_a;`);
    await cleanupPool.query(`DROP SEQUENCE IF EXISTS order_seq_img_shop_b;`);

    await app.close();
    await cleanupPool.end();
    await shopappPool.end();
    await superAdminPool.end();
  });

  it('Shop Admin can create category and product without image', async () => {
    // 1. Create Category
    const catRes = await request(app.getHttpServer())
      .post('/catalog/categories')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ name: 'Bakery Breads' });

    expect(catRes.status).toBe(201);
    expect(catRes.body.name).toBe('Bakery Breads');
    categoryIdA = catRes.body.id;

    // 2. Create Product without image
    const prodRes = await request(app.getHttpServer())
      .post('/catalog/products')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ name: 'Milk Bread', price: 70, categoryId: categoryIdA });

    expect(prodRes.status).toBe(201);
    expect(prodRes.body.name).toBe('Milk Bread');
    expect(Number(prodRes.body.price)).toBe(70);
    expect(prodRes.body.image_url).toBeNull();
    productIdA = prodRes.body.id;
  });

  it('rejects invalid image file uploads and accepts valid PNG/JPEG images', async () => {
    // 1. Reject invalid file format (non-image text buffer)
    const badRes = await request(app.getHttpServer())
      .post(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .attach('image', invalidTextBuffer, 'fake.png');

    expect(badRes.status).toBe(400);
    expect(badRes.body.message).toMatch(/Unsupported file format/);

    // 2. Accept valid PNG
    const pngRes = await request(app.getHttpServer())
      .post(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .attach('image', validPngBuffer, 'product.png');

    expect(pngRes.status).toBe(201);
    expect(pngRes.body.image_url).toBeDefined();
    expect(pngRes.body.image_url).toMatch(/\.png$/);
  });

  it('Counter Staff can list products with image_url and stream image via Bearer or token query param', async () => {
    // 1. Counter Staff lists products
    const listRes = await request(app.getHttpServer())
      .get('/catalog/products')
      .set('Authorization', `Bearer ${tokenCounterA}`);

    expect(listRes.status).toBe(200);
    const prod = listRes.body.find((p: any) => p.id === productIdA);
    expect(prod).toBeDefined();
    expect(prod.image_url).toBeDefined();
    expect(prod.category_name).toBe('Bakery Breads');

    // 2. Stream image via Bearer header
    const imgResBearer = await request(app.getHttpServer())
      .get(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenCounterA}`);

    expect(imgResBearer.status).toBe(200);
    expect(imgResBearer.header['content-type']).toBe('image/png');
    expect(imgResBearer.body.length).toBe(validPngBuffer.length);

    // 3. Stream image via ?token= query parameter (for <img src="..."> tags)
    const imgResQuery = await request(app.getHttpServer())
      .get(`/catalog/products/${productIdA}/image?token=${tokenCounterA}`);

    expect(imgResQuery.status).toBe(200);
    expect(imgResQuery.header['content-type']).toBe('image/png');
    expect(imgResQuery.body.length).toBe(validPngBuffer.length);

    // 4. Request without token is rejected
    const unauthRes = await request(app.getHttpServer())
      .get(`/catalog/products/${productIdA}/image`);
    expect(unauthRes.status).toBe(401);
  });

  it('enforces RBAC: Counter Staff cannot manage products or product images', async () => {
    // 1. Counter Staff cannot create products
    const createRes = await request(app.getHttpServer())
      .post('/catalog/products')
      .set('Authorization', `Bearer ${tokenCounterA}`)
      .send({ name: 'Hacked Bread', price: 10 });
    expect(createRes.status).toBe(403);

    // 2. Counter Staff cannot upload product images
    const uploadRes = await request(app.getHttpServer())
      .post(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenCounterA}`)
      .attach('image', validPngBuffer, 'test.png');
    expect(uploadRes.status).toBe(403);

    // 3. Counter Staff cannot delete product images
    const deleteRes = await request(app.getHttpServer())
      .delete(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenCounterA}`);
    expect(deleteRes.status).toBe(403);
  });

  it('enforces Multi-Tenant Isolation: Tenant B cannot access or modify Tenant A product images', async () => {
    // 1. Tenant B cannot view Tenant A product image
    const getRes = await request(app.getHttpServer())
      .get(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminB}`);
    expect(getRes.status).toBe(404);

    // 2. Tenant B cannot upload/overwrite Tenant A product image
    const putRes = await request(app.getHttpServer())
      .post(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminB}`)
      .attach('image', validJpgBuffer, 'cross-tenant.jpg');
    expect(putRes.status).toBe(404);

    // 3. Tenant B cannot delete Tenant A product image
    const delRes = await request(app.getHttpServer())
      .delete(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminB}`);
    expect(delRes.status).toBe(404);

    // 4. Tenant B product catalog does not leak Tenant A products
    const listRes = await request(app.getHttpServer())
      .get('/catalog/products')
      .set('Authorization', `Bearer ${tokenAdminB}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.find((p: any) => p.id === productIdA)).toBeUndefined();
  });

  it('Shop Admin can replace and delete product images safely', async () => {
    // 1. Replace with JPEG
    const replaceRes = await request(app.getHttpServer())
      .post(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .attach('image', validJpgBuffer, 'replaced.jpg');

    expect(replaceRes.status).toBe(201);
    expect(replaceRes.body.image_url).toMatch(/\.jpg$/);

    // Verify streamed MIME type updated to image/jpeg
    const streamRes = await request(app.getHttpServer())
      .get(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminA}`);
    expect(streamRes.status).toBe(200);
    expect(streamRes.header['content-type']).toBe('image/jpeg');

    // 2. Delete product image
    const delRes = await request(app.getHttpServer())
      .delete(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminA}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.image_url).toBeNull();

    // 3. Subsequent stream returns 404
    const notFoundRes = await request(app.getHttpServer())
      .get(`/catalog/products/${productIdA}/image`)
      .set('Authorization', `Bearer ${tokenAdminA}`);
    expect(notFoundRes.status).toBe(404);
  });
});
