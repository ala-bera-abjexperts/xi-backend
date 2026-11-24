/**
 * @fileoverview REST controller for wiki pages, versions, comments,
 * attachments, links, search, contributors, and image/file uploads.
 * All routes are nested under spaces — `GET /spaces/:spaceId/wiki/...`
 * @module src/wiki/wiki.controller
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Optional,
} from '@nestjs/common';
import { AgentOriginService } from '../chat-agent/agent-origin.service';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiService } from './wiki.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { WikiCommentsService } from './wiki-comments.service';
import { WikiSearchService } from './wiki-search.service';
import { WikiWorkflowService } from './wiki-workflow.service';
import { CreateWikiPageDto } from './dto/create-wiki-page.dto';
import { CreateWikiWhiteboardDto } from './dto/create-wiki-whiteboard.dto';
import { UpdateWikiPageDto } from './dto/update-wiki-page.dto';
import { PatchWikiCustomFieldsDto } from './dto/patch-wiki-custom-fields.dto';
import { CreateWikiCommentDto } from './dto/create-wiki-comment.dto';
import { UpdateWikiCommentDto } from './dto/update-wiki-comment.dto';
import { CreateWikiLinkDto } from './dto/create-wiki-link.dto';
import { SetPageLabelsDto } from './dto/set-page-labels.dto';
import { SetPagePermissionsDto } from './dto/set-page-permissions.dto';
import { PublishWikiPageDto } from './dto/publish-wiki-page.dto';
import { RestoreWikiVersionDto } from './dto/restore-wiki-version.dto';
import { ReorderItemsDto } from './dto/reorder-items.dto';
import { WikiLabelsService } from './wiki-labels.service';
import { WatchersService } from '../watchers/watchers.service';

import { extractTipTapCommentThreadIds } from './wiki-content.util';

type WikiQuery = Record<string, string | undefined>;
type WikiPage = Record<string, unknown> & { id?: string; slug?: string };

@RequireFeature('module_wiki')
@ApiTags('Wiki')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/wiki')
export class WikiController {
  constructor(
    private readonly wikiService: WikiService,
    private readonly labelsService: WikiLabelsService,
    private readonly permissionsService: WikiPermissionsService,
    private readonly commentsService: WikiCommentsService,
    private readonly searchService: WikiSearchService,
    private readonly workflowService: WikiWorkflowService,
    private readonly watchersService: WatchersService,
    @Optional() private readonly origins?: AgentOriginService,
  ) {}

  @Get('watch')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Get the current user wiki-space watch state' })
  async getSpaceWatchState(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    await this.assertWikiSpaceView(user, spaceId);
    return this.watchersService.getWikiWatchState(
      user.organizationId,
      user.userId,
      spaceId,
    );
  }

  @Put('watch')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Watch this wiki space as the current user' })
  async watchSpace(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    await this.assertWikiSpaceView(user, spaceId);
    return this.watchersService.setWikiWatch(
      user.organizationId,
      user.userId,
      spaceId,
      undefined,
      'space',
      true,
    );
  }

  @Delete('watch')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary: 'Stop watching this wiki space as the current user',
  })
  async unwatchSpace(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    await this.assertWikiSpaceView(user, spaceId);
    return this.watchersService.setWikiWatch(
      user.organizationId,
      user.userId,
      spaceId,
      undefined,
      'space',
      false,
    );
  }

  private async assertWikiSpaceView(
    user: RequestUser,
    spaceId: string,
  ): Promise<void> {
    const baseline = await this.permissionsService.getSpaceBaseline(
      user.userId,
      spaceId,
      user.organizationId,
    );
    if (baseline.can_view === false) {
      throw new ForbiddenException(
        'You do not have permission to view this wiki space',
      );
    }
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private async resolvePageId(
    pageIdOrSlug: string,
    spaceId: string,
  ): Promise<string> {
    if (this.isUuid(pageIdOrSlug)) return pageIdOrSlug;

    const page = (await this.wikiService.getPageBySlugOrId(
      pageIdOrSlug,
      spaceId,
    )) as WikiPage;
    if (!page.id || typeof page.id !== 'string') {
      throw new BadRequestException('Wiki page could not be resolved');
    }
    return page.id;
  }

  private boolQuery(value: string | undefined): boolean | undefined {
    return value !== undefined ? value === 'true' : undefined;
  }

  private firstQuery(
    query: WikiQuery,
    legacyName: string,
    modernName: string,
  ): string | undefined {
    return query[legacyName] ?? query[modernName];
  }

  private normalizePageDto<T extends object>(dto: T): T {
    const normalized = { ...dto } as Record<string, unknown>;
    if (normalized['category_id'] === undefined && normalized['categoryId']) {
      normalized['category_id'] = normalized['categoryId'];
    }
    if (normalized['parent_id'] === undefined && normalized['parentId']) {
      normalized['parent_id'] = normalized['parentId'];
    }
    if (
      normalized['is_published'] === undefined &&
      normalized['isPublished'] !== undefined
    ) {
      normalized['is_published'] = normalized['isPublished'];
    }
    if (
      normalized['is_archived'] === undefined &&
      normalized['isArchived'] !== undefined
    ) {
      normalized['is_archived'] = normalized['isArchived'];
    }
    return normalized as T;
  }

  // ========================================================================
  // Static sub-paths (must come before /:pageId)
  // ========================================================================

  /** GET /spaces/:spaceId/wiki/search */
  @Get('search')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Search wiki pages by keyword' })
  @ApiParam({ name: 'spaceId' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Matching pages returned' })
  async search(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() queryParams: WikiQuery,
    @Query('limit') limit?: string,
  ) {
    const query = queryParams.q ?? queryParams.search;
    if (!query) {
      throw new BadRequestException('Search query is required');
    }
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return this.wikiService.searchPages(
      spaceId,
      query,
      Math.min(parsedLimit, 200),
    );
  }

  /** GET /spaces/:spaceId/wiki/task-report */
  @Get('task-report')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary: 'List inline wiki tasks for the Confluence task report macro',
  })
  async taskReport(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number(limit);
    return this.wikiService.getTaskReport(
      spaceId,
      Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    );
  }

  /** GET /spaces/:spaceId/wiki/attachments */
  @Get('attachments')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'List attachments across a wiki space' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 200, description: 'Space attachments returned' })
  async getSpaceAttachments(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number(limit);
    return this.wikiService.getSpaceAttachments(
      spaceId,
      Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    );
  }

  /** GET /spaces/:spaceId/wiki/search/advanced — Wiki 2.0 full-text search */
  @Get('search/advanced')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary:
      'Advanced full-text search (tsvector + filters: author, labels, ' +
      'status, updated window, custom fields, attachments)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'authorId', required: false })
  @ApiQuery({ name: 'labelIds', required: false, description: 'CSV of UUIDs' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'updatedAfter', required: false })
  @ApiQuery({ name: 'updatedBefore', required: false })
  @ApiQuery({ name: 'includeArchived', required: false })
  @ApiQuery({ name: 'hasAttachments', required: false })
  @ApiQuery({ name: 'cf', required: false, description: 'JSON key→value map' })
  @ApiQuery({
    name: 'sort',
    required: false,
    description: 'relevance | updated_at | created_at | title | cf:<field_key>',
  })
  @ApiQuery({
    name: 'dir',
    required: false,
    description: 'asc | desc (sort direction)',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: '{ results, total, hasMore }' })
  async advancedSearch(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: WikiQuery = {},
  ) {
    const q = (query.q ?? '').trim();

    if (q && (q.length < 2 || q.length > 200)) {
      throw new BadRequestException('q must be between 2 and 200 characters');
    }

    let cf: Record<string, unknown> | undefined;

    if (query.cf) {
      try {
        const parsed = JSON.parse(query.cf) as unknown;

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error('not an object');
        }
        cf = parsed as Record<string, unknown>;
      } catch {
        throw new BadRequestException('cf must be a JSON object');
      }
    }

    const labelIds = query.labelIds
      ? query.labelIds
          .split(',')
          .map((s) => s.trim())
          .filter((s) => this.isUuid(s))
      : undefined;
    const validSorts = ['relevance', 'updated_at', 'created_at', 'title'];
    const validStatuses = ['draft', 'in_review', 'published'];

    // `sort` accepts the built-in keys OR `cf:<field_key>` to sort by a wiki
    // custom field. The field_key is charset-guarded here (defense-in-depth)
    // and re-validated in the service against the space's wiki custom fields
    // before use, so an unknown/injected key is rejected rather than trusted.
    const sortRaw = query.sort ?? '';
    const cfSortMatch = /^cf:(.+)$/.exec(sortRaw);
    let sort: 'relevance' | 'updated_at' | 'created_at' | 'title' | undefined;
    let sortCustomField: string | undefined;

    if (cfSortMatch) {
      const key = cfSortMatch[1].trim();

      if (key && /^[A-Za-z0-9_.:-]{1,100}$/.test(key)) {
        sortCustomField = key;
      }
    } else if (validSorts.includes(sortRaw)) {
      sort = sortRaw as 'relevance' | 'updated_at' | 'created_at' | 'title';
    }

    const dirRaw = query.dir ?? query.direction;
    const sortDirection =
      dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : undefined;

    return this.searchService.advancedSpaceSearch(user, spaceId, {
      q: q || undefined,
      authorId:
        query.authorId && this.isUuid(query.authorId)
          ? query.authorId
          : undefined,
      labelIds,
      status: validStatuses.includes(query.status ?? '')
        ? (query.status as 'draft' | 'in_review' | 'published')
        : undefined,
      updatedAfter: query.updatedAfter,
      updatedBefore: query.updatedBefore,
      includeArchived: this.boolQuery(query.includeArchived),
      hasAttachments: this.boolQuery(query.hasAttachments),
      cf,
      sort,
      sortCustomField,
      sortDirection,
      limit: query.limit ? parseInt(query.limit, 10) || undefined : undefined,
      offset: query.offset ? parseInt(query.offset, 10) || 0 : undefined,
    });
  }

  /** GET /spaces/:spaceId/wiki/link-search */
  @Get('link-search')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Search wiki pages for editor link autocomplete' })
  @ApiParam({ name: 'spaceId' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiResponse({ status: 200, description: 'Link autocomplete items returned' })
  async linkSearch(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() queryParams: WikiQuery,
  ) {
    const query = queryParams.search ?? queryParams.q;
    if (!query) {
      return { success: true, items: [] };
    }

    const pages = await this.wikiService.searchPages(spaceId, query, 10);
    const filtered = await this.permissionsService.filterAccessiblePages(
      pages,
      user.userId,
      spaceId,
    );

    return {
      success: true,
      items: (filtered as WikiPage[]).map((page) => ({
        href: `/spaces/${spaceId}/wiki/${page.slug ?? page.id}`,
        name: page.title,
        description: page.slug ?? page.id,
      })),
    };
  }

  /** GET /spaces/:spaceId/wiki/contributors */
  @Get('contributors')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Get top wiki contributors for a space' })
  @ApiParam({ name: 'spaceId' })
  @ApiQuery({ name: 'period', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Contributors returned' })
  async getContributors(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('period') period?: string,
    @Query('limit') limit?: string,
  ) {
    const validPeriods = ['week', 'month', 'all'] as const;
    type Period = (typeof validPeriods)[number];
    const safePeriod: Period = validPeriods.includes(period as Period)
      ? (period as Period)
      : 'month';
    const parsedLimit = limit ? parseInt(limit, 10) : 10;
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestException('limit must be a positive integer');
    }
    return this.wikiService.getContributors(
      spaceId,
      safePeriod,
      Math.min(parsedLimit, 100),
    );
  }

  /** POST /spaces/:spaceId/wiki/reorder */
  @Post('reorder')
  @RequireSpacePermission('edit_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder wiki pages (sort_order)' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 200, description: 'Pages reordered' })
  async reorder(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: ReorderItemsDto,
  ) {
    const result = await this.wikiService.reorderPages(dto.updates, spaceId);
    return { success: true, updated: result.updated };
  }

  /** POST /spaces/:spaceId/wiki/upload-image */
  @Post('upload-image')
  @RequireSpacePermission('add_attachments_wiki')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload an inline image for wiki editor' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 201, description: 'Image URL returned' })
  async uploadImage(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.wikiService.uploadImage(spaceId, file);
  }

  /** POST /spaces/:spaceId/wiki/images — legacy Next alias */
  @Post('images')
  @RequireSpacePermission('edit_wiki_pages')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload an inline image for wiki editor' })
  async uploadImageLegacy(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.wikiService.uploadImage(spaceId, file);
  }

  /** POST /spaces/:spaceId/wiki/upload-file */
  @Post('upload-file')
  @RequireSpacePermission('add_attachments_wiki')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a generic file attachment for wiki' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 201, description: 'File URL returned' })
  async uploadFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.wikiService.uploadFile(spaceId, file);
  }

  /** POST /spaces/:spaceId/wiki/files — legacy Next alias */
  @Post('files')
  @RequireSpacePermission('edit_wiki_pages')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a generic file attachment for wiki' })
  async uploadFileLegacy(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.wikiService.uploadFile(spaceId, file);
  }

  // ========================================================================
  // Space-level permissions context
  // ========================================================================

  /** GET /spaces/:spaceId/wiki/permissions — current user's wiki permission context + bulk page permissions map */
  @Get('permissions')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary:
      "Get current user's wiki permission context + bulk page permissions map for a space",
  })
  @ApiParam({ name: 'spaceId' })
  async getSpacePermissionsContext(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    const [ctx, permissionsMap] = await Promise.all([
      this.permissionsService.resolveUserContext(user.userId, spaceId),
      this.permissionsService.getSpacePermissionsMap(spaceId),
    ]);

    return { _userContext: ctx, ...permissionsMap };
  }

  // ========================================================================
  // Core page CRUD
  // ========================================================================

  /** GET /spaces/:spaceId/wiki */
  @Get()
  @SkipThrottle()
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'List wiki pages in a space' })
  @ApiParam({ name: 'spaceId' })
  @ApiQuery({ name: 'parentId', required: false })
  @ApiQuery({ name: 'isPublished', required: false })
  @ApiQuery({ name: 'isArchived', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Keyset cursor from a previous response. Preferred over `offset`: it addresses a position in ' +
      'the ordering rather than a row count, so it stays correct when rows are added, removed or ' +
      'hidden by permissions between requests.',
  })
  @ApiQuery({
    name: 'order',
    required: false,
    enum: ['default', 'tree'],
    description:
      '`tree` orders by depth first, guaranteeing a parent is returned before any of its children — ' +
      'required by the sidebar, which builds the tree client-side and would otherwise render a child ' +
      'at the root until its parent arrives in a later page.',
  })
  @ApiResponse({ status: 200, description: 'Pages returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: WikiQuery = {},
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
    @Query('cursor') cursor?: string,
    @Query('order') orderStr?: string,
  ) {
    const parentId = this.firstQuery(query, 'parent_id', 'parentId');
    const categoryId = this.firstQuery(query, 'category_id', 'categoryId');
    const isPublished = this.firstQuery(query, 'is_published', 'isPublished');
    const isArchived = this.firstQuery(query, 'is_archived', 'isArchived');
    const limit = Math.min(parseInt(limitStr ?? '200', 10) || 200, 500);
    const offset = parseInt(offsetStr ?? '0', 10) || 0;
    // ACL-aware pagination lives in the service now: total/hasMore are
    // computed AFTER permission filtering, so paging never skips or repeats.
    const result = await this.wikiService.getPages(
      spaceId,
      {
        parent_id: parentId === 'null' ? null : parentId,
        is_published: this.boolQuery(isPublished),
        is_archived: this.boolQuery(isArchived),
        search: query.search ?? query.q,
        category_id: categoryId,
        limit,
        offset,
        cursor,
        order: orderStr === 'tree' ? 'tree' : 'default',
      },
      user.userId,
    );

    return {
      data: result.data,
      total: result.total,
      hasMore: result.hasMore,
      nextOffset: offset + result.data.length,
      // Only present when paging by cursor; omitted on the last page.
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      // The read hit ACL_LIST_FETCH_CAP, so `total` under-reports and rows past the cap are
      // unreachable. Surfaced so a truncated listing can never be mistaken for a complete one.
      ...(result.truncated ? { truncated: true } : {}),
    };
  }

  /** POST /spaces/:spaceId/wiki */
  @Post()
  @RequireSpacePermission('create_wiki_pages')
  @ApiOperation({ summary: 'Create a new wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 201, description: 'Page created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateWikiPageDto,
  ) {
    const normalizedDto = this.normalizePageDto(dto);
    await this.assertCanCreateUnder(user, spaceId, normalizedDto.parent_id);
    return this.wikiService.createPage(
      { ...normalizedDto, space_id: spaceId },
      user.organizationId,
      user.userId,
    );
  }

  /**
   * POST /spaces/:spaceId/wiki/whiteboards — a whiteboard plus its link row in the tree.
   * Also needs `create_whiteboards` (checked in the service) and the Whiteboards licence.
   */
  @Post('whiteboards')
  @RequireFeature('module_whiteboards')
  @RequireSpacePermission('create_wiki_pages')
  @ApiOperation({ summary: 'Create a whiteboard in the wiki tree' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 201, description: 'Whiteboard and tree row created' })
  async createWhiteboard(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateWikiWhiteboardDto,
  ) {
    await this.assertCanCreateUnder(user, spaceId, dto.parent_id);
    return this.wikiService.createWhiteboardPage(spaceId, user, dto);
  }

  /**
   * POST /spaces/:spaceId/wiki/whiteboards/:whiteboardId/page — the board's tree row, created at
   * the root if missing, so the Share dialog has a page ACL to edit. Also needs `edit_whiteboards`
   * (checked in the service).
   */
  @Post('whiteboards/:whiteboardId/page')
  @RequireFeature('module_whiteboards')
  @RequireSpacePermission('create_wiki_pages')
  @ApiOperation({
    summary: "Ensure a whiteboard's wiki tree row (for sharing)",
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'whiteboardId' })
  @ApiResponse({ status: 201, description: 'Tree row id' })
  async ensureWhiteboardPage(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
  ) {
    await this.assertCanCreateUnder(user, spaceId, null);
    return this.wikiService.ensureWhiteboardPage(spaceId, user, whiteboardId);
  }

  private async assertCanCreateUnder(
    user: RequestUser,
    spaceId: string,
    parentId: string | null | undefined,
  ): Promise<void> {
    // Rule 12: creating a child page requires can_create (= can_edit) on the parent
    if (parentId) {
      await this.permissionsService.assertPageAccess(
        parentId,
        user.userId,
        spaceId,
        'can_create',
      );
      return;
    }
    // Root page: no parent rule to lean on, so the space matrix decides.
    await this.permissionsService.assertSpaceCanCreate(
      user.userId,
      spaceId,
      user.organizationId,
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/clone */
  @Post(':pageId/clone')
  @RequireSpacePermission('create_wiki_pages')
  @ApiOperation({ summary: 'Clone a wiki page into a new draft' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 201, description: 'Cloned page' })
  async clonePage(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    // A clone copies the source, so the caller must be allowed to read it first.
    await this.permissionsService.assertPageAccess(
      pageId,
      user.userId,
      spaceId,
      'can_view',
    );

    // A clone is a new page, so the space matrix gates it like any create.
    await this.permissionsService.assertSpaceCanCreate(
      user.userId,
      spaceId,
      user.organizationId,
    );
    return this.wikiService.clonePage(
      pageId,
      spaceId,
      user.userId,
      user.organizationId,
    );
  }

  /** GET /spaces/:spaceId/wiki/:pageId */
  @Get(':pageId')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Get a wiki page by ID' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiQuery({ name: 'withRelations', required: false })
  @ApiResponse({ status: 200, description: 'Page returned' })
  @ApiResponse({ status: 403, description: 'No page-level view permission' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Query() query: WikiQuery = {},
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);

    // One trace serves both the access check (throws Forbidden when denied)
    // and the workflow capabilities below.
    const trace = await this.permissionsService.assertPageAccessWithTrace(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );

    const withRelations =
      query.with_relations === 'true' || query.withRelations === 'true';
    const page = (
      withRelations
        ? await this.wikiService.getPageWithRelations(resolvedPageId, spaceId)
        : await this.wikiService.getPageById(resolvedPageId, spaceId)
    ) as Record<string, unknown>;

    // Append the caller's workflow capabilities (Wiki 2.0 contract).
    const settings = await this.workflowService.getSettings(
      spaceId,
      user.organizationId,
    );
    const status = ((page['workflow_status'] as string) ??
      (page['is_published'] ? 'published' : 'draft')) as
      | 'draft'
      | 'in_review'
      | 'published';

    // The page screen asks for the "Drafted by Robert" label in the same request. Lists never do.
    const origin =
      query.withOrigin === 'true' && this.origins ? await this.origins.forObject(user, 'wiki_page', page) : null;

    return {
      ...page,
      ...(origin && { robert_origin: origin }),
      capabilities: this.workflowService.computeCapabilities(
        user.userId,
        status,
        (page['workflow_metadata'] as Record<string, unknown>) ?? null,
        trace,
        settings,
      ),
    };
  }

  @Get(':pageId/watch')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Get the current user wiki-page watch state' })
  async getPageWatchState(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.watchersService.getWikiWatchState(
      user.organizationId,
      user.userId,
      spaceId,
      resolvedPageId,
    );
  }

  @Put(':pageId/watch')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Watch this wiki page as the current user' })
  async watchPage(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.watchersService.setWikiWatch(
      user.organizationId,
      user.userId,
      spaceId,
      resolvedPageId,
      'page',
      true,
    );
  }

  @Delete(':pageId/watch')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Stop watching this wiki page as the current user' })
  async unwatchPage(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.watchersService.setWikiWatch(
      user.organizationId,
      user.userId,
      spaceId,
      resolvedPageId,
      'page',
      false,
    );
  }

  /** PUT /spaces/:spaceId/wiki/:pageId */
  @Put(':pageId')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({ summary: 'Update a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Page updated' })
  @ApiResponse({ status: 403, description: 'No page-level edit permission' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: UpdateWikiPageDto,
    @Headers('x-wiki-schema') wikiSchema?: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );

    const normalized = this.normalizePageDto(dto);
    const result = await this.wikiService.updatePage(
      resolvedPageId,
      spaceId,
      normalized,
      user.userId,
      undefined,
      { header: wikiSchema },
    );

    // TipTap content changed → reconcile inline comment anchors (best-effort).
    const finalFormat =
      normalized.content_format ??
      ((result as Record<string, unknown>)?.['content_format'] as string);

    if (normalized.content !== undefined && finalFormat === 'tiptap') {
      void this.commentsService
        .syncAnchors(
          resolvedPageId,
          extractTipTapCommentThreadIds(normalized.content),
        )
        .catch(() => undefined);
    }

    return result;
  }

  /**
   * PATCH /spaces/:spaceId/wiki/:pageId/custom-fields
   *
   * Partial, merge-semantics update of custom-field values (null clears a key).
   * Separate from PUT :pageId so the right-rail panel and the in-body block can
   * each send only what they changed, and so property edits are not blocked by
   * a live collab session (this never touches content).
   */
  @Patch(':pageId/custom-fields')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({
    summary: "Partially update a wiki page's custom field values",
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Custom field values updated' })
  @ApiResponse({ status: 403, description: 'No page-level edit permission' })
  async patchCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: PatchWikiCustomFieldsDto,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );

    return this.wikiService.patchCustomFieldValues(
      resolvedPageId,
      spaceId,
      dto.values ?? {},
      user.userId,
    );
  }

  /** DELETE /spaces/:spaceId/wiki/:pageId */
  @Delete(':pageId')
  @RequireSpacePermission('delete_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Page deleted' })
  @ApiResponse({ status: 403, description: 'No page-level delete permission' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_delete',
    );
    await this.wikiService.deletePage(
      resolvedPageId,
      spaceId,
      user.userId,
      user,
    );
    return { success: true };
  }

  /** GET /spaces/:spaceId/wiki/:pageId/delete-preview */
  @Get(':pageId/delete-preview')
  @RequireSpacePermission('delete_wiki_pages')
  @ApiOperation({
    summary:
      'Count what deleting a page together with everything below it would remove',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  async deleteTreePreview(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    const plan = await this.planDeleteTree(
      resolvedPageId,
      spaceId,
      user.userId,
    );

    return {
      folders: plan.folders,
      pages: plan.pages,
      whiteboards: plan.whiteboards,
      forbidden: plan.forbidden,
      items: plan.items,
    };
  }

  /** DELETE /spaces/:spaceId/wiki/:pageId/tree — the page and everything below it, or nothing */
  @Delete(':pageId/tree')
  @RequireSpacePermission('delete_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a page together with everything below it',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Page and descendants deleted' })
  @ApiResponse({
    status: 403,
    description: 'No delete permission on the page or on something below it',
  })
  async removeTree(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);

    await this.wikiService.getPageById(resolvedPageId, spaceId);

    const descendants = await this.wikiService.getDescendants(
      resolvedPageId,
      spaceId,
    );
    const ctx = await this.permissionsService.resolveUserContext(
      user.userId,
      spaceId,
    );

    // Every page is checked before anything is deleted, so a refusal deletes nothing
    if (!ctx.isSpaceAdmin) {
      for (const id of [resolvedPageId, ...descendants.map((d) => d.id)]) {
        await this.permissionsService.assertPageAccess(
          id,
          user.userId,
          spaceId,
          'can_delete',
        );
      }
    }

    const { deleted } = await this.wikiService.deletePageTree(
      resolvedPageId,
      spaceId,
      user,
      descendants,
    );

    return { success: true, deleted };
  }

  // What a tree delete would remove (the page first, then everything below it) and what the user may not delete
  private async planDeleteTree(
    pageId: string,
    spaceId: string,
    userId: string,
  ) {
    const root = (await this.wikiService.getPageById(
      pageId,
      spaceId,
    )) as Record<string, unknown>;
    const descendants = await this.wikiService.getDescendants(pageId, spaceId);
    const ctx = await this.permissionsService.resolveUserContext(
      userId,
      spaceId,
    );
    const all = [
      {
        id: pageId,
        title: String(root?.['title'] ?? ''),
        parentId: null as string | null,
        depth: 0,
        isFolder:
          (root?.['metadata'] as Record<string, unknown> | undefined)?.[
            'is_folder'
          ] === true,
        isWhiteboard: Boolean(root?.['whiteboard_id']),
      },
      ...descendants,
    ];
    const blocked = new Set<string>();

    // ponytail: one permission resolution per page; batch it if folders ever hold thousands of pages
    if (!ctx.isSpaceAdmin) {
      for (const item of all) {
        const decision = await this.permissionsService.getEffectivePermission(
          userId,
          item.id,
          spaceId,
        );

        if (!decision.can_delete) blocked.add(item.id);
      }
    }

    return {
      folders: descendants.filter((d) => d.isFolder).length,
      pages: descendants.filter((d) => !d.isFolder).length,
      // Subset of `pages` — link rows are pages to every existing consumer of this count.
      whiteboards: descendants.filter((d) => d.isWhiteboard).length,
      forbidden: blocked.size,

      // Every item, no cap (user decision) — the confirmation lists all of them
      items: all.map((item) => ({
        ...item,
        canDelete: !blocked.has(item.id),
      })),
    };
  }

  // ========================================================================
  // Publish / archive
  // ========================================================================

  /**
   * PATCH /spaces/:spaceId/wiki/:pageId/publish — legacy route, kept working.
   * Internally maps to the Wiki 2.0 workflow publish/unpublish transitions
   * (with the space-admin escape hatch: an admin publishing an in-review page
   * approves it) so existing UI/automations don't break.
   */
  @Patch(':pageId/publish')
  @Post(':pageId/publish')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({ summary: 'Publish or unpublish a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Publish state updated' })
  @ApiResponse({ status: 403, description: 'No page-level edit permission' })
  async publish(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: PublishWikiPageDto,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    return this.workflowService.legacyPublish(
      resolvedPageId,
      spaceId,
      dto.publish,
      user,
    );
  }

  // ========================================================================
  // Versions
  // ========================================================================

  /** GET /spaces/:spaceId/wiki/:pageId/versions */
  @Get(':pageId/versions')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'List version history for a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Versions returned' })
  async getVersions(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.wikiService.getVersions(resolvedPageId, spaceId);
  }

  /** POST /spaces/:spaceId/wiki/:pageId/versions/restore */
  @Post(':pageId/versions/restore')
  @Post(':pageId/versions')
  @RequireSpacePermission('edit_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a wiki page to a prior version' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Page restored to version' })
  async restoreVersion(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: RestoreWikiVersionDto,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    return this.wikiService.restoreVersion(
      resolvedPageId,
      spaceId,
      dto.version,
      user.userId,
    );
  }

  // ========================================================================
  // Comments
  // ========================================================================

  /**
   * GET /spaces/:spaceId/wiki/:pageId/comments
   * Default: legacy flat list. Pass `threaded=true` (or any of the
   * `resolved`/`inline` filters) for the Wiki 2.0 threaded tree.
   */
  @Get(':pageId/comments')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'List comments on a wiki page (flat or threaded)' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiQuery({ name: 'threaded', required: false })
  @ApiQuery({ name: 'resolved', required: false })
  @ApiQuery({ name: 'inline', required: false })
  @ApiResponse({ status: 200, description: 'Comments returned' })
  async getComments(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Query() query: WikiQuery = {},
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );

    const wantsThreaded =
      query.threaded === 'true' ||
      query.resolved !== undefined ||
      query.inline !== undefined;

    if (wantsThreaded) {
      return this.commentsService.getThreaded(
        resolvedPageId,
        spaceId,
        {
          resolved: this.boolQuery(query.resolved),
          inline: this.boolQuery(query.inline),
        },
        user.userId,
      );
    }

    return this.commentsService.getComments(
      resolvedPageId,
      spaceId,
      user.userId,
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/comments */
  @Post(':pageId/comments')
  @RequireSpacePermission('add_comments_wiki')
  @ApiOperation({ summary: 'Add a comment to a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  async createComment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: CreateWikiCommentDto,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.commentsService.createComment(
      resolvedPageId,
      spaceId,
      dto,
      user.userId,
    );
  }

  /** PUT /spaces/:spaceId/wiki/:pageId/comments/:commentId */
  @Put(':pageId/comments/:commentId')
  @RequireSpacePermission('add_comments_wiki')
  @ApiOperation({ summary: 'Update a wiki comment (author only)' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Comment updated' })
  async updateComment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: UpdateWikiCommentDto,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.commentsService.updateComment(
      resolvedPageId,
      commentId,
      spaceId,
      dto,
      user.userId,
    );
  }

  /** DELETE /spaces/:spaceId/wiki/:pageId/comments/:commentId */
  @Delete(':pageId/comments/:commentId')
  @RequireSpacePermission('delete_comments_wiki')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a wiki comment (author, page creator, or space admin)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  async deleteComment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    await this.commentsService.deleteComment(
      resolvedPageId,
      commentId,
      spaceId,
      user.userId,
    );
    return { success: true };
  }

  /** POST /spaces/:spaceId/wiki/:pageId/comments/:commentId/resolve */
  @Post(':pageId/comments/:commentId/resolve')
  @RequireSpacePermission('view_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a root comment thread (author, editor, or space admin)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Comment resolved' })
  async resolveComment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.commentsService.setResolved(
      resolvedPageId,
      commentId,
      spaceId,
      user.userId,
      true,
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/comments/:commentId/unresolve */
  @Post(':pageId/comments/:commentId/unresolve')
  @RequireSpacePermission('view_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a resolved root comment thread' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Comment unresolved' })
  async unresolveComment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.commentsService.setResolved(
      resolvedPageId,
      commentId,
      spaceId,
      user.userId,
      false,
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/comments/:commentId/read */
  @Post(':pageId/comments/:commentId/read')
  @RequireSpacePermission('view_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a root comment thread read for the caller' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Thread marked read' })
  async markCommentRead(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.commentsService.setReadState(
      resolvedPageId,
      commentId,
      spaceId,
      user.userId,
      false,
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/comments/:commentId/unread */
  @Post(':pageId/comments/:commentId/unread')
  @RequireSpacePermission('view_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a root comment thread unread for the caller' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Thread marked unread' })
  async markCommentUnread(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.commentsService.setReadState(
      resolvedPageId,
      commentId,
      spaceId,
      user.userId,
      true,
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/comments/read-all */
  @Post(':pageId/comments/read-all')
  @RequireSpacePermission('view_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark every thread on the page read for the caller',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Threads marked read' })
  async markAllCommentsRead(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.commentsService.markAllRead(
      resolvedPageId,
      spaceId,
      user.userId,
    );
  }

  // ========================================================================
  // Attachments
  // ========================================================================

  /** GET /spaces/:spaceId/wiki/:pageId/attachments */
  @Get(':pageId/attachments')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'List attachments on a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Attachments returned' })
  async getAttachments(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.wikiService.getAttachments(resolvedPageId);
  }

  /** GET /spaces/:spaceId/wiki/:pageId/attachments/versions?fileName=… */
  @Get(':pageId/attachments/versions')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary: 'List every version of one attachment filename on a wiki page',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiQuery({ name: 'fileName', required: true })
  @ApiResponse({ status: 200, description: 'Attachment versions returned' })
  async getAttachmentVersions(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Query('fileName') fileName: string,
  ) {
    if (!fileName?.trim()) {
      throw new BadRequestException('fileName is required');
    }

    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.wikiService.getAttachmentVersions(
      resolvedPageId,
      spaceId,
      fileName,
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/attachments */
  @Post(':pageId/attachments')
  @RequireSpacePermission('add_attachments_wiki')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file attachment to a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 201, description: 'Attachment created' })
  async createAttachment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    return this.wikiService.createAttachment(
      resolvedPageId,
      spaceId,
      file,
      user.userId,
    );
  }

  /** DELETE /spaces/:spaceId/wiki/:pageId/attachments/:attachmentId */
  @Delete(':pageId/attachments/:attachmentId')
  @RequireSpacePermission('delete_attachments_wiki')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a wiki page attachment' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'attachmentId' })
  @ApiResponse({ status: 200, description: 'Attachment deleted' })
  async deleteAttachment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    await this.wikiService.deleteAttachment(
      attachmentId,
      resolvedPageId,
      spaceId,
      user.userId,
    );
    return { success: true };
  }

  /** DELETE /spaces/:spaceId/wiki/:pageId/attachments?attachmentId=... */
  @Delete(':pageId/attachments')
  @RequireSpacePermission('delete_attachments_wiki')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a wiki page attachment by query ID' })
  async deleteAttachmentByQuery(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Query('attachmentId') attachmentIdQuery?: string,
    @Query('id') idQuery?: string,
  ) {
    const attachmentId = attachmentIdQuery ?? idQuery;
    if (!attachmentId) {
      throw new BadRequestException('Attachment ID required');
    }
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    await this.wikiService.deleteAttachment(
      attachmentId,
      resolvedPageId,
      spaceId,
      user.userId,
    );
    return { success: true };
  }

  // ========================================================================
  // Links
  // ========================================================================

  /** GET /spaces/:spaceId/wiki/:pageId/links */
  @Get(':pageId/links')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Get outgoing links from a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Links returned' })
  async getLinks(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.wikiService.getLinks(
      resolvedPageId,
      user.userId,
      user.organizationId,
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/links */
  @Post(':pageId/links')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({ summary: 'Add a link from a wiki page to another entity' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 201, description: 'Link created' })
  async createLink(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: CreateWikiLinkDto,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    return this.wikiService.createLink(
      resolvedPageId,
      dto,
      user.userId,
      user.organizationId,
    );
  }

  /** DELETE /spaces/:spaceId/wiki/:pageId/links/:linkId */
  @Delete(':pageId/links/:linkId')
  @RequireSpacePermission('edit_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a link from a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiParam({ name: 'linkId' })
  @ApiResponse({ status: 200, description: 'Link deleted' })
  async deleteLink(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    await this.wikiService.deleteLink(linkId, resolvedPageId, user.userId);
    return { success: true };
  }

  // ========================================================================
  // Labels (page-level)
  // ========================================================================

  /** GET /spaces/:spaceId/wiki/:pageId/labels */
  @Get(':pageId/labels')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Get labels assigned to a wiki page' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Page labels returned' })
  async getPageLabels(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_view',
    );
    return this.labelsService.getPageLabels(resolvedPageId);
  }

  /** PUT /spaces/:spaceId/wiki/:pageId/labels */
  @Put(':pageId/labels')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({
    summary: 'Set labels on a wiki page (replaces existing)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Labels set' })
  async setPageLabels(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: SetPageLabelsDto,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    return this.labelsService.setPageLabels(resolvedPageId, spaceId, dto);
  }

  // ========================================================================
  // Permissions (page-level)
  // ========================================================================

  /** GET /spaces/:spaceId/wiki/:pageId/permissions */
  @Get(':pageId/permissions')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary:
      'Get access control entries for a wiki page (creator or admin only)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Permissions returned' })
  @ApiResponse({ status: 403, description: 'Only page creator or space admin' })
  async getPermissions(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);

    // The ACL + member emails are inspector data — gate it like the sibling
    // matrix/suggestions routes so a member denied a restricted page cannot
    // enumerate its permission entries.
    const canManage = await this.permissionsService.isCreatorOrAdmin(
      resolvedPageId,
      user.userId,
      spaceId,
    );

    if (!canManage) {
      throw new ForbiddenException(
        'Only the page creator or a space admin can view permissions',
      );
    }

    return this.permissionsService.getPagePermissions(resolvedPageId, spaceId);
  }

  /** PUT /spaces/:spaceId/wiki/:pageId/permissions */
  @Put(':pageId/permissions')
  @Post(':pageId/permissions')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({
    summary:
      'Set access control entries for a wiki page (creator or admin only)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Permissions set' })
  @ApiResponse({ status: 403, description: 'Only page creator or space admin' })
  async setPermissions(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: SetPagePermissionsDto,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    // Rewriting the ACL is an edit of the page: a creator whose space rights
    // forbid editing must not be able to change who can reach it.
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );
    const canManage = await this.permissionsService.isCreatorOrAdmin(
      resolvedPageId,
      user.userId,
      spaceId,
    );
    if (!canManage) {
      throw new ForbiddenException(
        'Only the page creator or a space admin can manage permissions',
      );
    }
    return this.permissionsService.setPagePermissions(
      resolvedPageId,
      spaceId,
      dto,
      { userId: user.userId, organizationId: user.organizationId },
    );
  }

  /**
   * GET /spaces/:spaceId/wiki/:pageId/permissions/trace
   * The caller's own permission decision trace ("why can/can't I see this?").
   * Deliberately does NOT require page-level view — the trace is the answer.
   */
  @Get(':pageId/permissions/trace')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary: "Explain the caller's effective permission on a page",
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Decision trace returned' })
  async getPermissionTrace(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);

    return this.permissionsService.resolveWithTrace(
      user.userId,
      resolvedPageId,
      spaceId,
    );
  }

  /**
   * GET /spaces/:spaceId/wiki/:pageId/permissions/suggestions
   * Trace WHY a target user OR group has/lacks access and, when denied,
   * suggest grants (creator/admin only). Query: `targetType=user|group`
   * (default `user`) + `targetId=<uuid>`; the legacy `userId=<uuid>` is kept
   * as an alias for `targetType=user`. Response shape is identical for both:
   * `{ hasAccess, trace, suggestions }`.
   */
  @Get(':pageId/permissions/suggestions')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary:
      'Trace a target user or group’s access and suggest grants when denied ' +
      '(creator or admin only)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiQuery({
    name: 'targetType',
    required: false,
    description: 'user | group (default user)',
  })
  @ApiQuery({
    name: 'targetId',
    required: false,
    description: 'User or group UUID',
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    description: 'Legacy alias for targetType=user',
  })
  @ApiResponse({
    status: 200,
    description: '{ hasAccess, trace, suggestions }',
  })
  async getGrantSuggestions(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('userId') userIdAlias?: string,
  ) {
    const type = targetType === 'group' ? 'group' : 'user';
    const resolvedTargetId = targetId ?? userIdAlias;

    if (!resolvedTargetId) {
      throw new BadRequestException('targetId (or userId) is required');
    }

    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    const canManage = await this.permissionsService.isCreatorOrAdmin(
      resolvedPageId,
      user.userId,
      spaceId,
    );

    if (!canManage) {
      throw new ForbiddenException(
        'Only the page creator or a space admin can inspect access',
      );
    }

    return type === 'group'
      ? this.permissionsService.getGroupGrantSuggestions(
          resolvedPageId,
          spaceId,
          resolvedTargetId,
        )
      : this.permissionsService.getGrantSuggestions(
          resolvedPageId,
          spaceId,
          resolvedTargetId,
        );
  }

  /**
   * GET /spaces/:spaceId/wiki/:pageId/permissions/matrix
   * Effective-access matrix for all space members/groups (creator/admin only).
   */
  @Get(':pageId/permissions/matrix')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary:
      'Effective-access matrix for space members and groups (creator or ' +
      'admin only)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Matrix returned' })
  async getAccessMatrix(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);
    const canManage = await this.permissionsService.isCreatorOrAdmin(
      resolvedPageId,
      user.userId,
      spaceId,
    );
    if (!canManage) {
      throw new ForbiddenException(
        'Only the page creator or a space admin can inspect access',
      );
    }

    return this.permissionsService.getEffectiveAccessMatrix(
      resolvedPageId,
      spaceId,
    );
  }

  /** DELETE /spaces/:spaceId/wiki/:pageId/permissions */
  @Delete(':pageId/permissions')
  @RequireSpacePermission('delete_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Clear all custom permissions for a wiki page (creator or admin only)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Permissions cleared' })
  @ApiResponse({ status: 403, description: 'Only page creator or space admin' })
  async clearPermissions(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId') pageId: string,
  ) {
    const resolvedPageId = await this.resolvePageId(pageId, spaceId);

    // Clearing every rule is an edit of the page, same as rewriting them.
    await this.permissionsService.assertPageAccess(
      resolvedPageId,
      user.userId,
      spaceId,
      'can_edit',
    );

    const canManage = await this.permissionsService.isCreatorOrAdmin(
      resolvedPageId,
      user.userId,
      spaceId,
    );
    if (!canManage) {
      throw new ForbiddenException(
        'Only the page creator or a space admin can manage permissions',
      );
    }
    await this.permissionsService.clearPagePermissions(
      resolvedPageId,
      spaceId,
      {
        userId: user.userId,
        organizationId: user.organizationId,
      },
    );
    return { success: true };
  }
}
