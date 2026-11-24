import { runControllerContractSuite } from '../test/controller-contract.helper';
import { WhiteboardDetailsController } from './whiteboard-details.controller';

runControllerContractSuite({
  controller: WhiteboardDetailsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
