/**
 * @fileoverview Wiki page comments — threaded reads, inline anchors
 * (TipTap comment marks), resolve/unresolve, and anchor orphan syncing.
 * Extracted from wiki.service as part of Wiki 2.0; the REST routes stay on
 * wiki.controller.
 * @module src/wiki/wiki-comments.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import { WikiService } from './wiki.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import type { CreateWikiCommentDto } from './dto/create-wiki-comment.dto';
import type { UpdateWikiCommentDto } from './dto/update-wiki-comment.dto';
import { WatchersService } from '../watchers/watchers.service';
import { WIKI_USER_COLUMNS, withFullName } from './wiki-user.util';
import { PermissionsService } from '../permissions/permissions.service';
import { WhiteboardLiveService } from '../whiteboards/whiteboard-live.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_JOIN = `*, created_by_user:users!created_by(${WIKI_USER_COLUMNS}), updated_by_user:users!updated_by(${WIKI_USER_COLUMNS})`;

/** Adds the display name the UI renders to both joined users. */
function withAuthorNames<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    created_by_user: withFullName(
      row['created_by_user'] as Record<string, unknown> | null,
    ),
    updated_by_user: withFullName(
      row['updated_by_user'] as Record<string, unknown> | null,
    ),
  };
}

interface CommentRow {
  id: string;
  wiki_page_id: string;
  parent_id: string | null;
  content: string;
  anchor: Record<string, unknown> | null;
  anchor_status: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_by: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** Validated inline-comment anchor. */
interface CommentAnchor {
  type: 'text-range';
  threadId: string;
  quotedText: string;
  blockId?: string;
}

/**
 * Validated whiteboard pin: scene coordinates, optionally attached to an Excalidraw element
 * (`dx`/`dy` = offset from the element's x/y, so the pin follows it when it moves).
 */
interface CanvasAnchor {
  type: 'canvas';
  threadId: string;
  x: number;
  y: number;
  elementId?: string;
  dx?: number;
  dy?: number;
}

/** Far beyond any real board, small enough that nothing overflows when it is rendered. */
const MAX_SCENE_COORD = 10_000_000;
const ELEMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

@Injectable()
export class WikiCommentsService {
  private static readonly COMMENTS = 'wiki_page_comments';
  private static readonly READS = 'wiki_page_comment_reads';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly wikiService: WikiService,
    private readonly wikiPermissions: WikiPermissionsService,
    @Optional()
    @Inject(forwardRef(() => WatchersService))
    private readonly watchersService?: WatchersService,
    @Optional()
    private readonly permissions?: PermissionsService,
    @Optional()
    @Inject(forwardRef(() => WhiteboardLiveService))
    private readonly live?: WhiteboardLiveService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** On a whiteboard link row: tell the board's viewers to refetch its comments (fire-and-forget). */
  private pingBoard(page: Record<string, unknown>): void {
    const whiteboardId = page['whiteboard_id'] as string | null | undefined;

    if (whiteboardId)
      void this.live?.broadcast(whiteboardId, 'comments_changed');
  }

  /**
   * Page ∈ space guard, plus the board's own rules when the page is a whiteboard link row:
   * its comments follow the board, so they need the Whiteboards view right (the route only
   * checks the wiki keys), and an archived board takes no new writes.
   */
  private async loadPage(
    pageId: string,
    spaceId: string,
    userId: string,
    write: boolean,
  ): Promise<Record<string, unknown>> {
    const page = (await this.wikiService.getPageById(
      pageId,
      spaceId,
    )) as Record<string, unknown>;
    const whiteboardId = page['whiteboard_id'] as string | null | undefined;

    if (!whiteboardId) return page;

    // Fail closed: without the permissions service the right cannot be checked.
    const canView = await this.permissions?.hasSpacePermission(
      userId,
      (page['organization_id'] as string) ?? '',
      spaceId,
      'view_whiteboards',
    );

    if (!canView) {
      throw new ForbiddenException('You do not have access to this whiteboard');
    }

    if (write) {
      const { data, error } = await this.client
        .from('whiteboards')
        .select('is_archived')
        .eq('id', whiteboardId)
        .eq('space_id', spaceId)
        .maybeSingle();
      if (error) throw new BadRequestException(error.message);

      if ((data as { is_archived?: boolean } | null)?.is_archived) {
        throw new BadRequestException(
          'Cannot comment on an archived whiteboard',
        );
      }
    }

    return page;
  }

  /**
   * Page creator, space admin or org admin (WikiPermissionsService.isCreatorOrAdmin), and on a
   * whiteboard also the board's creator: its link row is created by whoever shared it first.
   */
  private async canManage(
    page: Record<string, unknown>,
    pageId: string,
    userId: string,
    spaceId: string,
  ): Promise<boolean> {
    if (await this.wikiPermissions.isCreatorOrAdmin(pageId, userId, spaceId)) {
      return true;
    }

    const whiteboardId = page['whiteboard_id'] as string | null | undefined;

    if (!whiteboardId) return false;

    const { data, error } = await this.client
      .from('whiteboards')
      .select('created_by')
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);

    return (
      (data as { created_by?: string | null } | null)?.created_by === userId
    );
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Flat comment list (legacy shape, oldest first). */
  async getComments(
    pageId: string,
    spaceId: string,
    userId: string,
  ): Promise<unknown[]> {
    await this.loadPage(pageId, spaceId, userId, false);

    const { data, error } = await this.client
      .from(WikiCommentsService.COMMENTS)
      .select(USER_JOIN)
      .eq('wiki_page_id', pageId)
      .order('created_at', { ascending: true });
    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as Record<string, unknown>[]).map(withAuthorNames);
  }

  /**
   * Threaded comment tree. One query; the tree is assembled in memory by
   * parent_id, roots ordered oldest-first with their `replies[]` inline.
   *
   * Filters apply to ROOT comments only:
   *  - resolved: true → only resolved roots; false → only unresolved roots
   *  - inline:  true → only roots carrying an anchor
   */
  async getThreaded(
    pageId: string,
    spaceId: string,
    filters: { resolved?: boolean; inline?: boolean },
    userId: string,
  ): Promise<unknown[]> {
    await this.loadPage(pageId, spaceId, userId, false);

    const { data, error } = await this.client
      .from(WikiCommentsService.COMMENTS)
      .select(USER_JOIN)
      .eq('wiki_page_id', pageId)
      .order('created_at', { ascending: true });
    if (error) throw new BadRequestException(error.message);

    const rows = ((data ?? []) as CommentRow[]).map(withAuthorNames);
    const byId = new Map<string, CommentRow & { replies: CommentRow[] }>();

    for (const row of rows) {
      byId.set(row.id, { ...row, replies: [] });
    }

    const roots: (CommentRow & { replies: CommentRow[] })[] = [];

    for (const row of rows) {
      const node = byId.get(row.id)!;

      if (row.parent_id && byId.has(row.parent_id)) {
        byId.get(row.parent_id)!.replies.push(node);
      } else {
        roots.push(node);
      }
    }

    const shown = roots.filter((root) => {
      if (filters.resolved === true && root.resolved_at === null) return false;
      if (filters.resolved === false && root.resolved_at !== null) return false;
      if (filters.inline === true && root.anchor === null) return false;

      return true;
    });

    // The caller's read receipt per thread (null = never opened): the board's unread pins.
    const receipts = new Map<
      string,
      { read_at: string; marked_unread: boolean }
    >();

    if (shown.length) {
      const reads = await this.client
        .from(WikiCommentsService.READS)
        .select('comment_id, read_at, marked_unread')
        .eq('user_id', userId)
        .in(
          'comment_id',
          shown.map((root) => root.id),
        );
      if (reads.error) throw new BadRequestException(reads.error.message);

      for (const r of (reads.data ?? []) as {
        comment_id: string;
        read_at: string;
        marked_unread: boolean;
      }[])
        receipts.set(r.comment_id, r);
    }

    return shown.map((root) => ({
      ...root,
      read_at: receipts.get(root.id)?.read_at ?? null,
      marked_unread: receipts.get(root.id)?.marked_unread ?? false,
    }));
  }

  /**
   * The caller's read state of one thread (its root comment), for them only. Read: read now and
   * not marked unread. Unread ("Mark as unread"): flagged, read_at kept. Read access suffices.
   */
  async setReadState(
    pageId: string,
    commentId: string,
    spaceId: string,
    userId: string,
    unread: boolean,
  ): Promise<{ read_at: string | null; marked_unread: boolean }> {
    const page = await this.loadPage(pageId, spaceId, userId, false);

    const cv = await this.client
      .from(WikiCommentsService.COMMENTS)
      .select('parent_id')
      .eq('id', commentId)
      .eq('wiki_page_id', pageId)
      .maybeSingle();
    if (!cv.data) throw new NotFoundException('Comment not found');

    if ((cv.data as { parent_id: string | null }).parent_id !== null) {
      throw new BadRequestException(
        'Only root comments can be marked read or unread',
      );
    }

    // Unread leaves read_at out: a new row takes the default, an existing one keeps its time.
    const read_at = unread ? null : new Date().toISOString();
    const up = await this.client.from(WikiCommentsService.READS).upsert(
      {
        comment_id: commentId,
        user_id: userId,
        marked_unread: unread,
        ...(read_at ? { read_at } : {}),
      },
      { onConflict: 'comment_id,user_id' },
    );
    if (up.error) throw new BadRequestException(up.error.message);
    this.pingBoard(page);

    return { read_at, marked_unread: unread };
  }

  /** Marks every thread on the page read for the caller ("Mark all as read"). */
  async markAllRead(
    pageId: string,
    spaceId: string,
    userId: string,
  ): Promise<{ read_at: string; count: number }> {
    const page = await this.loadPage(pageId, spaceId, userId, false);

    const roots = await this.client
      .from(WikiCommentsService.COMMENTS)
      .select('id')
      .eq('wiki_page_id', pageId)
      .is('parent_id', null);
    if (roots.error) throw new BadRequestException(roots.error.message);

    const read_at = new Date().toISOString();
    const rows = ((roots.data ?? []) as { id: string }[]).map((r) => ({
      comment_id: r.id,
      user_id: userId,
      read_at,
      marked_unread: false,
    }));

    if (rows.length) {
      const up = await this.client
        .from(WikiCommentsService.READS)
        .upsert(rows, { onConflict: 'comment_id,user_id' });
      if (up.error) throw new BadRequestException(up.error.message);
      this.pingBoard(page);
    }

    return { read_at, count: rows.length };
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Creates a comment (optionally threaded under a parent on the same page,
   * optionally anchored to an inline text range). Content is HTML-sanitized;
   * mention notifications reuse the wiki mention pipeline.
   */
  async createComment(
    pageId: string,
    spaceId: string,
    dto: CreateWikiCommentDto,
    userId: string,
  ): Promise<unknown> {
    const page = await this.loadPage(pageId, spaceId, userId, true);

    if (page['is_archived']) {
      throw new BadRequestException('Cannot comment on an archived page');
    }

    if (dto.parent_id) {
      const parentRes = await this.client
        .from(WikiCommentsService.COMMENTS)
        .select('id, parent_id')
        .eq('id', dto.parent_id)
        .eq('wiki_page_id', pageId)
        .maybeSingle();

      if (!parentRes.data) {
        throw new BadRequestException('Parent comment not found on this page');
      }
    }

    // Replies inherit the thread from their root — anchors are root-only.
    if (dto.anchor && dto.parent_id) {
      throw new BadRequestException(
        'Only root comments may carry an inline anchor',
      );
    }

    const anchor = dto.anchor
      ? this.validateAnchor(dto.anchor, Boolean(page['whiteboard_id']))
      : null;
    const content = sanitizeRichText(dto.content) ?? '';

    const ci = await this.client
      .from(WikiCommentsService.COMMENTS)
      .insert({
        wiki_page_id: pageId,
        content,
        parent_id: dto.parent_id ?? null,
        anchor,
        // `anchor_status` is NOT NULL DEFAULT 'active', so writing an explicit null for a comment
        // with NO anchor made every plain (non-inline) comment fail the insert with a not-null
        // violation. Omitting the key lets the column default apply. Safe for anchor-less rows:
        // `syncAnchors` only considers rows filtered by `.not('anchor', 'is', null)`, so it never
        // reads or flips this value for them.
        ...(anchor ? { anchor_status: 'active' } : {}),
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single();
    if (ci.error) throw new BadRequestException(ci.error.message);

    if (content) {
      void this.wikiService.notifyMentionedUsers(
        content,
        'wiki_comment',
        (ci.data as { id: string }).id,
        pageId,
        (page['title'] as string) ?? '',
        (page['organization_id'] as string) ?? '',
        userId,
        spaceId,
      );
    }
    void this.watchersService?.notifyWikiWatchers({
      organizationId: (page['organization_id'] as string) ?? '',
      spaceId,
      pageId,
      actorUserId: userId,
      title: (page['title'] as string) ?? '',
      changeKind: 'comment_added',
    });
    this.pingBoard(page);

    return ci.data as unknown;
  }

  /** Updates a comment (author only). Content is HTML-sanitized. */
  async updateComment(
    pageId: string,
    commentId: string,
    spaceId: string,
    dto: UpdateWikiCommentDto,
    userId: string,
  ): Promise<unknown> {
    const page = await this.loadPage(pageId, spaceId, userId, true);

    const cv = await this.client
      .from(WikiCommentsService.COMMENTS)
      .select('created_by, content')
      .eq('id', commentId)
      .eq('wiki_page_id', pageId)
      .maybeSingle();
    if (!cv.data) throw new NotFoundException('Comment not found');
    const c = cv.data as Record<string, unknown>;

    if (c['created_by'] !== userId) {
      throw new ForbiddenException(
        'Only the comment author can edit this comment',
      );
    }

    const content = sanitizeRichText(dto.content) ?? '';

    const cu = await this.client
      .from(WikiCommentsService.COMMENTS)
      .update({
        content,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', commentId)
      .eq('wiki_page_id', pageId)
      .select()
      .single();
    if (cu.error) throw new BadRequestException(cu.error.message);

    if (content) {
      void this.wikiService.notifyMentionedUsers(
        content,
        'wiki_comment',
        commentId,
        pageId,
        (page['title'] as string) ?? '',
        (page['organization_id'] as string) ?? '',
        userId,
        spaceId,
        (c['content'] as string | null | undefined) ?? null,
      );
    }

    this.pingBoard(page);

    return cu.data as unknown;
  }

  /** Deletes a comment: author, page creator, or space admin. */
  async deleteComment(
    pageId: string,
    commentId: string,
    spaceId: string,
    userId: string,
  ): Promise<void> {
    const page = await this.loadPage(pageId, spaceId, userId, true);

    const dc = await this.client
      .from(WikiCommentsService.COMMENTS)
      .select('created_by')
      .eq('id', commentId)
      .eq('wiki_page_id', pageId)
      .maybeSingle();
    if (!dc.data) throw new NotFoundException('Comment not found');
    const c = dc.data as Record<string, unknown>;

    if (c['created_by'] !== userId) {
      const canManage = await this.canManage(page, pageId, userId, spaceId);

      if (!canManage) {
        throw new ForbiddenException(
          'Only the comment author, page creator, or a space admin can delete this comment',
        );
      }
    }

    const { error } = await this.client
      .from(WikiCommentsService.COMMENTS)
      .delete()
      .eq('id', commentId)
      .eq('wiki_page_id', pageId);
    if (error) throw new BadRequestException(error.message);
    this.pingBoard(page);
  }

  /**
   * Resolves or unresolves a ROOT comment thread. Allowed for the comment
   * author, a space admin, or anyone holding can_edit on the page.
   */
  async setResolved(
    pageId: string,
    commentId: string,
    spaceId: string,
    userId: string,
    resolved: boolean,
  ): Promise<unknown> {
    const page = await this.loadPage(pageId, spaceId, userId, true);

    const cv = await this.client
      .from(WikiCommentsService.COMMENTS)
      .select('created_by, parent_id')
      .eq('id', commentId)
      .eq('wiki_page_id', pageId)
      .maybeSingle();
    if (!cv.data) throw new NotFoundException('Comment not found');
    const c = cv.data as Record<string, unknown>;

    if (c['parent_id'] !== null) {
      throw new BadRequestException(
        'Only root comments can be resolved or unresolved',
      );
    }

    if (c['created_by'] !== userId) {
      const perm = await this.wikiPermissions.getEffectivePermission(
        userId,
        pageId,
        spaceId,
      );

      if (!perm.can_edit) {
        const isAdmin = await this.canManage(page, pageId, userId, spaceId);

        if (!isAdmin) {
          throw new ForbiddenException(
            'Only the author, a space admin, or a page editor can resolve comments',
          );
        }
      }
    }

    const cu = await this.client
      .from(WikiCommentsService.COMMENTS)
      .update({
        resolved_at: resolved ? new Date().toISOString() : null,
        resolved_by: resolved ? userId : null,
      })
      .eq('id', commentId)
      .eq('wiki_page_id', pageId)
      .select()
      .single();
    if (cu.error) throw new BadRequestException(cu.error.message);

    this.pingBoard(page);

    return cu.data as unknown;
  }

  // ── Anchor sync ───────────────────────────────────────────────────────────

  /**
   * Reconciles inline anchors against the live TipTap comment-mark thread ids:
   * roots whose `anchor.threadId` disappeared from the document flip to
   * 'orphaned'; reappearing threads flip back to 'active'. Best-effort — the
   * caller (collab save / updatePage) invokes this fire-and-forget.
   */
  async syncAnchors(pageId: string, liveThreadIds: string[]): Promise<void> {
    const { data, error } = await this.client
      .from(WikiCommentsService.COMMENTS)
      .select('id, anchor, anchor_status')
      .eq('wiki_page_id', pageId)
      .is('parent_id', null)
      .not('anchor', 'is', null);
    if (error) throw new BadRequestException(error.message);

    const live = new Set(liveThreadIds);
    const toOrphan: string[] = [];
    const toActivate: string[] = [];

    for (const row of (data ?? []) as CommentRow[]) {
      const anchor = row.anchor as { type?: string; threadId?: string } | null;
      const threadId = anchor?.threadId;

      // Whiteboard pins have no TipTap mark; only text ranges can be orphaned here.
      if (!threadId || anchor?.type === 'canvas') continue;

      if (live.has(threadId)) {
        if (row.anchor_status !== 'active') toActivate.push(row.id);
      } else if (row.anchor_status !== 'orphaned') {
        toOrphan.push(row.id);
      }
    }

    if (toOrphan.length > 0) {
      await this.client
        .from(WikiCommentsService.COMMENTS)
        .update({ anchor_status: 'orphaned' })
        .eq('wiki_page_id', pageId)
        .in('id', toOrphan);
    }
    if (toActivate.length > 0) {
      await this.client
        .from(WikiCommentsService.COMMENTS)
        .update({ anchor_status: 'active' })
        .eq('wiki_page_id', pageId)
        .in('id', toActivate);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Validates the anchor shape (rejects anything unexpected). Pins only on whiteboard rows. */
  private validateAnchor(
    raw: Record<string, unknown>,
    isBoard: boolean,
  ): CommentAnchor | CanvasAnchor {
    if (raw['type'] === 'canvas') {
      if (!isBoard) {
        throw new BadRequestException(
          'Canvas anchors are only allowed on whiteboards',
        );
      }

      return this.validateCanvasAnchor(raw);
    }

    // A whiteboard has no text to anchor to: only pins (or no anchor) there.
    if (isBoard) {
      throw new BadRequestException(
        "anchor.type must be 'canvas' on a whiteboard",
      );
    }

    if (raw['type'] !== 'text-range') {
      throw new BadRequestException(
        "anchor.type must be 'text-range' or 'canvas'",
      );
    }

    const threadId = raw['threadId'];

    if (typeof threadId !== 'string' || !UUID_RE.test(threadId)) {
      throw new BadRequestException('anchor.threadId must be a UUID');
    }

    const quotedText = raw['quotedText'];

    if (typeof quotedText !== 'string' || quotedText.length > 500) {
      throw new BadRequestException(
        'anchor.quotedText must be a string of at most 500 chars',
      );
    }

    const blockId = raw['blockId'];

    if (
      blockId !== undefined &&
      (typeof blockId !== 'string' || blockId.length > 200)
    ) {
      throw new BadRequestException('anchor.blockId must be a short string');
    }

    const anchor: CommentAnchor = {
      type: 'text-range',
      threadId: threadId.toLowerCase(),
      quotedText,
    };

    if (typeof blockId === 'string') anchor.blockId = blockId;

    return anchor;
  }

  private validateCanvasAnchor(raw: Record<string, unknown>): CanvasAnchor {
    const threadId = raw['threadId'];

    if (typeof threadId !== 'string' || !UUID_RE.test(threadId)) {
      throw new BadRequestException('anchor.threadId must be a UUID');
    }

    const coord = (key: string, required: boolean): number | undefined => {
      const value = raw[key];

      if (value === undefined && !required) return undefined;

      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        Math.abs(value) > MAX_SCENE_COORD
      ) {
        throw new BadRequestException(`anchor.${key} must be a finite number`);
      }

      return value;
    };

    const anchor: CanvasAnchor = {
      type: 'canvas',
      threadId: threadId.toLowerCase(),
      x: coord('x', true)!,
      y: coord('y', true)!,
    };
    const elementId = raw['elementId'];

    if (elementId !== undefined) {
      if (typeof elementId !== 'string' || !ELEMENT_ID_RE.test(elementId)) {
        throw new BadRequestException('anchor.elementId must be a short id');
      }

      anchor.elementId = elementId;
      anchor.dx = coord('dx', true);
      anchor.dy = coord('dy', true);
    }

    return anchor;
  }
}
