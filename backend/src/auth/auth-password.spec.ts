import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { AuthService, TenantLoginDto, SuperAdminLoginDto } from './auth.module';

describe('AuthService Password Security & Error Handling', () => {
  let authService: AuthService;
  let mockDb: any;
  let mockJwt: any;
  let mockConfig: any;
  let mockAudit: any;

  beforeEach(() => {
    mockDb = {
      tenantPool: { query: jest.fn() },
      superAdminPool: { query: jest.fn() },
      withTenant: jest.fn(),
      withSuperAdmin: jest.fn(),
    };
    mockJwt = { sign: jest.fn().mockReturnValue('mock_token') };
    mockConfig = { get: jest.fn().mockReturnValue('secret') };
    mockAudit = { logSuperAdmin: jest.fn(), logTenant: jest.fn() };

    authService = new AuthService(mockDb, mockJwt, mockConfig, mockAudit);
  });

  describe('Password Hashing with Argon2id', () => {
    it('produces valid Argon2id hashes', async () => {
      const plain = 'SecretPassword123!';
      const hash = await authService.hashPassword(plain);

      expect(hash).toBeDefined();
      expect(hash.startsWith('$argon2id$')).toBe(true);

      const isValid = await argon2.verify(hash, plain);
      expect(isValid).toBe(true);
    });
  });

  describe('Safe Password Verification', () => {
    it('returns true for correct password', async () => {
      const plain = 'CorrectPassword123!';
      const hash = await argon2.hash(plain, { type: argon2.argon2id });
      const result = await authService.verifyPassword(hash, plain);
      expect(result).toBe(true);
    });

    it('returns false for wrong password', async () => {
      const plain = 'CorrectPassword123!';
      const hash = await argon2.hash(plain, { type: argon2.argon2id });
      const result = await authService.verifyPassword(hash, 'WrongPassword');
      expect(result).toBe(false);
    });

    it('gracefully handles malformed hash without throwing TypeError (e.g. pchstr missing $)', async () => {
      // Test values that previously triggered: TypeError: pchstr must contain a $ as first char
      const malformedHashes = [
        'invalid_plaintext_hash',
        'not_a_hash_at_all',
        '12345',
        '',
        null as any,
        undefined as any,
        '$$$corrupt_dollar_signs$$$',
      ];

      for (const badHash of malformedHashes) {
        let result: boolean | null = null;
        let threw = false;
        try {
          result = await authService.verifyPassword(badHash, 'SomePassword');
        } catch {
          threw = true;
        }

        expect(threw).toBe(false);
        expect(result).toBe(false);
      }
    });
  });

  describe('Controlled Authentication Error on Malformed Hash', () => {
    it('tenantLogin throws UnauthorizedException (401), not 500, when database hash is malformed', async () => {
      mockDb.tenantPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'tenant-uuid-1', status: 'active' }],
      });

      mockDb.withTenant.mockImplementationOnce(async (_tenantId: string, fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: 'user-uuid-1', password_hash: 'corrupted_hash_without_dollar', status: 'active' }],
          }),
        });
      });

      const dto: TenantLoginDto = {
        shopCode: 'TEST_SHOP',
        username: 'staff1',
        password: 'Password123!',
      };

      await expect(authService.tenantLogin(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('superAdminLogin throws UnauthorizedException (401), not 500, when database hash is malformed', async () => {
      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: 'admin-uuid-1', password_hash: 'not_a_valid_argon2_hash', status: 'active' }],
          }),
        });
      });

      const dto: SuperAdminLoginDto = {
        username: 'admin',
        password: 'Password123!',
      };

      await expect(authService.superAdminLogin(dto)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('Password Change & mustChangePassword Flow', () => {
    it('tenantLogin passes mustChangePassword: true when flagged in users table', async () => {
      mockDb.tenantPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'tenant-uuid-1', status: 'active' }],
      });

      const validHash = await argon2.hash('TempPassword123!', { type: argon2.argon2id });
      mockDb.withTenant.mockImplementation(async (_tenantId: string, fn: any) => {
        return fn({
          query: jest.fn()
            .mockResolvedValueOnce({
              rows: [{
                id: 'user-uuid-1',
                username: 'admin',
                display_name: 'Shop Admin',
                password_hash: validHash,
                status: 'active',
                must_change_password: true,
              }],
            })
            .mockResolvedValueOnce({ rows: [{ code: 'order.create' }] }) // permissions
            .mockResolvedValueOnce({ rows: [] }), // counters
        });
      });

      const result = await authService.tenantLogin({
        shopCode: 'ACTIVE_SHOP',
        username: 'admin',
        password: 'TempPassword123!',
      });

      expect(result.user.mustChangePassword).toBe(true);
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ mustChangePassword: true }),
        expect.any(Object),
      );
    });

    it('tenantLogin throws UnauthorizedException (401) when shop is inactive', async () => {
      mockDb.tenantPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'tenant-uuid-1', status: 'inactive' }],
      });

      await expect(
        authService.tenantLogin({
          shopCode: 'INACTIVE_SHOP',
          username: 'admin',
          password: 'Password123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('changePassword throws BadRequestException if new password equals current password', async () => {
      await expect(
        authService.changePassword(
          { sub: 'user-1', tenantId: 'tenant-1', isSuperAdmin: false, permissions: [] },
          { currentPassword: 'SamePassword123!', newPassword: 'SamePassword123!' },
        ),
      ).rejects.toThrow('New password must be different from current password');
    });

    it('changePassword throws UnauthorizedException if current password is incorrect', async () => {
      const storedHash = await argon2.hash('CorrectCurrent123!', { type: argon2.argon2id });
      mockDb.withTenant.mockImplementationOnce(async (_tId: string, fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: 'user-1', password_hash: storedHash, status: 'active' }],
          }),
        });
      });

      await expect(
        authService.changePassword(
          { sub: 'user-1', tenantId: 'tenant-1', isSuperAdmin: false, permissions: [] },
          { currentPassword: 'WrongPassword!', newPassword: 'NewSecurePass123!' },
        ),
      ).rejects.toThrow('Current password is incorrect');
    });

    it('changePassword successfully hashes new password with Argon2id and clears must_change_password', async () => {
      const storedHash = await argon2.hash('OldPassword123!', { type: argon2.argon2id });
      const queryMock = jest.fn()
        .mockResolvedValueOnce({
          rows: [{ id: 'user-1', password_hash: storedHash, status: 'active' }],
        })
        .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE query

      mockDb.withTenant.mockImplementation(async (_tId: string, fn: any) => {
        return fn({ query: queryMock });
      });

      const result = await authService.changePassword(
        { sub: 'user-1', tenantId: 'tenant-1', isSuperAdmin: false, permissions: ['order.create'] },
        { currentPassword: 'OldPassword123!', newPassword: 'NewStrongPassword123!' },
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Password updated successfully');
      expect(mockAudit.logTenant).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          actorUserId: 'user-1',
          action: 'user.change_password',
        }),
      );

      // Verify UPDATE was called with new hash and must_change_password = false
      expect(queryMock).toHaveBeenCalledTimes(2);
      const updateArgs = queryMock.mock.calls[1];
      expect(updateArgs[0]).toContain('UPDATE users SET password_hash = $1, must_change_password = false');
      const newHashSaved = updateArgs[1][0];
      expect(newHashSaved.startsWith('$argon2id$')).toBe(true);
      const verifyNew = await argon2.verify(newHashSaved, 'NewStrongPassword123!');
      expect(verifyNew).toBe(true);
    });
  });

  describe('Super Admin Login & Credential Changes', () => {
    it('authenticates Super Admin case-insensitively using Argon2id verified credentials', async () => {
      const plainPassword = 'UpdatedSuperAdminPass2026!';
      const hash = await argon2.hash(plainPassword, { type: argon2.argon2id });

      const queryMock = jest.fn().mockResolvedValueOnce({
        rows: [{ id: 'sa-uuid-1', password_hash: hash, status: 'active' }],
      });

      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({ query: queryMock });
      });

      const result = await authService.superAdminLogin({
        username: 'New_Platform_Admin',
        password: plainPassword,
      });

      expect(result).toBeDefined();
      expect(result.accessToken).toBe('mock_token');
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('LOWER(username) = LOWER($1)'),
        ['New_Platform_Admin'],
      );
      expect(mockAudit.logSuperAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'sa-uuid-1',
          action: 'auth.super_admin_login',
        }),
      );
    });

    it('rejects Super Admin login with incorrect password', async () => {
      const hash = await argon2.hash('CorrectPass123!', { type: argon2.argon2id });

      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: 'sa-uuid-1', password_hash: hash, status: 'active' }],
          }),
        });
      });

      await expect(
        authService.superAdminLogin({
          username: 'superadmin',
          password: 'WrongPassword!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects Super Admin login if user is inactive', async () => {
      const hash = await argon2.hash('Pass123!', { type: argon2.argon2id });

      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: 'sa-uuid-1', password_hash: hash, status: 'disabled' }],
          }),
        });
      });

      await expect(
        authService.superAdminLogin({
          username: 'superadmin',
          password: 'Pass123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
