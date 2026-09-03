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
}

@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

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
