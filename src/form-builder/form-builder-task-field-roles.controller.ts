import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';
import { FormBuilderTaskFieldRolesService } from './form-builder-task-field-roles.service';
import { SyncTaskFieldRolesDto } from './dto/sync-task-field-roles.dto';

@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms/:formId/task-field-roles')
export class FormBuilderTaskFieldRolesController {
  constructor(private readonly service: FormBuilderTaskFieldRolesService) {}

  @Get()
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'List task field role mappings for a form' })
  async list(@Param('formId', ParseUUIDPipe) formId: string) {
    return this.service.list(formId);
  }

  @Put()
  @RequireSpacePermission('edit_forms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync (replace) all task field role mappings for a form',
  })
  async sync(
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: SyncTaskFieldRolesDto,
  ) {
    return this.service.sync(formId, dto.space_id, dto.mappings);
  }
}
