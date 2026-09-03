#!/usr/bin/env bash
# One-time PostgreSQL bootstrap for local development.
#
# This creates the database and the three roles the application depends
# on (DATABASE.md §7-8, SECURITY.md §14, §19). Role CREATION is
# deliberately a superuser-only bootstrap step, run once — the migration
# role itself does NOT have CREATEROLE, so it cannot create these roles
# on its own (see migrations/0005_super-admin-rls.js for why this
# separation matters).
#
# Usage: run as a user that can `sudo -u postgres psql` (or adjust for
# your environment), then fill in real passwords in .env before starting
# the app. This script uses placeholder passwords — CHANGE THEM.
set -euo pipefail

DB_NAME="${DB_NAME:-shopapp_dev}"
MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-CHANGE_ME_migrator}"
RUNTIME_PASSWORD="${RUNTIME_PASSWORD:-CHANGE_ME_runtime}"
SUPERADMIN_PASSWORD="${SUPERADMIN_PASSWORD:-CHANGE_ME_superadmin}"

run_psql() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
}

echo "Creating database and roles for ${DB_NAME}..."

run_psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp_migrator') THEN
    CREATE ROLE shopapp_migrator WITH LOGIN PASSWORD '${MIGRATOR_PASSWORD}' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp') THEN
    CREATE ROLE shopapp WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp_superadmin') THEN
    CREATE ROLE shopapp_superadmin WITH LOGIN PASSWORD '${SUPERADMIN_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
\$\$;
SQL

run_psql -c "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 || \
  run_psql -c "CREATE DATABASE ${DB_NAME} OWNER shopapp_migrator;"

run_psql -d "${DB_NAME}" -c "GRANT ALL ON SCHEMA public TO shopapp_migrator;"
run_psql -d "${DB_NAME}" -c "GRANT USAGE, CREATE ON SCHEMA public TO shopapp;"

cat <<EOF

Done. Now:
  1. Update .env with the passwords you used (or the CHANGE_ME defaults,
     for local dev only — never in a real deployment):
       DATABASE_URL="postgresql://shopapp_migrator:${MIGRATOR_PASSWORD}@localhost:5432/${DB_NAME}"
       RUNTIME_DATABASE_URL="postgresql://shopapp:${RUNTIME_PASSWORD}@localhost:5432/${DB_NAME}"
       SUPERADMIN_DATABASE_URL="postgresql://shopapp_superadmin:${SUPERADMIN_PASSWORD}@localhost:5432/${DB_NAME}"
  2. Run migrations: npm run migrate:up
EOF
