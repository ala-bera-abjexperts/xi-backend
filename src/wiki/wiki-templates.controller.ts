/**
 * @fileoverview REST controller for wiki page templates, nested under spaces:
 * `GET /spaces/:spaceId/wiki-templates` returns the space's templates plus the tenant's.
 * A template is a page under the space's Templates root; `:id/content` is what a new
 * page copies, `pages/:pageId/settings` its level / title preset. `PATCH|DELETE :id`
 * are for legacy (dialog-made) templates; a page template is deleted like any page.
 * @module src/wiki/wiki-templates.controller
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
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
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiTemplatesService } from './wiki-templates.service';
import {
  CreateWikiTemplateDto,
  UpdateWikiTemplateDto,
  WikiTemplateSettingsDto,
} from './dto/wiki-template.dto';

@RequireFeature('module_wiki')
@ApiTags('Wiki Templates')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/wiki-templates')
export class WikiTemplatesController {
  constructor(private readonly service: WikiTemplatesService) {}

  /** GET /spaces/:spaceId/wiki-templates */
  @Get()
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'List space and tenant wiki templates' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 200, description: 'Templates returned' })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(spaceId, user);
  }

  /** POST /spaces/:spaceId/wiki-templates */
  @Post()
  @RequireSpacePermission('create_wiki_pages')
  @ApiOperation({
    summary: 'Create a template page under the space Templates root',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 201, description: 'Template page created' })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateWikiTemplateDto,
  ) {
    return this.service.create(spaceId, user, dto);
  }

  /** GET /spaces/:spaceId/wiki-templates/:id/content */
  @Get(':id/content')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Title preset and content a new page copies' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'id', description: 'Template page id or legacy id' })
  @ApiResponse({ status: 200, description: 'Template content returned' })
  async getContent(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getContent(id, spaceId, user);
  }

  /** PUT /spaces/:spaceId/wiki-templates/pages/:pageId/settings */
  @Put('pages/:pageId/settings')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({ summary: 'Save level, title preset and description' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Settings saved' })
  async saveSettings(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: WikiTemplateSettingsDto,
  ) {
    return this.service.saveSettings(pageId, spaceId, user, dto);
  }

  /** PATCH /spaces/:spaceId/wiki-templates/:id */
  @Patch(':id')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({ summary: 'Update a legacy wiki template' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Template updated' })
  async update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateWikiTemplateDto,
  ) {
    return this.service.update(id, spaceId, user, dto);
  }

  /** DELETE /spaces/:spaceId/wiki-templates/:id */
  @Delete(':id')
  @RequireSpacePermission('delete_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a legacy wiki template' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Template deleted' })
  async remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.remove(id, spaceId, user);
    return { success: true };
  }
}
