import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AssetsItemsController } from './assets-items.controller';

runControllerContractSuite({
  controller: AssetsItemsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
