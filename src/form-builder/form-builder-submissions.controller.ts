import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderSubmissionsService } from './form-builder-submissions.service';
import { CreateFormBuilderSubmissionDto } from './dto/create-form-builder-submission.dto';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';

@RequireFeature('module_form_builder')
@ApiTags('form-builder-submissions')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms/:formId/submissions')
export class FormBuilderSubmissionsController {
  constructor(private readonly service: FormBuilderSubmissionsService) {}

  @Get()
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'List submissions for a form (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list(
      formId,
      spaceId,
      user.organizationId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('draft')
  @RequireSpacePermission('submit_forms')
  @ApiOperation({ summary: "Get the current user's saved draft for a form" })
  async getDraft(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getDraft(
      formId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Post('draft')
  @RequireSpacePermission('submit_forms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Save or update the current user's draft for a form",
  })
  async saveDraft(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: CreateFormBuilderSubmissionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.upsertDraft(
      formId,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Delete('draft')
  @RequireSpacePermission('submit_forms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete the current user's draft for a form" })
  async deleteDraft(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.deleteDraft(
      formId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Post()
  @RequireSpacePermission('submit_forms')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a response to a form' })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: CreateFormBuilderSubmissionDto,
    @CurrentUser() user: RequestUser,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.service.create(
      formId,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
      { ip, userAgent },
    );
  }

  @Delete(':submissionId')
  @RequireSpacePermission('edit_forms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a single submission' })
  async remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(
      submissionId,
      formId,
      spaceId,
      user.organizationId,
    );
  }
}
