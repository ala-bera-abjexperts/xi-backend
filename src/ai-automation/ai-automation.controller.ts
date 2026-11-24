import { Controller, Get } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TenantAiService } from './tenant-ai.service';

@RequireFeature('module_automations')
@ApiTags('AI Automation')
@ApiBearerAuth()
@Controller('ai-automation')
export class AiAutomationController {
  constructor(
    private readonly tenantAi: TenantAiService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  @Get('models')
  @ApiOperation({
    summary: "Models offered by the organization's AI provider",
    description:
      'Provider from Tenant Config → AI, its default model and the models it currently lists (the key never leaves the server). ' +
      'Returns an empty list with an error text when no provider is configured or the provider cannot be reached.',
  })
  @ApiResponse({
    status: 200,
    description: 'Provider, default model and model ids',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  listModels(@CurrentUser() user: RequestUser) {
    return this.tenantAi.listModels(
      this.supabaseAdmin.getClient() as SupabaseClient,
      user.organizationId,
    );
  }
}
