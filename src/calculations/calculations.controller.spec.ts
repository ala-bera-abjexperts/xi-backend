import { runControllerContractSuite } from '../test/controller-contract.helper';
import { CalculationsController } from './calculations.controller';

runControllerContractSuite({
  controller: CalculationsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
