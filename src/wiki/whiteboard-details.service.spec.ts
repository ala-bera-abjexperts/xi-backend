/**
 * @fileoverview WhiteboardDetailsService — who may change labels and the owner, and what a
 * transfer does to the board's wiki row and Share rules.
 * @module src/wiki/whiteboard-details.service.spec
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import { WhiteboardDetailsService } from './whiteboard-details.service';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { WhiteboardsService } from '../whiteboards/whiteboards.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { WikiService } from './wiki.service';
import type { WikiLabelsService } from './wiki-labels.service';
import type { WikiPermissionsService } from './wiki-permissions.service';

const SPACE = 'space-1';
const BOARD = 'board-1';
const PAGE = 'page-1';
const OWNER = 'u-owner';
const OTHER = 'u-other';
const NEXT = 'u-next';
const me = (userId: string) =>
  ({ userId, organizationId: 'org-1' }) as RequestUser;

/** Thenable query chain resolving to `result`; records updates. */
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  const self = () => c;

  for (const m of ['select', 'eq', 'in', 'update']) c[m] = jest.fn(self);
  c.maybeSingle = jest.fn(() => Promise.resolve(result));
  c.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);

  return c as Record<string, jest.Mock>;
}

describe('WhiteboardDetailsService', () => {
  let tables: Record<string, Record<string, jest.Mock>[]>;
  let boards: Record<string, jest.Mock>;
  let wiki: Record<string, jest.Mock>;
  let labels: Record<string, jest.Mock>;
  let wikiPermissions: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let service: WhiteboardDetailsService;

  const queue = (table: string, data: unknown, error: unknown = null) => {
    const c = chain({ data, error });

    (tables[table] ??= []).push(c);

    return c;
  };

  /** The reads getDetails makes, for a board whose wiki row (if any) is owned by `owner`. */
  const queueDetails = (owner: string | null = OWNER) => {
    queue('whiteboards', {
      created_by: OWNER,
      updated_by: OWNER,
      created_at: '2026-09-25T10:00:00Z',
      updated_at: '2026-10-02T10:00:00Z',
      is_archived: false,
      created_by_user: { id: OWNER, first_name: 'Kim', last_name: 'Chen' },
      updated_by_user: null,
    });
    queue('wiki_pages', owner ? { id: PAGE, created_by: owner } : null);
  };

  beforeEach(() => {
    tables = {};
    boards = {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      assertBoardAccess: jest.fn().mockResolvedValue(undefined),
    };
    wiki = { ensureWhiteboardPage: jest.fn().mockResolvedValue({ id: PAGE }) };
    labels = {
      getLabels: jest
        .fn()
        .mockResolvedValue([{ id: 'l-1', name: 'Design', color: '#111111' }]),
      getPageLabels: jest.fn().mockResolvedValue([]),
      setPageLabels: jest.fn().mockResolvedValue([]),
      createLabel: jest
        .fn()
        .mockImplementation((_s: string, dto: { name: string }) =>
          Promise.resolve({ id: 'l-new', name: dto.name, color: '#6366f1' }),
        ),
    };
    wikiPermissions = {
      setPagePermissions: jest.fn().mockResolvedValue([]),
      assertSpaceCanCreate: jest.fn().mockResolvedValue(undefined),
    };
    permissions = {
      hasSpacePermission: jest.fn().mockResolvedValue(true),
      hasAnyPermission: jest.fn().mockResolvedValue(false),
      resolveSpaceBaseGrant: jest.fn().mockResolvedValue({
        isAdmin: false,
        isMember: true,
        spaceRole: 'member',
      }),
    };
    audit = { logActionForRequest: jest.fn().mockResolvedValue(undefined) };

    const supabase = {
      getClient: () => ({
        from: (table: string) => {
          const next = tables[table]?.shift();

          if (!next) throw new Error(`unexpected query on ${table}`);

          return next;
        },
        rpc: jest.fn().mockResolvedValue({
          data: [
            {
              element_count: 3,
              scene_bytes: 900,
              version_count: 2,
              contributor_count: 1,
              open_comment_count: 1,
              resolved_comment_count: 0,
            },
          ],
          error: null,
        }),
      }),
    } as unknown as SupabaseAdminService;

    service = new WhiteboardDetailsService(
      supabase,
      boards as unknown as WhiteboardsService,
      wiki as unknown as WikiService,
      labels as unknown as WikiLabelsService,
      wikiPermissions as unknown as WikiPermissionsService,
      permissions as unknown as PermissionsService,
      audit as unknown as AuditLogsService,
    );
  });

  describe('details', () => {
    it('reports the wiki row creator as owner and the board creator as creator', async () => {
      queueDetails(OTHER);

      const details = await service.getDetails(SPACE, me(OWNER), BOARD);

      expect(details).toMatchObject({
        wiki_page_id: PAGE,
        owner_id: OTHER,
        created_by: OWNER,
        created_by_user: { full_name: 'Kim Chen' },
        stats: { element_count: 3, open_comment_count: 1 },
      });
      expect(boards.assertBoardAccess).toHaveBeenCalledWith(
        SPACE,
        OWNER,
        BOARD,
        'can_view',
      );
    });

    it('falls back to the board creator as owner before the board has a wiki row', async () => {
      queueDetails(null);

      await expect(
        service.getDetails(SPACE, me(OWNER), BOARD),
      ).resolves.toMatchObject({
        wiki_page_id: null,
        owner_id: OWNER,
        labels: [],
      });
    });
  });

  describe('labels', () => {
    it('requires board edit rights (Share ACL) to change labels', async () => {
      boards.assertBoardAccess.mockRejectedValue(new ForbiddenException());

      await expect(
        service.setLabels(SPACE, me(OTHER), BOARD, ['l-1']),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(labels.setPageLabels).not.toHaveBeenCalled();
    });

    it('refuses label changes on an archived board', async () => {
      queue('whiteboards', { is_archived: true });

      await expect(
        service.setLabels(SPACE, me(OWNER), BOARD, ['l-1']),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('de-duplicates ids and writes them on the existing wiki row', async () => {
      queue('whiteboards', { is_archived: false });
      queue('wiki_pages', { id: PAGE });

      await service.setLabels(SPACE, me(OWNER), BOARD, ['l-1', 'l-1']);

      expect(labels.setPageLabels).toHaveBeenCalledWith(PAGE, SPACE, {
        label_ids: ['l-1'],
      });
      expect(wiki.ensureWhiteboardPage).not.toHaveBeenCalled();
    });

    it('creates the wiki row on first label only with the create-page right', async () => {
      queue('whiteboards', { is_archived: false });
      queue('wiki_pages', null);
      wikiPermissions.assertSpaceCanCreate.mockRejectedValue(
        new ForbiddenException(),
      );

      await expect(
        service.setLabels(SPACE, me(OWNER), BOARD, ['l-1']),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(wiki.ensureWhiteboardPage).not.toHaveBeenCalled();
    });

    it('rejects more labels than a page can hold', async () => {
      queue('whiteboards', { is_archived: false });
      const ids = Array.from({ length: 51 }, (_, i) => `l-${i}`);

      await expect(
        service.setLabels(SPACE, me(OWNER), BOARD, ids),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns the existing label for a name that differs only in case', async () => {
      queue('whiteboards', { is_archived: false });

      await expect(
        service.createLabel(SPACE, me(OWNER), BOARD, '  design '),
      ).resolves.toMatchObject({ id: 'l-1' });
      expect(labels.createLabel).not.toHaveBeenCalled();
    });

    it('creates a new label with the wiki create right, trimmed (Unicode kept)', async () => {
      queue('whiteboards', { is_archived: false });

      await expect(
        service.createLabel(SPACE, me(OWNER), BOARD, ' Ünïcode 🚀 '),
      ).resolves.toMatchObject({ name: 'Ünïcode 🚀' });
    });

    it('refuses a new label without the wiki create right or the org label key', async () => {
      queue('whiteboards', { is_archived: false });
      permissions.hasSpacePermission.mockResolvedValue(false);

      await expect(
        service.createLabel(SPACE, me(OTHER), BOARD, 'Roadmap'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(labels.createLabel).not.toHaveBeenCalled();
    });

    it('accepts the org key can_create_wiki_labels instead of the space right', async () => {
      queue('whiteboards', { is_archived: false });
      permissions.hasSpacePermission.mockResolvedValue(false);
      permissions.hasAnyPermission.mockResolvedValue(true);

      await expect(
        service.createLabel(SPACE, me(OTHER), BOARD, 'Roadmap'),
      ).resolves.toMatchObject({ id: 'l-new' });
    });
  });

  describe('ownership transfer', () => {
    it('refuses a caller who is neither owner nor admin', async () => {
      queueDetails(OWNER);

      await expect(
        service.transferOwner(SPACE, me(OTHER), BOARD, NEXT),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(wiki.ensureWhiteboardPage).not.toHaveBeenCalled();
    });

    it("lets a space admin transfer someone else's board", async () => {
      queueDetails(OWNER);
      permissions.resolveSpaceBaseGrant.mockResolvedValue({
        isAdmin: false,
        isMember: true,
        spaceRole: 'admin',
      });
      queue('wiki_pages', { id: PAGE });
      queue('wiki_page_permissions', []);
      const update = queue('wiki_pages', null);
      queueDetails(NEXT);

      await expect(
        service.transferOwner(SPACE, me(OTHER), BOARD, NEXT),
      ).resolves.toMatchObject({ owner_id: NEXT });
      expect(update.update).toHaveBeenCalledWith({ created_by: NEXT });
    });

    it('refuses a new owner without whiteboard access in the space', async () => {
      queueDetails(OWNER);
      permissions.hasSpacePermission.mockResolvedValue(false);

      await expect(
        service.transferOwner(SPACE, me(OWNER), BOARD, NEXT),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(permissions.hasSpacePermission).toHaveBeenCalledWith(
        NEXT,
        'org-1',
        SPACE,
        'view_whiteboards',
      );
    });

    it('moves an open board without touching its Share rules, and audits it', async () => {
      queueDetails(OWNER);
      queue('wiki_pages', { id: PAGE });
      queue('wiki_page_permissions', []);
      queue('wiki_pages', null);
      queueDetails(NEXT);

      await service.transferOwner(SPACE, me(OWNER), BOARD, NEXT);

      expect(wikiPermissions.setPagePermissions).not.toHaveBeenCalled();
      expect(audit.logActionForRequest).toHaveBeenCalledWith(
        me(OWNER),
        'whiteboard',
        BOARD,
        'update',
        { owner: { from: OWNER, to: NEXT } },
      );
    });

    it('keeps the previous owner as editor on a restricted board', async () => {
      queueDetails(OWNER);
      queue('wiki_pages', { id: PAGE });
      queue('wiki_page_permissions', [
        {
          entity_type: 'user',
          entity_id: OWNER,
          can_view: true,
          can_edit: true,
          can_delete: true,
        },
        {
          entity_type: 'group',
          entity_id: 'g-1',
          can_view: true,
          can_edit: false,
          can_delete: false,
        },
      ]);
      queue('wiki_pages', null);
      queueDetails(NEXT);

      await service.transferOwner(SPACE, me(OWNER), BOARD, NEXT);

      expect(wikiPermissions.setPagePermissions).toHaveBeenCalledWith(
        PAGE,
        SPACE,
        {
          permissions: [
            expect.objectContaining({ entity_type: 'group', entity_id: 'g-1' }),
            {
              entity_type: 'user',
              entity_id: OWNER,
              can_view: true,
              can_edit: true,
              can_delete: false,
            },
          ],
        },
        { userId: OWNER, organizationId: 'org-1' },
      );
    });

    it('is a no-op when the new owner is already the owner', async () => {
      queueDetails(OWNER);

      await service.transferOwner(SPACE, me(OWNER), BOARD, OWNER);

      expect(wiki.ensureWhiteboardPage).not.toHaveBeenCalled();
      expect(audit.logActionForRequest).not.toHaveBeenCalled();
    });
  });
});
