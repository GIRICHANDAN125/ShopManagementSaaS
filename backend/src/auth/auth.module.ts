import {
  BadRequestException,
  Injectable,
  Logger,
  Module,
  UnauthorizedException,
  Controller,
  Post,
  Body,
  HttpCode,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { PassportStrategy, AuthGuard } from '@nestjs/passport';
import * as argon2 from 'argon2';
import { IsString, MinLength } from 'class-validator';
import { DatabaseModule, DatabaseService } from '../database/database.module';
import { AuditModule, AuditService } from '../audit/audit.module';

// ---- DTOs ----------------------------------------------------------------

export class TenantLoginDto {
  @IsString() shopCode: string;
  @IsString() username: string;
  @IsString() @MinLength(1) password: string;
}

export class SuperAdminLoginDto {
  @IsString() username: string;
  @IsString() @MinLength(1) password: string;
}

export class ChangePasswordDto {
  @IsString() @MinLength(1) currentPassword: string;
  @IsString() @MinLength(6) newPassword: string;
}

// ---- JWT payload shape -----------------------------------------------------
// tenantId is ALWAYS derived server-side and embedded here at issuance time.
// No downstream code ever accepts a tenant id from anywhere else
// (ARCHITECTURE.md §4).
export interface AccessTokenPayload {
  sub: string; // user id
  tenantId: string | null; // null only for verified Super Admin tokens
  isSuperAdmin: boolean;
  permissions: string[];
  mustChangePassword?: boolean;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  /**
   * Safely verifies password against hash. Malformed hashes or unexpected argon2
   * parsing failures return false and log a warning, rather than throwing an
   * unhandled TypeError (e.g. "pchstr must contain a $ as first char") to the client.
   */
  async verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
      if (!hash || typeof hash !== 'string' || !hash.startsWith('$')) {
        this.logger.warn('Password verification failed: stored hash is malformed or invalid format.');
        return false;
      }
      return await argon2.verify(hash, plain);
    } catch (err) {
      this.logger.warn(
        `Password verification failed safely: ${(err as Error)?.message || 'unknown verification error'}`,
      );
      return false;
    }
  }

  /**
   * Tenant employee login. The shop code resolves tenant_id from the
   * un-RLS'd `tenants` table BEFORE any RLS-protected lookup — this is
   * the one legitimate place a tenant context gets established from
   * scratch, and it happens from a code the shop's own staff enters, not
   * from anything the client "declares" as trusted.
   */
  async tenantLogin(dto: TenantLoginDto) {
    const tenantRow = await this.db.tenantPool.query(
      `SELECT id, status FROM tenants WHERE code = $1`,
      [dto.shopCode],
    );
    if (tenantRow.rowCount === 0 || tenantRow.rows[0].status !== 'active') {
      throw new UnauthorizedException('Invalid shop code or inactive shop');
    }
    const tenantId = tenantRow.rows[0].id;

    const user = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, username, display_name, password_hash, status, must_change_password FROM users WHERE tenant_id = $1 AND username = $2`,
        [tenantId, dto.username],
      );
      return res.rows[0] ?? null;
    });

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await this.verifyPassword(user.password_hash, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const permissions = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT DISTINCT p.code FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN user_roles ur ON ur.role_id = rp.role_id
         WHERE ur.user_id = $1`,
        [user.id],
      );
      return res.rows.map((r) => r.code as string);
    });

    const assignedCounter = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name, code FROM counters WHERE tenant_id = $1 AND assigned_user_id = $2 AND status = 'active' LIMIT 1`,
        [tenantId, user.id],
      );
      return res.rows[0] ?? null;
    });

    const tokens = await this.issueTokens({
      sub: user.id,
      tenantId,
      isSuperAdmin: false,
      permissions,
      mustChangePassword: !!user.must_change_password,
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        mustChangePassword: !!user.must_change_password,
      },
      assignedCounter,
    };
  }

  /**
   * Super Admin login. Deliberately a SEPARATE code path from tenantLogin
   * — it never touches the tenant pool at all, only the super-admin pool,
   * and only ever looks up rows with tenant_id IS NULL
   * (ARCHITECTURE.md §4, point 4).
   */
  async superAdminLogin(dto: SuperAdminLoginDto) {
    const user = await this.db.withSuperAdmin(async (client) => {
      const res = await client.query(
        `SELECT id, password_hash, status FROM users WHERE tenant_id IS NULL AND LOWER(username) = LOWER($1)`,
        [dto.username],
      );
      return res.rows[0] ?? null;
    });

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await this.verifyPassword(user.password_hash, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.audit.logSuperAdmin({
      actorUserId: user.id,
      action: 'auth.super_admin_login',
      entityType: 'user',
      entityId: user.id,
    });

    return this.issueTokens({
      sub: user.id,
      tenantId: null,
      isSuperAdmin: true,
      permissions: ['*'], // Super Admin scope is enforced by the DB grants/RLS split, not this claim
    });
  }

  /**
   * Allows authenticated Shop Admin or staff to change their password.
   * Also used during forced first-login to transition temporary password to permanent.
   */
  async changePassword(user: AccessTokenPayload, dto: ChangePasswordDto) {
    if (!user || !user.sub || !user.tenantId) {
      throw new UnauthorizedException('Invalid user context');
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must be different from current password');
    }

    const tenantId = user.tenantId;
    const userId = user.sub;

    const userRow = await this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, password_hash, status FROM users WHERE id = $1 AND tenant_id = $2`,
        [userId, tenantId],
      );
      return res.rows[0] ?? null;
    });

    if (!userRow || userRow.status !== 'active') {
      throw new UnauthorizedException('User not found or disabled');
    }

    const valid = await this.verifyPassword(userRow.password_hash, dto.currentPassword);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const newHash = await this.hashPassword(dto.newPassword);

    await this.db.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2 AND tenant_id = $3`,
        [newHash, userId, tenantId],
      );
    });

    await this.audit.logTenant({
      tenantId,
      actorUserId: userId,
      action: 'user.change_password',
      entityType: 'user',
      entityId: userId,
      metadata: { timestamp: new Date().toISOString(), result: 'success' },
    });

    const freshTokens = await this.issueTokens({
      sub: userId,
      tenantId,
      isSuperAdmin: false,
      permissions: user.permissions ?? [],
      mustChangePassword: false,
    });

    return {
      success: true,
      message: 'Password updated successfully',
      ...freshTokens,
    };
  }

  private async issueTokens(payload: AccessTokenPayload) {
    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_TTL') ?? '15m',
    });
    const refreshToken = this.jwt.sign(
      { sub: payload.sub, tenantId: payload.tenantId, mustChangePassword: payload.mustChangePassword },
      {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get('JWT_REFRESH_TTL') ?? '7d',
      },
    );
    return { accessToken, refreshToken };
  }
}

// ---- Passport JWT strategy --------------------------------------------------

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly db: DatabaseService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET') as string,
    });
  }

  async validate(payload: AccessTokenPayload) {
    // Whatever is returned here becomes req.user — this is the ONLY
    // source of tenantId/permissions for downstream guards. It comes
    // from the verified, signed token, never from request body/query.

    // Platform Super Admin tokens bypass tenant status check
    if (payload.isSuperAdmin) {
      return payload;
    }

    // Tenant-scoped tokens must verify that the tenant exists and is active.
    // This guarantees that any existing JWTs stop working immediately after
    // shop deactivation or deletion.
    if (payload.tenantId) {
      const tenantRow = await this.db.tenantPool.query(
        `SELECT status FROM tenants WHERE id = $1`,
        [payload.tenantId],
      );
      if (tenantRow.rowCount === 0 || tenantRow.rows[0].status !== 'active') {
        throw new UnauthorizedException('Shop is inactive or does not exist');
      }
    }

    return payload;
  }
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

// ---- Controller --------------------------------------------------------------

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: TenantLoginDto) {
    return this.authService.tenantLogin(dto);
  }

  @Post('super-admin/login')
  @HttpCode(200)
  async superAdminLogin(@Body() dto: SuperAdminLoginDto) {
    return this.authService.superAdminLogin(dto);
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user, dto);
  }
}

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    ConfigModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule, PassportModule],
})
export class AuthModule {}
