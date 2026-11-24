import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderFieldsService } from './form-builder-fields.service';
import { FormBuilderVersionsService } from './form-builder-versions.service';
import { ReplaceFormBuilderFieldsDto } from './dto/replace-form-builder-fields.dto';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';

@RequireFeature('module_form_builder')
@ApiTags('form-builder-fields')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms/:formId/fields')
export class FormBuilderFieldsController {
  constructor(
    private readonly service: FormBuilderFieldsService,
    private readonly versions: FormBuilderVersionsService,
  ) {}

  @Get()
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'List fields for a form, ordered by sort_order' })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(formId, spaceId, user.organizationId);
  }

  @Put()
  @RequireSpacePermission('manage_forms')
  @ApiOperation({
    summary: 'Atomically replace ALL fields for a form (version-locked)',
  })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async replace(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ReplaceFormBuilderFieldsDto,
    @CurrentUser() user: RequestUser,
  ) {
    const result: unknown = await this.service.replaceAll(
      formId,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );

    // Auto-snapshot the saved form as a new version. Best-effort and deduped —
    // it must never fail or slow the save it hangs off.
    await this.versions
      .captureVersion(formId, spaceId, user.organizationId, user.userId)
      .catch(() => undefined);

    return result;
  }
}
