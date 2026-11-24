/**
 * @fileoverview Unit tests for the UsersController. All service methods are mocked
 * to isolate controller-level logic including file validation.
 * @module src/users/users.controller.spec
 * @author Prince Jadiya
 */

/* eslint-disable @typescript-eslint/unbound-method */

import { UPLOAD_LIMITS } from '../common/upload-limits';
import { BadRequestException } from '@nestjs/common';
import { Readable } from 'stream';
import { UsersController } from './users.controller';
import { UsersService, PublicUser } from './users.service';

/** Creates a properly typed mock Multer file for upload tests */
function mockFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'test.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 1024,
    buffer: Buffer.from('fake-image'),
    stream: new Readable(),
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;

  const mockUser: PublicUser = {
    id: 'user-1',
    email: 'test@example.com',
    first_name: 'Test',
    last_name: 'User',
    auth_user_id: 'auth-1',
    organization_id: 'org-1',
    avatar_url: null,
    avatar_path: null,
    mobile: null,
    role: null,
    country: null,
    language: null,
    date_of_birth: null,
    cover_image_url: null,
    cover_image_path: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const mockRequestUser = {
    authUserId: 'auth-1',
    userId: 'user-1',
    email: 'test@example.com',
    organizationId: 'org-1',
  };

  beforeEach(() => {
    usersService = {
      getProfile: jest.fn(),
      updateProfile: jest.fn(),
      uploadAvatar: jest.fn(),
      deleteAvatar: jest.fn(),
      uploadCoverImage: jest.fn(),
      deleteCoverImage: jest.fn(),
      getOrganizationMembers: jest.fn(),
      mergePlaceholderUser: jest.fn(),
      getUserByAuthUserId: jest.fn(),
      getUserByEmail: jest.fn(),
      getUserById: jest.fn(),
      getAvatarSignedUrl: jest.fn(),
      getCoverImageSignedUrl: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    controller = new UsersController(usersService);
  });

  describe('GET /users/profile', () => {
    it('should return the current user profile', async () => {
      usersService.getProfile.mockResolvedValue(mockUser);

      const result = await controller.getProfile(mockRequestUser);

      expect(result).toEqual({ user: mockUser });
      expect(usersService.getProfile).toHaveBeenCalledWith('auth-1');
    });
  });

  describe('PATCH /users/profile', () => {
    it('should update the user profile', async () => {
      const updateData = { first_name: 'Updated' };
      const updatedUser = { ...mockUser, first_name: 'Updated' };
      usersService.updateProfile.mockResolvedValue(updatedUser);

      const result = await controller.updateProfile(
        mockRequestUser,
        updateData,
      );

      expect(result).toEqual({
        user: updatedUser,
        message: 'Profile updated successfully',
      });
      expect(usersService.updateProfile).toHaveBeenCalledWith(
        'user-1',
        updateData,
      );
    });
  });

  describe('POST /users/avatar', () => {
    it('should upload a valid avatar', async () => {
      const avatarUser: PublicUser = {
        ...mockUser,
        avatar_url: 'https://signed-url.com/avatar',
      };
      usersService.uploadAvatar.mockResolvedValue(avatarUser);

      const file = mockFile({
        originalname: 'avatar.png',
        mimetype: 'image/png',
        size: 1024,
      });

      const result = await controller.uploadAvatar(mockRequestUser, file);

      expect(result).toEqual({
        user: avatarUser,
        message: 'Avatar uploaded successfully',
      });
      expect(usersService.uploadAvatar).toHaveBeenCalledWith(
        'user-1',
        file.buffer,
        'avatar.png',
        'image/png',
      );
    });

    it('should reject avatars over the small-image limit', async () => {
      const file = mockFile({
        originalname: 'large.png',
        size: UPLOAD_LIMITS.SMALL_IMAGE + 1,
      });

      await expect(
        controller.uploadAvatar(mockRequestUser, file),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject non-image files', async () => {
      const file = mockFile({
        originalname: 'document.pdf',
        mimetype: 'application/pdf',
      });

      await expect(
        controller.uploadAvatar(mockRequestUser, file),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when no file is provided', async () => {
      await expect(
        controller.uploadAvatar(
          mockRequestUser,
          undefined as unknown as Express.Multer.File,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('DELETE /users/avatar', () => {
    it('should call deleteAvatar and return updated user', async () => {
      usersService.deleteAvatar.mockResolvedValue(mockUser);

      const result = await controller.deleteAvatar(mockRequestUser);

      expect(result).toEqual({
        user: mockUser,
        message: 'Avatar deleted successfully',
      });
      expect(usersService.deleteAvatar).toHaveBeenCalledWith('user-1');
    });
  });

  describe('POST /users/cover-image', () => {
    it('should upload a valid cover image', async () => {
      const coverUser: PublicUser = {
        ...mockUser,
        cover_image_url: 'https://signed-url.com/cover',
      };
      usersService.uploadCoverImage.mockResolvedValue(coverUser);

      const file = mockFile({
        originalname: 'cover.jpg',
        mimetype: 'image/jpeg',
        size: 2048,
      });

      const result = await controller.uploadCoverImage(mockRequestUser, file);

      expect(result).toEqual({
        user: coverUser,
        message: 'Cover image uploaded successfully',
      });
      expect(usersService.uploadCoverImage).toHaveBeenCalledWith(
        'user-1',
        file.buffer,
        'cover.jpg',
        'image/jpeg',
      );
    });

    it('should reject cover images over the content-image limit', async () => {
      const file = mockFile({
        originalname: 'large-cover.png',
        size: UPLOAD_LIMITS.CONTENT_IMAGE + 1,
      });

      await expect(
        controller.uploadCoverImage(mockRequestUser, file),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject non-image files for cover image', async () => {
      const file = mockFile({
        originalname: 'doc.txt',
        mimetype: 'text/plain',
        size: 512,
      });

      await expect(
        controller.uploadCoverImage(mockRequestUser, file),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('DELETE /users/cover-image', () => {
    it('should call deleteCoverImage and return updated user', async () => {
      usersService.deleteCoverImage.mockResolvedValue(mockUser);

      const result = await controller.deleteCoverImage(mockRequestUser);

      expect(result).toEqual({
        user: mockUser,
        message: 'Cover image deleted successfully',
      });
      expect(usersService.deleteCoverImage).toHaveBeenCalledWith('user-1');
    });
  });

  describe('GET /users/organization-members', () => {
    it('should return organization member list', async () => {
      const members: PublicUser[] = [
        { ...mockUser, membership_role: 'owner' },
        { ...mockUser, id: 'user-2', email: 'other@example.com' },
      ];
      usersService.getOrganizationMembers.mockResolvedValue(members);

      const result = await controller.getOrganizationMembers(mockRequestUser);

      expect(result).toEqual({ members, total: 2 });
      expect(usersService.getOrganizationMembers).toHaveBeenCalledWith('org-1');
    });
  });

  describe('POST /users/organization-members/:userId/merge', () => {
    it('passes the placeholder, target and dry-run flag to the service', async () => {
      const result = { dry_run: true, counts: {} };
      usersService.mergePlaceholderUser.mockResolvedValue(result);

      await expect(
        controller.mergePlaceholderUser(mockRequestUser, 'ph-1', {
          target_user_id: 'real-1',
          dry_run: true,
        }),
      ).resolves.toEqual(result);
      expect(usersService.mergePlaceholderUser).toHaveBeenCalledWith(
        mockRequestUser,
        'ph-1',
        'real-1',
        true,
      );
    });

    it('defaults to a real merge when dry_run is omitted', async () => {
      usersService.mergePlaceholderUser.mockResolvedValue({
        dry_run: false,
        counts: {},
      });

      await controller.mergePlaceholderUser(mockRequestUser, 'ph-1', {
        target_user_id: 'real-1',
      });

      expect(usersService.mergePlaceholderUser).toHaveBeenCalledWith(
        mockRequestUser,
        'ph-1',
        'real-1',
        false,
      );
    });
  });
});
