import { Injectable, Module } from '@nestjs/common';
import { DatabaseModule, DatabaseService } from '../database/database.module';

interface TenantAuditEntry {
  tenantId: string;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
}

interface SuperAdminAuditEntry {
  actorUserId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
}

// Fields that must never end up in audit metadata, redacted defensively
// even if a caller passes them by mistake (SECURITY.md §16, DATABASE.md §9).
const FORBIDDEN_KEYS = [
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'credential',
  'credentialHash',
];

function redact(metadata?: Record<string, unknown>) {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (FORBIDDEN_KEYS.some((f) => k.toLowerCase().includes(f.toLowerCase()))) {
      continue;
    }
    clean[k] = v;
  }
  return clean;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  /** Single call site for tenant-scoped audit writes — this is what
   * DATABASE.md §9 calls the "redaction helper used at the single call
   * site," so redaction can't drift per module. */
  async logTenant(entry: TenantAuditEntry) {
    await this.db.withTenant(entry.tenantId, (client) =>
      client.query(
        `INSERT INTO audit_logs
           (tenant_id, actor_user_id, actor_device_id, action, entity_type, entity_id, metadata, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          entry.tenantId,
          entry.actorUserId ?? null,
          entry.actorDeviceId ?? null,
          entry.action,
          entry.entityType,
          entry.entityId ?? null,
          redact(entry.metadata),
          entry.correlationId ?? null,
        ],
      ),
    );
  }

  /** Super Admin / platform-level audit writes — always tenant_id NULL,
   * always via the narrowly-scoped super-admin pool (never the ordinary
   * tenant pool, which has no grant path for NULL-tenant rows at all). */
  async logSuperAdmin(entry: SuperAdminAuditEntry) {
    await this.db.withSuperAdmin((client) =>
      client.query(
        `INSERT INTO audit_logs
           (tenant_id, actor_user_id, action, entity_type, entity_id, metadata, correlation_id)
         VALUES (NULL,$1,$2,$3,$4,$5,$6)`,
        [
          entry.actorUserId,
          entry.action,
          entry.entityType,
          entry.entityId ?? null,
          redact(entry.metadata),
          entry.correlationId ?? null,
        ],
      ),
    );
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
