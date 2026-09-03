import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsString, IsUUID, MinLength } from 'class-validator';
import * as argon2 from 'argon2';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { PermissionsGuard, RequirePermission } from '../rbac/rbac.module';

export class CreateEmployeeDto {
  @IsString() username: string;
  @IsString() displayName: string;
  @IsString() @MinLength(6) password: string;
  @IsArray() @IsUUID('4', { each: true }) roleIds: string[];
}

export class CreateRoleDto {
  @IsString() name: string;
  @IsArray() @IsString({ each: true }) permissionCodes: string[];
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listEmployees(tenantId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT u.id, u.username, u.display_name, u.status,
                COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = $1
         GROUP BY u.id
         ORDER BY u.username`,
        [tenantId],
      );
      return res.rows;
    });
  }

  async createEmployee(tenantId: string, actorUserId: string, dto: CreateEmployeeDto) {
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const user = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO users (tenant_id, username, password_hash, display_name, status)
         VALUES ($1,$2,$3,$4,'active') RETURNING id, username, display_name`,
        [tenantId, dto.username, passwordHash, dto.displayName],
      );
      const user = res.rows[0];
      for (const roleId of dto.roleIds) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`,
          [user.id, roleId],
        );
      }
      return user;
    });
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'employee.create',
      entityType: 'user',
      entityId: user.id,
      metadata: { username: dto.username },
    });
    return user;
  }

  async disableEmployee(tenantId: string, actorUserId: string, userId: string) {
    await this.db.withTenant(tenantId, (client) =>
      client.query(`UPDATE users SET status = 'disabled' WHERE id = $1 AND tenant_id = $2`, [
        userId,
        tenantId,
      ]),
    );
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'employee.disable',
      entityType: 'user',
      entityId: userId,
    });
  }

  async listRoles(tenantId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT r.id, r.name,
                COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
         WHERE r.tenant_id = $1
         GROUP BY r.id
         ORDER BY r.name`,
        [tenantId],
      );
      return res.rows;
    });
  }

  async listPermissionCatalog() {
    // Global catalog — not tenant-owned, safe to expose to any authenticated
    // tenant user with employee.manage (the frontend needs the full list to
    // build a role-permission editor).
    return this.db.tenantPool
      .query(`SELECT code FROM permissions ORDER BY code`)
      .then((r) => r.rows.map((row) => row.code));
  }

  async createRole(tenantId: string, actorUserId: string, dto: CreateRoleDto) {
    const role = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO roles (tenant_id, name) VALUES ($1,$2) RETURNING id, name`,
        [tenantId, dto.name],
      );
      const role = res.rows[0];
      if (dto.permissionCodes.length > 0) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT $1, id FROM permissions WHERE code = ANY($2::text[])`,
          [role.id, dto.permissionCodes],
        );
      }
      return role;
    });
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'role.create',
      entityType: 'role',
      entityId: role.id,
      metadata: { name: dto.name, permissions: dto.permissionCodes },
    });
    return role;
  }
}

@Controller('employees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('employee.manage')
  async list(@Req() req: any) {
    return this.employees.listEmployees(req.user.tenantId);
  }

  @Post()
  @RequirePermission('employee.manage')
  async create(@Req() req: any, @Body() dto: CreateEmployeeDto) {
    return this.employees.createEmployee(req.user.tenantId, req.user.sub, dto);
  }

  @Post(':id/disable')
  @RequirePermission('employee.manage')
  async disable(@Req() req: any, @Param('id') id: string) {
    await this.employees.disableEmployee(req.user.tenantId, req.user.sub, id);
    return { disabled: true };
  }
}

@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('employee.manage')
  async list(@Req() req: any) {
    return this.employees.listRoles(req.user.tenantId);
  }

  @Get('permission-catalog')
  @RequirePermission('employee.manage')
  async permissionCatalog() {
    return this.employees.listPermissionCatalog();
  }

  @Post()
  @RequirePermission('employee.manage')
  async create(@Req() req: any, @Body() dto: CreateRoleDto) {
    return this.employees.createRole(req.user.tenantId, req.user.sub, dto);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [EmployeesController, RolesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
