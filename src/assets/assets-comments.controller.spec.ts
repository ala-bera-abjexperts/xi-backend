import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AssetsCommentsController } from './assets-comments.controller';

runControllerContractSuite({
  controller: AssetsCommentsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
