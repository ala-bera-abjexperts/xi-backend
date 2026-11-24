/**
 * @fileoverview Unit tests for TaskStatusesService — CRUD, transitions,
 * default management, in-use protection, reorder, duplicate.
 * @module src/task-statuses/task-statuses.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TaskStatusesService } from './task-statuses.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('TaskStatusesService', () => {
  let service: TaskStatusesService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;

  const ORG = 'org-1';

  const mockStatus = {
    id: 'st-1',
    organization_id: ORG,
    space_id: null,
    category_id: null,
    name: 'Open',
    key: 'open',
    color: '#6B7280',
    icon: 'lucide:circle',
    sort_order: 1,
    is_default: true,
    is_completed: false,
    is_active: true,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn().mockResolvedValue({ data: 0, error: null });
    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;
    service = new TaskStatusesService(supa);
  });

  // ---- getAll -----------------------------------------------------------

  describe('getAll', () => {
    it('returns statuses sorted by sort_order', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockStatus], error: null }),
      );
      const r = await service.getAll(ORG);
      expect(r).toHaveLength(1);
    });

    it('throws on DB error', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'boom' } }),
      );
      await expect(service.getAll(ORG)).rejects.toThrow(BadRequestException);
    });
  });

  // ---- getById ----------------------------------------------------------

  describe('getById', () => {
    it('returns the status', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockStatus, error: null }),
      );
      const r = await service.getById('st-1', ORG);
      expect(r.name).toBe('Open');
    });

    it('throws 404 on missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getById('nope', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---- getByKey ---------------------------------------------------------

  describe('getByKey', () => {
    it('returns status by key in scope', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockStatus, error: null }),
      );
      const r = await service.getByKey(ORG, null, 'open');
      expect(r?.key).toBe('open');
    });

    it('returns null when not found', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.getByKey(ORG, null, 'nope');
      expect(r).toBeNull();
    });
  });

  // ---- getDefault -------------------------------------------------------

  describe('getDefault', () => {
    it('returns org-level default when no space', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockStatus, is_default: true }, error: null }),
      );
      const r = await service.getDefault(ORG);
      expect(r?.is_default).toBe(true);
    });

    it('prefers space default over org default', async () => {
      const spaceStatus = {
        ...mockStatus,
        space_id: 'space-1',
        is_default: true,
      };
      mockFrom.mockReturnValueOnce(
        buildChain({ data: spaceStatus, error: null }),
      );
      const r = await service.getDefault(ORG, 'space-1');
      expect(r?.space_id).toBe('space-1');
    });

    it('returns null when no default exists', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.getDefault(ORG);
      expect(r).toBeNull();
    });
  });

  // ---- getCompletedStatuses ---------------------------------------------

  describe('getCompletedStatuses', () => {
    it('returns only completed statuses', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [{ ...mockStatus, is_completed: true, name: 'Done' }],
          error: null,
        }),
      );
      const r = await service.getCompletedStatuses(ORG);
      expect(r).toHaveLength(1);
      expect(r[0].is_completed).toBe(true);
    });
  });

  // ---- isValidTransition ------------------------------------------------

  describe('isValidTransition', () => {
    it('returns true when transition exists', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'tr-1' }, error: null }),
      );
      expect(await service.isValidTransition('st-1', 'st-2', ORG)).toBe(true);
    });

    it('returns false when transition missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      expect(await service.isValidTransition('st-1', 'st-9', ORG)).toBe(false);
    });
  });

  // ---- getByIdWithTransitions -------------------------------------------

  describe('getByIdWithTransitions', () => {
    it('embeds transition IDs', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ to_status_id: 'st-2' }, { to_status_id: 'st-3' }],
            error: null,
          }),
        ); // getTransitions
      const r = await service.getByIdWithTransitions('st-1', ORG);
      expect(r.allowed_transitions).toEqual(['st-2', 'st-3']);
    });
  });

  // ---- create -----------------------------------------------------------

  describe('create', () => {
    it('inserts and returns the status', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // key check
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })); // insert
      const r = await service.create(ORG, {
        name: 'Open',
        key: 'open',
        color: '#6B7280',
      });
      expect(r.id).toBe('st-1');
    });

    it('rejects duplicate key in same scope', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'existing' }, error: null }),
      );
      await expect(
        service.create(ORG, { name: 'Open', key: 'open', color: '#6B7280' }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws when key uniqueness lookup fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'lookup failed' } }),
      );
      await expect(
        service.create(ORG, { name: 'Open', key: 'open', color: '#6B7280' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a space_id outside the authenticated organization', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.create(ORG, {
          name: 'Open',
          key: 'open',
          color: '#6B7280',
          space_id: 'space-from-other-org',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('clears other defaults when is_default=true', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // key check
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockStatus, is_default: true },
            error: null,
          }),
        ) // insert
        .mockReturnValueOnce(buildChain({ data: { id: 'st-1' }, error: null })) // promote target
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // clearDefault
      const r = await service.create(ORG, {
        name: 'Open',
        key: 'open',
        color: '#6B7280',
        is_default: true,
      });
      expect(r.is_default).toBe(true);
    });

    it('creates transitions when allowed_transitions provided', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // key check
        .mockReturnValueOnce(
          buildChain({ data: { ...mockStatus, id: 'st-new' }, error: null }),
        ) // insert
        .mockReturnValueOnce(
          buildChain({ data: [{ id: 'st-2' }], error: null }),
        ) // validate targets
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete old
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // insert transitions
      const r = await service.create(ORG, {
        name: 'Open',
        key: 'open',
        color: '#6B7280',
        allowed_transitions: ['st-2'],
      });
      expect(r.id).toBe('st-new');
    });
  });

  // ---- update -----------------------------------------------------------

  describe('update', () => {
    it('partial-updates and returns', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockStatus, name: 'Open v2' },
            error: null,
          }),
        ); // update
      const r = await service.update('st-1', ORG, { name: 'Open v2' });
      expect(r.name).toBe('Open v2');
    });

    it('accepts key equal to the stored key and never writes it', async () => {
      const updateChain = buildChain({
        data: { ...mockStatus, name: 'Open v2' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(updateChain); // update
      const r = await service.update('st-1', ORG, {
        key: 'open',
        name: 'Open v2',
      });
      expect(r.name).toBe('Open v2');
      // Exact payload: key is never part of the write.
      expect(updateChain.update).toHaveBeenCalledWith({ name: 'Open v2' });
    });

    it('rejects a key different from the stored key without updating', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockStatus, error: null }),
      ); // getById
      await expect(
        service.update('st-1', ORG, { key: 'renamed', name: 'Open v2' }),
      ).rejects.toThrow(
        new BadRequestException('Status key cannot be changed'),
      );
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('returns the existing status when only an equal key is sent', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockStatus, error: null }),
      ); // getById
      const r = await service.update('st-1', ORG, { key: 'open' });
      expect(r).toEqual(mockStatus);
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('re-applies an explicit category_id replaced by the auto-category trigger', async () => {
      const CAT_CUSTOM = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
      const CAT_DONE = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
      const stored = { ...mockStatus, category_id: CAT_CUSTOM };
      const fixChain = buildChain({
        data: { ...stored, is_completed: true },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: stored, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: { id: CAT_CUSTOM }, error: null }),
        ) // assertCategoryInOrganization
        .mockReturnValueOnce(
          buildChain({
            data: { ...stored, is_completed: true, category_id: CAT_DONE },
            error: null,
          }),
        ) // update (trigger replaced category)
        .mockReturnValueOnce(fixChain); // category follow-up update
      const r = await service.update('st-1', ORG, {
        is_completed: true,
        category_id: CAT_CUSTOM,
      });
      expect(fixChain.update).toHaveBeenCalledWith({ category_id: CAT_CUSTOM });
      expect(r.category_id).toBe(CAT_CUSTOM);
      expect(r.is_completed).toBe(true);
    });

    it('clears defaults when setting is_default=true', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: { id: 'st-1' }, error: null })) // promote target
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // clearDefault
      const r = await service.update('st-1', ORG, { is_default: true });
      expect(r.is_default).toBe(true);
    });

    it('rolls back status field changes when transition replacement fails', async () => {
      const rollbackChain = buildChain({ data: null, error: null });

      mockRpc
        .mockResolvedValueOnce({
          data: null,
          error: { message: 'transition failure' },
        })
        .mockResolvedValueOnce({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: [{ to_status_id: 'st-old' }], error: null }),
        ) // previous transitions
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockStatus, name: 'Open v2' },
            error: null,
          }),
        ) // status update
        .mockReturnValueOnce(rollbackChain); // rollback status update

      await expect(
        service.update('st-1', ORG, {
          name: 'Open v2',
          allowed_transitions: ['st-new'],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(rollbackChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Open' }),
      );
      expect(mockRpc).toHaveBeenLastCalledWith(
        'replace_task_status_transitions',
        {
          p_status_id: 'st-1',
          p_organization_id: ORG,
          p_space_id: null,
          p_to_status_ids: ['st-old'],
        },
      );
    });
  });

  // ---- delete -----------------------------------------------------------

  describe('delete', () => {
    it('deletes when not in use', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // isInUse
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // findWorkflowsUsingStatus countQ
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete transitions (from)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete transitions (to)
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete status
      await expect(service.delete('st-1', ORG)).resolves.toBeUndefined();
    });

    it('throws ConflictException when in use by tasks', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 5 }));
      await expect(service.delete('st-1', ORG)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ConflictException listing workflow names when used by workflow_nodes', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // isInUse (not used by tasks)
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 2 })) // findWorkflowsUsingStatus countQ
        .mockReturnValueOnce(
          buildChain({
            data: [
              { workflows: { id: 'wf-1', name: 'Bug Lifecycle' } },
              { workflows: { id: 'wf-2', name: 'Feature Pipeline' } },
            ],
            error: null,
          }),
        ); // findWorkflowsUsingStatus sampleQ

      await expect(service.delete('st-1', ORG)).rejects.toThrow(
        ConflictException,
      );

      // Re-run to capture the message text (mockFrom queue is drained; rebuild)
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 2 }))
        .mockReturnValueOnce(
          buildChain({
            data: [
              { workflows: { id: 'wf-1', name: 'Bug Lifecycle' } },
              { workflows: { id: 'wf-2', name: 'Feature Pipeline' } },
            ],
            error: null,
          }),
        );

      try {
        await service.delete('st-1', ORG);
        fail('expected ConflictException');
      } catch (err) {
        const msg = (err as ConflictException).message;
        expect(msg).toContain('Bug Lifecycle');
        expect(msg).toContain('Feature Pipeline');
      }
    });

    it('truncates workflow list with overflow suffix when count exceeds sample limit', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 8 })) // 8 workflows total
        .mockReturnValueOnce(
          buildChain({
            data: [
              { workflows: { id: 'wf-1', name: 'WF One' } },
              { workflows: { id: 'wf-2', name: 'WF Two' } },
              { workflows: { id: 'wf-3', name: 'WF Three' } },
              { workflows: { id: 'wf-4', name: 'WF Four' } },
              { workflows: { id: 'wf-5', name: 'WF Five' } },
            ],
            error: null,
          }),
        );

      try {
        await service.delete('st-1', ORG);
        fail('expected ConflictException');
      } catch (err) {
        const msg = (err as ConflictException).message;
        expect(msg).toContain('WF One');
        expect(msg).toContain('and 3 more');
      }
    });
  });

  // ---- toggleActive -----------------------------------------------------

  describe('toggleActive', () => {
    it('activates a status', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockStatus, is_active: false },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null }));
      const r = await service.toggleActive('st-1', true, ORG);
      expect(r.is_active).toBe(true);
    });

    it('blocks deactivation when in use', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 3 }));
      await expect(service.toggleActive('st-1', false, ORG)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ---- setDefault -------------------------------------------------------

  describe('setDefault', () => {
    it('sets default and clears others', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null }))
        .mockReturnValueOnce(buildChain({ data: { id: 'st-1' }, error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockStatus, is_default: true },
            error: null,
          }),
        );
      const r = await service.setDefault('st-1', ORG);
      expect(r.is_default).toBe(true);
    });
  });

  // ---- reorder ----------------------------------------------------------

  describe('reorder', () => {
    it('updates sort_order for each item', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'st-1' }, { id: 'st-2' }],
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: { id: 'st-2' }, error: null }));
      await expect(
        service.reorder(
          [
            { id: 'st-1', sort_order: 0 },
            { id: 'st-2', sort_order: 1 },
          ],
          ORG,
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects stale ids before logging reorder success', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'One or more task statuses were not found' },
      });

      await expect(
        service.reorder([{ id: 'st-missing', sort_order: 0 }], ORG, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---- duplicate --------------------------------------------------------

  describe('duplicate', () => {
    it('clones status + transitions', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById (duplicate)
        .mockReturnValueOnce(
          buildChain({
            data: [{ to_status_id: 'st-2' }],
            error: null,
          }),
        ) // getTransitions
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertKeyUnique (duplicate)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertKeyUnique (create)
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockStatus, id: 'st-dup', name: 'Open Copy' },
            error: null,
          }),
        ) // insert (create)
        .mockReturnValueOnce(
          buildChain({ data: [{ id: 'st-2' }], error: null }),
        ) // validate targets
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete old transitions
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // insert transitions
      const r = await service.duplicate('st-1', ORG, 'Open Copy');
      expect(r.id).toBe('st-dup');
    });
  });

  // ---- Transitions ------------------------------------------------------

  describe('getTransitions', () => {
    it('returns to_status_ids', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [{ to_status_id: 'st-2' }, { to_status_id: 'st-3' }],
          error: null,
        }),
      );
      const r = await service.getTransitions('st-1', ORG);
      expect(r).toEqual(['st-2', 'st-3']);
    });
  });

  describe('setTransitions', () => {
    it('bulk replaces transitions', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'st-2' }, { id: 'st-3' }],
            error: null,
          }),
        ) // validate targets
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete old
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // insert new
      await expect(
        service.setTransitions('st-1', ['st-2', 'st-3'], ORG),
      ).resolves.toBeUndefined();
    });

    it('rejects targets from different org', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          message: 'Target statuses not found in this organization: unknown-id',
        },
      });
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockStatus, error: null }),
      ); // getById
      await expect(
        service.setTransitions('st-1', ['unknown-id'], ORG),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('addTransition', () => {
    it('inserts a single transition', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById (from)
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'st-2', organization_id: ORG },
            error: null,
          }),
        ) // getById (to)
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // insert
      await expect(
        service.addTransition('st-1', 'st-2', ORG),
      ).resolves.toBeUndefined();
    });
  });

  describe('removeTransition', () => {
    it('deletes a single transition', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockStatus, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      await expect(
        service.removeTransition('st-1', 'st-2', ORG),
      ).resolves.toBeUndefined();
    });
  });
});
