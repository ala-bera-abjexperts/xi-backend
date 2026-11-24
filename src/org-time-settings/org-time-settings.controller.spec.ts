import { runControllerContractSuite } from '../test/controller-contract.helper';
import { OrgTimeSettingsController } from './org-time-settings.controller';

runControllerContractSuite({
  controller: OrgTimeSettingsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
