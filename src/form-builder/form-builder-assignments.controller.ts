import {
  Body,
  Controller,
  Delete,
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
import { FormBuilderAssignmentsService } from './form-builder-assignments.service';
import { AssignFormDto } from './dto/assign-form.dto';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';

@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms')
export class FormBuilderAssignmentsController {
  constructor(private readonly service: FormBuilderAssignmentsService) {}

  // literal route — declared before the :formId routes below so it is matched first
  @Get('assignments/mine')
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'List forms assigned to the current user' })
  async listMine(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listMine(spaceId, user.organizationId, user.userId);
  }

  @Post(':formId/assignments')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Assign a form to users and/or roles' })
  async assign(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: AssignFormDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.assign(
      formId,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Get(':formId/assignments')
  @RequireSpacePermission('view_form_responses')
  @ApiOperation({ summary: 'List all assignments for a form' })
  async listForForm(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listForForm(formId, spaceId, user.organizationId);
  }

  @Delete(':formId/assignments/:assignmentId')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Remove a form assignment' })
  async remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(
      formId,
      assignmentId,
      spaceId,
      user.organizationId,
    );
  }
}
