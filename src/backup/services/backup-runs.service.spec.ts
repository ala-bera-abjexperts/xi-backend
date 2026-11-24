/**
 * @fileoverview Run creation tests — the unit key and the duplicate-run conflict.
 * @module src/backup/services/backup-runs.service.spec
 *
 * The item-plan assertions exist because `backup_run_items_unit_uidx` is a unique index over
 * (run_id, component_key, coalesce(table_name), coalesce(space_id), sequence). A plan that emits two
 * units with the same key fails the whole insert, and with it the whole run.
 */

import { ConflictException } from '@nestjs/common';
import { BackupRunsService } from './backup-runs.service';
import type { BackupRunItemPlan } from './backup-runs.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

const ORG = 'org-1';
const SCHEME = 'sch-1';
const TARGET = 'tgt-1';

const schemeRow = {
  id: SCHEME,
  organization_id: ORG,
  target_id: TARGET,
  name: 'Nightly',
  selection: { components: ['tasks'], tiers: { content: true } },
  options: {},
  scheme_version: 3,
  status: 'active',
  encrypt_archive: true,
};

const targetRow = {
  id: TARGET,
  target_type: 'sftp',
  auth_method: 'sftp_password',
  config: { host: 'backup.example.com', port: 22 },
  is_enabled: true,
  is_revoked: false,
};

function buildChain(resolved: {
  data: unknown;
  error: unknown;
  count?: number;
}) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'update']) {
    chain[method] = jest.fn().mockImplementation(self);
  }

  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(resolved).then(resolve);

  return chain;
}

describe('BackupRunsService', () => {
  let service: BackupRunsService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;

  function setup(
    rpcResult: { data: unknown; error: unknown },
    schemeOverride: Partial<typeof schemeRow> = {},
  ) {
    const currentScheme = {
      ...schemeRow,
      ...schemeOverride,
      selection: schemeOverride.selection ?? schemeRow.selection,
      options: schemeOverride.options ?? schemeRow.options,
    };

    mockFrom = jest.fn().mockImplementation((table: string) => {
      if (table === 'backup_schemes') {
        return buildChain({ data: currentScheme, error: null });
      }

      if (table === 'backup_targets') {
        return buildChain({ data: targetRow, error: null });
      }

      // backup_runs — the concurrency probe, which reads a count.
      return buildChain({ data: [], error: null, count: 0 });
    });

    mockRpc = jest.fn().mockResolvedValue(rpcResult);

    service = new BackupRunsService({
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService);
  }

  beforeEach(() => setup({ data: 'run-1', error: null }));

  describe('buildItemPlan', () => {
    it('emits a globally unique (component, table, sequence) triple', () => {
      const plan = service.buildItemPlan(['tasks', 'wiki']);
      const keys = plan.map(
        (item) =>
          `${item.component_key}::${item.table_name ?? '@@none'}::${item.sequence}`,
      );

      expect(new Set(keys).size).toBe(keys.length);
    });

    it('orders parents before children so the archive restores in FK order', () => {
      const plan = service.buildItemPlan(['tasks']);
      const tableItems = plan.filter((item) => item.item_kind === 'table');

      // sequence is assigned from the insertLevel sort, so it must be monotonic.
      const sequences = tableItems.map((item) => item.sequence);

      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    });

    it('always ends with the manifest', () => {
      const plan = service.buildItemPlan(['tasks']);

      expect(plan[plan.length - 1].item_kind).toBe('manifest');
    });

    it('never emits an empty plan for a real component', () => {
      // A run with zero items would look like "nothing pending" to a worker, which is how an empty
      // archive gets reported as a success.
      expect(service.buildItemPlan(['tasks']).length).toBeGreaterThan(1);
    });

    it('deduplicates a component listed twice', () => {
      const once = service.buildItemPlan(['tasks']);
      const twice = service.buildItemPlan(['tasks', 'tasks']);

      expect(twice.length).toBe(once.length);
    });

    it('plans a storage unit for a component that stores files', () => {
      const plan = service.buildItemPlan(['file_explorer']);
      const storage = plan.filter((i) => i.item_kind === 'storage_prefix');

      // Exactly one unit per file-storing component, not one per file.
      expect(storage).toHaveLength(1);
      expect(storage[0].component_key).toBe('file_explorer');
      expect(storage[0].table_name).toBeNull();
    });

    it('plans a storage unit for attachments, so their files are copied', () => {
      const plan = service.buildItemPlan(['attachments']);
      const storage = plan.filter((i) => i.item_kind === 'storage_prefix');

      // Attachments spans six tables and five buckets. One unit covers all of them, because the
      // worker walks every source registered for the component.
      expect(storage).toHaveLength(1);
      expect(storage[0].component_key).toBe('attachments');
    });

    it('plans a storage unit for wiki, whose attachments were unregistered', () => {
      const plan = service.buildItemPlan(['wiki']);
      const storage = plan.filter((i) => i.item_kind === 'storage_prefix');

      // wiki_attachments and wiki_page_attachments hold the file paths. Until they were registry
      // entries, wiki had no storage source and this unit was never planned — so wiki attachments
      // were archived as neither rows nor bytes.
      expect(storage).toHaveLength(1);
      expect(storage[0].component_key).toBe('wiki');
    });

    it('plans one storage unit per file-storing component in a mixed selection', () => {
      const plan = service.buildItemPlan([
        'tasks',
        'attachments',
        'wiki',
        'file_explorer',
      ]);
      const storage = plan
        .filter((i) => i.item_kind === 'storage_prefix')
        .map((i) => i.component_key)
        .sort();

      expect(storage).toEqual(['attachments', 'file_explorer', 'wiki']);
    });

    it('plans no storage unit for a component that stores none', () => {
      const plan = service.buildItemPlan(['tasks']);

      expect(plan.some((i) => i.item_kind === 'storage_prefix')).toBe(false);
    });

    it('adds structural parent tables to the run items without widening the saved component selection', () => {
      const plan = service.buildItemPlan(['form_submissions']);
      const tableNames = plan
        .filter((item) => item.item_kind === 'table')
        .map((item) => item.table_name);
      const indexOf = (table: string) => tableNames.indexOf(table);

      expect(tableNames).toEqual(
        expect.arrayContaining([
          'form_builder',
          'form_builder_integrations',
          'form_builder_webhooks',
          'form_builder_submissions',
          'form_builder_webhook_deliveries',
          'form_builder_integration_deliveries',
        ]),
      );
      expect(tableNames).not.toContain('form_builder_fields');
      expect(indexOf('form_builder')).toBeLessThan(
        indexOf('form_builder_submissions'),
      );
      expect(indexOf('form_builder_webhooks')).toBeLessThan(
        indexOf('form_builder_webhook_deliveries'),
      );
      expect(indexOf('form_builder_integrations')).toBeLessThan(
        indexOf('form_builder_integration_deliveries'),
      );
    });

    it('copies files only after every table of that component', () => {
      const plan = service.buildItemPlan(['file_explorer']);
      const lastTable = plan.map((i) => i.item_kind).lastIndexOf('table');
      const storageAt = plan.findIndex((i) => i.item_kind === 'storage_prefix');

      // The object list is read from fe_versions, so those rows must already be in the archive.
      // Bytes whose metadata is missing cannot be restored.
      expect(storageAt).toBeGreaterThan(lastTable);
    });

    it('still ends with the manifest once storage units exist', () => {
      const plan = service.buildItemPlan(['file_explorer']);

      expect(plan[plan.length - 1].item_kind).toBe('manifest');
    });
  });

  describe('createRun', () => {
    it('freezes the scheme version and selection onto the run', async () => {
      await service.createRun({
        organizationId: ORG,
        schemeId: SCHEME,
        triggerSource: 'manual',
        userId: 'user-1',
      });

      const [, args] = mockRpc.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];

      expect(args.p_scheme_version).toBe(3);
      expect(args.p_selection_snapshot).toEqual(schemeRow.selection);
      expect(args.p_trigger_source).toBe('manual');
    });

    it('keeps the saved selection snapshot exact while adding restorable parent run items', async () => {
      setup(
        { data: 'run-1', error: null },
        {
          selection: {
            components: ['form_submissions'],
            tiers: { content: true, configuration: true },
          },
        },
      );

      await service.createRun({
        organizationId: ORG,
        schemeId: SCHEME,
        triggerSource: 'manual',
      });

      const [, args] = mockRpc.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      const items = args.p_items as BackupRunItemPlan[];

      expect(args.p_selection_snapshot).toEqual({
        components: ['form_submissions'],
        tiers: { content: true, configuration: true },
      });
      expect(items.some((item) => item.table_name === 'form_builder')).toBe(
        true,
      );
      expect(
        items.some((item) => item.table_name === 'form_builder_submissions'),
      ).toBe(true);
    });

    it('refuses an unencrypted run when dependency parents would add credential-bearing tables', async () => {
      setup(
        { data: 'run-1', error: null },
        {
          encrypt_archive: false,
          selection: {
            components: ['form_submissions'],
            tiers: { content: true, configuration: true },
          },
        },
      );

      await expect(
        service.createRun({
          organizationId: ORG,
          schemeId: SCHEME,
          triggerSource: 'manual',
        }),
      ).rejects.toThrow(/Enable archive encryption/);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('never copies the target secret into the run snapshot', async () => {
      await service.createRun({
        organizationId: ORG,
        schemeId: SCHEME,
        triggerSource: 'schedule',
      });

      const [, args] = mockRpc.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      const snapshot = JSON.stringify(args.p_target_config_snapshot);

      expect(snapshot).not.toContain('secret');
      expect(snapshot).toContain('backup.example.com');
    });

    it('maps a duplicate active run to 409 rather than swallowing it', async () => {
      // 23505 from backup_runs_one_active_per_scheme is the guarantee, not a fault.
      setup({ data: null, error: { code: '23505', message: 'duplicate key' } });

      await expect(
        service.createRun({
          organizationId: ORG,
          schemeId: SCHEME,
          triggerSource: 'manual',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('reports a missing migration as an actionable error', async () => {
      setup({
        data: null,
        error: { code: 'PGRST202', message: 'function does not exist' },
      });

      await expect(
        service.createRun({
          organizationId: ORG,
          schemeId: SCHEME,
          triggerSource: 'manual',
        }),
      ).rejects.toThrow(/migration has not been applied/);
    });
  });
});
