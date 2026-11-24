import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { SiteTemplatesController } from './site-templates.controller';

runControllerContractSuite({
  controller: SiteTemplatesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
