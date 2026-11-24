import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PartnerReportingController } from './partner-reporting.controller';

runControllerContractSuite({
  controller: PartnerReportingController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
