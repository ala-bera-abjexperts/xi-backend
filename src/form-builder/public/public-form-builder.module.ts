import { Module } from '@nestjs/common';

import { PublicFormBuilderController } from './public-form-builder.controller';
import { PublicFormBuilderService } from './public-form-builder.service';
import { RecaptchaVerifierService } from './recaptcha-verifier.service';
import { FormBuilderModule } from '../form-builder.module';
import { OrganizationModulesModule } from '../../organization-modules/organization-modules.module';

@Module({
  imports: [
    // Provides FormBuilderSubmissionEventsService and FormBuilderAssignmentsService.
    // A public submission must run the SAME post-submission pipeline as an in-app
    // one — approvals, webhooks, integrations, task creation, automations.
    //
    // Also provides FormBuilderPaymentConfigService and FormBuilderPaymentsService, so a public
    // `products` field is gated on a real gateway and anonymous checkout reuses the same money code
    // as an in-app payment rather than a second implementation of it.
    FormBuilderModule,

    // Provides OrganizationModulesService.isEnabled(), which combines the licence
    // entitlement with the tenant admin's module toggle. Checking the raw
    // entitlement alone would keep serving a form for a tenant that has
    // explicitly switched the Form Builder module off.
    OrganizationModulesModule,
  ],
  controllers: [PublicFormBuilderController],
  providers: [PublicFormBuilderService, RecaptchaVerifierService],

  // Exported so the Site Studio embed path reuses this stack's asset resolution and reCAPTCHA
  // verification instead of keeping a second copy that can drift.
  exports: [PublicFormBuilderService, RecaptchaVerifierService],
})
export class PublicFormBuilderModule {}
