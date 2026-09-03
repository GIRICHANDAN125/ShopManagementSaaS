/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`); // for gen_random_uuid()

  pgm.sql(`
    CREATE TABLE tenants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      business_type TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      order_sequence_name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NULL REFERENCES tenants(id),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, username)
    );
  `);

  pgm.sql(`
    CREATE TABLE roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      UNIQUE (tenant_id, name)
    );
  `);

  pgm.sql(`
    CREATE TABLE permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT UNIQUE NOT NULL
    );
  `);

  pgm.sql(`
    CREATE TABLE role_permissions (
      role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );
  `);

  pgm.sql(`
    CREATE TABLE user_roles (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, role_id)
    );
  `);

  pgm.sql(`
    CREATE TABLE counters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))
    );
  `);

  pgm.sql(`
    CREATE TABLE categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      UNIQUE (tenant_id, name)
    );
  `);

  pgm.sql(`
    CREATE TABLE products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      category_id UUID REFERENCES categories(id),
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      counter_id UUID REFERENCES counters(id),
      name TEXT NOT NULL,
      credential_hash TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','replaced')),
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ NULL,
      UNIQUE (tenant_id, name)
    );
  `);

  pgm.sql(`
    CREATE TABLE device_order_reservations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      device_id UUID NOT NULL REFERENCES devices(id),
      range_start BIGINT NOT NULL,
      range_end BIGINT NOT NULL,
      next_to_issue BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','abandoned')),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ NULL,
      UNIQUE (tenant_id, range_start, range_end)
    );
  `);
  pgm.sql(`CREATE INDEX idx_reservations_tenant_device_status ON device_order_reservations (tenant_id, device_id, status);`);

  pgm.sql(`
    CREATE TABLE orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      order_number BIGINT NOT NULL,
      display_number SMALLINT NOT NULL,
      idempotency_key UUID NOT NULL,
      counter_id UUID REFERENCES counters(id),
      device_id UUID REFERENCES devices(id),
      created_by_user_id UUID NOT NULL REFERENCES users(id),
      order_type TEXT NOT NULL,
      status TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'online' CHECK (origin IN ('online','offline_reserved')),
      subtotal NUMERIC(12,2) NOT NULL,
      packing_charge NUMERIC(12,2) NOT NULL DEFAULT 0,
      discount NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL,
      scheduled_for TIMESTAMPTZ NULL,
      created_at_device TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, order_number),
      UNIQUE (tenant_id, idempotency_key)
    );
  `);
  pgm.sql(`CREATE INDEX idx_orders_tenant_created_at ON orders (tenant_id, created_at);`);
  pgm.sql(`CREATE INDEX idx_orders_tenant_status ON orders (tenant_id, status);`);
  pgm.sql(`CREATE INDEX idx_orders_tenant_created_at_device ON orders (tenant_id, created_at_device);`);

  pgm.sql(`
    CREATE TABLE order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      product_id UUID NOT NULL REFERENCES products(id),
      quantity INT NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL,
      line_total NUMERIC(12,2) NOT NULL
    );
  `);

  pgm.sql(`
    CREATE TABLE order_status_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      status TEXT NOT NULL,
      changed_by UUID REFERENCES users(id),
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NULL REFERENCES tenants(id),
      actor_user_id UUID REFERENCES users(id),
      actor_device_id UUID REFERENCES devices(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id UUID,
      metadata JSONB,
      correlation_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_audit_tenant_created ON audit_logs (tenant_id, created_at);`);
  pgm.sql(`CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);`);

  pgm.sql(`
    CREATE TABLE tenant_settings (
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tenant_settings;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS order_status_history;
    DROP TABLE IF EXISTS order_items;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS device_order_reservations;
    DROP TABLE IF EXISTS devices;
    DROP TABLE IF EXISTS products;
    DROP TABLE IF EXISTS categories;
    DROP TABLE IF EXISTS counters;
    DROP TABLE IF EXISTS user_roles;
    DROP TABLE IF EXISTS role_permissions;
    DROP TABLE IF EXISTS permissions;
    DROP TABLE IF EXISTS roles;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS tenants;
  `);
};
