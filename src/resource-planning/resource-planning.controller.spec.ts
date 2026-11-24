import {
  PERMISSIONS_KEY,
  type PermissionOptions,
} from '../auth/decorators/require-permissions.decorator';
import { ResourcePlanningController } from './resource-planning.controller';
import { ResourcePlanningCoreController } from './resource-planning-core.controller';

function requiredPermissions<T extends object>(
  controller: T,
  method: keyof T,
): string[] {
  const handler = controller[method];
  const metadata = Reflect.getMetadata(PERMISSIONS_KEY, handler as object) as
    | PermissionOptions
    | undefined;
  return metadata?.permissions ?? [];
}

describe('Resource Planning controller permissions', () => {
  it.each(['listTaskAllocations', 'getTaskRollup'] as const)(
    'requires view permission for %s',
    (method) => {
      expect(
        requiredPermissions(ResourcePlanningController.prototype, method),
      ).toContain('can_view_resource_planning');
    },
  );

  it.each([
    'createTaskAllocation',
    'updateTaskAllocation',
    'deleteTaskAllocation',
  ] as const)('requires manage permission for %s', (method) => {
    expect(
      requiredPermissions(ResourcePlanningController.prototype, method),
    ).toContain('can_manage_resource_planning');
  });

  it.each([
    'createUnit',
    'createUnitMembership',
    'createCapacityPeriod',
    'createBudgetEntry',
  ] as const)('requires manage permission for core write %s', (method) => {
    expect(
      requiredPermissions(ResourcePlanningCoreController.prototype, method),
    ).toContain('can_manage_resource_planning');
  });
});
