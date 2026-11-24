import { runControllerContractSuite } from '../test/controller-contract.helper';
import { QuickFiltersUserStateController } from './quick-filters-user-state.controller';

runControllerContractSuite({
  controller: QuickFiltersUserStateController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
