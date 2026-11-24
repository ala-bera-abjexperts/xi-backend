import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PartnerOfficeController } from './partner-office.controller';

runControllerContractSuite({
  controller: PartnerOfficeController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
