import { runControllerContractSuite } from '../test/controller-contract.helper';
import { NotificationsController } from './notifications.controller';

runControllerContractSuite({
  controller: NotificationsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
