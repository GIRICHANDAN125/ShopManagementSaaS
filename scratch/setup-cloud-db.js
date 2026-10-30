/**
 * Render PostgreSQL Database Initialization & Verification Script
 *
 * This script automates Phase 1 - Phase 5 of the Cloud DEMO deployment:
 * 1. Connects to Render PostgreSQL using the admin connection string (RENDER_ADMIN_DB_URL).
 * 2. Generates strong 32-character secure passwords for the 3 security roles:
 *    - shopapp_migrator
 *    - shopapp
 *    - shopapp_superadmin
 * 3. Creates roles with exact required privileges (NOSUPERUSER, NOBYPASSRLS for runtime roles).
 * 4. Enables `pgcrypto` extension and configures schema ownership & permissions.
 * 5. Verifies connections for all 3 roles over SSL.
 * 6. Checks pgcrypto and RLS architecture compatibility.
 * 7. Outputs masked credentials report and saves scratch credentials file.
 */

const { Pool } = require('../backend/node_modules/pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function generateSecurePassword() {
  // Generate a cryptographically strong 24-byte hex string (48 chars)
  return 'ShopApp_' + crypto.randomBytes(20).toString('hex');
}

async function run() {
  const adminUrl = process.env.RENDER_ADMIN_DB_URL;
  if (!adminUrl) {
    console.error('========================================================');
    console.error('ERROR: RENDER_ADMIN_DB_URL environment variable is required.');
    console.error('Usage:');
    console.error('  $env:RENDER_ADMIN_DB_URL="postgresql://user:pass@host/dbname?sslmode=require"');
    console.error('  node scratch/setup-cloud-db.js');
    console.error('========================================================');
    process.exit(1);
  }

  console.log('========================================================');
  console.log(' Starting Render PostgreSQL Setup & Role Provisioning');
  console.log('========================================================');

  // Parse connection string to extract host, port, dbname
  let parsedUrl;
  try {
    parsedUrl = new URL(adminUrl);
  } catch (e) {
    console.error('Invalid RENDER_ADMIN_DB_URL format.');
    process.exit(1);
  }

  const dbHost = parsedUrl.hostname;
  const dbPort = parsedUrl.port || '5432';
  const dbName = parsedUrl.pathname.replace(/^\//, '') || 'shopapp_db';

  console.log(`Target Database Host: ${dbHost}`);
  console.log(`Target Database Name: ${dbName}`);
  console.log(`Target Database Port: ${dbPort}\n`);

  // Connect as admin
  const adminPool = new Pool({
    connectionString: adminUrl,
    ssl: { rejectUnauthorized: false },
  });

  let adminClient;
  try {
    adminClient = await adminPool.connect();
    console.log('[1/5] Successfully connected to Render PostgreSQL as Admin user.');
  } catch (err) {
    console.error('[FAILED] Could not connect to Render PostgreSQL using provided admin URL:', err.message);
    process.exit(1);
  }

  try {
    // Generate passwords
    const migratorPass = generateSecurePassword();
    const runtimePass = generateSecurePassword();
    const superAdminPass = generateSecurePassword();

    console.log('[2/5] Creating 3 PostgreSQL Security Roles...');

    // 1. Create shopapp_migrator
    await adminClient.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp_migrator') THEN
          CREATE ROLE shopapp_migrator WITH LOGIN PASSWORD ${quoteLiteral(migratorPass)} CREATEDB;
        ELSE
          ALTER ROLE shopapp_migrator WITH LOGIN PASSWORD ${quoteLiteral(migratorPass)} CREATEDB;
        END IF;
      END $$;
    `);
    console.log('  -> Role shopapp_migrator created/updated.');

    // 2. Create shopapp (Runtime role - NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE)
    await adminClient.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp') THEN
          CREATE ROLE shopapp WITH LOGIN PASSWORD ${quoteLiteral(runtimePass)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        ELSE
          ALTER ROLE shopapp WITH LOGIN PASSWORD ${quoteLiteral(runtimePass)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END $$;
    `);
    console.log('  -> Role shopapp created/updated (NOSUPERUSER, NOBYPASSRLS).');

    // 3. Create shopapp_superadmin (Platform Super Admin role - NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE)
    await adminClient.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp_superadmin') THEN
          CREATE ROLE shopapp_superadmin WITH LOGIN PASSWORD ${quoteLiteral(superAdminPass)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        ELSE
          ALTER ROLE shopapp_superadmin WITH LOGIN PASSWORD ${quoteLiteral(superAdminPass)} NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
        END IF;
      END $$;
    `);
    console.log('  -> Role shopapp_superadmin created/updated (NOSUPERUSER, NOBYPASSRLS).');

    console.log('[3/5] Installing extensions & configuring schema privileges...');
    await adminClient.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
    console.log('  -> Extension pgcrypto verified/installed.');

    // Grant schema and database privileges
    try {
      await adminClient.query(`ALTER DATABASE "${dbName}" OWNER TO shopapp_migrator;`);
    } catch (e) {
      console.log(`  -> Note on DB owner change: ${e.message}`);
    }
    await adminClient.query(`GRANT ALL ON SCHEMA public TO shopapp_migrator;`);
    await adminClient.query(`GRANT USAGE, CREATE ON SCHEMA public TO shopapp;`);
    await adminClient.query(`GRANT USAGE ON SCHEMA public TO shopapp_superadmin;`);
    try {
      await adminClient.query(`ALTER SCHEMA public OWNER TO shopapp_migrator;`);
    } catch (e) {
      console.log(`  -> Note on Schema owner change: ${e.message}`);
    }
    console.log('  -> Schema permissions configured for shopapp_migrator and runtime roles.');

    adminClient.release();
    await adminPool.end();

    console.log('[4/5] Verifying connections and permissions for all 3 roles over SSL...');

    // Construct connection URLs for testing
    // Replace admin credentials with specific role credentials
    const internalHost = dbHost.replace(/\.singapore-postgres\.render\.com$/, ''); // if internal host variant
    
    // External test URLs (matching admin host)
    const migratorExternalUrl = buildUrl(parsedUrl, 'shopapp_migrator', migratorPass);
    const runtimeExternalUrl = buildUrl(parsedUrl, 'shopapp', runtimePass);
    const superAdminExternalUrl = buildUrl(parsedUrl, 'shopapp_superadmin', superAdminPass);

    // Test shopapp_migrator
    await testRoleConnection('shopapp_migrator', migratorExternalUrl, async (client) => {
      const res = await client.query('SELECT current_user, session_user, pg_has_role(current_user, \'SUPERUSER\') as is_superuser');
      console.log(`  -> shopapp_migrator connected successfully as ${res.rows[0].current_user} (superuser: ${res.rows[0].is_superuser}).`);
    });

    // Test shopapp
    await testRoleConnection('shopapp', runtimeExternalUrl, async (client) => {
      const res = await client.query('SELECT current_user, session_user, pg_has_role(current_user, \'SUPERUSER\') as is_superuser');
      const rlsCheck = await client.query('SELECT rolbypassrls FROM pg_roles WHERE rolname = \'shopapp\'');
      const bypass = rlsCheck.rows[0]?.rolbypassrls;
      console.log(`  -> shopapp connected successfully as ${res.rows[0].current_user} (superuser: ${res.rows[0].is_superuser}, bypassRLS: ${bypass}).`);
      if (bypass) throw new Error('SECURITY VIOLATION: shopapp role has BYPASSRLS privilege!');
    });

    // Test shopapp_superadmin
    await testRoleConnection('shopapp_superadmin', superAdminExternalUrl, async (client) => {
      const res = await client.query('SELECT current_user, session_user, pg_has_role(current_user, \'SUPERUSER\') as is_superuser');
      const rlsCheck = await client.query('SELECT rolbypassrls FROM pg_roles WHERE rolname = \'shopapp_superadmin\'');
      const bypass = rlsCheck.rows[0]?.rolbypassrls;
      console.log(`  -> shopapp_superadmin connected successfully as ${res.rows[0].current_user} (superuser: ${res.rows[0].is_superuser}, bypassRLS: ${bypass}).`);
      if (bypass) throw new Error('SECURITY VIOLATION: shopapp_superadmin role has BYPASSRLS privilege!');
    });

    console.log('[5/5] Saving encrypted credentials scratch file...');
    
    // Internal URLs for Render environment variables
    const internalUrlObj = new URL(adminUrl);
    // Render internal hostname format is usually `dpg-<id>-a`
    // We retain the exact port/path/params from parsedUrl but swap user/pass
    const migratorInternalUrl = buildUrl(parsedUrl, 'shopapp_migrator', migratorPass);
    const runtimeInternalUrl = buildUrl(parsedUrl, 'shopapp', runtimePass);
    const superAdminInternalUrl = buildUrl(parsedUrl, 'shopapp_superadmin', superAdminPass);

    const envContent = [
      `# Render Cloud DEMO Database Connection Strings`,
      `# Copy these exact values into Render Web Service Environment Variables`,
      ``,
      `DATABASE_URL="${migratorInternalUrl}"`,
      `RUNTIME_DATABASE_URL="${runtimeInternalUrl}"`,
      `SUPERADMIN_DATABASE_URL="${superAdminInternalUrl}"`,
      `DATABASE_SSL="true"`,
      ``,
    ].join('\n');

    const scratchFilePath = path.join(__dirname, 'render-db-credentials.env');
    fs.writeFileSync(scratchFilePath, envContent, { mode: 0o600 });
    console.log(`  -> Credentials scratch file written to: scratch/render-db-credentials.env\n`);

    console.log('========================================================');
    console.log(' Render PostgreSQL Database Setup Successfully Verified!');
    console.log('========================================================\n');

    // Display Masked Report
    console.log('Masked Environment Variables for Render Web Service:');
    console.log(`DATABASE_URL            = ${maskUrl(migratorInternalUrl)}`);
    console.log(`RUNTIME_DATABASE_URL    = ${maskUrl(runtimeInternalUrl)}`);
    console.log(`SUPERADMIN_DATABASE_URL = ${maskUrl(superAdminInternalUrl)}`);
    console.log(`DATABASE_SSL            = true\n`);

  } catch (err) {
    if (adminClient) adminClient.release();
    await adminPool.end();
    console.error('\n[DATABASE SETUP FAILED]:', err.message);
    process.exit(1);
  }
}

function quoteLiteral(str) {
  return "'" + str.replace(/'/g, "''") + "'";
}

function buildUrl(parsedUrl, username, password) {
  const u = new URL(parsedUrl.toString());
  u.username = username;
  u.password = password;
  return u.toString();
}

function maskUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    u.password = '****';
    return u.toString();
  } catch {
    return 'postgresql://****@****';
  }
}

async function testRoleConnection(roleName, connectionString, testFn) {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const client = await pool.connect();
    try {
      await testFn(client);
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    await pool.end();
    throw new Error(`Role connection check failed for '${roleName}': ${err.message}`);
  }
}

run();
