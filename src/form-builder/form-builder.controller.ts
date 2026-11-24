import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';
import { FormBuilderService } from './form-builder.service';
import { CreateFormBuilderDto } from './dto/create-form-builder.dto';
import { UpdateFormBuilderDto } from './dto/update-form-builder.dto';
import { UpdateFormPublicLinkDto } from './dto/update-form-public-link.dto';
import { RecaptchaVerifierService } from './public/recaptcha-verifier.service';
import { CheckRecaptchaKeysDto } from './dto/check-recaptcha-keys.dto';

@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms')
export class FormBuilderController {
  constructor(
    private readonly service: FormBuilderService,
    private readonly recaptcha: RecaptchaVerifierService,
  ) {}

  @Get()
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'List all forms in a space' })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.service.list(
      spaceId,
      user.organizationId,
      includeArchived === 'true',
    );
  }

  /**
   * Which render modes a reCAPTCHA site key supports.
   *
   * A Checkbox key and an Invisible/v3 key are indistinguishable by inspection, and picking the wrong
   * one renders a BLANK widget on the live form with no error — `grecaptcha.render` does not throw
   * for it. This lets the properties panel say so while the author is still editing.
   *
   * Two path segments on purpose: `@Get(':formId')` below would otherwise match a single segment and
   * reject it as a non-UUID before this handler is reached.
   */
  @Post('tools/recaptcha-key-check')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_forms')
  @ApiOperation({
    summary: 'Check a reCAPTCHA key pair against Google (advisory)',
  })
  async checkRecaptchaKeys(@Body() dto: CheckRecaptchaKeysDto) {
    return this.recaptcha.probeSiteKey(
      dto.site_key ?? '',
      dto.secret_key,
      dto.origin,
    );
  }

  @Post()
  @RequireSpacePermission('create_forms')
  @ApiOperation({ summary: 'Create a new form (status=draft)' })
  @ApiResponse({ status: 201, description: 'Form created' })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateFormBuilderDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(dto, spaceId, user.organizationId, user.userId);
  }

  // NOTE: literal routes MUST precede @Get(':formId') / @Post(':formId/...') below,
  // otherwise a request to .../forms/templates matches :formId='templates' and
  // ParseUUIDPipe rejects it with 400.
  @Get('templates')
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'List saved form templates in a space' })
  async listTemplates(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listTemplates(spaceId, user.organizationId);
  }

  @Post('templates/:templateId/instantiate')
  @RequireSpacePermission('create_forms')
  @ApiOperation({ summary: 'Create a new draft form from a template' })
  async instantiateTemplate(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.instantiateTemplate(
      templateId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Post(':formId/duplicate')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Duplicate a form into a new draft' })
  async duplicate(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.duplicate(
      formId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Post(':formId/save-as-template')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Save a form as a reusable template' })
  async saveAsTemplate(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.saveAsTemplate(
      formId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Get(':formId')
  @RequireSpacePermission('view_forms')
  @ApiOperation({ summary: 'Get a single form by ID' })
  @ApiResponse({ status: 404, description: 'Form not found' })
  async getOne(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getOne(formId, spaceId, user.organizationId);
  }

  @Patch(':formId')
  @RequireSpacePermission('edit_forms')
  @ApiOperation({ summary: 'Update a form (optimistic lock via version)' })
  @ApiResponse({ status: 409, description: 'Version conflict' })
  async update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: UpdateFormBuilderDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(
      formId,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  /**
   * Enable/disable the standalone public link. Deliberately a separate route
   * from PATCH :formId so the general editor save (`edit_forms`) cannot flip a
   * form public as a side effect — sharing a form with the internet is a
   * `manage_forms` decision.
   */
  @Patch(':formId/public-link')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Enable or disable the public link for a form' })
  @ApiResponse({ status: 409, description: 'Slug already taken or reserved' })
  async updatePublicLink(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: UpdateFormPublicLinkDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.updatePublicLink(
      formId,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Delete(':formId')
  @RequireSpacePermission('delete_forms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a form (retains submissions)' })
  async remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(
      formId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }
}
