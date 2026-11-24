import { runControllerContractSuite } from '../test/controller-contract.helper';
import { CustomFieldsController } from './custom-fields.controller';

runControllerContractSuite({
  controller: CustomFieldsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
