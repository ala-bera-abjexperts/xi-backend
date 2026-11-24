import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';

jest.mock('../../tasks/tasks.service', () => ({
  TasksService: class TasksService {},
}));

import { PublicSiteStudioController } from './public-site-studio.controller';

runControllerContractSuite({
  controller: PublicSiteStudioController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('PublicSiteStudioController public routes', () => {
  it('keeps published page resolution unauthenticated', () => {
    const resolvePage = Object.getOwnPropertyDescriptor(
      PublicSiteStudioController.prototype,
      'resolvePage',
    )?.value as unknown;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, resolvePage)).toBe(true);
  });
});
