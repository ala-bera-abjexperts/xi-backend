import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { FormFieldsController } from './form-fields.controller';

runControllerContractSuite({
  controller: FormFieldsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
