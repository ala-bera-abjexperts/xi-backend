import { runControllerContractSuite } from '../test/controller-contract.helper';
import { UserTimeSettingsController } from './user-time-settings.controller';

runControllerContractSuite({
  controller: UserTimeSettingsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
