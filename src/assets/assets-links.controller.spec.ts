import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AssetsLinksController } from './assets-links.controller';

runControllerContractSuite({
  controller: AssetsLinksController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
