#!/bin/sh
set -e

echo "========================================================"
echo " Starting Multi-Tenant SaaS Backend Container Entrypoint"
echo "========================================================"

echo "[1/4] Waiting for PostgreSQL to be ready..."
node -e "
const { Pool } = require('pg');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is missing');
  process.exit(1);
}
const pool = new Pool({ connectionString });
async function wait() {
  for (let i = 0; i < 60; i++) {
    try {
      const client = await pool.connect();
      client.release();
      await pool.end();
      console.log('  -> PostgreSQL connection established successfully.');
      process.exit(0);
    } catch (err) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.error('  -> Timeout waiting for PostgreSQL database connection.');
  process.exit(1);
}
wait();
"

echo "[2/4] Executing database migrations (node-pg-migrate)..."
npx node-pg-migrate up -d DATABASE_URL

echo "[3/4] Bootstrapping Super Admin user..."
npx ts-node -r dotenv/config scripts/bootstrap-superadmin.ts

echo "[4/4] Starting NestJS production application..."
exec "$@"
