import { runControllerContractSuite } from '../test/controller-contract.helper';
import { CardFieldsController } from './card-fields.controller';

runControllerContractSuite({
  controller: CardFieldsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
