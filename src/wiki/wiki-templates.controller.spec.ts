import { runControllerContractSuite } from '../test/controller-contract.helper';
import { WikiTemplatesController } from './wiki-templates.controller';

runControllerContractSuite({
  controller: WikiTemplatesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
