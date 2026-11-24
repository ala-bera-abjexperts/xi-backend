import { runControllerContractSuite } from '../test/controller-contract.helper';
import { TimeEntriesController } from './time-entries.controller';

runControllerContractSuite({
  controller: TimeEntriesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
