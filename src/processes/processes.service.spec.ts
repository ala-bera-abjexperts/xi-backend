/**
 * @fileoverview Unit tests for ProcessesService — CRUD, key generation,
 * type-specific validation, multi-parent relationships, cascade delete.
 * @module src/processes/processes.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ProcessesService } from './processes.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('ProcessesService', () => {
  let service: ProcessesService;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const SPACE = 'space-1';

  const mockProcess = {
    id: 'proc-1',
    organization_id: ORG,
    space_id: SPACE,
    key: 'S1-P1',
    title: 'Risk Assessment',
    description: null,
    request_type: 'Risiko',
    status: 'active',
    hierarchy_level_id: null,
    parent_id: null,
    sort_order: 0,
    vuln_c_p: null,
    vuln_c_i: null,
    vuln_i_p: null,
    vuln_i_i: null,
    vuln_a_p: null,
    vuln_a_i: null,
    action_c_p: null,
    action_c_i: null,
    action_i_p: null,
    action_i_i: null,
    action_a_p: null,
    action_a_i: null,
    custom_field_values: {},
    assigned_to: null,
    created_by: null,
    updated_by: null,
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
    chain.neq = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
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
    const auditLogsService = {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../audit-logs/audit-logs.service').AuditLogsService;
    service = new ProcessesService(supa, auditLogsService);
  });

  // ---- getById ----------------------------------------------------------

  describe('getById', () => {
    it('returns a process', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockProcess, error: null }),
      );
      const r = await service.getById('proc-1', ORG);
      expect(r.key).toBe('S1-P1');
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
    it('returns a process by key', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockProcess, error: null }),
      );
      const r = await service.getByKey('S1-P1', ORG);
      expect(r.id).toBe('proc-1');
    });

    it('throws 404 on unknown key', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getByKey('X-P999', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---- getAll -----------------------------------------------------------

  describe('getAll', () => {
    it('returns paginated processes', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockProcess], error: null, count: 1 }),
      );
      const r = await service.getAll(ORG, SPACE);
      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
    });
  });

  // ---- create -----------------------------------------------------------

  describe('create', () => {
    it('creates a process with auto-generated key', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { key: 'TS' }, error: null })) // space lookup
        .mockReturnValueOnce(
          buildChain({ data: { key: 'TS-P2' }, error: null }),
        ) // max key
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })); // insert
      const r = await service.create(ORG, 'user-1', {
        space_id: SPACE,
        title: 'Risk Assessment',
        request_type: 'Risiko',
      });
      expect(r.id).toBe('proc-1');
    });

    it('rejects Maßnahme without action_* values', async () => {
      await expect(
        service.create(ORG, 'user-1', {
          space_id: SPACE,
          title: 'Action plan',
          request_type: 'Maßnahme',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects Schwachstelle without vuln_* values', async () => {
      await expect(
        service.create(ORG, 'user-1', {
          space_id: SPACE,
          title: 'Vuln entry',
          request_type: 'Schwachstelle',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates process with parent relationships', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { key: 'TS' }, error: null })) // space lookup
        .mockReturnValueOnce(
          buildChain({ data: { key: 'TS-P2' }, error: null }),
        ) // max key
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })) // insert process
        .mockReturnValueOnce(
          buildChain({ data: { id: 'parent-1' }, error: null }),
        ) // verify parent
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // insert relationship
      const r = await service.create(ORG, 'user-1', {
        space_id: SPACE,
        title: 'Child',
        request_type: 'Risiko',
        parent_ids: ['parent-1'],
      });
      expect(r.id).toBe('proc-1');
    });

    it('creates a parent relationship from legacy parent_id payloads', async () => {
      const relationshipInsertChain = buildChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: { key: 'TS' }, error: null })) // space lookup
        .mockReturnValueOnce(
          buildChain({ data: { key: 'TS-P2' }, error: null }),
        ) // max key
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })) // insert process
        .mockReturnValueOnce(
          buildChain({ data: { id: 'parent-1' }, error: null }),
        ) // verify parent
        .mockReturnValueOnce(relationshipInsertChain); // insert relationship

      const r = await service.create(ORG, 'user-1', {
        space_id: SPACE,
        title: 'Child',
        request_type: 'Risiko',
        parent_id: 'parent-1',
      } as never);

      expect(r.id).toBe('proc-1');
      expect(mockFrom).toHaveBeenCalledWith('process_relationships');
      expect(relationshipInsertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          relationship_type: 'parent_child',
        }),
      );
    });
  });

  // ---- update -----------------------------------------------------------

  describe('update', () => {
    it('partial updates a process', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockProcess, title: 'Updated' },
            error: null,
          }),
        ); // update
      const r = await service.update('proc-1', ORG, 'user-1', {
        title: 'Updated',
      });
      expect(r.title).toBe('Updated');
    });
  });

  // ---- delete -----------------------------------------------------------

  describe('delete', () => {
    it('cascade-deletes with relationships', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete relationships (child)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete relationships (parent)
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete process
      await expect(
        service.delete('proc-1', ORG, 'user-1'),
      ).resolves.toBeUndefined();
    });
  });

  // ---- reorder ----------------------------------------------------------

  describe('reorder', () => {
    it('updates sort_order for each item', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.reorder(
          [
            { id: 'proc-1', sort_order: 0 },
            { id: 'proc-2', sort_order: 1 },
          ],
          ORG,
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ---- Relationships ----------------------------------------------------

  describe('getRelationships', () => {
    it('returns parents and children', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'rel-1', parent_process_id: 'p-parent' }],
            error: null,
          }),
        ) // parents
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'rel-2', child_process_id: 'p-child' }],
            error: null,
          }),
        ); // children
      const r = await service.getRelationships('proc-1', ORG);
      expect(r.parents).toHaveLength(1);
      expect(r.children).toHaveLength(1);
    });
  });

  describe('createRelationship', () => {
    it('creates a parent-child relationship', async () => {
      const relationshipInsertChain = buildChain({
        data: {
          id: 'rel-1',
          parent_process_id: 'parent-1',
          child_process_id: 'proc-1',
        },
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })) // getById child
        .mockReturnValueOnce(
          buildChain({ data: { id: 'parent-1' }, error: null }),
        ) // verify parent
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // dup check
        .mockReturnValueOnce(relationshipInsertChain); // insert
      const r = (await service.createRelationship('proc-1', ORG, {
        parent_process_id: 'parent-1',
      })) as { id: string };
      expect(r.id).toBe('rel-1');
      expect(relationshipInsertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          relationship_type: 'parent_child',
        }),
      );
    });

    it('rejects self-referencing relationship', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockProcess, error: null }),
      );
      await expect(
        service.createRelationship('proc-1', ORG, {
          parent_process_id: 'proc-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects duplicate relationship', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })) // getById child
        .mockReturnValueOnce(
          buildChain({ data: { id: 'parent-1' }, error: null }),
        ) // verify parent
        .mockReturnValueOnce(
          buildChain({ data: { id: 'existing' }, error: null }),
        ); // dup check
      await expect(
        service.createRelationship('proc-1', ORG, {
          parent_process_id: 'parent-1',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteRelationship', () => {
    it('deletes a relationship', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockProcess, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      await expect(
        service.deleteRelationship('proc-1', 'rel-1', ORG),
      ).resolves.toBeUndefined();
    });
  });
});
