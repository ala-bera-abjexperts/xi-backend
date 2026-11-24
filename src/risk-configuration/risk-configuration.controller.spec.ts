import { runControllerContractSuite } from '../test/controller-contract.helper';
import { RiskConfigurationController } from './risk-configuration.controller';

runControllerContractSuite({
  controller: RiskConfigurationController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
