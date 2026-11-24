/**
 * @fileoverview Contract tests for BackupTargetsController — the decorator stack and the
 * per-request module gate, both of which are security controls rather than conveniences.
 * @module src/backup/controllers/backup-targets.controller.spec
 */

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { REQUIRE_FEATURE_KEY } from '../../auth/decorators/require-feature.decorator';
import { PERMISSIONS_KEY } from '../../auth/decorators/require-permissions.decorator';
import { BackupTargetsController } from './backup-targets.controller';

runControllerContractSuite({
  controller: BackupTargetsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('BackupTargetsController access control', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' };

  function setup(moduleEnabled = true) {
    const targetsService = {
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      rotateSecret: jest.fn(),
      remove: jest.fn(),
    };
    const organizationModulesService = {
      isEnabled: jest.fn().mockResolvedValue(moduleEnabled),
    };

    const controller = new BackupTargetsController(
      targetsService as never,
      organizationModulesService as never,
    );

    return { controller, targetsService, organizationModulesService };
  }

  it('requires the module_backup licence feature for the whole controller', () => {
    const features = Reflect.getMetadata(
      REQUIRE_FEATURE_KEY,
      BackupTargetsController,
    ) as string[];

    expect(features).toContain('module_backup');
  });

  it.each([
    ['list', 'can_manage_backups'],
    ['get', 'can_manage_backups'],
    ['create', 'can_manage_backup_credentials'],
    ['update', 'can_manage_backup_credentials'],
    ['rotateSecret', 'can_manage_backup_credentials'],
    ['remove', 'can_manage_backup_credentials'],
  ])('gates %s behind %s', (method, permission) => {
    const meta = Reflect.getMetadata(
      PERMISSIONS_KEY,
      BackupTargetsController.prototype[
        method as keyof BackupTargetsController
      ] as object,
    ) as { permissions: string[] };

    expect(meta.permissions).toContain(permission);
  });

  it('reads a credential only through the write endpoints, never the read ones', () => {
    // Reading a target needs the lesser permission; touching its secret needs the credential one.
    const handler = Object.getOwnPropertyDescriptor(
      BackupTargetsController.prototype,
      'list',
    )?.value as object;

    const read = Reflect.getMetadata(PERMISSIONS_KEY, handler) as {
      permissions: string[];
    };

    expect(read.permissions).not.toContain('can_manage_backup_credentials');
  });

  describe('per-request module gate', () => {
    it('refuses every route while the module is disabled', async () => {
      const { controller } = setup(false);

      await expect(controller.list(user as never)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        controller.create(user as never, {} as never),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.rotateSecret(user as never, 'tgt-1', {} as never),
      ).rejects.toThrow(ForbiddenException);
      await expect(controller.remove(user as never, 'tgt-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('checks the toggle on every call rather than caching it', async () => {
      const { controller, organizationModulesService } = setup(true);

      await controller.list(user as never);
      await controller.list(user as never);

      // Two requests, two checks — a cached result would let a mid-session disable keep working.
      expect(organizationModulesService.isEnabled).toHaveBeenCalledTimes(2);
      expect(organizationModulesService.isEnabled).toHaveBeenCalledWith(
        'org-1',
        'backup',
      );
    });

    it('passes the authenticated organization, never a body value', async () => {
      const { controller, targetsService } = setup(true);

      await controller.create(
        user as never,
        {
          name: 'x',
          organizationId: 'org-999',
        } as never,
      );

      expect(targetsService.create).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        expect.objectContaining({ name: 'x' }),
      );
    });
  });
});
