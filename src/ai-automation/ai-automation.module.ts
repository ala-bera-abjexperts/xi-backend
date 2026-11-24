import { Module } from '@nestjs/common';

import { AutomationsModule } from '../automations/automations.module';
import { LicensingModule } from '../licensing/licensing.module';
import { AiAutomationController } from './ai-automation.controller';
import { ExtractInvoiceAction } from './invoice/extract-invoice.action';
import { TenantAiService } from './tenant-ai.service';

// AI automation actions. Outside AutomationsModule because they need injected services; nothing
// imports this module back, so there is no cycle. SupabaseModule is @Global.
@Module({
  imports: [AutomationsModule, LicensingModule],
  controllers: [AiAutomationController],
  providers: [
    TenantAiService,

    // Provider only — it self-registers with the automations ActionRegistryService on init.
    ExtractInvoiceAction,
  ],
  exports: [TenantAiService],
})
export class AiAutomationModule {}
