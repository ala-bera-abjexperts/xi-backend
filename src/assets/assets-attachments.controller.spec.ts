import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AssetsAttachmentsController } from './assets-attachments.controller';

runControllerContractSuite({
  controller: AssetsAttachmentsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
