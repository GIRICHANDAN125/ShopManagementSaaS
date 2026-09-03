import { Pool } from 'pg';
import * as argon2 from 'argon2';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Platform Super Admin Bootstrap
 *
 * Requirements:
 * - Uses the intended privileged database path (SUPERADMIN_DATABASE_URL / shopapp_superadmin)
 * - Never uses the postgres superuser
 * - Password hashed with Argon2id
 * - Never stores or logs plaintext passwords
 * - Idempotent: running multiple times does not duplicate accounts or fail
 * - Verifies tenant_id IS NULL and status = active
 */
async function bootstrapSuperAdmin() {
  const superAdminUrl = process.env.SUPERADMIN_DATABASE_URL;
  if (!superAdminUrl) {
    console.error('ERROR: SUPERADMIN_DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const username = (process.env.SUPERADMIN_USERNAME || 'superadmin').trim();
  const displayName = (process.env.SUPERADMIN_DISPLAY_NAME || 'Platform Super Admin').trim();
  const password = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin2026!';

  if (!password || password.length < 8) {
    console.error('ERROR: SUPERADMIN_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && !process.env.SUPERADMIN_PASSWORD) {
    console.error('ERROR: SUPERADMIN_PASSWORD must be explicitly provided in production.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: superAdminUrl,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check if super admin user already exists
    const existingRes = await client.query(
      `SELECT id, username, display_name, status, tenant_id FROM users WHERE tenant_id IS NULL AND username = $1`,
      [username],
    );

    if (existingRes.rowCount && existingRes.rowCount > 0) {
      const existing = existingRes.rows[0];
      if (existing.tenant_id !== null) {
        throw new Error(`Integrity violation: Super Admin ${username} has non-null tenant_id.`);
      }

      console.log(`[BOOTSTRAP] Super Admin '${username}' already exists (ID: ${existing.id}, status: ${existing.status}). No changes made.`);
      await client.query('COMMIT');
      return;
    }

    // 2. Hash password with Argon2id
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // 3. Insert super admin user (tenant_id strictly NULL)
    const insertRes = await client.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, display_name, status)
       VALUES (gen_random_uuid(), NULL, $1, $2, $3, 'active')
       RETURNING id, username, display_name, status, tenant_id, password_hash`,
      [username, passwordHash, displayName],
    );

    const user = insertRes.rows[0];

    // 4. Verify post-conditions
    if (user.tenant_id !== null) {
      throw new Error(`Integrity violation: Created Super Admin user has tenant_id = ${user.tenant_id} (must be NULL)`);
    }
    if (user.status !== 'active') {
      throw new Error(`Integrity violation: Created Super Admin user status is ${user.status} (must be active)`);
    }

    const verified = await argon2.verify(user.password_hash, password);
    if (!verified) {
      throw new Error('Integrity violation: Password verification failed immediately after Argon2id hash.');
    }

    // 5. Audit log
    await client.query(
      `INSERT INTO audit_logs (tenant_id, action, entity_type, entity_id, metadata)
       VALUES (NULL, 'superadmin.bootstrap', 'user', $1, jsonb_build_object('username', $2::text))`,
      [user.id, user.username],
    );

    await client.query('COMMIT');

    console.log(`[BOOTSTRAP] Successfully created initial Super Admin user:`);
    console.log(`  ID:           ${user.id}`);
    console.log(`  Username:     ${user.username}`);
    console.log(`  Display Name: ${user.display_name}`);
    console.log(`  Status:       ${user.status}`);
    console.log(`  Tenant ID:    NULL (Platform Level)`);
    console.log(`  Auth Hash:    Argon2id verified`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[BOOTSTRAP] Failed to bootstrap Super Admin:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

bootstrapSuperAdmin();
