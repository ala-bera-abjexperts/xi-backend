import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SpaceOverridesService } from './space-overrides.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('SpaceOverridesService', () => {
  let service: SpaceOverridesService;
  let mockFrom: jest.Mock;

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    service = new SpaceOverridesService(supabase);
  });

  it('validates the space and target entity before upserting an override', async () => {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: 'space-1' }, error: null }))
      .mockReturnValueOnce(
        buildChain({
          data: { id: 'status-1', organization_id: 'org-1', space_id: null },
          error: null,
        }),
      )
      .mockReturnValueOnce(buildChain({ data: null, error: null }));

    await expect(
      service.setOverride('org-1', 'user-1', {
        spaceId: 'space-1',
        type: 'status',
        entityId: 'status-1',
        isEnabled: true,
        organizationId: 'ignored-org',
      }),
    ).resolves.toBeUndefined();

    expect(mockFrom).toHaveBeenNthCalledWith(1, 'spaces');
    expect(mockFrom).toHaveBeenNthCalledWith(2, 'task_statuses');
    expect(mockFrom).toHaveBeenNthCalledWith(3, 'space_status_overrides');
  });

  it('rejects overrides for spaces outside the caller organization', async () => {
    mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

    await expect(
      service.setOverride('org-1', 'user-1', {
        spaceId: 'space-2',
        type: 'priority',
        entityId: 'priority-1',
        isEnabled: false,
        organizationId: 'ignored-org',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('rejects target entities scoped to another space', async () => {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: 'space-1' }, error: null }))
      .mockReturnValueOnce(
        buildChain({
          data: {
            id: 'priority-1',
            organization_id: 'org-1',
            space_id: 'space-2',
          },
          error: null,
        }),
      );

    await expect(
      service.setOverride('org-1', 'user-1', {
        spaceId: 'space-1',
        type: 'priority',
        entityId: 'priority-1',
        isEnabled: false,
        organizationId: 'ignored-org',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('rejects deleted custom fields', async () => {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: 'space-1' }, error: null }))
      .mockReturnValueOnce(
        buildChain({
          data: {
            id: 'field-1',
            organization_id: 'org-1',
            space_id: null,
            is_deleted: true,
          },
          error: null,
        }),
      );

    await expect(
      service.setOverride('org-1', 'user-1', {
        spaceId: 'space-1',
        type: 'custom_field',
        entityId: 'field-1',
        isEnabled: false,
        organizationId: 'ignored-org',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
