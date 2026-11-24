/**
 * @fileoverview REST controller for space-scoped wiki labels.
 * Routes are nested under spaces — `GET /spaces/:spaceId/wiki-labels/...`
 * @module src/wiki/wiki-labels.controller
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
  Query,
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
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { WikiLabelsService } from './wiki-labels.service';
import { CreateWikiLabelDto } from './dto/create-wiki-label.dto';
import { UpdateWikiLabelDto } from './dto/update-wiki-label.dto';
import { ReorderItemsDto } from './dto/reorder-items.dto';

@RequireFeature('module_wiki')
@ApiTags('Wiki Labels')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/wiki-labels')
export class WikiLabelsController {
  constructor(private readonly service: WikiLabelsService) {}

  /** GET /spaces/:spaceId/wiki-labels */
  @Get()
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'List all wiki labels for a space' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 200, description: 'Labels returned' })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('include_assignments') includeAssignments?: string,
    @Query('includeAssignments') includeAssignmentsAlt?: string,
  ) {
    if (includeAssignments === 'true' || includeAssignmentsAlt === 'true') {
      return this.service.getPageLabelAssignmentsForSpace(spaceId);
    }

    return this.service.getLabels(spaceId);
  }

  /** POST /spaces/:spaceId/wiki-labels */
  @Post()
  @RequireSpacePermission('create_wiki_pages', ['can_create_wiki_labels'])
  @ApiOperation({ summary: 'Create a wiki label in a space' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 201, description: 'Label created' })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateWikiLabelDto,
  ) {
    return this.service.createLabel(spaceId, dto);
  }

  /** PATCH /spaces/:spaceId/wiki-labels/:labelId */
  @Patch(':labelId')
  @RequireSpacePermission('edit_wiki_pages', ['can_edit_wiki_labels'])
  @ApiOperation({ summary: 'Update a wiki label' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'labelId' })
  @ApiResponse({ status: 200, description: 'Label updated' })
  async update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @Body() dto: UpdateWikiLabelDto,
  ) {
    return this.service.updateLabel(labelId, spaceId, dto);
  }

  /** PUT /spaces/:spaceId/wiki-labels/:labelId (legacy alias for PATCH) */
  @Put(':labelId')
  @RequireSpacePermission('edit_wiki_pages', ['can_edit_wiki_labels'])
  @ApiOperation({ summary: 'Update a wiki label' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'labelId' })
  @ApiResponse({ status: 200, description: 'Label updated' })
  async updateViaPut(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @Body() dto: UpdateWikiLabelDto,
  ) {
    return this.service.updateLabel(labelId, spaceId, dto);
  }

  /** DELETE /spaces/:spaceId/wiki-labels/:labelId */
  @Delete(':labelId')
  @RequireSpacePermission('delete_wiki_pages', ['can_delete_wiki_labels'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a wiki label' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'labelId' })
  @ApiResponse({ status: 200, description: 'Label deleted' })
  async remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
  ) {
    await this.service.deleteLabel(labelId, spaceId);
    return { success: true };
  }

  /** POST /spaces/:spaceId/wiki-labels/reorder */
  @Post('reorder')
  @RequireSpacePermission('edit_wiki_pages', ['can_edit_wiki_labels'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder wiki labels' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 200, description: 'Labels reordered' })
  async reorder(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: ReorderItemsDto,
  ) {
    await this.service.reorderLabels(spaceId, dto);
    return { success: true };
  }
}
