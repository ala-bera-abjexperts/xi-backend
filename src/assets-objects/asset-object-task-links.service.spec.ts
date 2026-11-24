/**
 * @fileoverview Unit tests for AssetObjectTaskLinksService.create: the
 * relation-type org check (XE-T532 #6 security fix), the optional type, and
 * the duplicate-link conflict.
 * @module src/assets-objects/asset-object-task-links.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, ConflictException } from '@nestjs/common';

import { AssetObjectTaskLinksService } from './asset-object-task-links.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { AssetObjectHistoryService } from './asset-object-history.service';

type Resolved = { data: unknown; error: unknown };

function buildChain(resolved: Resolved) {
  const chain: Record<string, jest.Mock> = {};
  const self = () => chain;
  for (const m of ['select', 'eq', 'insert']) {
    chain[m] = jest.fn().mockImplementation(self);
  }
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  return chain;
}

describe('AssetObjectTaskLinksService.create', () => {
  const ORG = 'org-1';
  const SPACE = 'space-1';
  const OBJECT = 'obj-1';
  const TASK = 'task-1';

  let chains: Record<string, Record<string, jest.Mock>[]>;
  let logChange: jest.Mock;
  let service: AssetObjectTaskLinksService;

  function route(queues: Record<string, Resolved[]>) {
    chains = {};
    const from = jest.fn((table: string) => {
      const chain = buildChain(
        queues[table]?.shift() ?? { data: null, error: null },
      );
      (chains[table] ??= []).push(chain);
      return chain;
    });
    service = new AssetObjectTaskLinksService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { logChange } as unknown as AssetObjectHistoryService,
    );
  }

  const baseQueues = (overrides: Record<string, Resolved[]> = {}) => ({
    asset_objects: [
      {
        data: {
          id: OBJECT,
          schema_id: 'schema-1',
          space_id: SPACE,
          organization_id: ORG,
        },
        error: null,
      },
    ],
    tasks: [{ data: { id: TASK, space_id: SPACE }, error: null }],
    relation_types: [{ data: { id: 'rt-1' }, error: null }],
    asset_object_task_links: [
      { data: { id: 'link-1', relation_type_id: 'rt-1' }, error: null },
    ],
    ...overrides,
  });

  beforeEach(() => {
    logChange = jest.fn().mockResolvedValue(undefined);
  });

  it('400s a relation type from another org or the trash, without inserting', async () => {
    route(baseQueues({ relation_types: [{ data: null, error: null }] }));

    await expect(
      service.create(SPACE, ORG, 'user-1', OBJECT, {
        task_id: TASK,
        relation_type_id: 'rt-foreign',
      }),
    ).rejects.toThrow(new BadRequestException('Unknown relation type'));

    const rt = chains.relation_types[0];
    expect(rt.eq).toHaveBeenCalledWith('id', 'rt-foreign');
    expect(rt.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(rt.eq).toHaveBeenCalledWith('is_deleted', false);
    expect(chains.asset_object_task_links).toBeUndefined();
  });

  it('stores a valid type and records it in history', async () => {
    route(baseQueues());

    await service.create(SPACE, ORG, 'user-1', OBJECT, {
      task_id: TASK,
      relation_type_id: 'rt-1',
    });

    expect(chains.asset_object_task_links[0].insert).toHaveBeenCalledWith(
      expect.objectContaining({ relation_type_id: 'rt-1' }),
    );
    expect(logChange).toHaveBeenCalledWith(
      OBJECT,
      'schema-1',
      ORG,
      SPACE,
      'task_link_added',
      'user-1',
      {
        metadata: { taskId: TASK, linkId: 'link-1', relationTypeId: 'rt-1' },
      },
    );
  });

  it('stores null and skips the lookup when no type is chosen', async () => {
    route(baseQueues());

    await service.create(SPACE, ORG, 'user-1', OBJECT, { task_id: TASK });

    expect(chains.relation_types).toBeUndefined();
    expect(chains.asset_object_task_links[0].insert).toHaveBeenCalledWith(
      expect.objectContaining({ relation_type_id: null }),
    );
    expect(logChange).toHaveBeenCalledWith(
      OBJECT,
      'schema-1',
      ORG,
      SPACE,
      'task_link_added',
      'user-1',
      { metadata: { taskId: TASK, linkId: 'link-1', relationTypeId: null } },
    );
  });

  it('409s a task that is already linked', async () => {
    route(
      baseQueues({
        asset_object_task_links: [
          { data: null, error: { code: '23505', message: 'duplicate' } },
        ],
      }),
    );

    await expect(
      service.create(SPACE, ORG, 'user-1', OBJECT, { task_id: TASK }),
    ).rejects.toThrow(ConflictException);
  });
});
