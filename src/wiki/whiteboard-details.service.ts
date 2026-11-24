/**
 * @fileoverview The whiteboard Details panel: owner, creator, last editor, dates, labels, stats,
 * and the two writes it offers (labels, ownership transfer).
 *
 * A board's owner, labels and Share ACL all live on its wiki link row (`wiki_pages.whiteboard_id`),
 * the same row the wiki tree, Share and Comments use; the canvas stays in `whiteboards`. Owner
 * follows the wiki rule: the row's `created_by` (Share's "owner", full access). `whiteboards.created_by`
 * stays the board's creator ("Created"). A board without a row yet reports its creator as owner,
 * and the first label or transfer creates the row (WikiService.ensureWhiteboardPage).
 *
 * Lives in WikiModule because it writes through the wiki services; WikiModule already imports
 * WhiteboardsModule, so no circular injection.
 * @module src/wiki/whiteboard-details.service
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { WhiteboardsService } from '../whiteboards/whiteboards.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiService } from './wiki.service';
import { WikiLabelsService } from './wiki-labels.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { WIKI_USER_COLUMNS, withFullName } from './wiki-user.util';

/** wiki_page_labels per page (SetPageLabelsDto's cap). */
export const WHITEBOARD_LABEL_LIMIT = 50;

type UserRef = ReturnType<typeof withFullName>;

export interface WhiteboardLabel {
  id: string;
  name: string;
  color: string;
}

export interface WhiteboardStats {
  element_count: number;
  scene_bytes: number;
  version_count: number;
  contributor_count: number;
  open_comment_count: number;
  resolved_comment_count: number;
}

export interface WhiteboardDetails {
  wiki_page_id: string | null;
  owner_id: string | null;
  owner: UserRef;
  created_by: string | null;
  created_by_user: UserRef;
  updated_by: string | null;
  updated_by_user: UserRef;
  created_at: string;
  updated_at: string;
  is_archived: boolean;
  labels: WhiteboardLabel[];
  /** Null when the counts could not be read; the panel shows "-" rather than a guess. */
  stats: WhiteboardStats | null;
}

type RuleRow = {
  entity_type: 'user' | 'role' | 'group';
  entity_id: string;
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
};

@Injectable()
export class WhiteboardDetailsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly boards: WhiteboardsService,
    private readonly wiki: WikiService,
    private readonly labels: WikiLabelsService,
    private readonly wikiPermissions: WikiPermissionsService,
    private readonly permissions: PermissionsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getDetails(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
  ): Promise<WhiteboardDetails> {
    await this.boards.assertAvailable(user.organizationId, spaceId);
    await this.boards.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_view',
    );

    const [board, link, stats] = await Promise.all([
      this.client
        .from('whiteboards')
        .select(
          `created_by, updated_by, created_at, updated_at, is_archived, created_by_user:users!created_by(${WIKI_USER_COLUMNS}), updated_by_user:users!updated_by(${WIKI_USER_COLUMNS})`,
        )
        .eq('id', whiteboardId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .maybeSingle(),
      this.client
        .from('wiki_pages')
        .select(
          `id, created_by, owner_user:users!created_by(${WIKI_USER_COLUMNS})`,
        )
        .eq('whiteboard_id', whiteboardId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .maybeSingle(),
      this.client.rpc('whiteboard_details_stats', {
        p_whiteboard_id: whiteboardId,
        p_space_id: spaceId,
        p_organization_id: user.organizationId,
      }) as unknown as Promise<{
        data: WhiteboardStats[] | null;
        error: { message: string } | null;
      }>,
    ]);

    if (board.error) throw new BadRequestException(board.error.message);
    if (!board.data) throw new NotFoundException('Whiteboard not found');
    if (link.error) throw new BadRequestException(link.error.message);

    const row = board.data as Record<string, unknown>;
    const linkRow = link.data as Record<string, unknown> | null;
    const linkId = (linkRow?.['id'] as string | undefined) ?? null;
    const createdBy = (row['created_by'] as string | null) ?? null;
    const createdByUser = withFullName(
      row['created_by_user'] as Record<string, unknown> | null,
    );

    return {
      wiki_page_id: linkId,
      owner_id: linkRow
        ? ((linkRow['created_by'] as string | null) ?? null)
        : createdBy,
      owner: linkRow
        ? withFullName(linkRow['owner_user'] as Record<string, unknown> | null)
        : createdByUser,
      created_by: createdBy,
      created_by_user: createdByUser,
      updated_by: (row['updated_by'] as string | null) ?? null,
      updated_by_user: withFullName(
        row['updated_by_user'] as Record<string, unknown> | null,
      ),
      created_at: row['created_at'] as string,
      updated_at: row['updated_at'] as string,
      is_archived: row['is_archived'] === true,
      labels: linkId ? await this.readLabels(linkId) : [],
      // A failed count is shown as unknown, never as 0
      stats: stats.error ? null : (stats.data?.[0] ?? null),
    };
  }

  /** The space's label catalogue (shared with wiki pages). */
  async listLabels(spaceId: string, user: RequestUser) {
    await this.boards.assertAvailable(user.organizationId, spaceId);

    return (await this.labels.getLabels(spaceId)) as WhiteboardLabel[];
  }

  /**
   * Replaces the board's labels. Needs board edit rights (space key + Share ACL); creates the
   * wiki row on first use. Archived boards are read-only.
   */
  async setLabels(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
    labelIds: string[],
  ): Promise<WhiteboardLabel[]> {
    await this.assertEditable(spaceId, user, whiteboardId);

    const unique = [...new Set(labelIds)];

    if (unique.length > WHITEBOARD_LABEL_LIMIT) {
      throw new BadRequestException(
        `A whiteboard can have at most ${WHITEBOARD_LABEL_LIMIT} labels`,
      );
    }

    const page = await this.ensurePage(spaceId, user, whiteboardId);

    // Also checks that every label belongs to this space
    await this.labels.setPageLabels(page.id, spaceId, { label_ids: unique });

    return this.readLabels(page.id);
  }

  /**
   * Creates a space label from the board, or returns the existing one with the same name
   * (case-insensitive), so "Design" and "design" never become two labels. Same right as the
   * wiki's label create route: create_wiki_pages, or the org key can_create_wiki_labels.
   */
  async createLabel(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
    name: string,
    color?: string,
  ): Promise<WhiteboardLabel> {
    await this.assertEditable(spaceId, user, whiteboardId);

    const trimmed = name.trim();

    if (!trimmed) throw new BadRequestException('Label name is required');

    const existing = (
      (await this.labels.getLabels(spaceId)) as WhiteboardLabel[]
    ).find((l) => l.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());

    if (existing) return existing;

    const canCreate =
      (await this.permissions.hasSpacePermission(
        user.userId,
        user.organizationId,
        spaceId,
        'create_wiki_pages',
      )) ||
      (await this.permissions.hasAnyPermission(
        user.userId,
        user.organizationId,
        ['can_create_wiki_labels'],
      ));

    if (!canCreate) {
      throw new ForbiddenException('You cannot create labels in this space');
    }

    return (await this.labels.createLabel(spaceId, {
      name: trimmed,
      ...(color ? { color } : {}),
    })) as WhiteboardLabel;
  }

  /**
   * Hands the board to another space member. Only the current owner, a space owner/admin or an
   * org admin. The new owner needs view_whiteboards in the space. The previous owner keeps edit
   * access: if the board has its own Share rules they get an explicit edit grant there; otherwise
   * their space rights (or the folder's rules) apply as for everyone else.
   */
  async transferOwner(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
    newOwnerId: string,
  ): Promise<WhiteboardDetails> {
    const details = await this.getDetails(spaceId, user, whiteboardId);
    const previousOwner = details.owner_id;

    if (
      previousOwner !== user.userId &&
      !(await this.isSpaceAdmin(user, spaceId))
    ) {
      throw new ForbiddenException(
        'Only the owner or an admin can change the owner',
      );
    }

    if (newOwnerId === previousOwner) return details;

    const eligible = await this.permissions.hasSpacePermission(
      newOwnerId,
      user.organizationId,
      spaceId,
      'view_whiteboards',
    );

    if (!eligible) {
      throw new BadRequestException(
        'The new owner must be a member of this space who can open whiteboards',
      );
    }

    const page = await this.ensurePage(spaceId, user, whiteboardId);

    // The board's own Share rules, read before the owner changes
    const { data: ownRules, error: rulesError } = await this.client
      .from('wiki_page_permissions')
      .select('entity_type, entity_id, can_view, can_edit, can_delete')
      .eq('wiki_page_id', page.id);

    if (rulesError) throw new BadRequestException(rulesError.message);

    const { error } = await this.client
      .from('wiki_pages')
      .update({ created_by: newOwnerId })
      .eq('id', page.id)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (error) throw new BadRequestException(error.message);

    const rules = (ownRules ?? []) as RuleRow[];

    if (rules.length > 0 && previousOwner) {
      const kept = rules.filter(
        (r) => !(r.entity_type === 'user' && r.entity_id === previousOwner),
      );

      // Through the wiki path: the new owner is added with full rights, the change is audited
      // and open wiki editors are told (permissions_changed).
      await this.wikiPermissions.setPagePermissions(
        page.id,
        spaceId,
        {
          permissions: [
            ...kept,
            {
              entity_type: 'user',
              entity_id: previousOwner,
              can_view: true,
              can_edit: true,
              can_delete: false,
            },
          ],
        },
        { userId: user.userId, organizationId: user.organizationId },
      );
    }

    void this.auditLogs.logActionForRequest(
      user,
      'whiteboard',
      whiteboardId,
      'update',
      { owner: { from: previousOwner, to: newOwnerId } },
    );

    return this.getDetails(spaceId, user, whiteboardId);
  }

  /**
   * The board's wiki row. A board without one gets it at the wiki root, which needs the same right
   * as the Share route that creates it (the space's create-page right), since it adds the board
   * to the wiki tree.
   */
  private async ensurePage(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
  ): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from('wiki_pages')
      .select('id')
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (data) return data as { id: string };

    await this.wikiPermissions.assertSpaceCanCreate(
      user.userId,
      spaceId,
      user.organizationId,
    );

    return this.wiki.ensureWhiteboardPage(spaceId, user, whiteboardId);
  }

  /** Org admin/owner, or owner/admin of this space. */
  private async isSpaceAdmin(
    user: RequestUser,
    spaceId: string,
  ): Promise<boolean> {
    const grant = await this.permissions.resolveSpaceBaseGrant(
      user.userId,
      user.organizationId,
      spaceId,
    );

    return (
      grant.isAdmin ||
      grant.spaceRole === 'owner' ||
      grant.spaceRole === 'admin'
    );
  }

  private async assertEditable(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
  ): Promise<void> {
    await this.boards.assertAvailable(user.organizationId, spaceId);
    await this.boards.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_edit',
    );

    const { data, error } = await this.client
      .from('whiteboards')
      .select('is_archived')
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Whiteboard not found');
    if ((data as { is_archived: boolean }).is_archived) {
      throw new ConflictException({
        code: 'WHITEBOARD_ARCHIVED',
        message: 'Whiteboard is archived',
      });
    }
  }

  private async readLabels(pageId: string): Promise<WhiteboardLabel[]> {
    const rows = (await this.labels.getPageLabels(pageId)) as {
      label?: WhiteboardLabel | null;
    }[];

    return rows
      .map((r) => r.label)
      .filter((l): l is WhiteboardLabel => Boolean(l));
  }
}
