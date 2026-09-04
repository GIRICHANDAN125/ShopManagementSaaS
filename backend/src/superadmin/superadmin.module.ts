import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { SuperAdminOnlyGuard } from '../rbac/rbac.module';

export class CreateTenantDto {
  @IsString() displayName: string;
  @IsOptional() @IsString() businessType?: string;
  @IsOptional() @IsString() adminUsername?: string;
  @IsOptional() @IsString() adminDisplayName?: string;
  @IsOptional() @IsString() @MinLength(6) adminPassword?: string;
  @IsOptional() @IsInt() @Min(1) maxEmployees?: number;
  @IsOptional() @IsInt() @Min(1) maxCounters?: number;
  @IsOptional() @IsInt() @Min(1) maxCustomerDisplays?: number;
  @IsOptional() @IsInt() @Min(1) maxPrinters?: number;
}

export class UpdateLimitsDto {
  @IsInt() @Min(1) maxEmployees: number;
  @IsInt() @Min(1) maxCounters: number;
  @IsInt() @Min(1) maxCustomerDisplays: number;
  @IsInt() @Min(1) maxPrinters: number;
}

export class SetTenantStatusDto {
  @IsString() tenantId: string;
  @IsIn(['active', 'inactive']) status: 'active' | 'inactive';
}

export const DEFAULT_SHOP_ROLES = [
  {
    name: 'Shop Admin',
    permissions: [
      'employee.manage',
      'shop.settings',
      'product.manage',
      'inventory.manage',
      'reports.view',
      'device.manage',
      'order.view',
      'order.create',
      'order.cancel',
      'receipt.print',
      'receipt.reprint',
    ],
  },
  {
    name: 'Counter Staff',
    permissions: ['order.create', 'order.view', 'receipt.print', 'receipt.reprint'],
  },
  {
    name: 'Kitchen Staff',
    permissions: ['order.view'],
  },
  {
    name: 'Coordinator Staff',
    permissions: ['order.view'],
  },
];

@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async createTenant(actorUserId: string, dto: CreateTenantDto) {
    const code = `TENANT_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const seqName = `order_seq_${code.toLowerCase()}`;

    const adminUsername = (dto.adminUsername?.trim() || 'admin').toLowerCase();
    const adminDisplayName = dto.adminDisplayName?.trim() || `${dto.displayName} Admin`;
    const plainPassword = dto.adminPassword || crypto.randomBytes(6).toString('hex'); // 12 characters
    const passwordHash = await argon2.hash(plainPassword, { type: argon2.argon2id });

    // Step 1: Insert tenant into root registry (superAdmin pool)
    const tenant = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `INSERT INTO tenants (code, display_name, business_type, status, order_sequence_name)
         VALUES ($1,$2,$3,'active',$4)
         RETURNING id, code, display_name, status`,
        [code, dto.displayName, dto.businessType ?? null, seqName],
      );
      const created = res.rows[0];

      // Provision tenant resource limits (Requirement 2 & 3)
      await client.query(
        `INSERT INTO tenant_resource_limits (tenant_id, max_employees, max_counters, max_customer_displays, max_printers)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          created.id,
          dto.maxEmployees ?? 5,
          dto.maxCounters ?? 1,
          dto.maxCustomerDisplays ?? 1,
          dto.maxPrinters ?? 1,
        ],
      );

      return created;
    });

    let adminUser: { id: string; username: string; display_name: string };

    try {
      // Step 2: Provision tenant order sequence (superAdmin pool)
      await this.db.withSuperAdmin((client) =>
        client.query(`SELECT create_tenant_order_sequence($1)`, [seqName]),
      );

      // Step 3: Transactional provisioning of default roles and initial Shop Admin (tenant pool under RLS)
      const provisionResult = await this.db.withTenant(tenant.id, async (client) => {
        let adminRoleId: string | null = null;

        for (const roleDef of DEFAULT_SHOP_ROLES) {
          const roleRes = await client.query(
            `INSERT INTO roles (tenant_id, name) VALUES ($1, $2) RETURNING id`,
            [tenant.id, roleDef.name],
          );
          const roleId = roleRes.rows[0].id;

          if (roleDef.name === 'Shop Admin') {
            adminRoleId = roleId;
          }

          if (roleDef.permissions.length > 0) {
            await client.query(
              `INSERT INTO role_permissions (role_id, permission_id)
               SELECT $1, id FROM permissions WHERE code = ANY($2::text[])`,
              [roleId, roleDef.permissions],
            );
          }
        }

        // Insert initial Shop Admin (tenant_id strictly equals tenant.id, never NULL)
        const userRes = await client.query(
          `INSERT INTO users (tenant_id, username, password_hash, display_name, status)
           VALUES ($1, $2, $3, $4, 'active')
           RETURNING id, username, display_name, status, tenant_id`,
          [tenant.id, adminUsername, passwordHash, adminDisplayName],
        );

        const createdUser = userRes.rows[0];

        if (adminRoleId) {
          await client.query(
            `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
            [createdUser.id, adminRoleId],
          );
        }

        // Initialize tenant settings
        await client.query(
          `INSERT INTO tenant_settings (tenant_id, key, value)
           VALUES ($1, 'packing_config', $2),
                  ($1, 'workflow_config', $3)
           ON CONFLICT (tenant_id, key) DO NOTHING`,
          [
            tenant.id,
            JSON.stringify({ rule: 'none' }),
            JSON.stringify({ mode: 'direct', enabledModules: ['printer'] }),
          ],
        );

        return {
          adminUser: {
            id: createdUser.id,
            username: createdUser.username,
            display_name: createdUser.display_name,
          },
        };
      });

      adminUser = provisionResult.adminUser;
    } catch (provisionErr) {
      // Compensating cleanup: if sequence or Shop Admin creation fails, clean up the tenant and sequence
      this.logger.error(`Provisioning failed for tenant ${tenant.id}. Initiating compensating rollback.`, provisionErr);
      try {
        await this.db.withSuperAdmin((client) =>
          client.query(`DELETE FROM tenants WHERE id = $1`, [tenant.id]),
        );
      } catch (cleanupErr) {
        this.logger.error(`Failed to delete orphaned tenant ${tenant.id} during compensating rollback:`, cleanupErr);
      }
      try {
        await this.db.withSuperAdmin((client) =>
          client.query(`SELECT drop_tenant_order_sequence($1)`, [seqName]),
        );
      } catch (seqCleanupErr) {
        this.logger.error(`Failed to drop orphaned sequence ${seqName} during compensating rollback:`, seqCleanupErr);
      }
      throw provisionErr;
    }

    // Step 4: Audit logging
    await this.audit.logSuperAdmin({
      actorUserId,
      action: 'tenant.create',
      entityType: 'tenant',
      entityId: tenant.id,
      metadata: { code: tenant.code, displayName: tenant.display_name },
    });

    return {
      id: tenant.id,
      code: tenant.code,
      display_name: tenant.display_name,
      status: tenant.status,
      admin_user: adminUser,
      initial_credentials: {
        shop_code: tenant.code,
        username: adminUser.username,
        temporary_password: plainPassword,
      },
    };
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

  async updateTenantLimits(actorUserId: string, tenantId: string, dto: UpdateLimitsDto) {
    // 1. Verify tenant exists using superadmin pool
    const tenant = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
      return res.rows[0];
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    // 2. Count active resources under explicit tenant context (respecting PostgreSQL RLS)
    const counts = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT
          (SELECT count(*) FROM users WHERE tenant_id = $1 AND status = 'active') AS active_employees,
          (SELECT count(*) FROM counters WHERE tenant_id = $1 AND status = 'active') AS active_counters,
          (SELECT count(*) FROM devices WHERE tenant_id = $1 AND type = 'customer_display' AND status = 'active') AS active_displays,
          (SELECT count(*) FROM printers WHERE tenant_id = $1 AND status = 'active') AS active_printers`,
        [tenantId],
      );
      return res.rows[0];
    });

    const activeEmployees = Number(counts.active_employees);
    const activeCounters = Number(counts.active_counters);
    const activeDisplays = Number(counts.active_displays);
    const activePrinters = Number(counts.active_printers);

    if (dto.maxEmployees < activeEmployees) {
      throw new BadRequestException(
        `Cannot reduce employee limit to ${dto.maxEmployees} because this shop currently has ${activeEmployees} active employee(s). Disable/remove ${activeEmployees - dto.maxEmployees} employee(s) first.`,
      );
    }
    if (dto.maxCounters < activeCounters) {
      throw new BadRequestException(
        `Cannot reduce counter limit to ${dto.maxCounters} because this shop currently has ${activeCounters} active counter(s). Deactivate/remove ${activeCounters - dto.maxCounters} counter(s) first.`,
      );
    }
    if (dto.maxCustomerDisplays < activeDisplays) {
      throw new BadRequestException(
        `Cannot reduce customer display limit to ${dto.maxCustomerDisplays} because this shop currently has ${activeDisplays} active display(s). Revoke ${activeDisplays - dto.maxCustomerDisplays} display(s) first.`,
      );
    }
    if (dto.maxPrinters < activePrinters) {
      throw new BadRequestException(
        `Cannot reduce printer limit to ${dto.maxPrinters} because this shop currently has ${activePrinters} active printer(s). Deactivate/remove ${activePrinters - dto.maxPrinters} printer(s) first.`,
      );
    }

    return this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `INSERT INTO tenant_resource_limits (tenant_id, max_employees, max_counters, max_customer_displays, max_printers, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           max_employees = EXCLUDED.max_employees,
           max_counters = EXCLUDED.max_counters,
           max_customer_displays = EXCLUDED.max_customer_displays,
           max_printers = EXCLUDED.max_printers,
           updated_at = now()
         RETURNING tenant_id, max_employees, max_counters, max_customer_displays, max_printers`,
        [tenantId, dto.maxEmployees, dto.maxCounters, dto.maxCustomerDisplays, dto.maxPrinters],
      );

      await this.audit.logSuperAdmin({
        actorUserId,
        action: 'tenant.limits_update',
        entityType: 'tenant',
        entityId: tenantId,
        metadata: dto as unknown as Record<string, unknown>,
      });

      return res.rows[0];
    });
  }

  async listTenants() {
    return this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `SELECT t.id, t.code, t.display_name, t.business_type, t.status, t.created_at,
                COALESCE(l.max_employees, 5) AS max_employees,
                COALESCE(l.max_counters, 1) AS max_counters,
                COALESCE(l.max_customer_displays, 1) AS max_customer_displays,
                COALESCE(l.max_printers, 1) AS max_printers,
                (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active') AS active_employees,
                (SELECT count(*) FROM counters c WHERE c.tenant_id = t.id AND c.status = 'active') AS active_counters,
                (SELECT count(*) FROM devices d WHERE d.tenant_id = t.id AND d.type = 'customer_display' AND d.status = 'active') AS active_displays,
                (SELECT count(*) FROM printers p WHERE p.tenant_id = t.id AND p.status = 'active') AS active_printers
         FROM tenants t
         LEFT JOIN tenant_resource_limits l ON l.tenant_id = t.id
         ORDER BY t.created_at DESC`,
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

  @Put(':id/limits')
  async updateLimits(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateLimitsDto) {
    return this.superAdmin.updateTenantLimits(req.user.sub, id, dto);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [SuperAdminController],
  providers: [SuperAdminService],
  exports: [SuperAdminService],
})
export class SuperAdminModule {}
