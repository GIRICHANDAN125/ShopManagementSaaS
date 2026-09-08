import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength, isUUID } from 'class-validator';
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
  @IsOptional() @IsBoolean() mustChangePassword?: boolean;
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
    const isTemporary = !dto.adminPassword;
    const plainPassword = dto.adminPassword || crypto.randomBytes(6).toString('hex'); // 12 characters
    const passwordHash = await argon2.hash(plainPassword, { type: argon2.argon2id });
    const mustChangePassword = dto.mustChangePassword !== undefined ? dto.mustChangePassword : isTemporary;

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
          `INSERT INTO users (tenant_id, username, password_hash, display_name, status, must_change_password)
           VALUES ($1, $2, $3, $4, 'active', $5)
           RETURNING id, username, display_name, status, tenant_id, must_change_password`,
          [tenant.id, adminUsername, passwordHash, adminDisplayName, mustChangePassword],
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
    if (!isUUID(dto.tenantId)) {
      throw new BadRequestException('Invalid tenant UUID format');
    }
    const tenant = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2
         RETURNING id, code, display_name, status`,
        [dto.status, dto.tenantId],
      );
      return res.rows[0];
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant ${dto.tenantId} not found`);
    }

    await this.audit.logSuperAdmin({
      actorUserId,
      action: `tenant.${dto.status === 'active' ? 'activate' : 'deactivate'}`,
      entityType: 'tenant',
      entityId: dto.tenantId,
      metadata: { code: tenant.code, displayName: tenant.display_name, status: dto.status },
    });

    return tenant;
  }

  async deleteTenant(actorUserId: string, tenantId: string) {
    if (!isUUID(tenantId)) {
      throw new BadRequestException('Invalid tenant UUID format');
    }

    // 1. Verify target tenant exists by exact UUID before attempting deletion
    const tenant = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `SELECT id, code, display_name FROM tenants WHERE id = $1`,
        [tenantId],
      );
      return res.rows[0];
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    // 2. Perform atomic cascading deletion strictly for target tenant UUID
    await this.db.withSuperAdmin(async (client) => {
      await client.query(`SELECT delete_tenant_cascade($1)`, [tenantId]);
    });

    // 3. Platform audit log (tenant_id IS NULL) so it permanently survives tenant deletion
    await this.audit.logSuperAdmin({
      actorUserId,
      action: 'tenant.delete',
      entityType: 'tenant',
      entityId: tenant.id,
      metadata: {
        targetTenantId: tenant.id,
        code: tenant.code,
        displayName: tenant.display_name,
        timestamp: new Date().toISOString(),
        result: 'success',
      },
    });

    return {
      success: true,
      message: `Shop ${tenant.display_name} (${tenant.code}) has been permanently deleted.`,
      id: tenant.id,
    };
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

  @Delete(':id')
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.superAdmin.deleteTenant(req.user.sub, id);
  }
}

// ---- Account Management DTOs ----------------------------------------------

export class UpdateSuperAdminUsernameDto {
  /**
   * The caller must supply their current username so we can
   * confirm they are the active Super Admin before renaming.
   */
  @IsString() @MinLength(1) currentUsername: string;

  /**
   * 3–50 characters, alphanumeric plus dots/underscores/hyphens only.
   * This mirrors the pattern used for tenant employees so the
   * login form never needs special-case handling.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'Username may only contain letters, digits, dots, underscores, and hyphens',
  })
  newUsername: string;
}

export class ChangeSuperAdminPasswordDto {
  @IsString() @MinLength(1) currentPassword: string;
  @IsString() @MinLength(8) newPassword: string;
  @IsString() @MinLength(1) confirmPassword: string;
}

// ---- SuperAdminAccountService ----------------------------------------------

@Injectable()
export class SuperAdminAccountService {
  private readonly logger = new Logger(SuperAdminAccountService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Returns the authenticated Super Admin's profile (no sensitive fields). */
  async getProfile(actorUserId: string) {
    const user = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `SELECT id, username, display_name, status, created_at
         FROM users
         WHERE id = $1 AND tenant_id IS NULL`,
        [actorUserId],
      );
      return res.rows[0] ?? null;
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Super Admin account not found or inactive');
    }
    return user;
  }

  /**
   * Changes the Super Admin's username.
   *
   * Security properties:
   *   - Only the currently authenticated Super Admin can rename themselves
   *     (actorUserId comes from the verified JWT, not the request body).
   *   - currentUsername must match the stored username as an extra guard.
   *   - New username is checked for uniqueness among ALL Super Admin rows
   *     (tenant_id IS NULL) via an explicit SELECT before the UPDATE because
   *     the standard UNIQUE(tenant_id, username) constraint treats NULL values
   *     as distinct, so it would not catch duplicates among Super Admin users.
   *   - Username format is validated by the DTO (alphanumeric / dots / etc).
   *   - Old username is invalidated for login immediately on UPDATE.
   */
  async updateUsername(actorUserId: string, dto: UpdateSuperAdminUsernameDto) {
    const trimmedNew = dto.newUsername.trim().toLowerCase();

    // 1. Verify the actor exists and current username matches
    const existing = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `SELECT id, username, status FROM users WHERE id = $1 AND tenant_id IS NULL`,
        [actorUserId],
      );
      return res.rows[0] ?? null;
    });

    if (!existing || existing.status !== 'active') {
      throw new UnauthorizedException('Super Admin account not found or inactive');
    }

    if (existing.username.toLowerCase() !== dto.currentUsername.trim().toLowerCase()) {
      throw new BadRequestException('Current username does not match');
    }

    // 2. No-op if the new username is the same as the current one
    if (existing.username.toLowerCase() === trimmedNew) {
      return { success: true, message: 'Username unchanged' };
    }

    // 3. Check uniqueness across all Super Admin accounts (tenant_id IS NULL)
    const duplicate = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `SELECT id FROM users WHERE tenant_id IS NULL AND LOWER(username) = $1 AND id != $2`,
        [trimmedNew, actorUserId],
      );
      return res.rows[0] ?? null;
    });

    if (duplicate) {
      throw new ConflictException(`Username "${dto.newUsername}" is already taken`);
    }

    // 4. Perform the update
    await this.db.withSuperAdmin(async (client) => {
      await client.query(
        `UPDATE users SET username = $1 WHERE id = $2 AND tenant_id IS NULL`,
        [trimmedNew, actorUserId],
      );
    });

    // 5. Audit log — no passwords, no hashes
    await this.audit.logSuperAdmin({
      actorUserId,
      action: 'superadmin.change_username',
      entityType: 'user',
      entityId: actorUserId,
      metadata: { oldUsername: existing.username, newUsername: trimmedNew },
    });

    this.logger.log(`Super Admin ${actorUserId} changed username from "${existing.username}" to "${trimmedNew}"`);

    return { success: true, message: 'Username updated successfully' };
  }

  /**
   * Changes the Super Admin's password.
   *
   * Follows the same security pattern as AuthService.changePassword for
   * tenant users (ARCHITECTURE.md §4, SECURITY.md §16):
   *   - Verifies current password with the existing safe verifier.
   *   - Hashes with Argon2id.
   *   - Never returns or logs passwords / hashes.
   *   - Uses the dedicated superAdminPool so RLS is not bypassed.
   */
  async changePassword(actorUserId: string, dto: ChangeSuperAdminPasswordDto) {
    // 1. Client-side-checkable validations (returned as 400 to avoid enumeration)
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('New password and confirmation do not match');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must be different from the current password');
    }

    // 2. Fetch current hash — never return it to the caller
    const user = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `SELECT id, password_hash, status FROM users WHERE id = $1 AND tenant_id IS NULL`,
        [actorUserId],
      );
      return res.rows[0] ?? null;
    });

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Super Admin account not found or inactive');
    }

    // 3. Verify current password with safe handler (malformed hashes → false, not 500)
    let valid = false;
    try {
      const hash: string = user.password_hash;
      if (hash && typeof hash === 'string' && hash.startsWith('$')) {
        valid = await argon2.verify(hash, dto.currentPassword);
      } else {
        this.logger.warn(`Super Admin ${actorUserId}: stored password hash is malformed`);
      }
    } catch (err) {
      this.logger.warn(
        `Super Admin ${actorUserId}: password verification failed safely: ${(err as Error)?.message}`,
      );
    }
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // 4. Hash new password with Argon2id
    const newHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    // 5. Persist the new hash
    await this.db.withSuperAdmin(async (client) => {
      await client.query(
        `UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2 AND tenant_id IS NULL`,
        [newHash, actorUserId],
      );
    });

    // 6. Audit log — no passwords, no hashes in metadata
    await this.audit.logSuperAdmin({
      actorUserId,
      action: 'superadmin.change_password',
      entityType: 'user',
      entityId: actorUserId,
      metadata: { timestamp: new Date().toISOString(), result: 'success' },
    });

    this.logger.log(`Super Admin ${actorUserId} changed their password`);

    return { success: true, message: 'Password updated successfully. Please use the new password on your next login.' };
  }
}

// ---- SuperAdminAccountController -------------------------------------------

@Controller('super-admin/account')
@UseGuards(JwtAuthGuard, SuperAdminOnlyGuard)
export class SuperAdminAccountController {
  constructor(private readonly account: SuperAdminAccountService) {}

  /** GET /super-admin/account/me — returns the authenticated Super Admin's profile */
  @Get('me')
  async getProfile(@Req() req: any) {
    return this.account.getProfile(req.user.sub);
  }

  /** PUT /super-admin/account/username — change the Super Admin's username */
  @Put('username')
  async updateUsername(@Req() req: any, @Body() dto: UpdateSuperAdminUsernameDto) {
    return this.account.updateUsername(req.user.sub, dto);
  }

  /** PUT /super-admin/account/password — change the Super Admin's password */
  @Put('password')
  async changePassword(@Req() req: any, @Body() dto: ChangeSuperAdminPasswordDto) {
    return this.account.changePassword(req.user.sub, dto);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [SuperAdminController, SuperAdminAccountController],
  providers: [SuperAdminService, SuperAdminAccountService],
  exports: [SuperAdminService, SuperAdminAccountService],
})
export class SuperAdminModule {}
