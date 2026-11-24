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
import { FormBuilderVersionsService } from './form-builder-versions.service';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';
import { RestoreFormVersionDto } from './dto/restore-form-version.dto';

@RequireFeature('module_form_builder')
@ApiTags('form-builder-versions')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms/:formId/versions')
export class FormBuilderVersionsController {
  constructor(private readonly service: FormBuilderVersionsService) {}

  @Get()
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: "List a form's version history (newest first)" })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(formId, spaceId, user.organizationId);
  }

  @Get(':versionId')
  @RequireSpacePermission('view_forms')
  @ApiOperation({
    summary: 'Get one version with its field snapshot (read-only preview)',
  })
  async getOne(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getOne(formId, versionId, spaceId, user.organizationId);
  }

  @Post()
  @RequireSpacePermission('manage_forms')
  @ApiOperation({
    summary: 'Manually snapshot the current form as a new version',
  })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.captureVersion(
      formId,
      spaceId,
      user.organizationId,
      user.userId,
      { force: true },
    );

    return { success: true };
  }

  @Post(':versionId/restore')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({
    summary: 'Restore a version onto the live form (records a new version)',
  })
  async restore(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: RestoreFormVersionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.restore(
      formId,
      versionId,
      spaceId,
      user.organizationId,
      user.userId,
      dto.version,
    );
  }
}
