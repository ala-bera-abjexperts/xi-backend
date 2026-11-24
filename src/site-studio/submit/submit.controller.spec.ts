import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { SubmitController } from './submit.controller';

runControllerContractSuite({
  controller: SubmitController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('SubmitController auth contract', () => {
  it('keeps public contact form submissions unauthenticated', () => {
    const publicSubmit = Object.getOwnPropertyDescriptor(
      SubmitController.prototype,
      'publicSubmit',
    )?.value as unknown;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, publicSubmit)).toBe(true);
  });
});
