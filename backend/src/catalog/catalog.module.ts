import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Module,
  Param,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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
  @IsOptional() @IsString() imageUrl?: string;
}

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() imageUrl?: string;
}

// ---- Storage & Validation ---------------------------------------------------

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const UPLOADS_BASE_DIR = path.join(process.cwd(), 'uploads', 'products');

export function validateImageBuffer(buffer: Buffer): { ext: string; mimeType: string } {
  if (!buffer || buffer.length < 12) {
    throw new BadRequestException('File is too small or invalid image data');
  }
  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new BadRequestException('Image exceeds maximum allowed size of 5MB');
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mimeType: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { ext: 'png', mimeType: 'image/png' };
  }
  // WebP: RIFF (bytes 0..3) ... WEBP (bytes 8..11)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { ext: 'webp', mimeType: 'image/webp' };
  }
  throw new BadRequestException('Unsupported file format. Only JPEG, PNG, and WebP images are allowed.');
}

// ---- Service ------------------------------------------------------------------

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private getTenantUploadDir(tenantId: string): string {
    // Validate tenantId is UUID to strictly prevent path traversal
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new BadRequestException('Invalid tenant identifier');
    }
    const dir = path.join(UPLOADS_BASE_DIR, tenantId);
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(UPLOADS_BASE_DIR))) {
      throw new BadRequestException('Invalid storage path');
    }
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }

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
   * Counter catalog picker calls. */
  async listProducts(tenantId: string, includeInactive = false) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT p.id, p.name, p.price, p.active, p.category_id, p.image_url, c.name AS category_name
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
        `INSERT INTO products (tenant_id, category_id, name, price, active, image_url)
         VALUES ($1,$2,$3,$4,true,$5) RETURNING id, name, price, active, category_id, image_url`,
        [tenantId, dto.categoryId ?? null, dto.name, dto.price, dto.imageUrl ?? null],
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
      ['imageUrl', 'image_url'],
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
         RETURNING id, name, price, active, category_id, image_url`,
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

  async uploadProductImage(
    tenantId: string,
    actorUserId: string,
    productId: string,
    file: { buffer: Buffer; originalname?: string; size: number },
  ) {
    const { ext } = validateImageBuffer(file.buffer);

    const existing = await this.getProduct(tenantId, productId);
    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    const tenantDir = this.getTenantUploadDir(tenantId);
    const filename = `${crypto.randomUUID()}.${ext}`;
    const targetPath = path.join(tenantDir, filename);

    fs.writeFileSync(targetPath, file.buffer);

    // If an old image existed, delete it from disk safely
    if (existing.image_url) {
      const oldFilename = path.basename(existing.image_url);
      const oldPath = path.join(tenantDir, oldFilename);
      if (fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch (_) {}
      }
    }

    const product = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE products SET image_url = $1 WHERE id = $2 AND tenant_id = $3
         RETURNING id, name, price, active, category_id, image_url`,
        [filename, productId, tenantId],
      );
      return res.rows[0];
    });

    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'product.image_upload',
      entityType: 'product',
      entityId: productId,
      metadata: { filename, size: file.size },
    });

    return product;
  }

  async deleteProductImage(tenantId: string, actorUserId: string, productId: string) {
    const existing = await this.getProduct(tenantId, productId);
    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    if (existing.image_url) {
      const tenantDir = this.getTenantUploadDir(tenantId);
      const oldFilename = path.basename(existing.image_url);
      const oldPath = path.join(tenantDir, oldFilename);
      if (fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch (_) {}
      }
    }

    const product = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE products SET image_url = NULL WHERE id = $1 AND tenant_id = $2
         RETURNING id, name, price, active, category_id, image_url`,
        [productId, tenantId],
      );
      return res.rows[0];
    });

    await this.audit.logTenant({
      tenantId,
      actorUserId,
      action: 'product.image_delete',
      entityType: 'product',
      entityId: productId,
    });

    return product;
  }

  async getProductImageStream(tenantId: string, productId: string) {
    const product = await this.getProduct(tenantId, productId);
    if (!product || !product.image_url) {
      throw new NotFoundException('Product image not found');
    }

    const tenantDir = this.getTenantUploadDir(tenantId);
    const safeFilename = path.basename(product.image_url);
    const filePath = path.join(tenantDir, safeFilename);

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Product image file not found');
    }

    const ext = path.extname(safeFilename).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return {
      stream: fs.createReadStream(filePath),
      mimeType,
    };
  }

  private async getProduct(tenantId: string, productId: string) {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name, price, active, category_id, image_url FROM products WHERE id = $1 AND tenant_id = $2`,
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

  @Get('products/:id/image')
  @RequirePermission('order.view')
  async getProductImage(
    @Req() req: any,
    @Param('id') id: string,
    @Res() res: any,
  ) {
    const { stream, mimeType } = await this.catalog.getProductImageStream(
      req.user.tenantId,
      id,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    stream.pipe(res);
  }

  @Post('products/:id/image')
  @RequirePermission('product.manage')
  @UseInterceptors(FileInterceptor('image'))
  async uploadProductImage(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    if (!file) {
      throw new BadRequestException('Image file is required');
    }
    return this.catalog.uploadProductImage(req.user.tenantId, req.user.sub, id, file);
  }

  @Delete('products/:id/image')
  @RequirePermission('product.manage')
  async deleteProductImage(@Req() req: any, @Param('id') id: string) {
    return this.catalog.deleteProductImage(req.user.tenantId, req.user.sub, id);
  }
}

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
