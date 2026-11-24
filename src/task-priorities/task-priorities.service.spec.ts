/**
 * @fileoverview Unit tests for TaskPrioritiesService — CRUD, default
 * management, in-use protection, reorder, duplicate, key uniqueness.
 * @module src/task-priorities/task-priorities.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TaskPrioritiesService } from './task-priorities.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('TaskPrioritiesService', () => {
  let service: TaskPrioritiesService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;

  const ORG = 'org-1';

  const mockPriority = {
    id: 'pri-1',
    organization_id: ORG,
    space_id: null,
    name: 'High',
    key: 'high',
    color: '#F97316',
    icon: 'lucide:chevron-up',
    sort_order: 4,
    is_default: false,
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
    chain.or = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
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
    service = new TaskPrioritiesService(supa);
  });

  // ---- getAll -----------------------------------------------------------

  describe('getAll', () => {
    it('returns priorities ordered by sort_order', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockPriority], error: null }),
      );
      const r = await service.getAll(ORG);
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe('pri-1');
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
    it('returns the priority', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockPriority, error: null }),
      );
      const r = await service.getById('pri-1', ORG);
      expect(r.name).toBe('High');
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
    it('returns priority by key', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockPriority, error: null }),
      );
      const r = await service.getByKey(ORG, null, 'high');
      expect(r?.key).toBe('high');
    });

    it('returns null when not found', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.getByKey(ORG, null, 'nope');
      expect(r).toBeNull();
    });
  });

  // ---- getDefault -------------------------------------------------------

  describe('getDefault', () => {
    it('returns org-level default', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...mockPriority, is_default: true },
          error: null,
        }),
      );
      const r = await service.getDefault(ORG);
      expect(r?.is_default).toBe(true);
    });

    it('returns null when no default exists', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.getDefault(ORG);
      expect(r).toBeNull();
    });
  });

  // ---- create -----------------------------------------------------------

  describe('create', () => {
    it('inserts and returns the priority', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // key uniqueness check
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })); // insert
      const r = await service.create(ORG, {
        name: 'High',
        key: 'high',
        color: '#F97316',
      });
      expect(r.id).toBe('pri-1');
    });

    it('rejects duplicate key in same scope', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'existing' }, error: null }),
      );
      await expect(
        service.create(ORG, { name: 'High', key: 'high', color: '#F97316' }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws when key uniqueness lookup fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'lookup failed' } }),
      );
      await expect(
        service.create(ORG, { name: 'High', key: 'high', color: '#F97316' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a space_id outside the authenticated organization', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.create(ORG, {
          name: 'High',
          key: 'high',
          color: '#F97316',
          space_id: 'space-from-other-org',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('clears other defaults when is_default=true', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // key check
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockPriority, is_default: true },
            error: null,
          }),
        ) // insert
        .mockReturnValueOnce(buildChain({ data: { id: 'pri-1' }, error: null })) // promote target
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // clearDefault
      const r = await service.create(ORG, {
        name: 'High',
        key: 'high',
        color: '#F97316',
        is_default: true,
      });
      expect(r.is_default).toBe(true);
    });
  });

  // ---- update -----------------------------------------------------------

  describe('update', () => {
    it('partial-updates and returns', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockPriority, name: 'Highest' },
            error: null,
          }),
        ); // update
      const r = await service.update('pri-1', ORG, { name: 'Highest' });
      expect(r.name).toBe('Highest');
    });

    it('clears defaults when setting is_default=true', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: { id: 'pri-1' }, error: null })) // promote target
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // clearDefault
      const r = await service.update('pri-1', ORG, { is_default: true });
      expect(r.is_default).toBe(true);
    });
  });

  // ---- delete -----------------------------------------------------------

  describe('delete', () => {
    it('deletes when not in use', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // isInUse
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      await expect(service.delete('pri-1', ORG)).resolves.toBeUndefined();
    });

    it('throws ConflictException when in use by tasks', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 3 })); // isInUse
      await expect(service.delete('pri-1', ORG)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ---- toggleActive -----------------------------------------------------

  describe('toggleActive', () => {
    it('activates a priority', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockPriority, is_active: false },
            error: null,
          }),
        ) // getById
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })); // update
      const r = await service.toggleActive('pri-1', true, ORG);
      expect(r.is_active).toBe(true);
    });

    it('blocks deactivation when in use', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 5 })); // isInUse
      await expect(service.toggleActive('pri-1', false, ORG)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ---- setDefault -------------------------------------------------------

  describe('setDefault', () => {
    it('sets default and clears others in scope', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: { id: 'pri-1' }, error: null })) // promote target
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // clearDefault
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockPriority, is_default: true },
            error: null,
          }),
        ); // update
      const r = await service.setDefault('pri-1', ORG);
      expect(r.is_default).toBe(true);
    });
  });

  // ---- reorder ----------------------------------------------------------

  describe('reorder', () => {
    it('updates sort_order for each item', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'pri-1' }, { id: 'pri-2' }],
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { id: 'pri-2' }, error: null }),
        );
      await expect(
        service.reorder(
          [
            { id: 'pri-1', sort_order: 0 },
            { id: 'pri-2', sort_order: 1 },
          ],
          ORG,
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects stale ids before logging reorder success', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'One or more task priorities were not found' },
      });

      await expect(
        service.reorder([{ id: 'pri-missing', sort_order: 0 }], ORG, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---- duplicate --------------------------------------------------------

  describe('duplicate', () => {
    it('clones with a new name and auto-generated key', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockPriority, error: null })) // getById (duplicate)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertKeyUnique (duplicate)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertKeyUnique (create)
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockPriority, id: 'pri-2', name: 'High Copy' },
            error: null,
          }),
        ); // insert (create)
      const r = await service.duplicate('pri-1', ORG, 'High Copy');
      expect(r.id).toBe('pri-2');
      expect(r.name).toBe('High Copy');
    });
  });
});
