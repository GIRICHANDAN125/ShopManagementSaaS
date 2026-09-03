import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';
import { JwtAuthGuard } from '../auth/auth.module';
import { PermissionsGuard, RequirePermission } from '../rbac/rbac.module';

// ---- DTOs -------------------------------------------------------------------

export class CreateCategoryDto {
  @IsString() name: string;
}

export class CreateProductDto {
  @IsString() name: string;
  @IsNumber() @Min(0) price: number;
  @IsOptional() @IsUUID() categoryId?: string;
}

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

// ---- Service ------------------------------------------------------------------

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listCategories(tenantId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name FROM categories WHERE tenant_id = $1 ORDER BY name`,
        [tenantId],
      );
      return res.rows;
    });
  }

  async createCategory(tenantId: string, actorUserId: string, dto: CreateCategoryDto) {
    const category = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO categories (tenant_id, name) VALUES ($1,$2) RETURNING id, name`,
        [tenantId, dto.name],
      );
      return res.rows[0];
    });
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'category.create',
      entityType: 'category',
      entityId: category.id,
      metadata: { name: dto.name },
    });
    return category;
  }

  async deleteCategory(tenantId: string, actorUserId: string, categoryId: string) {
    await this.db.withTenant(tenantId, (client) =>
      client.query(`DELETE FROM categories WHERE id = $1 AND tenant_id = $2`, [
        categoryId,
        tenantId,
      ]),
    );
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'category.delete',
      entityType: 'category',
      entityId: categoryId,
    });
  }

  /** Only active products are returned by default — this is what the
   * Counter catalog picker calls (requirement #7: no more pasted UUIDs). */
  async listProducts(tenantId: string, includeInactive = false) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT p.id, p.name, p.price, p.active, p.category_id, c.name AS category_name
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.tenant_id = $1 ${includeInactive ? '' : 'AND p.active = true'}
         ORDER BY c.name NULLS LAST, p.name`,
        [tenantId],
      );
      return res.rows;
    });
  }

  async createProduct(tenantId: string, actorUserId: string, dto: CreateProductDto) {
    const product = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO products (tenant_id, category_id, name, price, active)
         VALUES ($1,$2,$3,$4,true) RETURNING id, name, price, active, category_id`,
        [tenantId, dto.categoryId ?? null, dto.name, dto.price],
      );
      return res.rows[0];
    });
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'product.create',
      entityType: 'product',
      entityId: product.id,
      metadata: { name: dto.name, price: dto.price },
    });
    return product;
  }

  async updateProduct(
    tenantId: string,
    actorUserId: string,
    productId: string,
    dto: UpdateProductDto,
  ) {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, col] of [
      ['name', 'name'],
      ['price', 'price'],
      ['categoryId', 'category_id'],
      ['active', 'active'],
    ] as const) {
      if (dto[key] !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(dto[key]);
      }
    }
    if (fields.length === 0) return this.getProduct(tenantId, productId);

    values.push(productId, tenantId);
    const product = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE products SET ${fields.join(', ')} WHERE id = $${i++} AND tenant_id = $${i}
         RETURNING id, name, price, active, category_id`,
        values,
      );
      return res.rows[0];
    });
    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'product.update',
      entityType: 'product',
      entityId: productId,
      metadata: dto as Record<string, unknown>,
    });
    return product;
  }

  private async getProduct(tenantId: string, productId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name, price, active, category_id FROM products WHERE id = $1 AND tenant_id = $2`,
        [productId, tenantId],
      );
      return res.rows[0];
    });
  }
}

// ---- Controller -----------------------------------------------------------------

@Controller('catalog')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @RequirePermission('order.view')
  async listCategories(@Req() req: any) {
    return this.catalog.listCategories(req.user.tenantId);
  }

  @Post('categories')
  @RequirePermission('product.manage')
  async createCategory(@Req() req: any, @Body() dto: CreateCategoryDto) {
    return this.catalog.createCategory(req.user.tenantId, req.user.sub, dto);
  }

  @Delete('categories/:id')
  @RequirePermission('product.manage')
  async deleteCategory(@Req() req: any, @Param('id') id: string) {
    await this.catalog.deleteCategory(req.user.tenantId, req.user.sub, id);
    return { deleted: true };
  }

  @Get('products')
  @RequirePermission('order.view')
  async listProducts(@Req() req: any) {
    return this.catalog.listProducts(req.user.tenantId);
  }

  @Post('products')
  @RequirePermission('product.manage')
  async createProduct(@Req() req: any, @Body() dto: CreateProductDto) {
    return this.catalog.createProduct(req.user.tenantId, req.user.sub, dto);
  }

  @Put('products/:id')
  @RequirePermission('product.manage')
  async updateProduct(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.catalog.updateProduct(req.user.tenantId, req.user.sub, id, dto);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
