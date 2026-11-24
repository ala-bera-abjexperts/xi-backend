import { runControllerContractSuite } from '../test/controller-contract.helper';
import { ListsController } from './lists.controller';

runControllerContractSuite({
  controller: ListsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
