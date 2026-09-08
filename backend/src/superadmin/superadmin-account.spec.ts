import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  SuperAdminAccountService,
  SuperAdminAccountController,
  UpdateSuperAdminUsernameDto,
  ChangeSuperAdminPasswordDto,
} from './superadmin.module';

describe('SuperAdminAccountService & Controller', () => {
  let service: SuperAdminAccountService;
  let controller: SuperAdminAccountController;
  let mockDb: any;
  let mockAudit: any;

  beforeEach(() => {
    mockDb = {
      withSuperAdmin: jest.fn(),
    };
    mockAudit = {
      logSuperAdmin: jest.fn(),
    };

    service = new SuperAdminAccountService(mockDb, mockAudit);
    controller = new SuperAdminAccountController(service);
  });

  describe('getProfile', () => {
    it('returns active super admin profile without sensitive fields', async () => {
      const mockProfile = {
        id: 'sa-uuid-1',
        username: 'platform_admin',
        display_name: 'Platform Super Admin',
        status: 'active',
        created_at: new Date().toISOString(),
      };

      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [mockProfile],
          }),
        });
      });

      const result = await service.getProfile('sa-uuid-1');
      expect(result).toEqual(mockProfile);
      expect(result).not.toHaveProperty('password_hash');
    });

    it('throws UnauthorizedException if account is not found or inactive', async () => {
      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [],
          }),
        });
      });

      await expect(service.getProfile('non-existent-id')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException if account status is disabled', async () => {
      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: 'sa-uuid-disabled', username: 'admin', status: 'disabled' }],
          }),
        });
      });

      await expect(service.getProfile('sa-uuid-disabled')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('updateUsername', () => {
    it('successfully updates username to trimmed lowercase and logs audit event', async () => {
      const actorId = 'sa-uuid-1';
      const dto: UpdateSuperAdminUsernameDto = {
        currentUsername: 'old_admin',
        newUsername: 'New_Admin_User',
      };

      const mockQuery = jest.fn()
        // 1. Existing user check
        .mockResolvedValueOnce({
          rows: [{ id: actorId, username: 'old_admin', status: 'active' }],
        })
        // 2. Duplicate check
        .mockResolvedValueOnce({
          rows: [],
        })
        // 3. Update query
        .mockResolvedValueOnce({ rowCount: 1 });

      mockDb.withSuperAdmin.mockImplementation(async (fn: any) => {
        return fn({ query: mockQuery });
      });

      const result = await service.updateUsername(actorId, dto);
      expect(result.success).toBe(true);
      expect(result.message).toBe('Username updated successfully');

      // Verify update query was called with trimmed lowercase username
      expect(mockQuery).toHaveBeenCalledWith(
        `UPDATE users SET username = $1 WHERE id = $2 AND tenant_id IS NULL`,
        ['new_admin_user', actorId],
      );

      // Verify audit log without sensitive data
      expect(mockAudit.logSuperAdmin).toHaveBeenCalledWith({
        actorUserId: actorId,
        action: 'superadmin.change_username',
        entityType: 'user',
        entityId: actorId,
        metadata: { oldUsername: 'old_admin', newUsername: 'new_admin_user' },
      });
    });

    it('throws BadRequestException if currentUsername does not match', async () => {
      const actorId = 'sa-uuid-1';
      const dto: UpdateSuperAdminUsernameDto = {
        currentUsername: 'wrong_username',
        newUsername: 'new_admin',
      };

      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: actorId, username: 'correct_username', status: 'active' }],
          }),
        });
      });

      await expect(service.updateUsername(actorId, dto)).rejects.toThrow(BadRequestException);
    });

    it('returns early with no-op if new username is unchanged', async () => {
      const actorId = 'sa-uuid-1';
      const dto: UpdateSuperAdminUsernameDto = {
        currentUsername: 'same_admin',
        newUsername: 'same_admin',
      };

      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: actorId, username: 'same_admin', status: 'active' }],
          }),
        });
      });

      const result = await service.updateUsername(actorId, dto);
      expect(result.success).toBe(true);
      expect(result.message).toBe('Username unchanged');
      expect(mockAudit.logSuperAdmin).not.toHaveBeenCalled();
    });

    it('throws ConflictException if new username is already taken by another super admin', async () => {
      const actorId = 'sa-uuid-1';
      const dto: UpdateSuperAdminUsernameDto = {
        currentUsername: 'admin_1',
        newUsername: 'admin_2',
      };

      const mockQuery = jest.fn()
        // 1. Existing user check
        .mockResolvedValueOnce({
          rows: [{ id: actorId, username: 'admin_1', status: 'active' }],
        })
        // 2. Duplicate check returns existing user
        .mockResolvedValueOnce({
          rows: [{ id: 'sa-uuid-2' }],
        });

      mockDb.withSuperAdmin.mockImplementation(async (fn: any) => {
        return fn({ query: mockQuery });
      });

      await expect(service.updateUsername(actorId, dto)).rejects.toThrow(ConflictException);
    });
  });

  describe('changePassword', () => {
    it('throws BadRequestException if new password and confirm password do not match', async () => {
      const dto: ChangeSuperAdminPasswordDto = {
        currentPassword: 'CurrentPass123!',
        newPassword: 'NewPassword123!',
        confirmPassword: 'MismatchPassword123!',
      };

      await expect(service.changePassword('sa-uuid-1', dto)).rejects.toThrow(
        'New password and confirmation do not match',
      );
    });

    it('throws BadRequestException if new password equals current password', async () => {
      const dto: ChangeSuperAdminPasswordDto = {
        currentPassword: 'SamePassword123!',
        newPassword: 'SamePassword123!',
        confirmPassword: 'SamePassword123!',
      };

      await expect(service.changePassword('sa-uuid-1', dto)).rejects.toThrow(
        'New password must be different from the current password',
      );
    });

    it('throws UnauthorizedException if current password verification fails', async () => {
      const storedHash = await argon2.hash('RealCurrentPassword123!', { type: argon2.argon2id });
      const dto: ChangeSuperAdminPasswordDto = {
        currentPassword: 'WrongPassword123!',
        newPassword: 'NewPassword123!',
        confirmPassword: 'NewPassword123!',
      };

      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: 'sa-uuid-1', password_hash: storedHash, status: 'active' }],
          }),
        });
      });

      await expect(service.changePassword('sa-uuid-1', dto)).rejects.toThrow(
        'Current password is incorrect',
      );
    });

    it('throws UnauthorizedException when stored password hash is malformed (fails safe without crashing)', async () => {
      const dto: ChangeSuperAdminPasswordDto = {
        currentPassword: 'AnyPassword123!',
        newPassword: 'NewPassword123!',
        confirmPassword: 'NewPassword123!',
      };

      mockDb.withSuperAdmin.mockImplementationOnce(async (fn: any) => {
        return fn({
          query: jest.fn().mockResolvedValueOnce({
            rows: [{ id: 'sa-uuid-1', password_hash: 'not_a_valid_hash', status: 'active' }],
          }),
        });
      });

      await expect(service.changePassword('sa-uuid-1', dto)).rejects.toThrow(
        'Current password is incorrect',
      );
    });

    it('successfully verifies current password, hashes new password with Argon2id, updates database, and audit logs', async () => {
      const currentPlain = 'ValidCurrentPass123!';
      const newPlain = 'BrandNewSuperSecurePass456!';
      const storedHash = await argon2.hash(currentPlain, { type: argon2.argon2id });

      const dto: ChangeSuperAdminPasswordDto = {
        currentPassword: currentPlain,
        newPassword: newPlain,
        confirmPassword: newPlain,
      };

      const mockQuery = jest.fn()
        // 1. Fetch user hash
        .mockResolvedValueOnce({
          rows: [{ id: 'sa-uuid-1', password_hash: storedHash, status: 'active' }],
        })
        // 2. Update hash
        .mockResolvedValueOnce({ rowCount: 1 });

      mockDb.withSuperAdmin.mockImplementation(async (fn: any) => {
        return fn({ query: mockQuery });
      });

      const result = await service.changePassword('sa-uuid-1', dto);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Password updated successfully');

      // Verify update query persisted new hash with must_change_password = false
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const updateArgs = mockQuery.mock.calls[1];
      expect(updateArgs[0]).toContain(
        'UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2 AND tenant_id IS NULL',
      );
      const newSavedHash = updateArgs[1][0];
      expect(newSavedHash.startsWith('$argon2id$')).toBe(true);

      // Verify the new hash decrypts with the new password
      const isNewValid = await argon2.verify(newSavedHash, newPlain);
      expect(isNewValid).toBe(true);

      // Verify audit log
      expect(mockAudit.logSuperAdmin).toHaveBeenCalledWith({
        actorUserId: 'sa-uuid-1',
        action: 'superadmin.change_password',
        entityType: 'user',
        entityId: 'sa-uuid-1',
        metadata: expect.objectContaining({ result: 'success' }),
      });
    });
  });

  describe('SuperAdminAccountController delegation', () => {
    it('routes getProfile from JWT req.user.sub to service', async () => {
      const spy = jest.spyOn(service, 'getProfile').mockResolvedValueOnce({ id: 'u1' } as any);
      const req = { user: { sub: 'user-sub-123' } };

      const res = await controller.getProfile(req);
      expect(spy).toHaveBeenCalledWith('user-sub-123');
      expect(res).toEqual({ id: 'u1' });
    });

    it('routes updateUsername from JWT req.user.sub and body to service', async () => {
      const spy = jest.spyOn(service, 'updateUsername').mockResolvedValueOnce({ success: true, message: 'ok' });
      const req = { user: { sub: 'user-sub-123' } };
      const dto = { currentUsername: 'a', newUsername: 'b' };

      const res = await controller.updateUsername(req, dto);
      expect(spy).toHaveBeenCalledWith('user-sub-123', dto);
      expect(res).toEqual({ success: true, message: 'ok' });
    });

    it('routes changePassword from JWT req.user.sub and body to service', async () => {
      const spy = jest.spyOn(service, 'changePassword').mockResolvedValueOnce({ success: true, message: 'ok' });
      const req = { user: { sub: 'user-sub-123' } };
      const dto = { currentPassword: 'a', newPassword: 'b', confirmPassword: 'b' };

      const res = await controller.changePassword(req, dto);
      expect(spy).toHaveBeenCalledWith('user-sub-123', dto);
      expect(res).toEqual({ success: true, message: 'ok' });
    });
  });
});
