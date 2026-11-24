import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderApprovalsService } from './form-builder-approvals.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';

@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms')
export class FormBuilderApprovalsController {
  constructor(private readonly service: FormBuilderApprovalsService) {}

  // literal routes — declared before the :formId route so they are matched first
  @Get('approvals/mine')
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'List approval steps waiting on the current user' })
  async listMine(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listPendingForApprover(
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  // gated on view_forms (a lenient key every member holds) so the SpacePermissionsGuard
  // performs its membership check; the REAL authorization is the row-level "are you the
  // assigned pending approver?" check inside the service (404 otherwise).
  @Post('approvals/steps/:stepId/decide')
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'Approve or reject an approval step' })
  async decide(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: DecideApprovalDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.decide(stepId, user.userId, dto, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Get(':formId/approvals')
  @RequireSpacePermission('view_form_responses')
  @ApiOperation({ summary: 'List all approvals for a form' })
  async listForForm(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listForForm(formId, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  // Distinct path (extra segment) from :formId/approvals — no route collision.
  @Get(':formId/approvals/history')
  @RequireSpacePermission('view_form_responses')
  @ApiOperation({
    summary: 'Approval history (audit-log timeline) for a form',
  })
  async listApprovalHistory(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listApprovalHistory(formId, {
      spaceId,
      orgId: user.organizationId,
    });
  }
}
