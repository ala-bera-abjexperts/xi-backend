import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { FormBuilderWebhooksService } from './form-builder-webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';

@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms/:formId/webhooks')
export class FormBuilderWebhooksController {
  constructor(private readonly service: FormBuilderWebhooksService) {}

  @Get()
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List a form’s outbound webhooks' })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(formId, { spaceId, orgId: user.organizationId });
  }

  @Post()
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Create an outbound webhook' })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: CreateWebhookDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(
      formId,
      dto,
      { spaceId, orgId: user.organizationId },
      user.userId,
    );
  }

  @Patch(':webhookId')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Update an outbound webhook' })
  async update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(formId, webhookId, dto, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Delete(':webhookId')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Delete an outbound webhook' })
  async remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(formId, webhookId, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Post(':webhookId/test')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Send a test payload to a webhook' })
  async sendTest(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.sendTest(formId, webhookId, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Get(':webhookId/deliveries')
  @RequireSpacePermission('view_form_responses')
  @ApiOperation({ summary: 'List recent delivery attempts for a webhook' })
  async listDeliveries(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listDeliveries(formId, webhookId, {
      spaceId,
      orgId: user.organizationId,
    });
  }
}
