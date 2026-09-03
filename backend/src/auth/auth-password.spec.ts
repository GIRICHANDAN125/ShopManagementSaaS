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
});
