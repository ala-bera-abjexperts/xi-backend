import { runControllerContractSuite } from '../test/controller-contract.helper';
import { SprintsController } from './sprints.controller';

runControllerContractSuite({
  controller: SprintsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
