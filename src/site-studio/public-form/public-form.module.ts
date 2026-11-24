import { Module } from '@nestjs/common';
import { PublicFormController } from './public-form.controller';
import { PublicFormService } from './public-form.service';
import { FormBuilderModule } from '../../form-builder/form-builder.module';
import { PublicFormBuilderModule } from '../../form-builder/public/public-form-builder.module';
import { CustomFieldsModule } from '../../custom-fields/custom-fields.module';
import { TaskHierarchyConfigModule } from '../../task-hierarchy-config/task-hierarchy-config.module';
import { TaskPrioritiesModule } from '../../task-priorities/task-priorities.module';
import { TaskStatusesModule } from '../../task-statuses/task-statuses.module';

@Module({
  // Task-mapped choice fields (task_type / priority / status) must offer the SAME options a logged-in
  // user sees. Reusing these services rather than re-querying the tables is deliberate: they already
  // encode the org-level-plus-space scoping and the per-source is_active semantics, both of which are
  // easy to get subtly wrong by hand.
  imports: [
    // Provides FormBuilderSubmissionEventsService — an anonymous submission must run the same
    // post-submission pipeline (task creation / webhooks / notifications) as an in-app one.
    FormBuilderModule,

    // Provides PublicFormBuilderService (server-resolved asset options) and RecaptchaVerifierService,
    // so the embed path reuses the standalone public-form stack instead of duplicating it.
    PublicFormBuilderModule,

    // Provides FieldGroupsService — resolves the custom fields each task type defines.
    CustomFieldsModule,
    TaskHierarchyConfigModule,
    TaskPrioritiesModule,
    TaskStatusesModule,
  ],
  controllers: [PublicFormController],
  providers: [PublicFormService],
})
export class PublicFormModule {}
