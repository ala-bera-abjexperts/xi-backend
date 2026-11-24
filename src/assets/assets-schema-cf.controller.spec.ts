import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AssetsSchemaCfController } from './assets-schema-cf.controller';

runControllerContractSuite({
  controller: AssetsSchemaCfController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
