import { runControllerContractSuite } from '../test/controller-contract.helper';
import { SpaceTypesController } from './space-types.controller';

runControllerContractSuite({
  controller: SpaceTypesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
