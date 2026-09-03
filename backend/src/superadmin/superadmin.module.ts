import {
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
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
      return res.rows[0];
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
          `INSERT INTO tenant_settings (tenant_id, packing_charge_rule, packing_charge_flat, packing_charge_per_item, order_workflow_mode, enabled_modules)
           VALUES ($1, 'none', 0, 0, 'direct', ARRAY['printer'])
           ON CONFLICT (tenant_id) DO NOTHING`,
          [tenant.id],
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
      // Compensating cleanup: if sequence or Shop Admin creation fails, clean up the tenant
      this.logger.error(`Provisioning failed for tenant ${tenant.id}. Initiating compensating rollback.`, provisionErr);
      try {
        await this.db.withSuperAdmin((client) =>
          client.query(`DELETE FROM tenants WHERE id = $1`, [tenant.id]),
        );
      } catch (cleanupErr) {
        this.logger.error(`Failed to delete orphaned tenant ${tenant.id} during compensating rollback:`, cleanupErr);
      }
      throw provisionErr;
    }

    // Step 4: Audit logging
    await this.audit.logSuperAdmin({
      actorUserId,
      action: 'tenant.create',
      entityType: 'tenant',
      entityId: tenant.id,
      metadata: { code: tenant.code },
    });

    await this.audit.logSuperAdmin({
      actorUserId,
      action: 'tenant.provision_admin',
      entityType: 'user',
      entityId: adminUser.id,
      metadata: { tenantId: tenant.id, username: adminUser.username },
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
