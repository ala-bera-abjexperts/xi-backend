import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { PlanningRosterService } from './planning-roster.service';

describe('PlanningRosterService', () => {
  const user = { userId: 'actor-1', organizationId: 'org-1' } as RequestUser;

  let service: PlanningRosterService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let isEnabled: jest.Mock;
  let logActionForRequest: jest.Mock;

  /** Chainable delete query; `eq` calls are recorded on the returned mock. */
  function deleteChain(result: { data: unknown; error: unknown }) {
    const value: Record<string, jest.Mock> = {};
    for (const method of ['delete', 'eq']) {
      value[method] = jest.fn(() => value);
    }
    value.select = jest.fn().mockResolvedValue(result);
    return value;
  }

  const addResult = (overrides: Record<string, unknown> = {}) => ({
    added: 2,
    already_listed: 1,
    deactivated: 0,
    not_member: 0,
    added_user_ids: ['user-a', 'user-b'],
    ...overrides,
  });

  beforeEach(() => {
    from = jest.fn();
    rpc = jest.fn();
    isEnabled = jest.fn().mockResolvedValue(true);
    logActionForRequest = jest.fn().mockResolvedValue(undefined);
    service = new PlanningRosterService(
      { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
      { isEnabled } as unknown as OrganizationModulesService,
      { logActionForRequest } as unknown as AuditLogsService,
    );
  });

  it('rejects every method when the module is disabled', async () => {
    isEnabled.mockResolvedValue(false);

    await expect(service.list('org-1', {})).rejects.toThrow(ForbiddenException);
    await expect(service.addUsers(user, ['user-a'])).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.addGroup(user, 'group-1')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.remove(user, 'user-a')).rejects.toThrow(
      ForbiddenException,
    );
    expect(isEnabled).toHaveBeenCalledWith('org-1', 'resource_planning');
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('lists a page scoped to the org and maps capacity with numeric coercion', async () => {
    const base = {
      email: 'a@example.com',
      first_name: 'A',
      last_name: 'B',
      avatar_url: null,
      is_active: true,
      added_at: '2026-09-01T00:00:00Z',
      total_count: '42',
    };
    rpc.mockResolvedValue({
      data: [
        {
          ...base,
          user_id: 'user-a',
          weekly_capacity_hours: '37.5',
          cost_rate: '80.25',
          currency: 'EUR',
          capacity_is_active: false,
        },
        {
          ...base,
          user_id: 'user-b',
          weekly_capacity_hours: 40,
          cost_rate: null,
          currency: null,
          capacity_is_active: true,
        },
        {
          ...base,
          user_id: 'user-c',
          weekly_capacity_hours: null,
          cost_rate: null,
          currency: null,
          capacity_is_active: null,
        },
      ],
      error: null,
    });

    const result = await service.list('org-1', {
      search: 'ann',
      page: 3,
      limit: 10,
    });

    expect(rpc).toHaveBeenCalledWith('resource_planning_roster_list', {
      p_organization_id: 'org-1',
      p_search: 'ann',
      p_limit: 10,
      p_offset: 20,
    });
    expect(result.count).toBe(42);
    expect(result.page).toBe(3);
    expect(result.limit).toBe(10);
    expect(result.data.map((entry) => entry.capacity)).toEqual([
      {
        weekly_capacity_hours: 37.5,
        cost_rate: 80.25,
        currency: 'EUR',
        is_active: false,
      },
      {
        weekly_capacity_hours: 40,
        cost_rate: null,
        currency: null,
        is_active: true,
      },
      null,
    ]);
    expect(result.data[0]).not.toHaveProperty('total_count');
  });

  it('returns count 0 for an empty page', async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    const result = await service.list('org-1', {});

    expect(rpc).toHaveBeenCalledWith('resource_planning_roster_list', {
      p_organization_id: 'org-1',
      p_search: null,
      p_limit: 25,
      p_offset: 0,
    });
    expect(result).toEqual({ data: [], count: 0, page: 1, limit: 25 });
  });

  it('adds users as the actor in the caller org and audits the added ids', async () => {
    rpc.mockResolvedValue({ data: addResult(), error: null });

    const result = await service.addUsers(user, ['user-a', 'user-b', 'user-c']);

    expect(rpc).toHaveBeenCalledWith('resource_planning_roster_add', {
      p_organization_id: 'org-1',
      p_added_by: 'actor-1',
      p_user_ids: ['user-a', 'user-b', 'user-c'],
      p_group_id: null,
    });
    expect(result).toEqual({
      added: 2,
      already_listed: 1,
      deactivated: 0,
      not_member: 0,
    });
    expect(logActionForRequest).toHaveBeenCalledWith(
      user,
      'resource_planning_roster',
      'org-1',
      'create',
      {
        source: 'users',
        added_user_ids: ['user-a', 'user-b'],
        already_listed: 1,
        deactivated: 0,
        not_member: 0,
      },
    );
    expect(JSON.stringify(logActionForRequest.mock.calls)).not.toContain(
      'org-2',
    );
  });

  it('does not audit when nothing was added', async () => {
    rpc.mockResolvedValue({
      data: addResult({ added: 0, already_listed: 3, added_user_ids: [] }),
      error: null,
    });

    await service.addUsers(user, ['user-a']);

    expect(logActionForRequest).not.toHaveBeenCalled();
  });

  it('maps group-not-found and lost-membership errors on addGroup', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'group not found' },
    });
    await expect(service.addGroup(user, 'group-1')).rejects.toThrow(
      NotFoundException,
    );

    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23503', message: 'fk violation' },
    });
    await expect(service.addGroup(user, 'group-1')).rejects.toThrow(
      ConflictException,
    );

    expect(rpc).toHaveBeenCalledWith('resource_planning_roster_add', {
      p_organization_id: 'org-1',
      p_added_by: 'actor-1',
      p_user_ids: null,
      p_group_id: 'group-1',
    });
    expect(logActionForRequest).not.toHaveBeenCalled();
  });

  it('removes by organization_id and user_id and audits only a real delete', async () => {
    const hit = deleteChain({ data: [{ user_id: 'user-a' }], error: null });
    from.mockReturnValueOnce(hit);

    await expect(service.remove(user, 'user-a')).resolves.toEqual({
      removed: true,
    });
    expect(from).toHaveBeenCalledWith('resource_planning_roster');
    expect(hit.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(hit.eq).toHaveBeenCalledWith('user_id', 'user-a');
    expect(logActionForRequest).toHaveBeenCalledWith(
      user,
      'resource_planning_roster',
      'org-1',
      'delete',
      { user_id: 'user-a' },
    );

    logActionForRequest.mockClear();
    const miss = deleteChain({ data: [], error: null });
    from.mockReturnValueOnce(miss);

    await expect(service.remove(user, 'user-z')).resolves.toEqual({
      removed: false,
    });
    expect(miss.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(miss.eq).toHaveBeenCalledWith('user_id', 'user-z');
    expect(logActionForRequest).not.toHaveBeenCalled();
  });
});
