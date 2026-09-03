import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';

/**
 * Two separate pools, two separate DB credentials — this is the actual
 * enforcement boundary for the Super Admin split (SECURITY.md §19,
 * ARCHITECTURE.md §6):
 *  - `tenantPool` connects as `shopapp` — subject to the tenant_isolation_*
 *    RLS policies on every tenant-owned table, no grants at all on
 *    platform-only concerns.
 *  - `superAdminPool` connects as `shopapp_superadmin` — narrowly granted
 *    to `tenants` and the platform-level (tenant_id IS NULL) rows of
 *    `users`/`audit_logs` only. No ordinary request path ever obtains a
 *    client from this pool; only the SuperAdmin module does, and only
 *    after verifying the caller is an authenticated platform user.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  public readonly tenantPool: Pool;
  public readonly superAdminPool: Pool;

  constructor(private readonly config: ConfigService) {
    this.tenantPool = new Pool({
      connectionString: this.config.get<string>('RUNTIME_DATABASE_URL'),
      max: 10,
    });
    this.superAdminPool = new Pool({
      connectionString: this.config.get<string>('SUPERADMIN_DATABASE_URL'),
      max: 2,
    });
  }

  /**
   * Runs `fn` inside a single transaction on the tenant pool with
   * `app.current_tenant_id` set via SET LOCAL — scoped to this
   * transaction only, so it can never leak across pooled connections
   * (DATABASE.md §8, point 4). `tenantId` must already have been
   * resolved server-side from a verified token — callers must never pass
   * through a client-supplied value here.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.tenantPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant_id',
        tenantId,
      ]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Super Admin operations — always via the dedicated, narrow-scope pool. */
  async withSuperAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.superAdminPool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.tenantPool.end();
    await this.superAdminPool.end();
  }
}

@Module({
  imports: [ConfigModule],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
