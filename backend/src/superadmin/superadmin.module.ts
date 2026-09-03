import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import * as crypto from 'crypto';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { SuperAdminOnlyGuard } from '../rbac/rbac.module';

export class CreateTenantDto {
  @IsString() displayName: string;
  @IsOptional() @IsString() businessType?: string;
}

export class SetTenantStatusDto {
  @IsString() tenantId: string;
  @IsIn(['active', 'inactive']) status: 'active' | 'inactive';
}

@Injectable()
export class SuperAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async createTenant(actorUserId: string, dto: CreateTenantDto) {
    const code = `TENANT_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const seqName = `order_seq_${code.toLowerCase()}`;

    const tenant = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `INSERT INTO tenants (code, display_name, business_type, status, order_sequence_name)
         VALUES ($1,$2,$3,'active',$4)
         RETURNING id, code, display_name, status`,
        [code, dto.displayName, dto.businessType ?? null, seqName],
      );
      return res.rows[0];
    });

    // Sequence provisioning is a server-side, parameterized DDL call —
    // never built from client input directly beyond the generated code
    // above (DEPLOYMENT.md's per-tenant sequence provisioning note).
    // Runs on the migrator connection in a full deployment; here it uses
    // the tenant pool's underlying credentials are insufficient for DDL,
    // so this call is routed through the super-admin pool as the
    // operationally-privileged path for this one-time bootstrap step.
    await this.db.withSuperAdmin((client) =>
      client.query(`SELECT create_tenant_order_sequence($1)`, [seqName]),
    );

    // Note: the trigger on `tenants` already writes a DB-guaranteed audit
    // row for this INSERT. This additional application-level entry adds
    // richer context (actor) that the trigger alone cannot capture reliably
    // without RLS complications, and is intentionally a second, distinct
    // log line rather than a replacement for the trigger's guarantee.
    await this.audit.logSuperAdmin({
      actorUserId,
      action: 'tenant.create',
      entityType: 'tenant',
      entityId: tenant.id,
      metadata: { code: tenant.code },
    });

    return tenant;
  }

  async setTenantStatus(actorUserId: string, dto: SetTenantStatusDto) {
    const tenant = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2
         RETURNING id, code, status`,
        [dto.status, dto.tenantId],
      );
      return res.rows[0];
    });

    await this.audit.logSuperAdmin({
      actorUserId,
      action: `tenant.${dto.status === 'active' ? 'activate' : 'deactivate'}`,
      entityType: 'tenant',
      entityId: dto.tenantId,
    });

    return tenant;
  }

  async listTenants() {
    return this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `SELECT id, code, display_name, status, created_at FROM tenants ORDER BY created_at DESC`,
      );
      return res.rows;
    });
  }
}

@Controller('super-admin/tenants')
@UseGuards(JwtAuthGuard, SuperAdminOnlyGuard)
export class SuperAdminController {
  constructor(private readonly superAdmin: SuperAdminService) {}

  @Post()
  async create(@Req() req: any, @Body() dto: CreateTenantDto) {
    return this.superAdmin.createTenant(req.user.sub, dto);
  }

  @Get()
  async list() {
    return this.superAdmin.listTenants();
  }

  @Post('status')
  async setStatus(@Req() req: any, @Body() dto: SetTenantStatusDto) {
    return this.superAdmin.setTenantStatus(req.user.sub, dto);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [SuperAdminController],
  providers: [SuperAdminService],
  exports: [SuperAdminService],
})
export class SuperAdminModule {}
