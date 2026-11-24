import { runControllerContractSuite } from '../test/controller-contract.helper';
import { QuickFiltersController } from './quick-filters.controller';

runControllerContractSuite({
  controller: QuickFiltersController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
