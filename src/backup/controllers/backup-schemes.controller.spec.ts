/**
 * @fileoverview Contract tests for BackupSchemesController.
 * @module src/backup/controllers/backup-schemes.controller.spec
 */

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { REQUIRE_FEATURE_KEY } from '../../auth/decorators/require-feature.decorator';
import { PERMISSIONS_KEY } from '../../auth/decorators/require-permissions.decorator';
import { BackupSchemesController } from './backup-schemes.controller';

runControllerContractSuite({
  controller: BackupSchemesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('BackupSchemesController access control', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' };

  function setup(moduleEnabled = true) {
    const schemesService = {
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      rotatePassphrase: jest.fn(),
      remove: jest.fn(),
    };
    const organizationModulesService = {
      isEnabled: jest.fn().mockResolvedValue(moduleEnabled),
    };

    // Third constructor dependency, added when "run this scheme now" moved onto this controller.
    // Only createRun is reached from here — see backup-schemes.controller.ts POST :id/runs.
    const runsService = {
      createRun: jest.fn(),
    };

    const controller = new BackupSchemesController(
      schemesService as never,
      organizationModulesService as never,
      runsService as never,
    );

    return {
      controller,
      schemesService,
      organizationModulesService,
      runsService,
    };
  }

  it('requires the module_backup licence feature for the whole controller', () => {
    const features = Reflect.getMetadata(
      REQUIRE_FEATURE_KEY,
      BackupSchemesController,
    ) as string[];

    expect(features).toContain('module_backup');
  });

  it.each([
    ['list', 'can_manage_backups'],
    ['create', 'can_manage_backups'],
    ['update', 'can_manage_backups'],
    ['remove', 'can_manage_backups'],
    // Putting a scheme on a timer is a scheme edit, so it matches update rather than the
    // credential permission — otherwise the UI renders the button and the click 403s.
    ['activate', 'can_manage_backups'],
    ['pause', 'can_manage_backups'],
    // Replacing the archive passphrase is a credential change, not a scheme edit.
    ['rotatePassphrase', 'can_manage_backup_credentials'],
  ])('gates %s behind %s', (method, permission) => {
    const meta = Reflect.getMetadata(
      PERMISSIONS_KEY,
      BackupSchemesController.prototype[
        method as keyof BackupSchemesController
      ] as object,
    ) as { permissions: string[] };

    expect(meta.permissions).toContain(permission);
  });

  it('refuses every route while the module is disabled', async () => {
    const { controller } = setup(false);

    await expect(controller.list(user as never)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(controller.create(user as never, {} as never)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('passes the authenticated organization and actor through', async () => {
    const { controller, schemesService } = setup(true);

    await controller.create(user as never, { name: 'Nightly' } as never);

    expect(schemesService.create).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      expect.objectContaining({ name: 'Nightly' }),
    );
  });

  it('forwards only the passphrase string to the rotate call', async () => {
    const { controller, schemesService } = setup(true);

    await controller.rotatePassphrase(user as never, 'sch-1', {
      passphrase: 'a-good-passphrase',
    } as never);

    expect(schemesService.rotatePassphrase).toHaveBeenCalledWith(
      'org-1',
      'sch-1',
      'user-1',
      'a-good-passphrase',
    );
  });
});
