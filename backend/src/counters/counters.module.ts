import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { PermissionsGuard, RequirePermission } from '../rbac/rbac.module';

export class CreateCounterDto {
  @IsString() name: string;
  @IsString() code: string;
  @IsOptional() @IsUUID() assignedUserId?: string | null;
}

export class UpdateCounterDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
  @IsOptional() @IsUUID() assignedUserId?: string | null;
}

@Injectable()
export class CountersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listCounters(tenantId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT c.id, c.tenant_id, c.name, c.code, c.status, c.assigned_user_id, c.created_at,
                u.display_name AS assigned_user_name, u.username AS assigned_user_username
         FROM counters c
         LEFT JOIN users u ON u.id = c.assigned_user_id
         WHERE c.tenant_id = $1
         ORDER BY c.code ASC`,
        [tenantId],
      );
      return res.rows;
    });
  }

  async getAssignedCounter(tenantId: string, userId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name, code, status
         FROM counters
         WHERE tenant_id = $1 AND assigned_user_id = $2 AND status = 'active'
         LIMIT 1`,
        [tenantId, userId],
      );
      return res.rows[0] ?? null;
    });
  }

  async createCounter(tenantId: string, actorUserId: string, dto: CreateCounterDto) {
    return this.db.withTenant(tenantId, async (client) => {
      // 1. Concurrency safety: lock tenant resource limits row
      const limitRes = await client.query(
        `SELECT max_counters FROM tenant_resource_limits WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      const maxCounters = limitRes.rows[0]?.max_counters ?? 1;

      // 2. Count active counters
      const countRes = await client.query(
        `SELECT count(*) FROM counters WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId],
      );
      const activeCount = Number(countRes.rows[0].count);

      if (activeCount >= maxCounters) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'RESOURCE_LIMIT_REACHED',
          message: `Counter limit reached. Your shop is allowed ${maxCounters} counter(s).`,
        });
      }

      // 3. If assignedUserId is provided, verify employee belongs to this tenant and has Counter Staff capability (order.create)
      if (dto.assignedUserId) {
        const userCheck = await client.query(
          `SELECT u.id, u.status
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE u.id = $1 AND u.tenant_id = $2 AND p.code = 'order.create' AND u.status = 'active'`,
          [dto.assignedUserId, tenantId],
        );
        if (userCheck.rowCount === 0) {
          throw new BadRequestException(
            'Assigned employee must belong to this shop, be active, and hold a Counter Staff role.',
          );
        }
      }

      // 4. Check code uniqueness within tenant
      const codeCheck = await client.query(
        `SELECT 1 FROM counters WHERE tenant_id = $1 AND code = $2`,
        [tenantId, dto.code],
      );
      if (codeCheck.rowCount > 0) {
        throw new BadRequestException(`Counter with code "${dto.code}" already exists in this shop.`);
      }

      // 5. Insert counter
      const insertRes = await client.query(
        `INSERT INTO counters (tenant_id, name, code, status, assigned_user_id)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING id, name, code, status, assigned_user_id, created_at`,
        [tenantId, dto.name, dto.code, dto.assignedUserId ?? null],
      );
      const created = insertRes.rows[0];

      await this.audit.logTenant({
        tenantId,
        actorUserId,
        action: 'counter.create',
        entityType: 'counter',
        entityId: created.id,
        metadata: { name: created.name, code: created.code },
      });

      return created;
    });
  }

  async updateCounter(
    tenantId: string,
    actorUserId: string,
    counterId: string,
    dto: UpdateCounterDto,
  ) {
    return this.db.withTenant(tenantId, async (client) => {
      // Find counter
      const existingRes = await client.query(
        `SELECT id, name, code, status, assigned_user_id FROM counters WHERE id = $1 AND tenant_id = $2`,
        [counterId, tenantId],
      );
      if (existingRes.rowCount === 0) {
        throw new BadRequestException('Counter not found.');
      }
      const existing = existingRes.rows[0];

      // If activating an inactive counter, verify limit under lock
      if (dto.status === 'active' && existing.status !== 'active') {
        const limitRes = await client.query(
          `SELECT max_counters FROM tenant_resource_limits WHERE tenant_id = $1 FOR UPDATE`,
          [tenantId],
        );
        const maxCounters = limitRes.rows[0]?.max_counters ?? 1;

        const countRes = await client.query(
          `SELECT count(*) FROM counters WHERE tenant_id = $1 AND status = 'active'`,
          [tenantId],
        );
        const activeCount = Number(countRes.rows[0].count);

        if (activeCount >= maxCounters) {
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'RESOURCE_LIMIT_REACHED',
            message: `Counter limit reached. Your shop is allowed ${maxCounters} counter(s).`,
          });
        }
      }

      // If updating code, ensure uniqueness
      if (dto.code && dto.code !== existing.code) {
        const codeCheck = await client.query(
          `SELECT 1 FROM counters WHERE tenant_id = $1 AND code = $2 AND id != $3`,
          [tenantId, dto.code, counterId],
        );
        if (codeCheck.rowCount > 0) {
          throw new BadRequestException(`Counter with code "${dto.code}" already exists in this shop.`);
        }
      }

      // If assigning user, verify tenant ownership and permissions
      if (dto.assignedUserId) {
        const userCheck = await client.query(
          `SELECT u.id, u.status
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE u.id = $1 AND u.tenant_id = $2 AND p.code = 'order.create' AND u.status = 'active'`,
          [dto.assignedUserId, tenantId],
        );
        if (userCheck.rowCount === 0) {
          throw new BadRequestException(
            'Assigned employee must belong to this shop, be active, and hold a Counter Staff role.',
          );
        }
      }

      const updatedName = dto.name ?? existing.name;
      const updatedCode = dto.code ?? existing.code;
      const updatedStatus = dto.status ?? existing.status;
      const updatedAssigned =
        dto.assignedUserId !== undefined ? dto.assignedUserId : existing.assigned_user_id;

      const updateRes = await client.query(
        `UPDATE counters
         SET name = $1, code = $2, status = $3, assigned_user_id = $4, updated_at = now()
         WHERE id = $5 AND tenant_id = $6
         RETURNING id, name, code, status, assigned_user_id, updated_at`,
        [updatedName, updatedCode, updatedStatus, updatedAssigned, counterId, tenantId],
      );

      await this.audit.logTenant({
        tenantId,
        actorUserId,
        action: 'counter.update',
        entityType: 'counter',
        entityId: counterId,
        metadata: { name: updatedName, code: updatedCode, status: updatedStatus },
      });

      return updateRes.rows[0];
    });
  }

  async deleteCounter(tenantId: string, actorUserId: string, counterId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `DELETE FROM counters WHERE id = $1 AND tenant_id = $2 RETURNING id, name, code`,
        [counterId, tenantId],
      );
      if (res.rowCount === 0) {
        throw new BadRequestException('Counter not found.');
      }
      await this.audit.logTenant({
        tenantId,
        actorUserId,
        action: 'counter.delete',
        entityType: 'counter',
        entityId: counterId,
        metadata: { name: res.rows[0].name, code: res.rows[0].code },
      });
      return { deleted: true };
    });
  }
}

@Controller('counters')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CountersController {
  constructor(private readonly counters: CountersService) {}

  @Get()
  @RequirePermission('order.view')
  async list(@Req() req: any) {
    return this.counters.listCounters(req.user.tenantId);
  }

  @Get('assigned-to-me')
  @RequirePermission('order.create')
  async assignedToMe(@Req() req: any) {
    return this.counters.getAssignedCounter(req.user.tenantId, req.user.sub);
  }

  @Post()
  @RequirePermission('shop.settings')
  async create(@Req() req: any, @Body() dto: CreateCounterDto) {
    return this.counters.createCounter(req.user.tenantId, req.user.sub, dto);
  }

  @Put(':id')
  @RequirePermission('shop.settings')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateCounterDto) {
    return this.counters.updateCounter(req.user.tenantId, req.user.sub, id, dto);
  }

  @Delete(':id')
  @RequirePermission('shop.settings')
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.counters.deleteCounter(req.user.tenantId, req.user.sub, id);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [CountersController],
  providers: [CountersService],
  exports: [CountersService],
})
export class CountersModule {}
