import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderAssignmentsService } from './form-builder-assignments.service';

/**
 * Org-wide "assigned to me" — NOT space-scoped. Backs the /approvals "Assigned to me" tab where a
 * user sees every form assigned to them across all their spaces.
 *
 * There is no space in the URL, so the space-permission guard/interceptor do not apply. Authorization
 * is the row-level rule the service enforces: results are filtered to `assignee_user_id = the caller`
 * and `organization_id = the caller's active org`, so a user only ever sees their own assignments.
 *
 * Auth (SupabaseAuthGuard) and licence (FeatureGuard, via @RequireFeature) are global APP_GUARDs, so
 * no @UseGuards is needed here — unlike the space-scoped assignments controller.
 */
@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@Controller('form-builder')
export class FormBuilderMyAssignmentsController {
  constructor(private readonly service: FormBuilderAssignmentsService) {}

  @Get('assignments/mine')
  @ApiOperation({
    summary: 'List every form assigned to the current user across all spaces',
  })
  async listMine(@CurrentUser() user: RequestUser) {
    return this.service.listMineOrgWide(user.organizationId, user.userId);
  }
}
