/**
 * @fileoverview Unit tests for RelationTypesService — CRUD, system-type
 * protection, in-use protection, duplicate, toggle_active.
 * @module src/relation-types/relation-types.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RelationTypesService } from './relation-types.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

describe('RelationTypesService', () => {
  let service: RelationTypesService;
  let mockFrom: jest.Mock;
  let mockAuditLogsService: { logAction: jest.Mock };

  const ORG = 'org-1';

  const mockRelType = {
    id: 'rt-1',
    organization_id: ORG,
    name: 'Blocks',
    outward_description: 'blocks',
    inward_description: 'is blocked by',
    name_i18n: {},
    outward_description_i18n: {},
    inward_description_i18n: {},
    color: '#6B7280',
    icon: 'lucide:link',
    is_directional: true,
    is_system: false,
    is_active: true,
    is_deleted: false,
    sort_order: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };

  const systemRelType = { ...mockRelType, id: 'rt-sys', is_system: true };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
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
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    mockAuditLogsService = {
      logAction: jest.fn().mockResolvedValue(undefined),
    };
    service = new RelationTypesService(
      supa,
      mockAuditLogsService as unknown as AuditLogsService,
    );
  });

  // ---- getAll -----------------------------------------------------------

  describe('getAll', () => {
    it('returns relation types sorted by sort_order', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockRelType], error: null }),
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
    it('returns the relation type', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRelType, error: null }),
      );
      const r = await service.getById('rt-1', ORG);
      expect(r.name).toBe('Blocks');
    });

    it('throws 404 on missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getById('nope', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---- create -----------------------------------------------------------

  describe('create', () => {
    it('inserts and returns', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // name uniqueness
        .mockReturnValueOnce(buildChain({ data: mockRelType, error: null })); // insert
      const r = await service.create(ORG, 'user-1', {
        organizationId: 'ignored-org',
        name: 'Blocks',
        outward_description: 'blocks',
        inward_description: 'is blocked by',
      });
      expect(r.id).toBe('rt-1');
      expect(mockAuditLogsService.logAction).toHaveBeenCalledWith(
        ORG,
        'user-1',
        'relation_type',
        'rt-1',
        'create',
        expect.objectContaining({ name: 'Blocks' }),
      );
    });

    it('rejects duplicate name', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'existing' }, error: null }),
      );
      await expect(
        service.create(ORG, null, {
          name: 'Blocks',
          outward_description: 'blocks',
          inward_description: 'is blocked by',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws when name uniqueness lookup fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'lookup failed' } }),
      );
      await expect(
        service.create(ORG, null, {
          name: 'Blocks',
          outward_description: 'blocks',
          inward_description: 'is blocked by',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---- update -----------------------------------------------------------

  describe('update', () => {
    it('partial-updates and returns', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRelType, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertNameUnique
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockRelType, name: 'Blocks v2' },
            error: null,
          }),
        ); // update
      const r = await service.update('rt-1', ORG, null, { name: 'Blocks v2' });
      expect(r.name).toBe('Blocks v2');
    });

    it('rejects modification of system type', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: systemRelType, error: null }),
      );
      await expect(
        service.update('rt-sys', ORG, null, { name: 'Changed' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects duplicate name on update', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRelType, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: { id: 'other' }, error: null }),
        ); // name check
      await expect(
        service.update('rt-1', ORG, null, { name: 'Existing Name' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects empty legacy PATCH updates before touching the row', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRelType, error: null }),
      );

      await expect(
        service.update('rt-1', ORG, 'user-1', { organizationId: ORG } as never),
      ).rejects.toThrow(BadRequestException);
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockAuditLogsService.logAction).not.toHaveBeenCalled();
    });
  });

  // ---- delete -----------------------------------------------------------

  describe('delete', () => {
    it('deletes when not in use and not system', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRelType, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // task_relationships
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // process_relationships
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // asset_item_relations
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      await expect(
        service.delete('rt-1', ORG, 'user-1'),
      ).resolves.toBeUndefined();
      expect(mockAuditLogsService.logAction).toHaveBeenCalledWith(
        ORG,
        'user-1',
        'relation_type',
        'rt-1',
        'delete',
        { name: 'Blocks' },
      );
    });

    it('blocks deletion of system type', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: systemRelType, error: null }),
      );
      await expect(service.delete('rt-sys', ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('blocks deletion when in use', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRelType, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 3 })) // task_relationships count > 0
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // process_relationships
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })); // asset_item_relations
      await expect(service.delete('rt-1', ORG)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ---- toggleActive -----------------------------------------------------

  describe('toggleActive', () => {
    it('toggles active', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRelType, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockRelType, is_active: false },
            error: null,
          }),
        ); // update
      const r = await service.toggleActive('rt-1', false, ORG, 'user-1');
      expect(r.is_active).toBe(false);
      expect(mockAuditLogsService.logAction).toHaveBeenCalledWith(
        ORG,
        'user-1',
        'relation_type',
        'rt-1',
        'update',
        { is_active: false },
      );
    });

    it('blocks toggling system type', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: systemRelType, error: null }),
      );
      await expect(service.toggleActive('rt-sys', false, ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('blocks activating system type too', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...systemRelType, is_active: false },
          error: null,
        }),
      );
      await expect(service.toggleActive('rt-sys', true, ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ---- duplicate --------------------------------------------------------

  describe('duplicate', () => {
    it('clones with provided name and incremented sort_order', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRelType, error: null })) // getById (duplicate)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertNameUnique (duplicate)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertNameUnique (create)
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockRelType,
              id: 'rt-2',
              name: 'Custom Copy',
              sort_order: 1,
            },
            error: null,
          }),
        ); // insert (create)
      const r = await service.duplicate('rt-1', ORG, null, 'Custom Copy');
      expect(r.id).toBe('rt-2');
      expect(r.name).toBe('Custom Copy');
      expect(r.sort_order).toBe(1);
    });
  });
});
