import { SlaConfigurationService } from './sla-configuration.service';
import { SlaConfigurationController } from './sla-configuration.controller';
import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { SlaAccessService } from './sla-access.service';
import { SlaWorkerService } from './sla-worker.service';
import { SlaResultsService } from './sla-results.service';
import { SlaResultsController } from './sla-results.controller';
import { SlaRepliesService } from './sla-replies.service';
import { SlaRepliesController } from './sla-replies.controller';
import { SlaFormRequestsService } from './sla-form-requests.service';
import { SlaFormRequestsController } from './sla-form-requests.controller';
import { FormBuilderModule } from '../form-builder/form-builder.module';
import { PublicFormBuilderModule } from '../form-builder/public/public-form-builder.module';
@Module({
  // FormBuilderModule → FormBuilderSubmissionsService; PublicFormBuilderModule → the public
  // field sanitizer. Neither tree imports SlaModule/HelpCenterModule, so no cycle.
  imports: [PermissionsModule, FormBuilderModule, PublicFormBuilderModule],
  providers: [
    SlaConfigurationService,
    SlaAccessService,
    SlaWorkerService,
    SlaResultsService,
    SlaRepliesService,
    SlaFormRequestsService,
  ],
  controllers: [
    SlaConfigurationController,
    SlaResultsController,
    SlaRepliesController,
    SlaFormRequestsController,
  ],
  exports: [
    SlaAccessService,
    SlaResultsService,
    SlaRepliesService,
    SlaFormRequestsService,
  ],
})
export class SlaModule {}
