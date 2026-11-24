/**
 * @fileoverview Non-space-scoped wiki endpoints.
 * Handles cross-space queries: backlinks and org-wide search.
 * @module src/wiki/wiki-global.controller
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiService } from './wiki.service';
import { WikiSearchService } from './wiki-search.service';

@RequireFeature('module_wiki')
@ApiTags('Wiki')
@ApiBearerAuth()
@Controller('wiki')
export class WikiGlobalController {
  constructor(
    private readonly wikiService: WikiService,
    private readonly searchService: WikiSearchService,
  ) {}

  /**
   * GET /wiki/backlinks?target_type=task&target_id=uuid
   * Returns wiki pages that link to a given entity — org-scoped to the
   * caller and filtered through the page ACL.
   */
  @Get('backlinks')
  @ApiOperation({ summary: 'Get wiki pages that link to a specific entity' })
  @ApiQuery({
    name: 'target_type',
    required: true,
    enum: ['page', 'process', 'task', 'asset'],
  })
  @ApiQuery({ name: 'target_id', required: true })
  async getBacklinks(
    @CurrentUser() user: RequestUser,
    @Query('target_type') targetType: string,
    @Query('target_id') targetId: string,
  ) {
    if (!targetType || !targetId) {
      throw new BadRequestException('target_type and target_id are required');
    }
    return this.wikiService.getBacklinks(targetType, targetId, user);
  }

  /**
   * GET /wiki/search?q=...&limit=...
   * Org-wide wiki search across every space where the caller holds
   * view_wiki_pages; results carry space_key for URL building.
   */
  @Get('search')
  @ApiOperation({ summary: 'Search wiki pages across all accessible spaces' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false })
  async globalSearch(
    @CurrentUser() user: RequestUser,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const query = (q ?? '').trim();

    if (!query || query.length < 2) {
      throw new BadRequestException('q must be at least 2 characters');
    }

    const parsedLimit = limit ? parseInt(limit, 10) : undefined;

    if (parsedLimit !== undefined && (isNaN(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('limit must be a positive integer');
    }

    return this.searchService.globalSearch(user, query, parsedLimit);
  }
}
