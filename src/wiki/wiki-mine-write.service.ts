/**
 * @fileoverview MCP-facing, space-membership + space-permission + page-ACL
 * constrained wiki WRITES backing the MCP `wiki.create` / `wiki.update` tools.
 *
 * Mirrors the task write wrapper (tasks-mine-write.service) and the wiki read
 * wrapper (wiki-mine.service): every "you cannot write here" case (non-member
 * space, missing space permission, page-ACL denial, cross-org, nonexistent /
 * archived page, inaccessible parent) collapses to the identical
 * NotFoundException('Wiki page not found') — anti-probing, never a 403, never
 * distinguishable. The org is ALWAYS taken from the authenticated RequestUser
 * (`user.organizationId`), never from a parameter, so the caller cannot cross
 * orgs, change a page's space, or move it.
 *
 * Two gates per operation (both must pass):
 *   1. space gate  — org admin/owner, OR active member holding the short
 *                    space-level permission (`create_wiki_pages` /
 *                    `edit_wiki_pages`) — the same keys SpacePermissionsGuard and
 *                    getUserSpacePermissions use.
 *   2. page ACL    — WikiPermissionsService.assertPageAccess (closed-by-default;
 *                    creator + space/org admin bypass). For create-under-parent
 *                    we assert `can_create` on the PARENT; for update we assert
 *                    `can_edit` on the page. A ForbiddenException from the ACL is
 *                    caught and converted to the uniform notFound().
 *
 * wiki_pages has no `version` column, so update uses a guarded `updated_at`
 * claim for optimistic locking. Content is sanitized HERE before delegating
 * (WikiService.create/updatePage store content verbatim — sanitization is
 * otherwise only applied on read), since MCP-submitted content is untrusted.
 * All domain logic (slug, path/level, audit, outbox, mention notifications) is
 * delegated to WikiService. NEVER accepted from the client: page permissions/ACL,
 * attachments, archive, slug/category/sort_order/metadata, parent/space move on
 * update.
 * @module src/wiki/wiki-mine-write.service
 * @author Prince Jadiya
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import { WikiService } from './wiki.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { WikiWorkflowService } from './wiki-workflow.service';
import type { CreateWikiPageDto } from './dto/create-wiki-page.dto';
import type { UpdateWikiPageDto } from './dto/update-wiki-page.dto';
import type { MineCreateWikiPageDto } from './dto/mine-create-wiki-page.dto';
import type { MineUpdateWikiPageDto } from './dto/mine-update-wiki-page.dto';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Short space-permission key gating wiki page creation in a space. */
const CREATE_WIKI_PAGES_PERMISSION = 'create_wiki_pages';

/** Short space-permission key gating wiki page edits in a space. */
const EDIT_WIKI_PAGES_PERMISSION = 'edit_wiki_pages';

/** A whitelisted space reference embedded in a safe wiki result. */
interface SafeSpaceRef {
  id: string;
  key: string;
  name: string;
}

/** The whitelisted, MCP-safe wiki page shape returned by create/update. */
export interface SafeWikiPage {
  id: string;
  title: string;
  space: SafeSpaceRef | null;
  parentId: string | null;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
}

/**
 * Robert's create (chat-agent executor): a reserved page id, so a retried Confirm adopts the page it
 * already made, and a TipTap document the agent renderer built, saved through the strict TipTap
 * validator instead of the HTML sanitizer (which would strip every macro). Never from a client.
 */
export interface TrustedWikiCreate {
  pageId: string;
  doc: Record<string, unknown>;
}

/** Org-scoped identity + lock columns for a resolved wiki page. */
interface WikiPageRef {
  id: string;
  space_id: string;
  updated_at: string;
  is_archived: boolean;
}

@Injectable()
export class WikiMineWriteService {
  private static readonly PAGES_TABLE = 'wiki_pages';
  private static readonly SPACES_TABLE = 'spaces';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly wikiService: WikiService,
    private readonly wikiPermissions: WikiPermissionsService,
    @Optional() private readonly wikiWorkflow?: WikiWorkflowService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Uniform 404 for every denial — anti-probing, never disambiguate. */
  private notFound(): NotFoundException {
    return new NotFoundException('Wiki page not found');
  }

  // The space gate shared by create + update. Allow iff the caller is an org
  // admin/owner, or is an active member of `spaceId` AND holds the short space
  // permission `permissionKey`. Every other case returns false; the caller
  // converts that to the uniform notFound().
  private async hasSpacePermission(
    user: RequestUser,
    spaceId: string,
    permissionKey: string,
  ): Promise<boolean> {
    if (!user.organizationId || !spaceId) {
      return false;
    }

    const isAdminOrOwner = await this.permissionsService.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );

    if (isAdminOrOwner) {
      return true;
    }

    const resolved = await this.permissionsService.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      spaceId,
    );

    return resolved.isMember && resolved.permissions[permissionKey] === true;
  }

  /** Resolve a space UUID or key to a space id, scoped to the org (or null). */
  private async resolveSpaceIdOrKey(
    spaceIdOrKey: string,
    organizationId: string,
  ): Promise<string | null> {
    const isUuid = UUID_RE.test(spaceIdOrKey);

    const result = await this.client
      .from(WikiMineWriteService.SPACES_TABLE)
      .select('id')
      .eq(
        isUuid ? 'id' : 'key',
        isUuid ? spaceIdOrKey : spaceIdOrKey.toUpperCase(),
      )
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .maybeSingle();

    if (result.error) return null;

    return (result.data as { id?: string } | null)?.id ?? null;
  }

  // Resolve the org-scoped wiki page (by UUID) to its identity + lock columns.
  // Returns null when missing / cross-org (caller maps to uniform notFound()).
  private async resolveWikiPageRef(
    pageId: string,
    organizationId: string,
  ): Promise<WikiPageRef | null> {
    if (!UUID_RE.test(pageId)) return null;

    const result = await this.client
      .from(WikiMineWriteService.PAGES_TABLE)
      .select('id, space_id, updated_at, is_archived')
      .eq('id', pageId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error || !result.data) return null;

    const row = result.data as {
      id: string;
      space_id: string;
      updated_at: string;
      is_archived: boolean | null;
    };

    return {
      id: row.id,
      space_id: row.space_id,
      updated_at: row.updated_at,
      is_archived: row.is_archived === true,
    };
  }

  // Verify a create-under-parent is allowed: the parent must exist in the SAME
  // space + org and not be archived, and the caller must hold `can_create` on it
  // (derived from can_edit). Every failure — including the ACL ForbiddenException
  // — collapses to the uniform notFound() so a parent's existence never leaks.
  private async assertParentCreatable(
    parentPageId: string,
    spaceId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    if (!UUID_RE.test(parentPageId)) throw this.notFound();

    const result = await this.client
      .from(WikiMineWriteService.PAGES_TABLE)
      .select('id, space_id, is_archived')
      .eq('id', parentPageId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const parent = result.data as {
      space_id?: string;
      is_archived?: boolean | null;
    } | null;

    if (result.error || !parent) throw this.notFound();
    if (parent.space_id !== spaceId) throw this.notFound();
    if (parent.is_archived === true) throw this.notFound();

    try {
      await this.wikiPermissions.assertPageAccess(
        parentPageId,
        userId,
        spaceId,
        'can_create',
      );
    } catch {
      throw this.notFound();
    }
  }

  // Map a freshly created/updated wiki page row to the SAFE output shape.
  // Resolves the space ref org-scoped; NEVER returns content / internal fields.
  private async toSafePage(
    raw: Record<string, unknown>,
    organizationId: string,
  ): Promise<SafeWikiPage> {
    const spaceId = (raw.space_id as string | null) ?? null;
    let space: SafeSpaceRef | null = null;

    if (spaceId) {
      const spaceRow = await this.client
        .from(WikiMineWriteService.SPACES_TABLE)
        .select('id, key, name')
        .eq('id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      const s = spaceRow.data as SafeSpaceRef | null;

      if (s) {
        space = { id: s.id, key: s.key, name: s.name };
      }
    }

    return {
      id: raw.id as string,
      title: (raw.title as string) ?? '',
      space,
      parentId: (raw.parent_id as string | null) ?? null,
      status: raw.is_published === true ? 'published' : 'draft',
      createdAt: (raw.created_at as string) ?? '',
      updatedAt: (raw.updated_at as string) ?? '',
    };
  }

  // Re-read a page org-scoped and project it to the SAFE shape (used after
  // create, where WikiService.createPage returns only id/title/is_published).
  private async loadSafePage(
    pageId: string,
    organizationId: string,
  ): Promise<SafeWikiPage> {
    const result = await this.client
      .from(WikiMineWriteService.PAGES_TABLE)
      .select(
        'id, title, space_id, parent_id, is_published, created_at, updated_at',
      )
      .eq('id', pageId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error || !result.data) throw this.notFound();

    return this.toSafePage(
      result.data as Record<string, unknown>,
      organizationId,
    );
  }

  /** Read the current updated_at for a page (org-scoped), for conflict reports. */
  private async readCurrentUpdatedAt(
    pageId: string,
    organizationId: string,
  ): Promise<string | null> {
    const result = await this.client
      .from(WikiMineWriteService.PAGES_TABLE)
      .select('updated_at')
      .eq('id', pageId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    return (result.data as { updated_at?: string } | null)?.updated_at ?? null;
  }

  // A space that requires review lets only its admins publish directly (the workflow's
  // can_publish_direct rule); anyone else gets a draft instead of skipping the review.
  async mayPublishDirectly(
    user: RequestUser,
    spaceId: string,
  ): Promise<boolean> {
    if (!this.wikiWorkflow) return true;
    const settings = await this.wikiWorkflow.getSettings(
      spaceId,
      user.organizationId,
    );
    if (!settings.require_approval) return true;
    const ctx = await this.wikiPermissions.resolveUserContext(
      user.userId,
      spaceId,
    );
    return ctx.isSpaceAdmin;
  }

  // Create a wiki page in a space the caller may write to. Resolves the space
  // org-scoped, gates on `create_wiki_pages`, verifies parent access when a
  // parentPageId is supplied, sanitizes the content, then delegates to
  // WikiService.createPage (slug/path/level, audit, outbox, mentions). Defaults
  // to a draft. Returns the SAFE shape.
  async createWikiPage(
    user: RequestUser,
    dto: MineCreateWikiPageDto,
    trusted?: TrustedWikiCreate,
  ): Promise<{ page: SafeWikiPage }> {
    if (!user.organizationId) {
      throw this.notFound();
    }

    const spaceId = await this.resolveSpaceIdOrKey(
      dto.spaceIdOrKey,
      user.organizationId,
    );

    if (!spaceId) {
      throw this.notFound();
    }

    if (
      !(await this.hasSpacePermission(
        user,
        spaceId,
        CREATE_WIKI_PAGES_PERMISSION,
      ))
    ) {
      throw this.notFound();
    }

    if (dto.parentPageId) {
      await this.assertParentCreatable(
        dto.parentPageId,
        spaceId,
        user.userId,
        user.organizationId,
      );
    }

    // MCP content is untrusted product data; sanitize before persisting (the
    // core service stores content verbatim) and store as HTML.
    // The wiki editor supports tables (unlike the inline task/comment editor) → opt in.
    // Robert's document is TipTap JSON; createPage validates it with the strict TipTap whitelist.
    const content = trusted
      ? JSON.stringify(trusted.doc)
      : (sanitizeRichText(dto.content, { allowTables: true }) ?? '');

    const createDto: CreateWikiPageDto = {
      space_id: spaceId,
      title: dto.title,
      content,
      content_format: trusted ? 'tiptap' : 'html',
      parent_id: dto.parentPageId,
      tags: dto.tags,
      is_published:
        dto.status === 'published' &&
        (await this.mayPublishDirectly(user, spaceId)),
    };

    const created = (await (trusted
      ? this.wikiService.createPage(
          createDto,
          user.organizationId,
          user.userId,
          {
            id: trusted.pageId,
          },
        )
      : this.wikiService.createPage(
          createDto,
          user.organizationId,
          user.userId,
        ))) as { id: string };

    const page = await this.loadSafePage(created.id, user.organizationId);

    return { page };
  }

  // Update whitelisted fields of a wiki page the caller may edit, under
  // optimistic locking. Resolves the page org-scoped, rejects archived pages,
  // gates on `edit_wiki_pages` + the page-level `can_edit` ACL, performs a
  // guarded `updated_at` claim (atomic — only the writer whose expectedUpdatedAt
  // still matches wins; a lost claim throws a ConflictException carrying ONLY the
  // current updatedAt), then delegates the field updates to WikiService.updatePage
  // (whose own updated_at bump becomes the final value we return). Space/parent
  // are never moved (the DTO omits those fields). Returns the SAFE shape.
  async updateWikiPage(
    user: RequestUser,
    pageId: string,
    dto: MineUpdateWikiPageDto,
  ): Promise<{ page: SafeWikiPage; updatedAt: string }> {
    if (!user.organizationId) {
      throw this.notFound();
    }

    const ref = await this.resolveWikiPageRef(pageId, user.organizationId);

    if (!ref) {
      throw this.notFound();
    }

    // Editing an archived page is not supported via MCP; uniform 404 so the
    // archived state is not distinguishable from "not found".
    if (ref.is_archived) {
      throw this.notFound();
    }

    if (
      !(await this.hasSpacePermission(
        user,
        ref.space_id,
        EDIT_WIKI_PAGES_PERMISSION,
      ))
    ) {
      throw this.notFound();
    }

    try {
      await this.wikiPermissions.assertPageAccess(
        pageId,
        user.userId,
        ref.space_id,
        'can_edit',
      );
    } catch {
      throw this.notFound();
    }

    // Guarded updated_at claim: atomically touch updated_at iff it still equals
    // the expected value. PostgREST casts the ISO string to timestamptz, so the
    // comparison is a semantic instant match (string-format variance is safe). A
    // no-row result means a concurrent writer moved on; surface ONLY the current
    // updated_at (nested under `data` so the global exception filter preserves
    // it). The legacy REST edit path has no optimistic lock, so a concurrent
    // legacy edit can still last-write-win — that is the app's existing behavior.
    const claim = await this.client
      .from(WikiMineWriteService.PAGES_TABLE)
      .update({ updated_at: new Date().toISOString() })
      .eq('id', pageId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', ref.space_id)
      .eq('updated_at', dto.expectedUpdatedAt)
      .select('id')
      .maybeSingle();

    if (claim.error || !claim.data) {
      const currentUpdatedAt = await this.readCurrentUpdatedAt(
        pageId,
        user.organizationId,
      );

      throw new ConflictException({
        message: 'Wiki page was modified concurrently',
        data: { currentUpdatedAt },
      });
    }

    const content =
      dto.content !== undefined
        ? (sanitizeRichText(dto.content, { allowTables: true }) ?? '')
        : undefined;

    const updateDto: UpdateWikiPageDto = {
      title: dto.title,
      content,
      content_format: content !== undefined ? 'html' : undefined,
      tags: dto.tags,
      is_published:
        dto.status === undefined ? undefined : dto.status === 'published',
    };

    const updated = await this.wikiService.updatePage(
      pageId,
      ref.space_id,
      updateDto,
      user.userId,
    );

    const page = await this.toSafePage(
      updated as Record<string, unknown>,
      user.organizationId,
    );

    return { page, updatedAt: page.updatedAt };
  }
}
