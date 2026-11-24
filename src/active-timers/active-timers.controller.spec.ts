import { runControllerContractSuite } from '../test/controller-contract.helper';
import { ActiveTimersController } from './active-timers.controller';

runControllerContractSuite({
  controller: ActiveTimersController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
