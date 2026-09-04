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
import { IsIn, IsOptional, IsString } from 'class-validator';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { PermissionsGuard, RequirePermission } from '../rbac/rbac.module';

export interface ReceiptData {
  shopName: string;
  orderNumber: string;
  displayNumber: string;
  date: string;
  time: string;
  servedBy: string;
  username: string;
  items: { name: string; quantity: number; lineTotal: number }[];
  packingCharge: number;
  discount: number;
  total: number;
}

export interface PrinterAdapter {
  print(receipt: ReceiptData): Promise<{ success: boolean; error?: string }>;
}

@Injectable()
export class MockPrinterAdapter implements PrinterAdapter {
  async print(receipt: ReceiptData) {
    // eslint-disable-next-line no-console
    console.log('[MockPrinterAdapter] would print receipt:', JSON.stringify(receipt, null, 2));
    return { success: true };
  }
}

export const PRINTER_ADAPTER = 'PRINTER_ADAPTER';

export class CreatePrinterDto {
  @IsString() name: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() location?: string;
}

export class UpdatePrinterDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}

@Injectable()
export class PrinterService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listPrinters(tenantId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name, type, location, status, created_at, updated_at
         FROM printers
         WHERE tenant_id = $1
         ORDER BY created_at ASC`,
        [tenantId],
      );
      return res.rows;
    });
  }

  async createPrinter(tenantId: string, actorUserId: string, dto: CreatePrinterDto) {
    return this.db.withTenant(tenantId, async (client) => {
      // 1. Concurrency safety: lock tenant resource limits row
      const limitRes = await client.query(
        `SELECT max_printers FROM tenant_resource_limits WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      const maxPrinters = limitRes.rows[0]?.max_printers ?? 1;

      // 2. Count active printers
      const countRes = await client.query(
        `SELECT count(*) FROM printers WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId],
      );
      const activeCount = Number(countRes.rows[0].count);

      if (activeCount >= maxPrinters) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'RESOURCE_LIMIT_REACHED',
          message: `Printer limit reached. Your shop is allowed ${maxPrinters} printer(s).`,
        });
      }

      // 3. Name uniqueness within tenant
      const nameCheck = await client.query(
        `SELECT 1 FROM printers WHERE tenant_id = $1 AND name = $2`,
        [tenantId, dto.name],
      );
      if (nameCheck.rowCount > 0) {
        throw new BadRequestException(`Printer with name "${dto.name}" already exists in this shop.`);
      }

      // 4. Insert printer
      const res = await client.query(
        `INSERT INTO printers (tenant_id, name, type, location, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id, name, type, location, status, created_at`,
        [tenantId, dto.name, dto.type ?? 'thermal_receipt', dto.location ?? null],
      );
      const created = res.rows[0];

      await this.audit.logTenant({
        tenantId,
        actorUserId,
        action: 'printer.create',
        entityType: 'printer',
        entityId: created.id,
        metadata: { name: created.name, type: created.type },
      });

      return created;
    });
  }

  async updatePrinter(
    tenantId: string,
    actorUserId: string,
    printerId: string,
    dto: UpdatePrinterDto,
  ) {
    return this.db.withTenant(tenantId, async (client) => {
      const existingRes = await client.query(
        `SELECT id, name, type, location, status FROM printers WHERE id = $1 AND tenant_id = $2`,
        [printerId, tenantId],
      );
      if (existingRes.rowCount === 0) {
        throw new BadRequestException('Printer not found.');
      }
      const existing = existingRes.rows[0];

      // If activating an inactive printer, check limit under lock
      if (dto.status === 'active' && existing.status !== 'active') {
        const limitRes = await client.query(
          `SELECT max_printers FROM tenant_resource_limits WHERE tenant_id = $1 FOR UPDATE`,
          [tenantId],
        );
        const maxPrinters = limitRes.rows[0]?.max_printers ?? 1;

        const countRes = await client.query(
          `SELECT count(*) FROM printers WHERE tenant_id = $1 AND status = 'active'`,
          [tenantId],
        );
        const activeCount = Number(countRes.rows[0].count);

        if (activeCount >= maxPrinters) {
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'RESOURCE_LIMIT_REACHED',
            message: `Printer limit reached. Your shop is allowed ${maxPrinters} printer(s).`,
          });
        }
      }

      if (dto.name && dto.name !== existing.name) {
        const nameCheck = await client.query(
          `SELECT 1 FROM printers WHERE tenant_id = $1 AND name = $2 AND id != $3`,
          [tenantId, dto.name, printerId],
        );
        if (nameCheck.rowCount > 0) {
          throw new BadRequestException(`Printer with name "${dto.name}" already exists in this shop.`);
        }
      }

      const updatedName = dto.name ?? existing.name;
      const updatedType = dto.type ?? existing.type;
      const updatedLocation = dto.location !== undefined ? dto.location : existing.location;
      const updatedStatus = dto.status ?? existing.status;

      const res = await client.query(
        `UPDATE printers
         SET name = $1, type = $2, location = $3, status = $4, updated_at = now()
         WHERE id = $5 AND tenant_id = $6
         RETURNING id, name, type, location, status, updated_at`,
        [updatedName, updatedType, updatedLocation, updatedStatus, printerId, tenantId],
      );

      await this.audit.logTenant({
        tenantId,
        actorUserId,
        action: 'printer.update',
        entityType: 'printer',
        entityId: printerId,
        metadata: { name: updatedName, status: updatedStatus },
      });

      return res.rows[0];
    });
  }

  async deletePrinter(tenantId: string, actorUserId: string, printerId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `DELETE FROM printers WHERE id = $1 AND tenant_id = $2 RETURNING id, name`,
        [printerId, tenantId],
      );
      if (res.rowCount === 0) {
        throw new BadRequestException('Printer not found.');
      }
      await this.audit.logTenant({
        tenantId,
        actorUserId,
        action: 'printer.delete',
        entityType: 'printer',
        entityId: printerId,
        metadata: { name: res.rows[0].name },
      });
      return { deleted: true };
    });
  }
}

@Controller('printers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PrintersController {
  constructor(private readonly printers: PrinterService) {}

  @Get()
  @RequirePermission('shop.settings')
  async list(@Req() req: any) {
    return this.printers.listPrinters(req.user.tenantId);
  }

  @Post()
  @RequirePermission('shop.settings')
  async create(@Req() req: any, @Body() dto: CreatePrinterDto) {
    return this.printers.createPrinter(req.user.tenantId, req.user.sub, dto);
  }

  @Put(':id')
  @RequirePermission('shop.settings')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdatePrinterDto) {
    return this.printers.updatePrinter(req.user.tenantId, req.user.sub, id, dto);
  }

  @Delete(':id')
  @RequirePermission('shop.settings')
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.printers.deletePrinter(req.user.tenantId, req.user.sub, id);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [PrintersController],
  providers: [
    { provide: PRINTER_ADAPTER, useClass: MockPrinterAdapter },
    PrinterService,
  ],
  exports: [PRINTER_ADAPTER, PrinterService],
})
export class PrinterModule {}
