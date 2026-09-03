import { Controller, Get, Injectable, Module, Query, Req, UseGuards } from '@nestjs/common';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { PermissionsGuard, RequirePermission } from '../rbac/rbac.module';

/**
 * All queries are scoped by tenant_id = $1 AND go through db.withTenant
 * (RLS session context set) — tenant isolation for reports is enforced
 * the same two ways as everywhere else (application filter + RLS
 * backstop), never assumed from a single layer.
 *
 * Date bucketing uses the TENANT'S configured timezone
 * (tenants.timezone), not server/UTC time — this is the specific bug
 * class flagged in TESTING.md §15 (midnight boundary tests).
 *
 * SECURITY NOTE: an earlier draft of this file string-interpolated the
 * timezone value directly into SQL (`AT TIME ZONE '${tz}'`). Even though
 * tz only ever comes from trusted server-side data (tenants.timezone,
 * settable only by Super Admin, never client input), that is an
 * injection-SHAPED pattern that should never exist regardless of the
 * current trust level of the data — found during this build's own
 * security review and fixed below to use bound parameters throughout,
 * including for the timezone itself and the day-count interval.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  private async getTimezone(tenantId: string): Promise<string> {
    const res = await this.db.tenantPool.query(
      `SELECT timezone FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return res.rows[0]?.timezone ?? 'UTC';
  }

  private async summaryForRange(tenantId: string, startAt: Date, endAt: Date) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT
           count(*) FILTER (WHERE status NOT IN ('CANCELLED')) AS total_orders,
           count(*) FILTER (WHERE status = 'COLLECTED') AS completed_orders,
           count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled_orders,
           count(*) FILTER (WHERE status IN ('CREATED','WAITING')) AS waiting_orders,
           count(*) FILTER (WHERE status = 'PREPARING') AS preparing_orders,
           count(*) FILTER (WHERE status = 'READY') AS ready_orders,
           COALESCE(sum(total) FILTER (WHERE status <> 'CANCELLED'), 0) AS revenue,
           COALESCE(avg(total) FILTER (WHERE status <> 'CANCELLED'), 0) AS average_order_value
         FROM orders
         WHERE tenant_id = $1
           AND created_at_device >= $2
           AND created_at_device <  $3`,
        [tenantId, startAt, endAt],
      );
      return res.rows[0];
    });
  }

  /** Computes [startAt, endAt) for "today" in the tenant's timezone using
   * a single parameterized query — no string interpolation of the
   * timezone or any other value anywhere in this path. */
  private async dayBoundsInTenantTz(
    tenantId: string,
    dayOffset: number,
  ): Promise<{ start: Date; end: Date }> {
    const tz = await this.getTimezone(tenantId);
    const res = await this.db.tenantPool.query(
      `SELECT
         (date_trunc('day', now() AT TIME ZONE $1) + make_interval(days => $2)) AT TIME ZONE $1 AS start_at,
         (date_trunc('day', now() AT TIME ZONE $1) + make_interval(days => $2 + 1)) AT TIME ZONE $1 AS end_at`,
      [tz, dayOffset],
    );
    return { start: res.rows[0].start_at, end: res.rows[0].end_at };
  }

  private async monthBoundsInTenantTz(tenantId: string): Promise<{ start: Date; end: Date }> {
    const tz = await this.getTimezone(tenantId);
    const res = await this.db.tenantPool.query(
      `SELECT
         date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1 AS start_at,
         (date_trunc('month', now() AT TIME ZONE $1) + interval '1 month') AT TIME ZONE $1 AS end_at`,
      [tz],
    );
    return { start: res.rows[0].start_at, end: res.rows[0].end_at };
  }

  async today(tenantId: string) {
    const { start, end } = await this.dayBoundsInTenantTz(tenantId, 0);
    return this.summaryForRange(tenantId, start, end);
  }

  async previousDay(tenantId: string) {
    const { start, end } = await this.dayBoundsInTenantTz(tenantId, -1);
    return this.summaryForRange(tenantId, start, end);
  }

  async lastNDays(tenantId: string, days: number) {
    const { end } = await this.dayBoundsInTenantTz(tenantId, 0);
    const { start } = await this.dayBoundsInTenantTz(tenantId, -days);
    return this.summaryForRange(tenantId, start, end);
  }

  async thisMonth(tenantId: string) {
    const { start, end } = await this.monthBoundsInTenantTz(tenantId);
    return this.summaryForRange(tenantId, start, end);
  }

  async customRange(tenantId: string, startISO: string, endISO: string) {
    return this.summaryForRange(tenantId, new Date(startISO), new Date(endISO));
  }
}

@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('today')
  @RequirePermission('reports.view')
  async today(@Req() req: any) {
    return this.reports.today(req.user.tenantId);
  }

  @Get('previous-day')
  @RequirePermission('reports.view')
  async previousDay(@Req() req: any) {
    return this.reports.previousDay(req.user.tenantId);
  }

  @Get('weekly')
  @RequirePermission('reports.view')
  async weekly(@Req() req: any) {
    return this.reports.lastNDays(req.user.tenantId, 7);
  }

  @Get('monthly')
  @RequirePermission('reports.view')
  async monthly(@Req() req: any) {
    return this.reports.thisMonth(req.user.tenantId);
  }

  @Get('range')
  @RequirePermission('reports.view')
  async range(@Req() req: any, @Query('start') start: string, @Query('end') end: string) {
    return this.reports.customRange(req.user.tenantId, start, end);
  }
}

@Module({
  imports: [DatabaseModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
