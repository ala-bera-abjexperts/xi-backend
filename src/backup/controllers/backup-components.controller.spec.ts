/**
 * @fileoverview Contract tests for BackupComponentsController — the registry projection is still
 * gated, and it must never leak a hard-excluded relation.
 * @module src/backup/controllers/backup-components.controller.spec
 */

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { REQUIRE_FEATURE_KEY } from '../../auth/decorators/require-feature.decorator';
import { PERMISSIONS_KEY } from '../../auth/decorators/require-permissions.decorator';
import { HARD_EXCLUDED_RELATIONS } from '../registry/component-registry';
import { BackupComponentsController } from './backup-components.controller';

runControllerContractSuite({
  controller: BackupComponentsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('BackupComponentsController', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' };

  function setup(moduleEnabled = true) {
    const organizationModulesService = {
      isEnabled: jest.fn().mockResolvedValue(moduleEnabled),
    };

    return {
      controller: new BackupComponentsController(
        organizationModulesService as never,
      ),
      organizationModulesService,
    };
  }

  it('requires the module_backup licence feature', () => {
    const features = Reflect.getMetadata(
      REQUIRE_FEATURE_KEY,
      BackupComponentsController,
    ) as string[];

    expect(features).toContain('module_backup');
  });

  it('opens the registry to either backup permission, not both', () => {
    // Asserted as an exact set with `any: true`, not with `toContain`. The previous version used
    // `toContain('can_manage_backups')`, which would have stayed green when the second permission was
    // added — a test that passes while its own name has become false is worse than one that fails.
    //
    // `any` is the load-bearing half: without it the two names read as AND, which would LOCK OUT the
    // owners who can use this today rather than letting restore-only operators in.
    const handler = Object.getOwnPropertyDescriptor(
      BackupComponentsController.prototype,
      'list',
    )?.value as object;

    const meta = Reflect.getMetadata(PERMISSIONS_KEY, handler) as {
      permissions: string[];
      any?: boolean;
    };

    expect({
      permissions: meta.permissions.slice().sort(),
      any: meta.any,
    }).toEqual({
      permissions: ['can_manage_backups', 'can_restore_backups'],
      any: true,
    });
  });

  it('refuses while the module is disabled', async () => {
    const { controller } = setup(false);

    await expect(controller.list(user as never)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('returns the four tiers and never a hard-excluded relation', async () => {
    const { controller } = setup(true);
    const tree = await controller.list(user as never);

    expect(tree.tiers.map((tier) => tier.tier)).toEqual([
      'content',
      'configuration',
      'binary_files',
      'identity',
    ]);

    const tables = tree.tiers.flatMap((tier) =>
      tier.components.flatMap((component) => component.tables),
    );

    expect(tables.length).toBeGreaterThan(0);

    for (const excluded of HARD_EXCLUDED_RELATIONS) {
      expect(tables).not.toContain(excluded);
    }
  });
});
