import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  ConflictException,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsArray, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { PermissionsGuard, RequirePermission } from '../rbac/rbac.module';
import { deriveDisplayNumber } from '../common/display-number';

import { RealtimeGateway, RealtimeModule } from '../realtime/realtime.module';

// ---- DTOs -------------------------------------------------------------------

class OrderItemDto {
  @IsUUID() productId: string;
  @IsNumber() @Min(1) quantity: number;
}

export class CreateOrderDto {
  @IsUUID() idempotencyKey: string;
  @IsArray() items: OrderItemDto[];
  @IsString() orderType: string;
  @IsOptional() @IsUUID() counterId?: string;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
}

export class UpdateStatusDto {
  @IsString() status: string;
}

export class SyncOfflineOrderDto {
  @IsUUID() idempotencyKey: string;
  @IsArray() items: OrderItemDto[];
  @IsString() orderType: string;
  @IsOptional() @IsUUID() counterId?: string;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsUUID() deviceId: string;
  @IsNumber() reservedOrderNumber: number; // already-issued from the device's reservation
  @IsString() createdAtDevice: string; // ISO timestamp of actual offline creation
}

// ---- Service ------------------------------------------------------------------

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Backend-authoritative order creation.
   *  - Idempotency: (tenant_id, idempotency_key) unique constraint is the
   *    real correctness boundary (DATABASE.md §7). Same key + same
   *    payload -> return existing order. Same key + different payload ->
   *    409, original never touched.
   *  - Numbering: allocate_next_order_number(seq_name) — a genuine
   *    Postgres sequence, non-transactional, never reused even on
   *    rollback (DATABASE.md §5).
   *  - Totals: computed here, server-side, from the tenant's product
   *    prices at read time — never trusts a client-supplied total
   *    (SECURITY.md §13).
   */
  async createOrder(
    tenantId: string,
    userId: string,
    dto: CreateOrderDto,
  ) {
    return this.db.withTenant(tenantId, async (client) => {
      // 1. Idempotency check first.
      const existing = await client.query(
        `SELECT o.id, o.order_number, o.display_number, o.total, o.status,
                (SELECT jsonb_agg(jsonb_build_object('productId', oi.product_id, 'quantity', oi.quantity))
                 FROM order_items oi WHERE oi.order_id = o.id) AS existing_items
         FROM orders o WHERE o.tenant_id = $1 AND o.idempotency_key = $2`,
        [tenantId, dto.idempotencyKey],
      );
      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        // Canonical string form deliberately does NOT rely on JSON key
        // ordering — jsonb (unlike json) does not preserve object-key
        // insertion order on round-trip, so a naive JSON.stringify
        // comparison of two independently-serialized objects can differ
        // even when the underlying data is identical.
        const canon = (items: { productId: string; quantity: number }[]) =>
          items
            .map((i) => `${i.productId}:${i.quantity}`)
            .sort()
            .join('|');
        const requestedCanon = canon(dto.items);
        const storedCanon = canon(
          (row.existing_items ?? []) as { productId: string; quantity: number }[],
        );
        if (requestedCanon !== storedCanon) {
          throw new ConflictException(
            'Idempotency key reused with a different payload; original order was not modified',
          );
        }
        return { ...this.toResponse(row), _idempotentReturn: true };
      }

      // 2. Fetch tenant's sequence name + product prices (server-authoritative).
      const tenantRow = await client.query(
        `SELECT order_sequence_name FROM tenants WHERE id = $1`,
        [tenantId],
      );
      const seqName = tenantRow.rows[0]?.order_sequence_name;
      if (!seqName) throw new BadRequestException('Tenant sequence not provisioned');

      const productIds = dto.items.map((i) => i.productId);
      const products = await client.query(
        `SELECT id, price FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND active = true`,
        [tenantId, productIds],
      );
      if (products.rowCount !== productIds.length) {
        throw new BadRequestException('One or more products are invalid or inactive');
      }
      const priceById = new Map(products.rows.map((p) => [p.id, Number(p.price)]));

      let subtotal = 0;
      const lineItems = dto.items.map((i) => {
        const unitPrice = priceById.get(i.productId)!;
        const lineTotal = unitPrice * i.quantity;
        subtotal += lineTotal;
        return { ...i, unitPrice, lineTotal };
      });

      // 3. Packing charge — resolved server-side from the tenant's own
      //    configuration (tenant_settings), never from client input.
      //    This is the authoritative-totals requirement applied to
      //    packing specifically: a client cannot claim "no charge" to
      //    avoid a configured flat/per-item packing fee.
      const packingConfigRes = await client.query(
        `SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = 'packing_config'`,
        [tenantId],
      );
      const packingConfig = packingConfigRes.rows[0]?.value ?? { rule: 'none' };
      let packingCharge = 0;
      if (packingConfig.rule === 'flat') packingCharge = Number(packingConfig.flatCharge ?? 0);
      if (packingConfig.rule === 'per_item')
        packingCharge = Number(packingConfig.perItemCharge ?? 0) * dto.items.length;
      const discount = dto.discount ?? 0;
      const total = subtotal + packingCharge - discount;

      // 4. Allocate the real order number — non-transactional sequence.
      const seqResult = await client.query(
        `SELECT allocate_next_order_number($1) AS n`,
        [seqName],
      );
      const orderNumber: bigint = BigInt(seqResult.rows[0].n);
      const displayNumber = deriveDisplayNumber(orderNumber);

      // 5. Insert order + items inside the same transaction.
      const orderRes = await client.query(
        `INSERT INTO orders
           (tenant_id, order_number, display_number, idempotency_key, counter_id,
            created_by_user_id, order_type, status, origin, subtotal, packing_charge,
            discount, total, created_at_device)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CREATED','online',$8,$9,$10,$11, now())
         RETURNING id, order_number, display_number, total, status`,
        [
          tenantId,
          orderNumber.toString(),
          displayNumber,
          dto.idempotencyKey,
          dto.counterId ?? null,
          userId,
          dto.orderType,
          subtotal,
          packingCharge,
          discount,
          total,
        ],
      );
      const order = orderRes.rows[0];

      for (const li of lineItems) {
        await client.query(
          `INSERT INTO order_items (order_id, tenant_id, product_id, quantity, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [order.id, tenantId, li.productId, li.quantity, li.unitPrice, li.lineTotal],
        );
      }
      await client.query(
        `INSERT INTO order_status_history (order_id, tenant_id, status, changed_by)
         VALUES ($1,$2,'CREATED',$3)`,
        [order.id, tenantId, userId],
      );

      return this.toResponse(order);
    });
  }

  async cancelOrder(tenantId: string, userId: string, orderId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE orders SET status = 'CANCELLED', updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('COLLECTED','CANCELLED')
         RETURNING id, order_number, status`,
        [orderId, tenantId],
      );
      if (res.rowCount === 0) {
        throw new BadRequestException('Order not found or not cancellable');
      }
      await client.query(
        `INSERT INTO order_status_history (order_id, tenant_id, status, changed_by)
         VALUES ($1,$2,'CANCELLED',$3)`,
        [orderId, tenantId, userId],
      );
      await this.audit.logTenant({
        tenantId,
        actorUserId: userId,
        action: 'order.cancel',
        entityType: 'order',
        entityId: orderId,
      });
      return res.rows[0];
    });
  }

  /** Manual reprint — re-renders stored data only, never calls create,
   * never allocates a number, never generates a new idempotency key
   * (blueprint §29, OFFLINE_SYNC_DESIGN.md §7, TESTING.md §10). */
  async getReceiptData(tenantId: string, orderId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const order = await client.query(
        `SELECT o.*, u.display_name AS served_by, u.username
         FROM orders o JOIN users u ON u.id = o.created_by_user_id
         WHERE o.id = $1 AND o.tenant_id = $2`,
        [orderId, tenantId],
      );
      if (order.rowCount === 0) throw new BadRequestException('Order not found');
      const items = await client.query(
        `SELECT oi.quantity, oi.unit_price, oi.line_total, p.name
         FROM order_items oi JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1`,
        [orderId],
      );
      return { order: order.rows[0], items: items.rows };
    });
  }

  async listActive(tenantId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT o.id, o.order_number, o.display_number, o.status, o.order_type,
                o.total, o.created_at, u.display_name AS served_by
         FROM orders o JOIN users u ON u.id = o.created_by_user_id
         WHERE o.tenant_id = $1 AND o.status NOT IN ('COLLECTED','CANCELLED')
         ORDER BY o.created_at ASC`,
        [tenantId],
      );
      return res.rows;
    });
  }

  /** Status transitions are intentionally NOT hardcoded to one pipeline
   * here — validating against a tenant's configured order_statuses is a
   * Phase-3 data-driven-config concern (DATABASE.md §11) not yet built;
   * this accepts any string and relies on the DB CHECK-free `status`
   * column, matching the current schema. Flagged as a simplification in
   * the final report. */
  async updateStatus(tenantId: string, userId: string, orderId: string, status: string) {
    const result = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE orders SET status = $1, updated_at = now()
         WHERE id = $2 AND tenant_id = $3
         RETURNING id, order_number, display_number, status`,
        [status, orderId, tenantId],
      );
      if (res.rowCount === 0) throw new BadRequestException('Order not found');
      await client.query(
        `INSERT INTO order_status_history (order_id, tenant_id, status, changed_by)
         VALUES ($1,$2,$3,$4)`,
        [orderId, tenantId, status, userId],
      );
      return res.rows[0];
    });

    // Real-time fan-out — tenant-scoped room only, server-resolved tenantId.
    this.realtime.emitOrderStatusChanged(tenantId, {
      orderId: result.id,
      orderNumber: result.order_number?.toString?.(),
      displayNumber: result.display_number,
      status: result.status,
    });

    return result;
  }

  /** Shared by online creation and offline sync — server-authoritative
   * pricing/packing computation must be identical for both paths. */
  private async computeTotals(
    client: any,
    tenantId: string,
    items: OrderItemDto[],
    discount: number,
  ) {
    const productIds = items.map((i) => i.productId);
    const products = await client.query(
      `SELECT id, price FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND active = true`,
      [tenantId, productIds],
    );
    if (products.rowCount !== productIds.length) {
      throw new BadRequestException('One or more products are invalid or inactive');
    }
    const priceById = new Map<string, number>(
      products.rows.map((p: any) => [p.id, Number(p.price)]),
    );

    let subtotal = 0;
    const lineItems = items.map((i) => {
      const unitPrice = priceById.get(i.productId)!;
      const lineTotal = unitPrice * i.quantity;
      subtotal += lineTotal;
      return { ...i, unitPrice, lineTotal };
    });

    const packingConfigRes = await client.query(
      `SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = 'packing_config'`,
      [tenantId],
    );
    const packingConfig = packingConfigRes.rows[0]?.value ?? { rule: 'none' };
    let packingCharge = 0;
    if (packingConfig.rule === 'flat') packingCharge = Number(packingConfig.flatCharge ?? 0);
    if (packingConfig.rule === 'per_item')
      packingCharge = Number(packingConfig.perItemCharge ?? 0) * items.length;
    const total = subtotal + packingCharge - discount;

    return { lineItems, subtotal, packingCharge, total };
  }

  /**
   * Offline order synchronization (OFFLINE_SYNC_DESIGN.md). Key
   * invariants enforced here, not just documented:
   *  - idempotency_key is checked FIRST, exactly like online creation —
   *    a retried sync attempt (dropped ack, client retry) returns the
   *    existing order, never a duplicate (§11 "sync must be idempotent").
   *  - the real order_number is NEVER reallocated here — it was already
   *    issued from the device's reservation before this call, and is
   *    validated (not trusted blindly) to actually fall within a
   *    reservation genuinely granted to this device for this tenant.
   *  - created_at_device is the caller-supplied actual offline creation
   *    timestamp — NOT `now()` — which is what later lets reports
   *    correctly bucket by actual transaction time rather than sync time
   *    (DATABASE.md §14 flags the bucketing *choice* as still open, but
   *    the timestamp itself must be preserved regardless of which way
   *    that choice is eventually made).
   *  - no print/reprint side effect of any kind (§13 — no automatic
   *    reprint after reconnect, ever).
   */
  async syncOfflineOrder(tenantId: string, userId: string, dto: SyncOfflineOrderDto) {
    return this.db.withTenant(tenantId, async (client) => {
      const existing = await client.query(
        `SELECT o.id, o.order_number, o.display_number, o.total, o.status,
                (SELECT jsonb_agg(jsonb_build_object('productId', oi.product_id, 'quantity', oi.quantity))
                 FROM order_items oi WHERE oi.order_id = o.id) AS existing_items
         FROM orders o WHERE o.tenant_id = $1 AND o.idempotency_key = $2`,
        [tenantId, dto.idempotencyKey],
      );
      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        const canon = (items: { productId: string; quantity: number }[]) =>
          items.map((i) => `${i.productId}:${i.quantity}`).sort().join('|');
        if (canon(dto.items) !== canon(row.existing_items ?? [])) {
          throw new ConflictException(
            'Idempotency key reused with a different payload; original order was not modified',
          );
        }
        return { ...this.toResponse(row), _idempotentReturn: true };
      }

      // Validate the reserved number genuinely belongs to this device.
      const reservationCheck = await client.query(
        `SELECT 1 FROM device_order_reservations
         WHERE tenant_id = $1 AND device_id = $2
           AND $3 BETWEEN range_start AND range_end`,
        [tenantId, dto.deviceId, dto.reservedOrderNumber],
      );
      if (reservationCheck.rowCount === 0) {
        throw new BadRequestException(
          'Reserved order number does not fall within any range granted to this device',
        );
      }

      const { lineItems, subtotal, packingCharge, total } = await this.computeTotals(
        client,
        tenantId,
        dto.items,
        dto.discount ?? 0,
      );
      const displayNumber = deriveDisplayNumber(dto.reservedOrderNumber);

      const orderRes = await client.query(
        `INSERT INTO orders
           (tenant_id, order_number, display_number, idempotency_key, counter_id, device_id,
            created_by_user_id, order_type, status, origin, subtotal, packing_charge,
            discount, total, created_at_device)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREATED','offline_reserved',$9,$10,$11,$12,$13)
         RETURNING id, order_number, display_number, total, status`,
        [
          tenantId,
          dto.reservedOrderNumber,
          displayNumber,
          dto.idempotencyKey,
          dto.counterId ?? null,
          dto.deviceId,
          userId,
          dto.orderType,
          subtotal,
          packingCharge,
          dto.discount ?? 0,
          total,
          dto.createdAtDevice,
        ],
      );
      const order = orderRes.rows[0];
      for (const li of lineItems) {
        await client.query(
          `INSERT INTO order_items (order_id, tenant_id, product_id, quantity, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [order.id, tenantId, li.productId, li.quantity, li.unitPrice, li.lineTotal],
        );
      }
      await client.query(
        `INSERT INTO order_status_history (order_id, tenant_id, status, changed_by)
         VALUES ($1,$2,'CREATED',$3)`,
        [order.id, tenantId, userId],
      );

      return { ...this.toResponse(order), _idempotentReturn: false };
    });
  }

  private toResponse(row: any) {
    return {
      id: row.id,
      orderNumber: row.order_number?.toString?.() ?? String(row.order_number),
      displayNumber: row.display_number,
      total: row.total,
      status: row.status,
    };
  }
}

// ---- Controller -----------------------------------------------------------------

@Controller('orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @RequirePermission('order.create')
  async create(@Req() req: any, @Res({ passthrough: true }) res: Response, @Body() dto: CreateOrderDto) {
    const result = await this.orders.createOrder(req.user.tenantId, req.user.sub, dto);
    const { _idempotentReturn, ...body } = result as any;
    // DATABASE.md §6: a retried request with the same idempotency key
    // returns the existing order with 200, not 201 — 201 is reserved for
    // a genuine new creation.
    res.status(_idempotentReturn ? 200 : 201);
    return body;
  }

  @Post(':id/cancel')
  @RequirePermission('order.cancel')
  async cancel(@Req() req: any, @Param('id') id: string) {
    return this.orders.cancelOrder(req.user.tenantId, req.user.sub, id);
  }

  @Get('active')
  @RequirePermission('order.view')
  async listActive(@Req() req: any) {
    return this.orders.listActive(req.user.tenantId);
  }

  @Post('sync-offline')
  @RequirePermission('order.create')
  async syncOffline(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: SyncOfflineOrderDto,
  ) {
    const result = await this.orders.syncOfflineOrder(req.user.tenantId, req.user.sub, dto);
    const { _idempotentReturn, ...body } = result as any;
    res.status(_idempotentReturn ? 200 : 201);
    return body;
  }

  @Post(':id/status')
  @RequirePermission('order.view')
  async updateStatus(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.orders.updateStatus(req.user.tenantId, req.user.sub, id, dto.status);
  }

  @Post(':id/reprint')
  @RequirePermission('receipt.reprint')
  async reprint(@Req() req: any, @Param('id') id: string) {
    return this.orders.getReceiptData(req.user.tenantId, id);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule, RealtimeModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
