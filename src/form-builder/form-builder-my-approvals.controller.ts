import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderApprovalsService } from './form-builder-approvals.service';

/**
 * Org-wide approvals inbox — NOT space-scoped. Backs the profile-menu "Approvals" page
 * where a user sees every pending approval assigned to them across all their spaces.
 *
 * There is no space in the URL, so the space-permission guard/interceptor do not apply.
 * Authorization is the same row-level rule the service enforces: results are filtered to
 * `approver_user_id = the caller` and `organization_id = the caller's active org`, so a
 * user can only ever see approvals genuinely waiting on them. Deciding still happens on the
 * space-scoped `POST .../approvals/steps/:stepId/decide` route (guarded per space).
 *
 * Auth (SupabaseAuthGuard) and licence (FeatureGuard, via @RequireFeature) are global
 * APP_GUARDs, so no @UseGuards is needed here — unlike the space-scoped controllers which
 * additionally opt into the non-global SpacePermissionsGuard.
 */
@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@Controller('form-builder')
export class FormBuilderMyApprovalsController {
  constructor(private readonly service: FormBuilderApprovalsService) {}

  @Get('approvals/mine')
  @ApiOperation({
    summary:
      'List every approval step waiting on the current user across all spaces',
  })
  async listMine(@CurrentUser() user: RequestUser) {
    return this.service.listPendingForApproverOrgWide(
      user.organizationId,
      user.userId,
    );
  }

  @Get('approvals/mine/history')
  @ApiOperation({
    summary:
      "List the current user's decided approvals (history) across all spaces",
  })
  async listMineHistory(@CurrentUser() user: RequestUser) {
    return this.service.listDecidedForApproverOrgWide(
      user.organizationId,
      user.userId,
    );
  }
}
