import { runControllerContractSuite } from '../test/controller-contract.helper';
import { HierarchyConfigController } from './hierarchy-config.controller';

runControllerContractSuite({
  controller: HierarchyConfigController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
