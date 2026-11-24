import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PartnerCustomerQuotesController } from './partner-customer-quotes.controller';

runControllerContractSuite({
  controller: PartnerCustomerQuotesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
