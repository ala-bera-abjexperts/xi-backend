import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SaveSiteAsTemplateDto } from './dto/save-site-as-template.dto';
import { SiteTemplatesService } from './site-templates.service';

/**
 * Site templates are org-scoped: the organization always comes from the authenticated user,
 * never from the request. Using a template happens on `POST /funnels` (`template_id`).
 */
@RequireFeature('module_site_studio')
@ApiTags('Site Studio — Templates')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('site-templates')
export class SiteTemplatesController {
  constructor(private readonly service: SiteTemplatesService) {}

  @Get()
  @RequirePermissions('can_create_site_studio')
  @ApiOperation({ summary: 'List the organization’s site templates' })
  async listTemplates(@CurrentUser() user: RequestUser) {
    const templates = await this.service.listTemplates(user.organizationId);
    return { data: templates };
  }

  @Post('from-site/:funnelId')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_create_site_studio')
  @ApiOperation({ summary: 'Save a site as a reusable template' })
  async saveSiteAsTemplate(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Body() dto: SaveSiteAsTemplateDto,
  ) {
    const template = await this.service.createFromFunnel(
      funnelId,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: template };
  }

  @Delete(':templateId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_delete_site_studio')
  @ApiOperation({
    summary: 'Delete a site template (sites made from it are unaffected)',
  })
  async deleteTemplate(
    @CurrentUser() user: RequestUser,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    await this.service.deleteTemplate(
      templateId,
      user.organizationId,
      user.userId,
    );
    return { data: { success: true } };
  }
}
