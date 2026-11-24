import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PermissionsService } from '../../permissions/permissions.service';
import { spaceGrantAllows } from '../../permissions/models/space-permissions.model';
import { WikiLabelsService } from '../wiki-labels.service';
import { WikiPermissionsService } from '../wiki-permissions.service';
import { WikiService } from '../wiki.service';
import {
  WIKI_MACRO_KINDS,
  type WikiMacroRequest,
  type WikiMacroResolution,
} from './wiki-macro.contract';
import { fetchFeed } from './rss-feed';
import { matchesBlogExpression, selectBlogPosts, type BlogPost } from './blog-posts';
import { WikiMacroRepository } from './wiki-macro.repository';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SCAN_CAP = 500;
const PARAM_KEYS: Record<WikiMacroRequest['kind'], readonly string[]> = {
  blogPosts: ['content', 'time', 'label', 'author', 'spaces', 'max', 'sort', 'reverse'],
  rssFeed: ['url', 'max', 'showTitlesOnly', 'titleBar'],
  pageTree: ['rootPageId', 'depth', 'limit', 'offset'],
  attachmentsList: ['pageId', 'limit', 'offset'],
  recentlyUpdated: ['limit', 'offset', 'types', 'hideHeading'],
  pageTreeSearch: ['rootPageId', 'mode', 'query', 'limit', 'offset'],
  changeHistory: ['pageId', 'limit', 'offset'],
  spaceDetails: ['width'],
  userList: ['groups', 'online', 'limit', 'offset'],
  userProfile: ['userId', 'userKey', 'userName'],
  profilePicture: ['userId', 'userKey', 'userName'],
  popularLabels: ['count', 'offset', 'style', 'spaceKey'],
  recentlyUsedLabels: ['count', 'offset', 'scope', 'style', 'title'],
  relatedLabels: ['labels', 'pageId', 'limit', 'offset'],
  contentByUser: ['userId', 'userKey', 'userName', 'limit', 'offset'],
  recentlyUpdatedDashboard: [
    'spaceKeys',
    'types',
    'labels',
    'users',
    'width',
    'showProfilePic',
    'limit',
    'offset',
  ],
  contentReportTable: ['labels', 'spaceKeys', 'limit', 'offset'],
  decisionReport: ['labels', 'spaceKeys', 'cql', 'limit', 'offset'],
  navigationMap: [
    'label',
    'title',
    'wrapAfter',
    'cellWidth',
    'limit',
    'offset',
  ],
};

type Params = Record<string, unknown>;
type Page = {
  id: string;
  title?: string;
  slug?: string;
  parent_id?: string | null;
  level?: number;
  updated_at?: string | null;
  created_at?: string | null;
  created_by?: string | null;
};

type LabelAssignment = {
  label_id?: string;
  assigned_at?: string | null;
  label?: { id?: string; name?: string; color?: string | null } | null;
};

@Injectable()
export class WikiMacroService {
  constructor(
    private readonly wikiService: WikiService,
    private readonly labelsService: WikiLabelsService,
    private readonly wikiPermissions: WikiPermissionsService,
    private readonly repository: WikiMacroRepository,
    private readonly permissionsService: PermissionsService,
  ) {}

  async resolve(
    user: RequestUser,
    spaceId: string,
    request: WikiMacroRequest,
  ): Promise<WikiMacroResolution> {
    if (!WIKI_MACRO_KINDS.includes(request?.kind)) {
      throw new BadRequestException('Unsupported macro kind');
    }

    const params = this.params(request.params);
    this.exact(params, PARAM_KEYS[request.kind]);
    await this.assertSpaceAccess(user, spaceId);

    switch (request.kind) {
      case 'blogPosts':
        return this.resolveBlogs(user, spaceId, params);
      case 'rssFeed':
        return this.resolveFeed(params);
      case 'pageTree':
        return this.resolvePageTree(user, spaceId, params);
      case 'attachmentsList':
        return this.resolveAttachments(user, spaceId, params);
      case 'recentlyUpdated':
        return this.resolveRecentlyUpdated(user, spaceId, params);
      case 'pageTreeSearch':
        return this.resolvePageTreeSearch(user, spaceId, params);
      case 'changeHistory':
        return this.resolveChangeHistory(user, spaceId, params);
      case 'spaceDetails':
        return this.resolveSpaceDetails(user, spaceId, params);
      case 'userList':
        return this.resolveUserList(user, spaceId, params);
      case 'userProfile':
        return this.resolveUserProfile(user, spaceId, params);
      case 'profilePicture':
        return this.resolveProfilePicture(user, spaceId, params);
      case 'popularLabels':
        return this.resolvePopularLabels(user, spaceId, params);
      case 'recentlyUsedLabels':
        return this.resolveRecentlyUsedLabels(user, spaceId, params);
      case 'relatedLabels':
        return this.resolveRelatedLabels(user, spaceId, params);
      case 'contentByUser':
        return this.resolveContentByUser(user, spaceId, params);
      case 'recentlyUpdatedDashboard':
        return this.resolveRecentlyUpdatedDashboard(user, spaceId, params);
      case 'contentReportTable':
        return this.resolveContentReportTable(user, spaceId, params);
      case 'decisionReport':
        return this.resolveDecisionReport(user, spaceId, params);
      case 'navigationMap':
        return this.resolveNavigationMap(user, spaceId, params);
    }
  }

  private async resolveFeed(params: Params): Promise<WikiMacroResolution> {
    const url = this.optionalString(params.url, 'url', 2048);
    if (!url) throw new BadRequestException('Enter an RSS feed URL');
    const max = this.integer(Number(params.max || 15), 'max', 1, 1000, 15);
    for (const key of ['showTitlesOnly', 'titleBar']) {
      if (params[key] !== undefined && !['true', 'false'].includes(String(params[key]))) throw new BadRequestException(`Invalid ${key}`);
    }
    try {
      const feed = await fetchFeed(url);
      return this.list('rssFeed', feed.items, max, 0, { title: feed.title, url: feed.url, description: feed.description });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Could not load feed');
    }
  }

  private async resolveBlogs(user: RequestUser, spaceId: string, raw: Params): Promise<WikiMacroResolution> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) params[key] = this.optionalString(value, key, 2000) ?? '';
    selectBlogPosts([], params); // Validate even when no content is visible.
    const spaces = await this.repository.getBlogSpaces(user.organizationId, user.userId);
    const expression = params.spaces || '@self';
    const terms = expression.split(/[,\s]+/).filter(Boolean);
    const known = new Set(spaces.map(space => space.key));
    for (const term of terms) {
      const key = term.replace(/^[+-]/, '');
      if (!key.startsWith('@') && key !== '*' && !known.has(key)) throw new BadRequestException('A selected blog space is unavailable');
      if (key.startsWith('@') && !['@self', '@all', '@global', '@personal', '@favorite', '@favourite'].includes(key)) throw new BadRequestException('Unknown blog space selector');
    }
    const posts: Array<BlogPost & { space_id: string; space_key: string; space_name: string }> = [];
    for (const space of spaces) {
      const aliases = [space.key, '@all', '*', space.id === spaceId ? '@self' : '', space.key.startsWith('~') ? '@personal' : '@global', ...(space.starred ? ['@favorite', '@favourite'] : [])];
      if (!matchesBlogExpression(expression, aliases)) continue;
      const grant = await this.permissionsService.resolveSpaceBaseGrant(user.userId, user.organizationId, space.id);
      if (!spaceGrantAllows(grant, 'view_wiki_pages')) continue;
      let cursor: string | undefined;
      do {
        const batch = await this.wikiService.getPages(space.id, { is_archived: false, is_published: true, limit: 500, cursor }, user.userId);
        const candidates = (batch.data as Array<BlogPost & { metadata?: Record<string, unknown> }>).filter(page => page.metadata?.content_kind === 'blogpost');
        const labels = candidates.length ? await this.labelsService.getBulkPageLabels(candidates.map(page => page.id)) : {};
        posts.push(...candidates.map(page => ({ ...page, space_id: space.id, space_key: space.key, space_name: space.name,
          labels: ((labels[page.id] || []) as LabelAssignment[]).map(label => label.label?.name || '').filter(Boolean) })));
        if (batch.hasMore && (!batch.nextCursor || batch.nextCursor === cursor)) throw new BadRequestException('Blog results could not be fully paginated');
        cursor = batch.hasMore ? batch.nextCursor : undefined;
      } while (cursor);
    }
    const selected = selectBlogPosts(posts, params);
    const authorNames = await this.repository.getBlogAuthorNames(selected.filter(post => !post.metadata?.blog_author_source_id).map(post => post.created_by || '').filter(Boolean));
    const rows = await Promise.all(selected.map(async post => {
      await this.assertPage(user, post.space_id, post.id);
      const page = await this.wikiService.getPageById(post.id, post.space_id) as Record<string, unknown>;
      if (page.is_published !== true || page.is_archived === true) return null;
      return { ...post, author: post.metadata?.blog_author_name || post.metadata?.blog_author_source_id || authorNames[post.created_by || ''] || post.author, content: params.content === 'titles' ? undefined : page.content, content_format: page.content_format };
    }));
    return this.list('blogPosts', rows.filter(row => row !== null), Number(params.max || 100), 0);
  }

  private async assertSpaceAccess(
    user: RequestUser,
    spaceId: string,
  ): Promise<void> {
    if (!user.organizationId) {
      throw new ForbiddenException('An active organization is required');
    }

    const grant = await this.permissionsService.resolveSpaceBaseGrant(
      user.userId,
      user.organizationId,
      spaceId,
    );
    if (!spaceGrantAllows(grant, 'view_wiki_pages')) {
      throw new ForbiddenException('Insufficient space permissions');
    }

    await this.repository.getSpace(spaceId, user.organizationId);
  }

  private async resolvePageTree(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const rootPageId = this.optionalUuid(params.rootPageId, 'rootPageId');
    const depth = this.integer(params.depth, 'depth', 1, 10, 2);
    const { limit, offset } = this.pagination(params, 100);

    if (!rootPageId) {
      return this.list('pageTree', [], limit, offset, {
        rootPageId: null,
        depth,
        unresolvedRoot: true,
      });
    }
    await this.assertPage(user, spaceId, rootPageId);

    const result = await this.wikiService.getPages(
      spaceId,
      { is_archived: false, limit: PAGE_SCAN_CAP, order: 'tree' },
      user.userId,
    );
    const pages = result.data as Page[];
    const scoped = this.descendants(pages, rootPageId, depth);

    return this.list('pageTree', scoped, limit, offset, {
      rootPageId,
      depth,
      truncated: result.truncated === true || result.hasMore === true,
    });
  }

  private async resolveAttachments(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const pageId = this.uuid(params.pageId, 'pageId');
    const { limit, offset } = this.pagination(params, 50);
    await this.assertPage(user, spaceId, pageId);
    const rows = await this.wikiService.getAttachments(pageId);
    return this.list('attachmentsList', rows, limit, offset);
  }

  private async resolveRecentlyUpdated(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const { limit, offset } = this.pagination(params, 10, 50);
    const types = this.stringArray(params.types, 'types', 10);
    this.optionalBoolean(params.hideHeading, 'hideHeading');

    if (types.some((type) => type !== 'page')) {
      return this.list('recentlyUpdated', [], limit, offset, {
        unsupportedTypes: types.filter((type) => type !== 'page'),
      });
    }

    const result = await this.wikiService.getPages(
      spaceId,
      { is_archived: false, limit: PAGE_SCAN_CAP },
      user.userId,
    );
    const pages = [...(result.data as Page[])].sort(
      (left, right) =>
        Date.parse(right.updated_at ?? '') - Date.parse(left.updated_at ?? ''),
    );
    return this.list('recentlyUpdated', pages, limit, offset, {
      hideHeading: params.hideHeading === true,
      truncated: result.truncated === true || result.hasMore === true,
    });
  }

  private async resolvePageTreeSearch(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const rootPageId = this.optionalUuid(params.rootPageId, 'rootPageId');
    const mode = this.oneOf(
      params.mode,
      'mode',
      ['search', 'pageIndex', 'searchResults'] as const,
      'search',
    );
    const query =
      this.optionalString(params.query, 'query', 1000)?.trim() ?? '';
    const { limit, offset } = this.pagination(params, 20, 100);
    if (!rootPageId) {
      return this.list('pageTreeSearch', [], limit, offset, {
        mode,
        query,
        rootPageId: null,
        unresolvedRoot: true,
      });
    }
    await this.assertPage(user, spaceId, rootPageId);

    if (mode !== 'pageIndex' && query.length < 2) {
      return this.list('pageTreeSearch', [], limit, offset, { mode, query });
    }

    const pageResult = await this.wikiService.getPages(
      spaceId,
      { is_archived: false, limit: PAGE_SCAN_CAP, order: 'tree' },
      user.userId,
    );
    const allPages = pageResult.data as Page[];
    const allowedIds = rootPageId
      ? new Set(
          this.descendants(allPages, rootPageId, 10).map((page) => page.id),
        )
      : null;

    let rows: Page[];
    if (mode === 'pageIndex') {
      rows = allPages
        .filter((page) => !allowedIds || allowedIds.has(page.id))
        .sort((left, right) =>
          String(left.title ?? '').localeCompare(String(right.title ?? '')),
        );
    } else {
      const matches = (await this.wikiService.searchPages(
        spaceId,
        query,
        PAGE_SCAN_CAP,
      )) as Page[];
      rows = (await this.wikiPermissions.filterAccessiblePages(
        matches.filter((page) => !allowedIds || allowedIds.has(page.id)),
        user.userId,
        spaceId,
      )) as Page[];
    }

    return this.list('pageTreeSearch', rows, limit, offset, {
      mode,
      query,
      rootPageId: rootPageId ?? null,
      truncated: pageResult.truncated === true || pageResult.hasMore === true,
    });
  }

  private async resolveChangeHistory(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const pageId = this.uuid(params.pageId, 'pageId');
    const { limit, offset } = this.pagination(params, 20, 100);
    await this.assertPage(user, spaceId, pageId);
    const rows = await this.wikiService.getVersions(pageId, spaceId);
    return this.list('changeHistory', rows, limit, offset);
  }

  private async resolveSpaceDetails(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const width = this.optionalString(params.width, 'width', 16);
    if (width) {
      const match = /^(\d{1,4}(?:\.\d{1,2})?)(px|%|em|rem)?$/.exec(width);
      const amount = Number(match?.[1]);
      const unit = match?.[2] ?? '';
      const maximum =
        unit === '%' || unit === 'em' || unit === 'rem' ? 100 : 4096;
      if (!match || amount <= 0 || amount > maximum) {
        throw new BadRequestException('width is invalid');
      }
    }
    const space = await this.repository.getSpace(spaceId, user.organizationId);
    return {
      kind: 'spaceDetails',
      data: {
        id: space.id,
        name: space.name,
        key: space.key,
        description: space.description,
        icon: space.icon_url ?? space.icon ?? null,
      },
      meta: { width: width ?? null },
    };
  }

  private async resolveUserList(
    _user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const groups = this.stringArray(params.groups, 'groups', 20);
    const online = this.optionalBoolean(params.online, 'online');
    const { limit, offset } = this.pagination(params, 100, 100);

    // Group-directory and presence mappings do not exist. Empty is safer than
    // silently broadening either filter to every member in the space.
    if (groups.length || online !== undefined) {
      return this.list('userList', [], limit, offset, {
        unresolvedGroups: groups,
        presenceFilterUnsupported: online !== undefined,
      });
    }

    const members = await this.repository.getSpaceMembers(
      spaceId,
      limit,
      offset,
    );
    const rows = members.data.flatMap((member) => {
      const user = Array.isArray(member.user) ? member.user[0] : member.user;
      if (!user?.id) return [];
      const name = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
      return [
        {
          id: user.id,
          name: name || 'Former user',
          avatarUrl: user.avatar_url ?? null,
          role: member.space_role ?? null,
        },
      ];
    });
    return {
      kind: 'userList',
      data: rows,
      pagination: {
        limit,
        offset,
        total: members.total,
        hasMore: members.hasMore,
      },
    };
  }

  private async resolveProfilePicture(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    return this.resolveIdentity('profilePicture', user, spaceId, params);
  }

  private async resolveUserProfile(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    return this.resolveIdentity('userProfile', user, spaceId, params);
  }

  private async resolveIdentity(
    kind: 'profilePicture' | 'userProfile',
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const userId = this.optionalString(params.userId, 'userId', 500);
    const userKey = this.optionalString(params.userKey, 'userKey', 500);
    const userName = this.optionalString(params.userName, 'userName', 500);
    const supplied =
      userId !== undefined || userKey !== undefined || userName !== undefined;
    // Only userId is a local identity. Source keys can themselves look like UUIDs.
    const targetId = userId && UUID_RE.test(userId)
      ? userId
      : supplied ? undefined : user.userId;
    const aliases = {
      userId: userId ?? null,
      userKey: userKey ?? null,
      userName: userName ?? null,
    };
    const membership = targetId
      ? await this.repository.getSpaceMemberByUserId(
          spaceId,
          targetId,
          user.organizationId,
        )
      : undefined;
    const profile = Array.isArray(membership?.user)
      ? membership.user[0]
      : membership?.user;

    if (!profile?.id) {
      const data = {
        id: null,
        name: userName || userKey || userId || 'Former user',
        avatarUrl: null,
        ...(kind === 'userProfile' ? { role: null } : {}),
      };
      return { kind, data, meta: { unresolved: true, ...aliases } } as Extract<
        WikiMacroResolution,
        { kind: typeof kind }
      >;
    }

    const name =
      `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() ||
      userName ||
      'Former user';
    const data = {
      id: profile.id,
      name,
      avatarUrl: profile.avatar_url ?? null,
      ...(kind === 'userProfile'
        ? {
            role: membership?.space_role ?? null,
          }
        : {}),
    };
    return { kind, data, meta: { unresolved: false, ...aliases } } as Extract<
      WikiMacroResolution,
      { kind: typeof kind }
    >;
  }

  private async resolvePopularLabels(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const count = this.integer(params.count, 'count', 1, 100, 100);
    const offset = this.integer(params.offset, 'offset', 0, 10_000, 0);
    const style = this.oneOf(
      params.style,
      'style',
      ['list', 'heatmap'] as const,
      'list',
    );
    const sourceSpaceKey = this.optionalString(params.spaceKey, 'spaceKey', 32);
    const space = await this.repository.getSpace(spaceId, user.organizationId);
    if (
      sourceSpaceKey &&
      sourceSpaceKey.toLowerCase() !== space.key.toLowerCase()
    ) {
      throw new BadRequestException('spaceKey must match the current space');
    }

    const pages = await this.wikiService.getPages(
      spaceId,
      { is_archived: false, limit: PAGE_SCAN_CAP },
      user.userId,
    );
    const ids = (pages.data as Page[]).map((page) => page.id);
    const [labels, assignments] = await Promise.all([
      this.labelsService.getLabels(spaceId),
      this.labelsService.getBulkPageLabels(ids),
    ]);
    const counts = new Map<string, number>();
    for (const pageAssignments of Object.values(assignments)) {
      for (const assignment of pageAssignments as Array<
        Record<string, unknown>
      >) {
        const nested = assignment.label as Record<string, unknown> | undefined;
        const id =
          typeof assignment.label_id === 'string'
            ? assignment.label_id
            : typeof nested?.id === 'string'
              ? nested.id
              : null;
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const rows = (labels as Array<Record<string, unknown>>)
      .map((label) => ({
        id: label.id,
        name: label.name,
        color: label.color ?? null,
        count: counts.get(String(label.id)) ?? 0,
      }))
      .filter((label) => label.count > 0)
      .sort(
        (left, right) =>
          right.count - left.count ||
          String(left.name).localeCompare(String(right.name)),
      );

    return this.list('popularLabels', rows, count, offset, {
      style,
      truncated: pages.truncated === true || pages.hasMore === true,
    });
  }

  private async resolveRecentlyUsedLabels(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const count = this.integer(params.count, 'count', 1, 100, 10);
    const offset = this.integer(params.offset, 'offset', 0, 10_000, 0);
    const scope = this.oneOf(
      params.scope,
      'scope',
      ['global', 'space', 'personal'] as const,
      'global',
    );
    const style = this.oneOf(
      params.style,
      'style',
      ['list', 'table'] as const,
      'list',
    );
    const title = this.optionalString(params.title, 'title', 200)?.trim();
    if (scope !== 'space') {
      return this.list('recentlyUsedLabels', [], count, offset, {
        scope,
        style,
        title: title ?? null,
        unsupportedScope: scope,
      });
    }

    const { pages, assignments, truncated } = await this.labelData(
      user,
      spaceId,
    );
    const rows = this.labelStats(pages, assignments).sort(
      (left, right) =>
        right.lastUsedAt - left.lastUsedAt ||
        left.name.localeCompare(right.name),
    );
    return this.list('recentlyUsedLabels', rows, count, offset, {
      scope,
      style,
      title: title ?? null,
      truncated,
    });
  }

  private async resolveRelatedLabels(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    let labels = this.reportLabels(params.labels, 'labels', 20);
    const pageId = this.optionalUuid(params.pageId, 'pageId');
    const { limit, offset } = this.pagination(params, 20, 100);
    if (!labels.length && !pageId) {
      return this.list('relatedLabels', [], limit, offset, {
        unresolvedSourcePage: true,
      });
    }
    if (pageId) await this.assertPage(user, spaceId, pageId);

    const { pages, assignments, truncated } = await this.labelData(
      user,
      spaceId,
    );
    if (!labels.length && pageId) {
      labels = this.assignmentNames(assignments[pageId] ?? []);
    }
    if (!labels.length) {
      return this.list('relatedLabels', [], limit, offset, {
        pageId: pageId ?? null,
        missingLabels: true,
      });
    }

    const seeds = new Set(labels.map((label) => label.toLowerCase()));
    const matches = pages.filter((page) =>
      this.pageHasAnyLabel(assignments[page.id] ?? [], seeds),
    );
    const related = new Map<
      string,
      { name: string; color: string | null; count: number }
    >();
    for (const page of matches) {
      for (const assignment of assignments[page.id] ?? []) {
        const name = assignment.label?.name?.trim();
        const key = name?.toLowerCase();
        if (!name || !key || seeds.has(key)) continue;
        const current = related.get(key);
        related.set(key, {
          name,
          color: assignment.label?.color ?? current?.color ?? null,
          count: (current?.count ?? 0) + 1,
        });
      }
    }
    const rows = [...related.values()].sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
    return this.list('relatedLabels', rows, limit, offset, {
      labels,
      pageId: pageId ?? null,
      truncated,
    });
  }

  private async resolveContentByUser(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const userId = this.optionalString(params.userId, 'userId', 200);
    const userKey = this.optionalString(params.userKey, 'userKey', 200);
    const userName = this.optionalString(params.userName, 'userName', 200);
    const { limit, offset } = this.pagination(params, 20, 100);
    if (!userId || !UUID_RE.test(userId)) {
      return this.list('contentByUser', [], limit, offset, {
        unresolvedUser: true,
        userId: userId ?? null,
        userKey: userKey ?? null,
        userName: userName ?? null,
      });
    }
    const member = await this.repository.getSpaceMemberByUserId(
      spaceId,
      userId,
      user.organizationId,
    );
    if (!member) {
      return this.list('contentByUser', [], limit, offset, {
        unresolvedUser: true,
        userId,
        userKey: userKey ?? null,
        userName: userName ?? null,
      });
    }
    const result = await this.visiblePages(user, spaceId);
    const rows = result.pages.filter((page) => page.created_by === userId);
    return this.list('contentByUser', rows, limit, offset, {
      userId,
      truncated: result.truncated,
    });
  }

  private async resolveRecentlyUpdatedDashboard(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const { limit, offset } = this.pagination(params, 20, 50);
    const spaceKeys = this.stringArray(params.spaceKeys, 'spaceKeys', 20);
    const types = this.stringArray(params.types, 'types', 10);
    const labels = this.reportLabels(params.labels, 'labels', 20);
    const users = this.stringArray(params.users, 'users', 20);
    const width = this.optionalString(params.width, 'width', 16);
    const showProfilePic =
      this.optionalBoolean(params.showProfilePic, 'showProfilePic') ?? false;
    const scope = await this.currentSpaceScope(user, spaceId, spaceKeys);
    if (!scope.valid || types.some((type) => type !== 'page')) {
      return this.list('recentlyUpdatedDashboard', [], limit, offset, {
        unresolvedSpaceKeys: scope.unresolved,
        unsupportedTypes: types.filter((type) => type !== 'page'),
      });
    }
    const invalidUsers = users.filter((value) => !UUID_RE.test(value));
    if (invalidUsers.length) {
      return this.list('recentlyUpdatedDashboard', [], limit, offset, {
        unresolvedUsers: invalidUsers,
      });
    }
    if (width && !/^([1-9]\d?|100)%$/.test(width)) {
      throw new BadRequestException(
        'width must be a percentage from 1% to 100%',
      );
    }

    const result = await this.visiblePages(user, spaceId);
    let rows = result.pages;
    if (users.length) {
      const selected = new Set(users);
      rows = rows.filter(
        (page) => page.created_by && selected.has(page.created_by),
      );
    }
    if (labels.length) {
      const assignments = await this.labelsService.getBulkPageLabels(
        rows.map((page) => page.id),
      );
      const selected = new Set(labels.map((label) => label.toLowerCase()));
      rows = rows.filter((page) =>
        this.pageHasAnyLabel(
          (assignments[page.id] ?? []) as LabelAssignment[],
          selected,
        ),
      );
    }
    rows = [...rows].sort(
      (left, right) =>
        Date.parse(right.updated_at ?? '') - Date.parse(left.updated_at ?? ''),
    );
    return this.list('recentlyUpdatedDashboard', rows, limit, offset, {
      spaceKeys,
      types: types.length ? types : ['page'],
      labels,
      users,
      width: width ?? '100%',
      showProfilePic,
      truncated: result.truncated,
    });
  }

  private async resolveContentReportTable(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const labels = this.reportLabels(params.labels, 'labels', 20);
    const spaceKeys = this.stringArray(params.spaceKeys, 'spaceKeys', 20);
    const { limit, offset } = this.pagination(params, 20, 200);
    if (!labels.length) {
      return this.list('contentReportTable', [], limit, offset, {
        missingLabels: true,
      });
    }
    const scope = await this.currentSpaceScope(user, spaceId, spaceKeys);
    if (!scope.valid) {
      return this.list('contentReportTable', [], limit, offset, {
        unresolvedSpaceKeys: scope.unresolved,
      });
    }
    const { pages, assignments, truncated } = await this.labelData(
      user,
      spaceId,
    );
    const selected = new Set(labels.map((label) => label.toLowerCase()));
    const rows = pages
      .filter((page) =>
        this.pageHasAnyLabel(assignments[page.id] ?? [], selected),
      )
      .sort(
        (left, right) =>
          Date.parse(right.updated_at ?? '') -
          Date.parse(left.updated_at ?? ''),
      );
    return this.list('contentReportTable', rows, limit, offset, {
      labels,
      spaceKeys,
      truncated,
    });
  }

  private async resolveNavigationMap(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const label = this.reportLabels([params.label], 'label', 1)[0];
    const title = this.optionalString(params.title, 'title', 200)?.trim();
    const wrapAfter = this.integer(params.wrapAfter, 'wrapAfter', 1, 8, 5);
    const cellWidth =
      this.optionalString(params.cellWidth, 'cellWidth', 16) ?? '90%';
    const { limit, offset } = this.pagination(params, 60, 60);
    if (!label) {
      return this.list('navigationMap', [], limit, offset, {
        missingLabel: true,
      });
    }
    if (!/^(?:[1-9]\d?|100)%$|^(?:1[2-9]\d|[2-4]\d{2})px$/.test(cellWidth)) {
      throw new BadRequestException('cellWidth is invalid');
    }
    const { pages, assignments, truncated } = await this.labelData(
      user,
      spaceId,
    );
    const selected = new Set([label.toLowerCase()]);
    const rows = pages
      .filter((page) =>
        this.pageHasAnyLabel(assignments[page.id] ?? [], selected),
      )
      .sort((left, right) =>
        String(left.title ?? '').localeCompare(String(right.title ?? '')),
      );
    return this.list('navigationMap', rows, limit, offset, {
      label,
      title: title ?? null,
      wrapAfter,
      cellWidth,
      truncated,
    });
  }

  private async resolveDecisionReport(
    user: RequestUser,
    spaceId: string,
    params: Params,
  ): Promise<WikiMacroResolution> {
    const { limit, offset } = this.pagination(params, 20, 100);
    const spaceKeys = this.stringArray(params.spaceKeys, 'spaceKeys', 20);
    let labels = this.reportLabels(params.labels, 'labels', 20);
    const cql = this.optionalString(params.cql, 'cql', 1000)?.trim();
    if (cql) {
      const match = /^label\s*=\s*"([^"\r\n]{1,100})"$/i.exec(cql);
      if (!match) {
        return this.list('decisionReport', [], limit, offset, {
          unsupportedCql: cql,
        });
      }
      labels = [
        ...new Set([...labels, this.reportLabels([match[1]], 'cql', 1)[0]]),
      ];
    }
    const scope = await this.currentSpaceScope(user, spaceId, spaceKeys);
    if (!scope.valid) {
      return this.list('decisionReport', [], limit, offset, {
        unresolvedSpaceKeys: scope.unresolved,
      });
    }

    const result = await this.visiblePages(user, spaceId);
    let candidates = result.pages;
    if (labels.length) {
      const assignments = await this.labelsService.getBulkPageLabels(
        candidates.map((page) => page.id),
      );
      const selected = new Set(labels.map((label) => label.toLowerCase()));
      candidates = candidates.filter((page) =>
        this.pageHasAnyLabel(
          (assignments[page.id] ?? []) as LabelAssignment[],
          selected,
        ),
      );
    }
    const pages = await this.repository.getDecisionPages(
      candidates.map((page) => page.id),
      100,
    );
    const rows = pages.flatMap((page) =>
      this.extractDecisions(page.content).map((decision) => ({
        pageId: page.id,
        pageTitle: page.title,
        ...decision,
      })),
    );
    return this.list('decisionReport', rows, limit, offset, {
      labels,
      spaceKeys,
      truncated: result.truncated || candidates.length > 100,
    });
  }

  private async visiblePages(
    user: RequestUser,
    spaceId: string,
  ): Promise<{ pages: Page[]; truncated: boolean }> {
    const result = await this.wikiService.getPages(
      spaceId,
      { is_archived: false, limit: PAGE_SCAN_CAP },
      user.userId,
    );
    return {
      pages: result.data as Page[],
      truncated: result.truncated === true || result.hasMore === true,
    };
  }

  private async labelData(
    user: RequestUser,
    spaceId: string,
  ): Promise<{
    pages: Page[];
    assignments: Record<string, LabelAssignment[]>;
    truncated: boolean;
  }> {
    const result = await this.visiblePages(user, spaceId);
    const assignments = (await this.labelsService.getBulkPageLabels(
      result.pages.map((page) => page.id),
    )) as Record<string, LabelAssignment[]>;
    return { ...result, assignments };
  }

  private reportLabels(
    value: unknown,
    name: string,
    maximum: number,
  ): string[] {
    const labels = this.stringArray(value, name, maximum).map((label) =>
      label.trim(),
    );
    if (
      labels.some(
        (label) => !label || [...label].some((char) => char.charCodeAt(0) < 32),
      )
    ) {
      throw new BadRequestException(`${name} contains an invalid label`);
    }
    return [
      ...new Map(labels.map((label) => [label.toLowerCase(), label])).values(),
    ];
  }

  private assignmentNames(assignments: LabelAssignment[]): string[] {
    return assignments.flatMap((assignment) => {
      const name = assignment.label?.name?.trim();
      return name ? [name] : [];
    });
  }

  private pageHasAnyLabel(
    assignments: LabelAssignment[],
    selected: Set<string>,
  ): boolean {
    return assignments.some((assignment) => {
      const name = assignment.label?.name?.trim().toLowerCase();
      return !!name && selected.has(name);
    });
  }

  private labelStats(
    pages: Page[],
    assignments: Record<string, LabelAssignment[]>,
  ): Array<{
    name: string;
    color: string | null;
    count: number;
    lastUsedAt: number;
  }> {
    const stats = new Map<
      string,
      { name: string; color: string | null; count: number; lastUsedAt: number }
    >();
    for (const page of pages) {
      for (const assignment of assignments[page.id] ?? []) {
        const name = assignment.label?.name?.trim();
        const key = name?.toLowerCase();
        if (!name || !key) continue;
        const current = stats.get(key);
        const assignedAt = Date.parse(assignment.assigned_at ?? '');
        const updatedAt = Date.parse(page.updated_at ?? '');
        stats.set(key, {
          name,
          color: assignment.label?.color ?? current?.color ?? null,
          count: (current?.count ?? 0) + 1,
          lastUsedAt: Math.max(
            current?.lastUsedAt ?? 0,
            Number.isFinite(assignedAt) ? assignedAt : 0,
            Number.isFinite(updatedAt) ? updatedAt : 0,
            0,
          ),
        });
      }
    }
    return [...stats.values()];
  }

  private async currentSpaceScope(
    user: RequestUser,
    spaceId: string,
    spaceKeys: string[],
  ): Promise<{ valid: boolean; unresolved: string[] }> {
    if (!spaceKeys.length) return { valid: true, unresolved: [] };
    const space = await this.repository.getSpace(spaceId, user.organizationId);
    const allowed = new Set([space.key.toLowerCase(), '@self', 'current']);
    const unresolved = spaceKeys.filter(
      (key) => !allowed.has(key.trim().toLowerCase()),
    );
    return { valid: unresolved.length === 0, unresolved };
  }

  private extractDecisions(
    raw: unknown,
  ): Array<{ decision: string; state: string }> {
    let root = raw;
    if (typeof raw === 'string') {
      try {
        root = JSON.parse(raw);
      } catch {
        return [];
      }
    }
    const rows: Array<{ decision: string; state: string }> = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const node = value as {
        type?: unknown;
        text?: unknown;
        attrs?: Record<string, unknown>;
        content?: unknown[];
      };
      if (node.type === 'decisionItem') {
        const text: string[] = [];
        const collect = (child: unknown): void => {
          if (!child || typeof child !== 'object' || Array.isArray(child))
            return;
          const item = child as { text?: unknown; content?: unknown[] };
          if (typeof item.text === 'string') text.push(item.text);
          for (const nested of item.content ?? []) collect(nested);
        };
        collect(node);
        const decision = text.join(' ').replace(/\s+/g, ' ').trim();
        if (decision) {
          rows.push({
            decision: decision.slice(0, 5000),
            state:
              typeof node.attrs?.state === 'string'
                ? node.attrs.state.slice(0, 50)
                : 'DECIDED',
          });
        }
        return;
      }
      for (const child of node.content ?? []) walk(child);
    };
    walk(root);
    return rows;
  }

  private async assertPage(
    user: RequestUser,
    spaceId: string,
    pageId: string,
  ): Promise<void> {
    await this.wikiPermissions.assertPageAccess(
      pageId,
      user.userId,
      spaceId,
      'can_view',
    );
  }

  private list<
    K extends Exclude<
      WikiMacroRequest['kind'],
      'spaceDetails' | 'userProfile' | 'profilePicture'
    >,
  >(
    kind: K,
    rows: unknown[],
    limit: number,
    offset: number,
    meta?: Record<string, unknown>,
  ): Extract<WikiMacroResolution, { kind: K }> {
    return {
      kind,
      data: rows.slice(offset, offset + limit),
      pagination: {
        limit,
        offset,
        total: rows.length,
        hasMore: offset + limit < rows.length,
      },
      ...(meta ? { meta } : {}),
    } as Extract<WikiMacroResolution, { kind: K }>;
  }

  private descendants(pages: Page[], rootId: string, depth: number): Page[] {
    const root = pages.find((page) => page.id === rootId);
    if (!root) return [];
    const result = [root];
    let parents = new Set([rootId]);
    for (let level = 0; level < depth; level += 1) {
      const children = pages.filter((page) =>
        page.parent_id ? parents.has(page.parent_id) : false,
      );
      if (!children.length) break;
      result.push(...children);
      parents = new Set(children.map((page) => page.id));
    }
    return result;
  }

  private params(value: unknown): Params {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('params must be an object');
    }
    return value as Params;
  }

  private exact(params: Params, allowed: readonly string[]): void {
    const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
    if (unknown.length) {
      throw new BadRequestException(`Unknown macro parameter: ${unknown[0]}`);
    }
  }

  private pagination(
    params: Params,
    fallback: number,
    maximum = 100,
  ): { limit: number; offset: number } {
    return {
      limit: this.integer(params.limit, 'limit', 1, maximum, fallback),
      offset: this.integer(params.offset, 'offset', 0, 10_000, 0),
    };
  }

  private uuid(value: unknown, name: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new BadRequestException(`${name} must be a UUID`);
    }
    return value;
  }

  private optionalUuid(value: unknown, name: string): string | undefined {
    return value === undefined || value === null || value === ''
      ? undefined
      : this.uuid(value, name);
  }

  private integer(
    value: unknown,
    name: string,
    minimum: number,
    maximum: number,
    fallback: number,
  ): number {
    if (value === undefined || value === null) return fallback;
    if (
      !Number.isInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum
    ) {
      throw new BadRequestException(
        `${name} must be an integer between ${minimum} and ${maximum}`,
      );
    }
    return Number(value);
  }

  private optionalString(
    value: unknown,
    name: string,
    maximum: number,
  ): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.length > maximum) {
      throw new BadRequestException(
        `${name} must be a string up to ${maximum} characters`,
      );
    }
    return value;
  }

  private optionalBoolean(value: unknown, name: string): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${name} must be a boolean`);
    }
    return value;
  }

  private stringArray(value: unknown, name: string, maximum: number): string[] {
    if (value === undefined || value === null) return [];
    if (
      !Array.isArray(value) ||
      value.length > maximum ||
      value.some(
        (item) =>
          typeof item !== 'string' || item.length < 1 || item.length > 100,
      )
    ) {
      throw new BadRequestException(
        `${name} must be an array of valid strings`,
      );
    }
    return value.filter((item): item is string => typeof item === 'string');
  }

  private oneOf<T extends readonly string[]>(
    value: unknown,
    name: string,
    allowed: T,
    fallback: T[number],
  ): T[number] {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new BadRequestException(`${name} is invalid`);
    }
    return value as T[number];
  }
}
