/**
 * @fileoverview Task-scoped, read-only view of form-builder submissions. Lives on its own
 * controller because the route is anchored on the TASK (`spaces/:spaceId/tasks/:taskId/...`)
 * rather than on a form, which the form-scoped submissions controller prefix cannot express.
 * @module src/form-builder/form-builder-task-submissions.controller
 */

import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderSubmissionsService } from './form-builder-submissions.service';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';

@RequireFeature('module_form_builder')
@ApiTags('form-builder-submissions')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/tasks/:taskId/form-submissions')
export class FormBuilderTaskSubmissionsController {
  constructor(private readonly service: FormBuilderSubmissionsService) {}

  @Get()
  @RequireSpacePermission('view_tasks')
  @ApiOperation({
    summary: 'List the submitted form responses that produced a task',
  })
  async listByTask(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listByTask(
      taskId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }
}
