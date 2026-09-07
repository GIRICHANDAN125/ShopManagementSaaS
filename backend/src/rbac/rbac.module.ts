import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  ForbiddenException,
  Module,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const PERMISSION_KEY = 'required_permission';
export const RequirePermission = (permission: string) =>
  SetMetadata(PERMISSION_KEY, permission);

/**
 * Fails closed: an endpoint with NO @RequirePermission decorator is
 * denied by this guard rather than allowed (SECURITY.md §2 — "allow-list,
 * not deny-list"). Register PermissionsGuard as a global guard so this
 * applies to every route by default; a route that intentionally needs no
 * permission check should use @RequirePermission('public') mapped to an
 * always-true rule, making the exception explicit rather than accidental.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string | undefined>(
      PERMISSION_KEY,
      context.getHandler(),
    );
    if (!required) {
      throw new ForbiddenException(
        'Endpoint has no declared permission requirement — denying by default',
      );
    }

    const req = context.switchToHttp().getRequest();
    const user = req.user as { permissions?: string[]; isSuperAdmin?: boolean; mustChangePassword?: boolean } | undefined;

    // Forced first-login password change:
    // Any user with mustChangePassword = true is blocked from all application endpoints
    // except the password change endpoint (/auth/change-password).
    if (user && !user.isSuperAdmin && user.mustChangePassword) {
      const path = req.path || req.url || '';
      if (!path.includes('/auth/change-password')) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'Password change required before accessing the application',
        });
      }
    }

    if (required === 'public') return true;

    if (!user) throw new ForbiddenException('Not authenticated');
    if (user.isSuperAdmin) {
      // Super Admin's authority is enforced by the DB grant/RLS split
      // (which endpoints they can even reach), not by this permission
      // list — a Super Admin token never carries shop-level permissions.
      return true;
    }
    if (!user.permissions?.includes(required)) {
      throw new ForbiddenException(`Missing permission: ${required}`);
    }
    return true;
  }
}

/** Used on the small number of endpoints that are Super-Admin-only and
 * must reject an ordinary tenant token even if it somehow carried a
 * matching permission string. */
@Injectable()
export class SuperAdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as { isSuperAdmin?: boolean } | undefined;
    if (!user?.isSuperAdmin) {
      throw new ForbiddenException('Super Admin access required');
    }
    return true;
  }
}

@Module({
  providers: [PermissionsGuard, SuperAdminOnlyGuard],
  exports: [PermissionsGuard, SuperAdminOnlyGuard],
})
export class RbacModule {}
