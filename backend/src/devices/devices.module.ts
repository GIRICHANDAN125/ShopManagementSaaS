import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsString, IsUUID, IsInt, IsOptional, Min, Max, IsIn } from 'class-validator';
import * as crypto from 'crypto';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { PermissionsGuard, RequirePermission } from '../rbac/rbac.module';

export class DeviceConnectDto {
  @IsUUID() deviceId: string;
  @IsString() credential: string;
}

// Credential mechanism: DATABASE.md/SECURITY.md §19 deliberately leave the
// exact mechanism (client cert vs bound secret token) open until Phase 9.
// This implementation uses a bound-secret-token approach as the concrete
// choice for this build, clearly isolated behind this module so swapping
// to client certs later does not touch callers.
function hashCredential(rawSecret: string, pepper: string): string {
  return crypto.createHmac('sha256', pepper).update(rawSecret).digest('hex');
}

export class RegisterDeviceDto {
  @IsString() name: string;
  @IsOptional() @IsUUID() counterId?: string;
  @IsOptional() @IsIn(['counter', 'customer_display']) type?: 'counter' | 'customer_display';
}

export class ReserveRangeDto {
  @IsInt() @Min(1) @Max(1000) blockSize: number;
}

@Injectable()
export class DevicesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Shop Admin action — requires device.manage. Returns the raw secret
   * exactly once; only the hash is ever stored. */
  async registerDevice(tenantId: string, actorUserId: string, dto: RegisterDeviceDto) {
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const pepper = process.env.DEVICE_CREDENTIAL_PEPPER ?? '';
    const credentialHash = hashCredential(rawSecret, pepper);
    const devType = dto.type ?? 'counter';

    const device = await this.db.withTenant(tenantId, async (client) => {
      if (devType === 'customer_display') {
        // Concurrency safety: lock tenant resource limits row
        const limitRes = await client.query(
          `SELECT max_customer_displays FROM tenant_resource_limits WHERE tenant_id = $1 FOR UPDATE`,
          [tenantId],
        );
        const maxDisplays = limitRes.rows[0]?.max_customer_displays ?? 1;

        const countRes = await client.query(
          `SELECT count(*) FROM devices WHERE tenant_id = $1 AND type = 'customer_display' AND status = 'active'`,
          [tenantId],
        );
        const activeCount = Number(countRes.rows[0].count);

        if (activeCount >= maxDisplays) {
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'RESOURCE_LIMIT_REACHED',
            message: `Customer Display limit reached. Your shop is allowed ${maxDisplays} display(s).`,
          });
        }
      }

      const res = await client.query(
        `INSERT INTO devices (tenant_id, counter_id, name, type, credential_hash, status)
         VALUES ($1,$2,$3,$4,$5,'active') RETURNING id, name, type, status`,
        [tenantId, dto.counterId ?? null, dto.name, devType, credentialHash],
      );
      const created = res.rows[0];
      // Non-sensitive routing entry — see migration 0010 for why this
      // table exists and why it deliberately has no RLS.
      await client.query(
        `INSERT INTO device_tenant_lookup (device_id, tenant_id) VALUES ($1,$2)`,
        [created.id, tenantId],
      );
      return created;
    });

    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'device.register',
      entityType: 'device',
      entityId: device.id,
      metadata: { name: dto.name, type: devType },
    });

    return { device, credential: rawSecret }; // shown once
  }

  async listDevices(tenantId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name, type, counter_id, status, registered_at, revoked_at
         FROM devices
         WHERE tenant_id = $1
         ORDER BY registered_at DESC`,
        [tenantId],
      );
      return res.rows;
    });
  }

  async revokeDevice(tenantId: string, actorUserId: string, deviceId: string) {
    await this.db.withTenant(tenantId, (client) =>
      client.query(
        `UPDATE devices SET status = 'revoked', revoked_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [deviceId, tenantId],
      ),
    );
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'device.revoke',
      entityType: 'device',
      entityId: deviceId,
    });
  }

  /** Authenticates a device by its raw secret, scoped to a tenant. Used
   * by the (not-yet-built) offline-capable counter client before it can
   * request a reservation. Kept here as the single verification path so
   * device auth logic never duplicates. */
  async authenticateDevice(tenantId: string, deviceId: string, rawSecret: string) {
    const pepper = process.env.DEVICE_CREDENTIAL_PEPPER ?? '';
    const expectedHash = hashCredential(rawSecret, pepper);
    const device = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, status FROM devices WHERE id = $1 AND tenant_id = $2 AND credential_hash = $3`,
        [deviceId, tenantId, expectedHash],
      );
      return res.rows[0] ?? null;
    });
    if (!device || device.status !== 'active') {
      throw new ForbiddenException('Invalid or revoked device credential');
    }
    return device;
  }

  /**
   * Device-native authentication for the realtime/TV path (requirement:
   * proper Customer TV/device auth per SECURITY.md §19 — no more reusing
   * a staff token). A device presents its OWN credential and receives a
   * narrowly-scoped token good only for the WebSocket subscription —
   * it carries no `permissions` and is never accepted by any REST
   * endpoint (see RealtimeGateway and JwtStrategy's separate handling).
   *
   * Bootstrap: resolves tenant_id via the non-sensitive
   * device_tenant_lookup table (migration 0010) — this reveals nothing
   * exploitable on its own — then verifies the actual credential against
   * the real, RLS-protected `devices` row inside that tenant's context.
   */
  async connectWithCredential(dto: DeviceConnectDto) {
    const pepper = process.env.DEVICE_CREDENTIAL_PEPPER ?? '';
    const expectedHash = hashCredential(dto.credential, pepper);

    const lookup = await this.db.tenantPool.query(
      `SELECT tenant_id FROM device_tenant_lookup WHERE device_id = $1`,
      [dto.deviceId],
    );
    if (lookup.rowCount === 0) {
      throw new ForbiddenException('Invalid device credential');
    }
    const tenantId = lookup.rows[0].tenant_id;

    const device = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, status, credential_hash FROM devices WHERE id = $1 AND tenant_id = $2`,
        [dto.deviceId, tenantId],
      );
      return res.rows[0] ?? null;
    });

    if (!device || device.status !== 'active' || device.credential_hash !== expectedHash) {
      throw new ForbiddenException('Invalid or revoked device credential');
    }

    const token = this.jwt.sign(
      { deviceId: device.id, tenantId, type: 'device' },
      { secret: this.config.get('JWT_ACCESS_SECRET'), expiresIn: '12h' },
    );

    await this.audit.logTenant({
      tenantId,
      actorDeviceId: device.id,
      action: 'device.connect',
      entityType: 'device',
      entityId: device.id,
    });

    return { token, tenantId };
  }

  /**
   * Reserves a contiguous, non-overlapping block of real order numbers
   * for a device (OFFLINE_SYNC_DESIGN.md §3, DATABASE.md §5.3/§6). Uses
   * the DB-side reserve_order_range() function, which takes a
   * tenant-scoped advisory lock so concurrent reservation requests for
   * the same tenant serialize against EACH OTHER only — never against
   * ordinary single-order allocation.
   */
  async reserveRange(tenantId: string, deviceId: string, dto: ReserveRangeDto) {
    return this.db.withTenant(tenantId, async (client) => {
      const device = await client.query(
        `SELECT status FROM devices WHERE id = $1 AND tenant_id = $2`,
        [deviceId, tenantId],
      );
      if (device.rowCount === 0 || device.rows[0].status !== 'active') {
        throw new ForbiddenException('Device not active');
      }
      const tenantRow = await client.query(
        `SELECT order_sequence_name FROM tenants WHERE id = $1`,
        [tenantId],
      );
      const seqName = tenantRow.rows[0].order_sequence_name;

      const rangeRes = await client.query(
        `SELECT * FROM reserve_order_range($1, $2, $3)`,
        [tenantId, seqName, dto.blockSize],
      );
      const { range_start, range_end } = rangeRes.rows[0];

      const reservation = await client.query(
        `INSERT INTO device_order_reservations
           (tenant_id, device_id, range_start, range_end, next_to_issue, status)
         VALUES ($1,$2,$3,$4,$3,'active')
         RETURNING id, range_start, range_end, next_to_issue, status`,
        [tenantId, deviceId, range_start, range_end],
      );
      return reservation.rows[0];
    });
  }

  /**
   * Issues the next number from an active reservation for offline order
   * creation. If the reservation is exhausted, this throws rather than
   * inventing a fallback numbering scheme (OFFLINE_SYNC_DESIGN.md §6 —
   * hard stop by design, no silent degradation).
   */
  async issueFromReservation(tenantId: string, reservationId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE device_order_reservations
         SET next_to_issue = next_to_issue + 1,
             status = CASE WHEN next_to_issue + 1 > range_end THEN 'exhausted' ELSE status END,
             closed_at = CASE WHEN next_to_issue + 1 > range_end THEN now() ELSE closed_at END
         WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND next_to_issue <= range_end
         RETURNING next_to_issue - 1 AS issued_number, status`,
        [reservationId, tenantId],
      );
      if (res.rowCount === 0) {
        throw new BadRequestException(
          'RANGE_EXHAUSTED: reservation has no numbers left — device must reconnect for a new reservation',
        );
      }
      return res.rows[0];
    });
  }
}

@Controller('devices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequirePermission('device.manage')
  async list(@Req() req: any) {
    return this.devices.listDevices(req.user.tenantId);
  }

  @Post()
  @RequirePermission('device.manage')
  async register(@Req() req: any, @Body() dto: RegisterDeviceDto) {
    return this.devices.registerDevice(req.user.tenantId, req.user.sub, dto);
  }

  @Post(':id/revoke')
  @RequirePermission('device.manage')
  async revoke(@Req() req: any, @Body('deviceId') deviceId: string) {
    return this.devices.revokeDevice(req.user.tenantId, req.user.sub, deviceId);
  }

  // Simplification flagged in the final report: these are reachable via
  // an authenticated staff session (device.manage), not by the physical
  // device presenting its own long-lived credential the way the realtime
  // /devices/connect path does. A fully rigorous build would extend
  // device-credential auth to this path too — deferred here for scope.
  @Post(':id/reserve-range')
  @RequirePermission('device.manage')
  async reserveRange(
    @Req() req: any,
    @Param('id') deviceId: string,
    @Body() dto: ReserveRangeDto,
  ) {
    return this.devices.reserveRange(req.user.tenantId, deviceId, dto);
  }

  @Post('reservations/:reservationId/issue')
  @RequirePermission('order.create')
  async issueNumber(@Req() req: any, @Param('reservationId') reservationId: string) {
    return this.devices.issueFromReservation(req.user.tenantId, reservationId);
  }
}

/** Deliberately NOT behind JwtAuthGuard — a device doesn't have a JWT
 * yet at this point; it presents its own credential directly, the same
 * way /auth/login accepts a raw password rather than requiring a token. */
@Controller('devices/connect')
export class DeviceConnectController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  async connect(@Body() dto: DeviceConnectDto) {
    return this.devices.connectWithCredential(dto);
  }
}

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    ConfigModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.get('JWT_ACCESS_SECRET') }),
    }),
  ],
  controllers: [DevicesController, DeviceConnectController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
