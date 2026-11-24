import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { FunnelsController } from './funnels.controller';

runControllerContractSuite({
  controller: FunnelsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
