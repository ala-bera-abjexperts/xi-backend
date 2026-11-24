import { runControllerContractSuite } from '../test/controller-contract.helper';
import { SwimlanesController } from './swimlanes.controller';

runControllerContractSuite({
  controller: SwimlanesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
