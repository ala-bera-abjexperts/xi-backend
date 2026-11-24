import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AssetsRelationsController } from './assets-relations.controller';

runControllerContractSuite({
  controller: AssetsRelationsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
