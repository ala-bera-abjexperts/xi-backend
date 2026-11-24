/**
 * @fileoverview Unit tests for PublicSiteStudioService.canEditFunnel (XE-T453).
 *
 * This backs an edit affordance rendered on a PUBLIC, customer-facing page, so the
 * contract is fail-closed and non-revealing: every negative path returns `{canEdit:false}`
 * rather than throwing, so a visitor cannot distinguish "funnel exists but you may not
 * edit it" from "no such funnel" by watching status codes.
 *
 * The tenancy assertion is the important one. Tenant isolation in this codebase is
 * app-layer only — there is no RLS backstop — so membership of the FUNNEL's organization
 * is checked explicitly rather than trusting `user.organizationId`. That field is also
 * literally unusable here: on a `@Public()` route the auth guard's optional-user path
 * attaches the identity with `organizationId: ''`.
 *
 * @module src/site-studio/public/can-edit-funnel.service.spec
 */

import { PublicSiteStudioService } from './public-site-studio.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TasksService } from '../../tasks/tasks.service';
import { ProcessesService } from '../../processes/processes.service';
import { WikiService } from '../../wiki/wiki.service';
import { PermissionsService } from '../../permissions/permissions.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';

const FUNNEL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

/** The guard attaches an empty organizationId on @Public() routes — mirrored here. */
const publicRouteUser = {
  userId: USER,
  authUserId: 'auth-user',
  email: 'e@example.com',
  organizationId: '',
  memberships: [],
} as unknown as RequestUser;

describe('PublicSiteStudioService.canEditFunnel', () => {
  let service: PublicSiteStudioService;
  let checkPermission: jest.Mock;

  /**
   * @param funnelOrg org the funnel belongs to, or null for "no such funnel"
   * @param memberOf  org the user is a member of, or null for "not a member"
   */
  function build(funnelOrg: string | null, memberOf: string | null) {
    const from = jest.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;

      chain.select = jest.fn().mockImplementation(self);
      chain.eq = jest.fn().mockImplementation(self);

      if (table === 'site_studio_funnels') {
        chain.maybeSingle = jest.fn().mockResolvedValue({
          data: funnelOrg ? { id: FUNNEL, organization_id: funnelOrg } : null,
          error: null,
        });
      } else {
        // organization_members — only returns a row when the org matches.
        chain.maybeSingle = jest.fn().mockResolvedValue({
          data: memberOf && memberOf === funnelOrg ? { user_id: USER } : null,
          error: null,
        });
      }

      return chain;
    });

    checkPermission = jest.fn().mockResolvedValue(true);

    service = new PublicSiteStudioService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {} as unknown as TasksService,
      {} as unknown as ProcessesService,
      {} as unknown as WikiService,

      // File Explorer collaborators: unused by canEditFunnel, but the constructor
      // takes them, so they are stubbed to keep the positional order honest.
      {} as never,
      {} as never,
      { checkPermission } as unknown as PermissionsService,
    );
  }

  it('allows a member of the funnel org who holds can_edit_site_studio', async () => {
    build(ORG, ORG);

    await expect(
      service.canEditFunnel(publicRouteUser, FUNNEL),
    ).resolves.toEqual({
      canEdit: true,
    });
    // Permission must be resolved against the FUNNEL's org, not the (empty) session org.
    expect(checkPermission).toHaveBeenCalledWith(
      USER,
      ORG,
      'can_edit_site_studio',
    );
  });

  it('denies a user who lacks the permission', async () => {
    build(ORG, ORG);
    checkPermission.mockResolvedValue(false);

    await expect(
      service.canEditFunnel(publicRouteUser, FUNNEL),
    ).resolves.toEqual({
      canEdit: false,
    });
  });

  it('denies a non-member of the funnel org and never consults permissions', async () => {
    build(ORG, OTHER_ORG);

    await expect(
      service.canEditFunnel(publicRouteUser, FUNNEL),
    ).resolves.toEqual({
      canEdit: false,
    });
    // The tenant boundary must reject before any permission lookup.
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('denies an anonymous visitor', async () => {
    build(ORG, ORG);

    await expect(service.canEditFunnel(undefined, FUNNEL)).resolves.toEqual({
      canEdit: false,
    });
  });

  it('denies an unknown funnel without revealing anything', async () => {
    build(null, ORG);

    await expect(
      service.canEditFunnel(publicRouteUser, FUNNEL),
    ).resolves.toEqual({
      canEdit: false,
    });
  });

  it('denies an empty funnel id', async () => {
    build(ORG, ORG);

    await expect(service.canEditFunnel(publicRouteUser, '')).resolves.toEqual({
      canEdit: false,
    });
  });
});
