// MCP-facing wiki read endpoints (`/wiki/mine/*`) backing the MCP
// `wiki.search` / `wiki.get` tools. Mirrors the `tasks/mine/*` placement.
//
// The global auth chain applies (so normal app-auth and the MCP S2S guard
// behave identically), plus the class-level `@RequireFeature('module_wiki')`
// (so a disabled/unlicensed wiki module is denied just like the rest of the
// app). There's deliberately no SpacePermissionsGuard here: these routes are
// cross-space (no `:spaceId` path param) and enforce member-space + per-page
// ACL inside WikiMineService, collapsing every denial to a uniform not-found
// (anti-probing). The org is always the caller's, never a parameter.

import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiMineService } from './wiki-mine.service';

@RequireFeature('module_wiki')
@ApiTags('Wiki')
@ApiBearerAuth()
@Controller('wiki/mine')
export class WikiMineController {
  constructor(private readonly wikiMineService: WikiMineService) {}

  // Parses a query-string integer, returning `undefined` for absent or
  // non-numeric values so the service applies its own default/clamp (no `NaN`
  // reaches the query layer). Mirrors the tasks controller.
  private parseFiniteInt(value?: string): number | undefined {
    if (value === undefined) return undefined;
    const parsed = parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search wiki pages the current user can access',
    description:
      'Title search over wiki pages the authenticated caller can read in ' +
      'their active organization — member spaces with view_wiki_pages (or org ' +
      'admin/owner) AND the per-page ACL. Never cross-org, never a non-member ' +
      'space, never an ACL-denied page, never an unpublished draft. Archived ' +
      'pages are excluded unless includeArchived=true. Backs the MCP ' +
      'wiki.search tool.',
  })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'spaceIdOrKey', required: false })
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResponse({ status: 200, description: 'Accessible wiki pages returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async searchMyWikiPages(
    @CurrentUser() user: RequestUser,
    @Query('q') q?: string,
    @Query('spaceIdOrKey') spaceIdOrKey?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.wikiMineService.searchMyWikiPages(user, {
      query: q || undefined,
      spaceIdOrKey: spaceIdOrKey || undefined,
      includeArchived: includeArchived === 'true',
      limit: this.parseFiniteInt(limit),
      cursor: cursor || undefined,
    });
  }

  @Get(':pageId')
  @ApiOperation({
    summary: 'Get one accessible wiki page by UUID',
    description:
      'Resolves a wiki page by UUID and returns it only when the caller can ' +
      'access its space (membership + view_wiki_pages, or org admin/owner) AND ' +
      'passes the per-page ACL. Cross-org, non-member, ACL-denied, draft, and ' +
      'nonexistent all return an IDENTICAL 404 (anti-probing). Content is ' +
      'sanitized plain text. Backs the MCP wiki.get tool.',
  })
  @ApiParam({ name: 'pageId', description: 'Wiki page UUID' })
  @ApiQuery({ name: 'includeChildren', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Accessible wiki page returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Page not found or not accessible' })
  async getMyWikiPage(
    @CurrentUser() user: RequestUser,
    @Param('pageId') pageId: string,
    @Query('includeChildren') includeChildren?: string,
  ) {
    return this.wikiMineService.getMyWikiPage(user, pageId, {
      includeChildren: includeChildren === 'true',
    });
  }
}
