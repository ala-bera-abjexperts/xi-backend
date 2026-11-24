import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PartnerAdminController } from './partner-admin.controller';

runControllerContractSuite({
  controller: PartnerAdminController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
