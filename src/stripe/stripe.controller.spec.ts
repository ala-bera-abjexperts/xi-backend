import { runControllerContractSuite } from '../test/controller-contract.helper';
import { StripeController } from './stripe.controller';

runControllerContractSuite({
  controller: StripeController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
