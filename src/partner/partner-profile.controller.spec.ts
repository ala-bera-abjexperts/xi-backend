import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PartnerProfileController } from './partner-profile.controller';

runControllerContractSuite({
  controller: PartnerProfileController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
