/**
 * @fileoverview Unit tests for the group-membership reverse lookup.
 * @module src/user-groups/user-groups.service.spec
 */

import { BadRequestException } from '@nestjs/common';
import { UserGroupsService } from './user-groups.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { PermissionsService } from '../permissions/permissions.service';

interface LookupOpts {
  /** Rows the joined query resolves with. */
  rows?: unknown[];
  /** Error the joined query resolves with. */
  error?: { message: string } | null;
}

function buildService(opts: LookupOpts = {}) {
  /** Every `.eq()` pair applied to the lookup, to prove tenant scoping. */
  const filters: Array<[string, unknown]> = [];
  const select = jest.fn();
  const inFilter = jest.fn();

  const chain: Record<string, unknown> = {};
  chain.eq = jest.fn((column: string, value: unknown) => {
    filters.push([column, value]);

    return chain;
  });
  chain.order = jest.fn().mockResolvedValue({
    data: opts.rows ?? [],
    error: opts.error ?? null,
  });

  inFilter.mockReturnValue(chain);
  select.mockReturnValue({ in: inFilter });

  const supabaseAdmin = {
    getClient: () => ({ from: jest.fn(() => ({ select })) }),
  } as unknown as SupabaseAdminService;

  const service = new UserGroupsService(supabaseAdmin, {
    bustOrg: jest.fn(),
  } as unknown as PermissionsService);

  return { service, select, inFilter, filters };
}

describe('UserGroupsService.getMembershipsForUsers', () => {
  it('groups rows by user and keeps groupless users as empty arrays', async () => {
    const { service } = buildService({
      rows: [
        { user_id: 'u1', group: { id: 'g1', name: 'Risk' } },
        { user_id: 'u1', group: { id: 'g2', name: 'Audit' } },
        { user_id: 'u2', group: { id: 'g1', name: 'Risk' } },
      ],
    });

    await expect(
      service.getMembershipsForUsers('org-1', ['u1', 'u2', 'u3']),
    ).resolves.toEqual({
      u1: [
        { id: 'g1', name: 'Risk' },
        { id: 'g2', name: 'Audit' },
      ],
      u2: [{ id: 'g1', name: 'Risk' }],
      u3: [],
    });
  });

  it('resolves everything in a single query scoped to the organization', async () => {
    const { service, select, inFilter, filters } = buildService({
      rows: [{ user_id: 'u1', group: { id: 'g1', name: 'Risk' } }],
    });

    await service.getMembershipsForUsers('org-1', ['u1', 'u2']);

    expect(select).toHaveBeenCalledTimes(1);
    expect(inFilter).toHaveBeenCalledWith('user_id', ['u1', 'u2']);
    expect(filters).toEqual([
      ['group.organization_id', 'org-1'],
      ['group.is_deleted', false],
    ]);
  });

  it('de-duplicates requested ids', async () => {
    const { service, inFilter } = buildService();

    await service.getMembershipsForUsers('org-1', ['u1', 'u1', 'u2']);

    expect(inFilter).toHaveBeenCalledWith('user_id', ['u1', 'u2']);
  });

  it('skips the query entirely when no ids are requested', async () => {
    const { service, select } = buildService();

    await expect(service.getMembershipsForUsers('org-1', [])).resolves.toEqual(
      {},
    );
    expect(select).not.toHaveBeenCalled();
  });

  it('flattens an array-shaped embedded group', async () => {
    const { service } = buildService({
      rows: [{ user_id: 'u1', group: [{ id: 'g1', name: 'Risk' }] }],
    });

    await expect(
      service.getMembershipsForUsers('org-1', ['u1']),
    ).resolves.toEqual({ u1: [{ id: 'g1', name: 'Risk' }] });
  });

  it('ignores rows for users that were not requested', async () => {
    const { service } = buildService({
      rows: [
        { user_id: 'u1', group: { id: 'g1', name: 'Risk' } },
        { user_id: 'stranger', group: { id: 'g9', name: 'Other' } },
      ],
    });

    await expect(
      service.getMembershipsForUsers('org-1', ['u1']),
    ).resolves.toEqual({ u1: [{ id: 'g1', name: 'Risk' }] });
  });

  it('surfaces query failures as a bad request', async () => {
    const { service } = buildService({ error: { message: 'boom' } });

    await expect(
      service.getMembershipsForUsers('org-1', ['u1']),
    ).rejects.toThrow(BadRequestException);
  });
});
