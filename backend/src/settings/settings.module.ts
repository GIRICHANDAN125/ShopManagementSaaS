import { Body, Controller, Get, Injectable, Module, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsArray, IsString, Min } from 'class-validator';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { PermissionsGuard, RequirePermission } from '../rbac/rbac.module';

export class PackingConfigDto {
  @IsIn(['none', 'flat', 'per_item']) rule: 'none' | 'flat' | 'per_item';
  @IsOptional() @IsNumber() @Min(0) flatCharge?: number;
  @IsOptional() @IsNumber() @Min(0) perItemCharge?: number;
}

export class WorkflowConfigDto {
  @IsIn(['direct', 'coordinator', 'kitchen']) mode: 'direct' | 'coordinator' | 'kitchen';
  @IsArray() @IsString({ each: true }) enabledModules: string[]; // e.g. ['kitchen_display','tv','coordinator_display','printer']
}

/**
 * Every value here lives in `tenant_settings` (key/value JSONB per tenant,
 * DATABASE.md §11) — no service class anywhere branches on a tenant's
 * name or type to decide packing/workflow behavior (Development Rule 1).
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private async getSetting<T>(tenantId: string, key: string, fallback: T): Promise<T> {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = $2`,
        [tenantId, key],
      );
      return res.rowCount > 0 ? res.rows[0].value : fallback;
    });
  }

  private async setSetting(tenantId: string, key: string, value: unknown) {
    return this.db.withTenant(tenantId, (client) =>
      client.query(
        `INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [tenantId, key, JSON.stringify(value)],
      ),
    );
  }

  getPackingConfig(tenantId: string) {
    return this.getSetting(tenantId, 'packing_config', { rule: 'none' });
  }

  async setPackingConfig(tenantId: string, actorUserId: string, dto: PackingConfigDto) {
    await this.setSetting(tenantId, 'packing_config', dto);
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'settings.packing_config.update',
      entityType: 'tenant_settings',
      metadata: dto as unknown as Record<string, unknown>,
    });
    return dto;
  }

  getWorkflowConfig(tenantId: string) {
    return this.getSetting(tenantId, 'workflow_config', {
      mode: 'direct',
      enabledModules: [],
    });
  }

  async setWorkflowConfig(tenantId: string, actorUserId: string, dto: WorkflowConfigDto) {
    await this.setSetting(tenantId, 'workflow_config', dto);
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'settings.workflow_config.update',
      entityType: 'tenant_settings',
      metadata: dto as unknown as Record<string, unknown>,
    });
    return dto;
  }

  async getResourceUsageAndLimits(tenantId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const limitsRes = await client.query(
        `SELECT max_employees, max_counters, max_customer_displays, max_printers
         FROM tenant_resource_limits
         WHERE tenant_id = $1`,
        [tenantId],
      );
      const limits = limitsRes.rows[0] ?? {
        max_employees: 5,
        max_counters: 1,
        max_customer_displays: 1,
        max_printers: 1,
      };

      const usageRes = await client.query(
        `SELECT
          (SELECT count(*) FROM users WHERE tenant_id = $1 AND status = 'active') AS active_employees,
          (SELECT count(*) FROM counters WHERE tenant_id = $1 AND status = 'active') AS active_counters,
          (SELECT count(*) FROM devices WHERE tenant_id = $1 AND type = 'customer_display' AND status = 'active') AS active_displays,
          (SELECT count(*) FROM printers WHERE tenant_id = $1 AND status = 'active') AS active_printers`,
        [tenantId],
      );
      const usage = usageRes.rows[0];

      return {
        limits: {
          max_employees: Number(limits.max_employees),
          max_counters: Number(limits.max_counters),
          max_customer_displays: Number(limits.max_customer_displays),
          max_printers: Number(limits.max_printers),
        },
        usage: {
          active_employees: Number(usage.active_employees),
          active_counters: Number(usage.active_counters),
          active_displays: Number(usage.active_displays),
          active_printers: Number(usage.active_printers),
        },
      };
    });
  }
}

@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('resource-usage')
  @RequirePermission('order.view')
  async getResourceUsage(@Req() req: any) {
    return this.settings.getResourceUsageAndLimits(req.user.tenantId);
  }

  @Get('packing')
  @RequirePermission('order.view')
  async getPacking(@Req() req: any) {
    return this.settings.getPackingConfig(req.user.tenantId);
  }

  @Post('packing')
  @RequirePermission('shop.settings')
  async setPacking(@Req() req: any, @Body() dto: PackingConfigDto) {
    return this.settings.setPackingConfig(req.user.tenantId, req.user.sub, dto);
  }

  @Get('workflow')
  @RequirePermission('order.view')
  async getWorkflow(@Req() req: any) {
    return this.settings.getWorkflowConfig(req.user.tenantId);
  }

  @Post('workflow')
  @RequirePermission('shop.settings')
  async setWorkflow(@Req() req: any, @Body() dto: WorkflowConfigDto) {
    return this.settings.setWorkflowConfig(req.user.tenantId, req.user.sub, dto);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
