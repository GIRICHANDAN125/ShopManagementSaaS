-- ==============================================================================
-- PostgreSQL Initialization Script for Multi-Tenant Shop SaaS (Docker)
-- Creates the required 3-role security model, extensions, and permissions on container init.
-- ==============================================================================

DO $$
BEGIN
  -- 1. shopapp_migrator: Schema owner, used ONLY for migrations
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp_migrator') THEN
    CREATE ROLE shopapp_migrator WITH LOGIN PASSWORD 'migrator_secure_password_123' CREATEDB SUPERUSER;
  END IF;

  -- 2. shopapp: Runtime role bound by RLS on tenant tables
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp') THEN
    CREATE ROLE shopapp WITH LOGIN PASSWORD 'runtime_secure_password_123' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- 3. shopapp_superadmin: Platform role for SuperAdmin module
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopapp_superadmin') THEN
    CREATE ROLE shopapp_superadmin WITH LOGIN PASSWORD 'superadmin_secure_password_123' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
  END IF;
END
$$;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Grant schema and database permissions
ALTER DATABASE shopapp_dev OWNER TO shopapp_migrator;
GRANT ALL ON SCHEMA public TO shopapp_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO shopapp;
ALTER SCHEMA public OWNER TO shopapp_migrator;
