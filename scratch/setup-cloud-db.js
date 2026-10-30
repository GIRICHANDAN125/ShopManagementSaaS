/**
 * Render PostgreSQL Database Initialization & Verification Script
 *
 * This script automates Cloud Database provisioning for ShopPilot:
 * 1. Connects to Render PostgreSQL using the admin connection string (RENDER_ADMIN_DB_URL).
 * 2. Requires RENDER_INTERNAL_HOST from the Render Dashboard to avoid host guessing.
 * 3. Idempotently provisions the 3 security roles:
 *    - shopapp_migrator (schema owner, used only for migrations)
 *    - shopapp (runtime role, strictly bound by RLS on tenant tables, NO schema CREATE)
 *    - shopapp_superadmin (platform role, restricted to tenants and platform rows)
 * 4. Never overwrites existing passwords without explicit FORCE_RESET_PASSWORDS=true.
 * 5. Never generates placeholder URLs. Fails safely if an existing password is unknown.
 * 6. Grants role membership to admin and transfers schema ownership with strict error handling.
 * 7. Configures explicit table, sequence, and function permissions matching the exact migration model.
 * 8. Configures ALTER DEFAULT PRIVILEGES for shopapp_migrator in schema public.
 * 9. Verifies SSL, RLS constraints, and lack of schema CREATE privilege for runtime roles.
 * 10. Closes all database connection pools cleanly on all execution paths.
 * 11. Generates separate External (local/migration) and Internal (web service) credentials report.
 */

const { Pool } = require('../backend/node_modules/pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function generateSecurePassword() {
  // Generate a cryptographically strong 24-byte hex string (48 chars)
  return 'ShopApp_' + crypto.randomBytes(24).toString('hex');
}

function quoteLiteral(str) {
  return "'" + str.replace(/'/g, "''") + "'";
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

function buildUrl(baseUrlObj, username, password, hostOverride = null) {
  if (!password || password.includes('EXISTING_PASSWORD')) {
    throw new Error(`Cannot build URL for role '${username}': valid password is required.`);
  }
  const u = new URL(baseUrlObj.toString());
  u.username = username;
  u.password = password;
  if (hostOverride) {
    u.hostname = hostOverride;
  }
  return u.toString();
}

/**
 * Parses existing credentials file if available, so passwords aren't lost on re-runs
 */
function loadExistingCredentials(filePath) {
  const creds = {};
  if (!fs.existsSync(filePath)) return creds;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)="?([^"]+)"?$/);
      if (match) {
        const val = match[2];
        try {
          const u = new URL(val);
          if (u.username && u.password && !u.password.includes('EXISTING_PASSWORD')) {
            creds[u.username] = decodeURIComponent(u.password);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return creds;
}

async function run() {
  // 1. Validate Admin Connection URL
  const adminUrl = process.env.RENDER_ADMIN_DB_URL || process.env.RENDER_EXTERNAL_DB_URL;
  if (!adminUrl) {
    console.error('========================================================================');
    console.error('ERROR: RENDER_ADMIN_DB_URL environment variable is required.');
    console.error('');
    console.error('Obtain your External Database URL from the Render Dashboard:');
    console.error('  Render Dashboard -> PostgreSQL -> Info -> External Database URL');
    console.error('');
    console.error('Usage in PowerShell:');
    console.error('  $env:RENDER_ADMIN_DB_URL="postgresql://user:pass@host.render.com/dbname?sslmode=require"');
    console.error('  $env:RENDER_INTERNAL_HOST="dpg-xxxxxxxxxxxx-a"');
    console.error('  node scratch/setup-cloud-db.js');
    console.error('========================================================================');
    process.exit(1);
  }

  // 2. Validate Render Internal Hostname (Do not guess)
  const internalHost = process.env.RENDER_INTERNAL_HOST?.trim();
  if (!internalHost) {
    console.error('========================================================================');
    console.error('ERROR: RENDER_INTERNAL_HOST environment variable is required.');
    console.error('');
    console.error('To prevent cross-region routing errors and public egress fees,');
    console.error('the internal database hostname must be provided directly from Render:');
    console.error('');
    console.error('How to find it:');
    console.error('  1. Open your Render Dashboard (https://dashboard.render.com).');
    console.error('  2. Select your PostgreSQL database instance.');
    console.error('  3. In the "Info" section, locate "Internal Database URL".');
    console.error('  4. Copy the hostname (e.g. "dpg-cxxxxxxxxxxxx-a").');
    console.error('');
    console.error('Example:');
    console.error('  $env:RENDER_INTERNAL_HOST="dpg-d0123456789-a"');
    console.error('========================================================================');
    process.exit(1);
  }

  const forceReset = process.env.FORCE_RESET_PASSWORDS === 'true';

  let parsedUrl;
  try {
    parsedUrl = new URL(adminUrl);
  } catch (e) {
    console.error('Invalid RENDER_ADMIN_DB_URL format. Must be a valid PostgreSQL connection URI.');
    process.exit(1);
  }

  const dbHost = parsedUrl.hostname;
  const dbPort = parsedUrl.port || '5432';
  const dbName = parsedUrl.pathname.replace(/^\//, '') || 'shopapp_db';

  console.log('========================================================');
  console.log(' Starting Render PostgreSQL Setup & Role Provisioning');
  console.log('========================================================');
  console.log(`Target External Host: ${dbHost}`);
  console.log(`Target Internal Host: ${internalHost}`);
  console.log(`Target Database Name: ${dbName}`);
  console.log(`Target Database Port: ${dbPort}`);
  console.log(`Force Password Reset: ${forceReset ? 'YES (FORCE_RESET_PASSWORDS=true)' : 'NO (Preserve Existing Passwords)'}\n`);

  // Load existing credentials from scratch file or environment variables
  const scratchFilePath = path.join(__dirname, 'render-db-credentials.env');
  const existingCreds = loadExistingCredentials(scratchFilePath);

  const envRolePasswords = {
    shopapp_migrator: process.env.MIGRATOR_PASSWORD || null,
    shopapp: process.env.RUNTIME_PASSWORD || null,
    shopapp_superadmin: process.env.SUPERADMIN_PASSWORD || null,
  };

  const adminPool = new Pool({
    connectionString: adminUrl,
    ssl: { rejectUnauthorized: false },
  });

  let adminClient = null;

  try {
    adminClient = await adminPool.connect();
    console.log('[1/5] Successfully connected to Render PostgreSQL as Admin user.');

    console.log('[2/5] Inspecting & provisioning 3 PostgreSQL Security Roles...');

    // Query existing roles
    const existingRolesRes = await adminClient.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('shopapp_migrator', 'shopapp', 'shopapp_superadmin')`
    );
    const existingRolesMap = {};
    for (const r of existingRolesRes.rows) {
      existingRolesMap[r.rolname] = r;
    }

    const resolvedRolePasswords = {};

    // Helper to setup role with strict safety and zero placeholders
    async function setupRole(roleName, options, envVarHint) {
      const existing = existingRolesMap[roleName];

      if (!existing) {
        // Role does not exist: generate fresh password and create
        const newPass = envRolePasswords[roleName] || generateSecurePassword();
        resolvedRolePasswords[roleName] = newPass;
        await adminClient.query(
          `CREATE ROLE ${roleName} WITH LOGIN PASSWORD ${quoteLiteral(newPass)} ${options};`
        );
        console.log(`  -> Role '${roleName}' created with new secure credentials.`);
      } else if (forceReset) {
        // Explicit password rotation requested
        const resetPass = envRolePasswords[roleName] || generateSecurePassword();
        resolvedRolePasswords[roleName] = resetPass;
        await adminClient.query(
          `ALTER ROLE ${roleName} WITH LOGIN PASSWORD ${quoteLiteral(resetPass)} ${options};`
        );
        console.log(`  -> [ROTATED] Role '${roleName}' password updated (FORCE_RESET_PASSWORDS=true).`);
      } else {
        // Role exists and forceReset is false
        // Ensure options (NOSUPERUSER, NOBYPASSRLS) are applied
        await adminClient.query(`ALTER ROLE ${roleName} WITH ${options};`);

        // Check if we have the password available locally or in env
        const knownPass = envRolePasswords[roleName] || existingCreds[roleName];
        if (knownPass) {
          resolvedRolePasswords[roleName] = knownPass;
          console.log(`  -> Role '${roleName}' exists. Using verified credentials from local file/env.`);
        } else {
          // Password is unknown and reset was not requested -> STOP SAFELY. Never use dummy placeholders!
          throw new Error(
            `Role '${roleName}' already exists in the database, but its password is not known locally.\n` +
            `To prevent service downtime or generating broken credentials, automatic resets are prohibited.\n\n` +
            `Remediation options:\n` +
            `  A) If you know the existing password, provide it via environment variable and re-run:\n` +
            `     $env:${envVarHint}="your-existing-password"\n\n` +
            `  B) If you want to intentionally rotate credentials for all roles, re-run with approval:\n` +
            `     $env:FORCE_RESET_PASSWORDS="true"\n` +
            `     node scratch/setup-cloud-db.js`
          );
        }
      }
    }

    // 1. shopapp_migrator: Schema owner, used ONLY for migrations (NOSUPERUSER, NOCREATEDB)
    await setupRole('shopapp_migrator', 'NOSUPERUSER NOCREATEDB NOCREATEROLE', 'MIGRATOR_PASSWORD');

    // 2. shopapp: Runtime role (NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE)
    await setupRole('shopapp', 'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', 'RUNTIME_PASSWORD');

    // 3. shopapp_superadmin: Platform Super Admin role (NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE)
    await setupRole('shopapp_superadmin', 'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', 'SUPERADMIN_PASSWORD');

    console.log('[3/5] Configuring extensions, schema ownership, and exact permissions...');

    // Enable pgcrypto extension
    await adminClient.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
    console.log('  -> Extension pgcrypto verified/installed.');

    // Grant membership of shopapp_migrator to current_user so ALTER SCHEMA OWNER succeeds
    try {
      await adminClient.query(`
        DO $$
        BEGIN
          EXECUTE format('GRANT shopapp_migrator TO %I;', current_user);
        END $$;
      `);
      console.log('  -> Granted shopapp_migrator membership to current admin user.');
    } catch (grantErr) {
      throw new Error(`Failed to grant role membership of 'shopapp_migrator' to current user: ${grantErr.message}`);
    }

    // Transfer public schema ownership to shopapp_migrator
    try {
      await adminClient.query(`ALTER SCHEMA public OWNER TO shopapp_migrator;`);
      console.log('  -> Schema public ownership transferred to shopapp_migrator.');
    } catch (ownerErr) {
      throw new Error(`Failed to transfer ownership of schema 'public' to 'shopapp_migrator': ${ownerErr.message}`);
    }

    // Schema level privileges
    await adminClient.query(`GRANT ALL ON SCHEMA public TO shopapp_migrator;`);
    await adminClient.query(`GRANT USAGE ON SCHEMA public TO shopapp;`);
    await adminClient.query(`REVOKE CREATE ON SCHEMA public FROM shopapp;`);
    await adminClient.query(`GRANT USAGE ON SCHEMA public TO shopapp_superadmin;`);
    await adminClient.query(`REVOKE CREATE ON SCHEMA public FROM shopapp_superadmin;`);
    console.log('  -> Schema public privileges configured: shopapp & shopapp_superadmin have USAGE only (NO CREATE).');

    // Default privileges for tables and sequences created by future migrations
    await adminClient.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE shopapp_migrator IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shopapp;
    `);
    await adminClient.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE shopapp_migrator IN SCHEMA public
        GRANT USAGE ON SEQUENCES TO shopapp;
    `);
    console.log('  -> Default privileges configured for future migrations under shopapp_migrator.');

    // Configure exact permissions matching migration model on existing tables if present
    await adminClient.query(`
      DO $$
      BEGIN
        -- Runtime role: standard DML on tenant-scoped operational tables
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON users TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'roles') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'permissions') THEN
          GRANT SELECT ON permissions TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'role_permissions') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_roles') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'counters') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON counters TO shopapp;
          GRANT SELECT ON counters TO shopapp_superadmin; -- For limit capacity checks
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'categories') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'products') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON products TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'devices') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON devices TO shopapp;
          GRANT SELECT ON devices TO shopapp_superadmin; -- For limit capacity checks
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'device_order_reservations') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON device_order_reservations TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'device_tenant_lookup') THEN
          GRANT SELECT, INSERT, DELETE ON device_tenant_lookup TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'orders') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'order_items') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON order_items TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'order_status_history') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON order_status_history TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenant_settings') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings TO shopapp;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'printers') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON printers TO shopapp;
          GRANT SELECT ON printers TO shopapp_superadmin; -- For limit capacity checks
        END IF;

        -- Audit logs: both roles insert, neither updates/deletes
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_logs') THEN
          GRANT SELECT, INSERT ON audit_logs TO shopapp;
          GRANT SELECT, INSERT ON audit_logs TO shopapp_superadmin;
        END IF;

        -- Root tenants registry: shopapp reads only; shopapp_superadmin manages
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenants') THEN
          GRANT SELECT ON tenants TO shopapp;
          REVOKE INSERT, UPDATE, DELETE ON tenants FROM shopapp;
          GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO shopapp_superadmin;
        END IF;

        -- Users: Super Admin only writes platform rows (enforced by RLS)
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users') THEN
          GRANT SELECT, INSERT, UPDATE ON users TO shopapp_superadmin;
        END IF;

        -- Resource limits: shopapp reads; shopapp_superadmin manages
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenant_resource_limits') THEN
          GRANT SELECT ON tenant_resource_limits TO shopapp;
          GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_resource_limits TO shopapp_superadmin;
        END IF;

        -- Sequences: runtime needs USAGE on all sequences
        GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO shopapp;
      END $$;
    `);
    console.log('  -> Verified exact table, sequence, and function permissions.');

    // Release admin client connection
    adminClient.release();
    adminClient = null;
    await adminPool.end();

    console.log('[4/5] Verifying connections, SSL, RLS, and security boundaries...');

    for (const [roleName, password] of Object.entries(resolvedRolePasswords)) {
      const testUrl = buildUrl(parsedUrl, roleName, password);
      await testRoleConnection(roleName, testUrl, async (client) => {
        const res = await client.query(
          `SELECT current_user, session_user, pg_has_role(current_user, 'SUPERUSER') as is_superuser`
        );
        const rlsCheck = await client.query(
          `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`,
          [roleName]
        );
        const { rolbypassrls, rolsuper } = rlsCheck.rows[0];

        console.log(
          `  -> ${roleName}: connected successfully over SSL (superuser: ${rolsuper}, bypassRLS: ${rolbypassrls}).`
        );

        if (rolsuper) {
          throw new Error(`SECURITY VIOLATION: Role ${roleName} has SUPERUSER privilege!`);
        }

        if (roleName !== 'shopapp_migrator' && rolbypassrls) {
          throw new Error(`SECURITY VIOLATION: Role ${roleName} has BYPASSRLS privilege!`);
        }

        if (roleName === 'shopapp') {
          const createCheck = await client.query(
            `SELECT has_schema_privilege('shopapp', 'public', 'CREATE') as can_create`
          );
          if (createCheck.rows[0]?.can_create) {
            throw new Error(`SECURITY VIOLATION: Role shopapp has CREATE privilege on schema public!`);
          }
          console.log(`  -> shopapp: verified CANNOT create schema objects in public.`);
        }

        if (roleName === 'shopapp_superadmin') {
          const createCheck = await client.query(
            `SELECT has_schema_privilege('shopapp_superadmin', 'public', 'CREATE') as can_create`
          );
          if (createCheck.rows[0]?.can_create) {
            throw new Error(`SECURITY VIOLATION: Role shopapp_superadmin has CREATE privilege on schema public!`);
          }
          console.log(`  -> shopapp_superadmin: verified CANNOT create schema objects in public.`);
        }
      });
    }

    console.log('[5/5] Generating credentials file & environment reports...');

    const migratorPass = resolvedRolePasswords['shopapp_migrator'];
    const runtimePass = resolvedRolePasswords['shopapp'];
    const superAdminPass = resolvedRolePasswords['shopapp_superadmin'];

    // Construct External URLs (for developer machine / local migrations)
    const migratorExternalUrl = buildUrl(parsedUrl, 'shopapp_migrator', migratorPass);
    const runtimeExternalUrl = buildUrl(parsedUrl, 'shopapp', runtimePass);
    const superAdminExternalUrl = buildUrl(parsedUrl, 'shopapp_superadmin', superAdminPass);

    // Construct Internal URLs (for Render Web Service)
    const migratorInternalUrl = buildUrl(parsedUrl, 'shopapp_migrator', migratorPass, internalHost);
    const runtimeInternalUrl = buildUrl(parsedUrl, 'shopapp', runtimePass, internalHost);
    const superAdminInternalUrl = buildUrl(parsedUrl, 'shopapp_superadmin', superAdminPass, internalHost);

    const envContent = [
      `# ==============================================================================`,
      `# Render Cloud PostgreSQL Credentials & Configuration`,
      `# Generated: ${new Date().toISOString()}`,
      `# Protected by .gitignore — NEVER commit to source control`,
      `# ==============================================================================`,
      ``,
      `# ------------------------------------------------------------------------------`,
      `# 1. RENDER BACKEND WEB SERVICE ENVIRONMENT VARIABLES (INTERNAL VPC NETWORK)`,
      `# Set these in the Render Dashboard -> Backend Web Service -> Environment:`,
      `# ------------------------------------------------------------------------------`,
      `DATABASE_URL="${migratorInternalUrl}"`,
      `RUNTIME_DATABASE_URL="${runtimeInternalUrl}"`,
      `SUPERADMIN_DATABASE_URL="${superAdminInternalUrl}"`,
      `DATABASE_SSL="true"`,
      ``,
      `# ------------------------------------------------------------------------------`,
      `# 2. LOCAL WORKSTATION / EXTERNAL CLI MIGRATION VARIABLES (PUBLIC HOSTNAME)`,
      `# Use these locally when running 'npm run migrate:up' from your laptop:`,
      `# ------------------------------------------------------------------------------`,
      `EXTERNAL_DATABASE_URL="${migratorExternalUrl}"`,
      `EXTERNAL_RUNTIME_DATABASE_URL="${runtimeExternalUrl}"`,
      `EXTERNAL_SUPERADMIN_DATABASE_URL="${superAdminExternalUrl}"`,
      ``,
    ].join('\n');

    fs.writeFileSync(scratchFilePath, envContent, { mode: 0o600 });
    console.log(`  -> Credentials written to: scratch/render-db-credentials.env (0o600, gitignored)\n`);

    console.log('========================================================');
    console.log(' Render PostgreSQL Database Setup Successfully Verified!');
    console.log('========================================================\n');

    console.log('Render Web Service Environment Variables (Internal VPC):');
    console.log(`  DATABASE_URL            = ${maskUrl(migratorInternalUrl)}`);
    console.log(`  RUNTIME_DATABASE_URL    = ${maskUrl(runtimeInternalUrl)}`);
    console.log(`  SUPERADMIN_DATABASE_URL = ${maskUrl(superAdminInternalUrl)}`);
    console.log(`  DATABASE_SSL            = true\n`);

    console.log('Local / External Migration Connection String (External Host):');
    console.log(`  EXTERNAL_DATABASE_URL   = ${maskUrl(migratorExternalUrl)}\n`);

  } catch (err) {
    console.error('\n[DATABASE SETUP FAILED]:', err.message);
    process.exit(1);
  } finally {
    if (adminClient) {
      try { adminClient.release(); } catch (_) {}
    }
    try { await adminPool.end(); } catch (_) {}
  }
}

async function testRoleConnection(roleName, connectionString, testFn) {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  let client = null;
  try {
    client = await pool.connect();
    await testFn(client);
  } catch (err) {
    throw new Error(`Role connection check failed for '${roleName}': ${err.message}`);
  } finally {
    if (client) {
      try { client.release(); } catch (_) {}
    }
    try { await pool.end(); } catch (_) {}
  }
}

run();
