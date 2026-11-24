import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PartnerSalesController } from './partner-sales.controller';

runControllerContractSuite({
  controller: PartnerSalesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
