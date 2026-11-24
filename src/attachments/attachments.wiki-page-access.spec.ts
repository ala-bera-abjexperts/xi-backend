/**
 * @fileoverview The wiki page-restriction gate on attachment access.
 *
 * Until historical versions existed, this route authorized on the SPACE permission alone, so a
 * space member who could not open a restricted page could still fetch its files by id. Importing
 * revision history multiplies that: every historical binary of a restricted page becomes reachable
 * the same way. These tests pin the gate and pin that it is scoped to wiki pages only.
 *
 * @module src/attachments/attachments.wiki-page-access.spec
 * @author Prince Jadiya
 */

import { ForbiddenException } from '@nestjs/common';

import { AttachmentsService } from './attachments.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { WikiPermissionsService } from '../wiki/wiki-permissions.service';

const USER = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'u@test',
  memberships: [],
} as unknown as Parameters<AttachmentsService['getDownloadInfo']>[0]['user'];

function harness(
  options: { pageAccess?: Error; withWikiService?: boolean } = {},
) {
  const resolved = {
    data: {
      id: 'wiki-page-1',
      organization_id: 'org-1',
      space_id: 'space-1',
    },
    error: null,
  };

  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.is = jest.fn().mockImplementation(self);
  chain.not = jest.fn().mockImplementation(self);
  chain.order = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);

  const permissions = {
    getUserSpacePermissions: jest.fn().mockResolvedValue({
      isMember: true,
      spaceRole: 'admin',
      globalRole: 'admin',
      permissions: { view_wiki_pages: true, view_tasks: true },
    }),
  };

  const wikiPermissions = {
    assertPageAccess: options.pageAccess
      ? jest.fn().mockRejectedValue(options.pageAccess)
      : jest.fn().mockResolvedValue(undefined),
  };

  const supabase = {
    getClient: () => ({
      from: jest.fn(() => chain),
      storage: { from: jest.fn(() => ({})) },
    }),
  } as unknown as SupabaseAdminService;

  const service = new AttachmentsService(
    supabase,
    permissions as unknown as PermissionsService,
    { logAction: jest.fn() } as unknown as AuditLogsService,
    undefined,
    undefined,
    undefined,
    options.withWikiService === false
      ? undefined
      : (wikiPermissions as unknown as WikiPermissionsService),
  );

  return { service, permissions, wikiPermissions };
}

describe('wiki page access gate on attachments', () => {
  it('checks the per-page restriction on top of the space permission', async () => {
    const h = harness();

    await h.service.listForEntity({
      user: USER,
      entityType: 'wiki_page',
      entityId: 'wiki-page-1',
    });

    expect(h.permissions.getUserSpacePermissions).toHaveBeenCalled();
    expect(h.wikiPermissions.assertPageAccess).toHaveBeenCalledWith(
      'wiki-page-1',
      'user-1',
      'space-1',
      'can_view',
    );
  });

  it('refuses when the page restriction denies the user, even though the space allows it', async () => {
    const h = harness({ pageAccess: new ForbiddenException('no page access') });

    await expect(
      h.service.listForEntity({
        user: USER,
        entityType: 'wiki_page',
        entityId: 'wiki-page-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('FAILS CLOSED when the wiki permission service is unavailable', async () => {
    // A missing dependency must never silently widen access back to the space-only check.
    const h = harness({ withWikiService: false });

    await expect(
      h.service.listForEntity({
        user: USER,
        entityType: 'wiki_page',
        entityId: 'wiki-page-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves non-wiki entities on the space-only check', async () => {
    const h = harness();

    await h.service.listForEntity({
      user: USER,
      entityType: 'task',
      entityId: 'task-1',
    });

    expect(h.wikiPermissions.assertPageAccess).not.toHaveBeenCalled();
  });
});
