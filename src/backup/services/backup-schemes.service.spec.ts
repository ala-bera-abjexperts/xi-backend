/**
 * @fileoverview Unit tests for BackupSchemesService — the encryption rules, cron validation,
 * component resolution against the registry, scheme_version bumping, and the delete guard.
 * @module src/backup/services/backup-schemes.service.spec
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BackupSchemesService } from './backup-schemes.service';
import { BackupSecretsService } from './backup-secrets.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

const ORG = 'org-1';
const USER = 'user-1';
const TARGET = '11111111-1111-4111-8111-111111111111';

const schemeRow = {
  id: 'sch-1',
  organization_id: ORG,
  target_id: TARGET,
  name: 'Nightly',
  description: null,
  selection: { tiers: {}, components: ['tasks'] },
  options: {},
  include_binary_files: false,
  include_identity: false,
  encrypt_archive: true,
  archive_passphrase_encrypted: 'cipher',
  key_fingerprint: null,
  scheme_version: 3,
  schedule_enabled: false,
  cron_expression: null,
  timezone: 'UTC',
  retention_count: null,
  retention_days: null,
  status: 'draft',
  last_run_at: null,
  last_run_status: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const baseDto = {
  name: 'Nightly',
  target_id: TARGET,
  selection: {
    tiers: {
      content: true,
      configuration: true,
      binary_files: false,
      identity: false,
    },
    components: ['tasks'],
  },
  archive_passphrase: 'a-good-passphrase',
};

describe('BackupSchemesService', () => {
  let service: BackupSchemesService;
  let mockFrom: jest.Mock;
  const originalKey = process.env.AI_ENCRYPTION_SECRET;

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolved).then(resolve);

    return chain;
  }

  beforeEach(() => {
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
    mockFrom = jest.fn();

    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    service = new BackupSchemesService(supabase, new BackupSecretsService());
  });

  afterAll(() => {
    process.env.AI_ENCRYPTION_SECRET = originalKey;
  });

  describe('create', () => {
    it('seals the passphrase and scopes the row to the caller organization', async () => {
      const chain = buildChain({ data: schemeRow, error: null });

      mockFrom.mockReturnValue(chain);

      const result = await service.create(ORG, USER, baseDto as never);
      const [inserted] = (chain.insert as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(inserted.organization_id).toBe(ORG);
      expect(inserted.archive_passphrase_encrypted).toBeTruthy();
      expect(JSON.stringify(inserted)).not.toContain('a-good-passphrase');

      // The passphrase ciphertext must not reach the client either.
      expect(result).not.toHaveProperty('archive_passphrase_encrypted');
      expect(result.has_passphrase).toBe(true);
    });

    it('requires a passphrase when the archive is encrypted', async () => {
      mockFrom.mockReturnValue(buildChain({ data: schemeRow, error: null }));

      await expect(
        service.create(ORG, USER, {
          ...baseDto,
          archive_passphrase: undefined,
        } as never),
      ).rejects.toThrow(/archive_passphrase/);
    });

    it('refuses to disable encryption when the selection holds credentials', async () => {
      mockFrom.mockReturnValue(buildChain({ data: schemeRow, error: null }));

      await expect(
        service.create(ORG, USER, {
          ...baseDto,
          encrypt_archive: false,
          selection: {
            ...baseDto.selection,
            components: ['tasks', 'automations'],
          },
        } as never),
      ).rejects.toThrow(/cannot be switched off/);
    });

    it('allows encryption to be disabled for a selection with no credentials', async () => {
      mockFrom.mockReturnValue(buildChain({ data: schemeRow, error: null }));

      await expect(
        service.create(ORG, USER, {
          ...baseDto,
          encrypt_archive: false,
          archive_passphrase: undefined,
        } as never),
      ).resolves.toBeDefined();
    });

    it('stores the selection exactly as it was ticked, adding nothing', async () => {
      // The regression. This used to run through `componentsWithParents`, so ticking `tasks` was
      // saved as six components and backed up twenty tables — and since the widened list was what
      // got written, the operator's real choice was overwritten and unrecoverable.
      const chain = buildChain({ data: schemeRow, error: null });

      mockFrom.mockReturnValue(chain);

      await service.create(ORG, USER, {
        ...baseDto,
        selection: { ...baseDto.selection, components: ['tasks'] },
      } as never);

      const [inserted] = (chain.insert as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];
      const selection = inserted.selection as { components: string[] };

      expect(selection.components).toEqual(['tasks']);
    });

    it('does not pull in a required parent component behind the operator back', async () => {
      // `tasks` declares requires on spaces/statuses/space_config/processes/relation_types. Naming
      // them here so this fails loudly if the closure is ever reinstated, rather than silently
      // growing every archive again.
      const chain = buildChain({ data: schemeRow, error: null });

      mockFrom.mockReturnValue(chain);

      await service.create(ORG, USER, {
        ...baseDto,
        selection: { ...baseDto.selection, components: ['tasks'] },
      } as never);

      const [inserted] = (chain.insert as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];
      const selection = inserted.selection as { components: string[] };

      for (const parent of [
        'spaces',
        'statuses',
        'space_config',
        'processes',
        'relation_types',
      ]) {
        expect(selection.components).not.toContain(parent);
      }
    });

    it('rejects a component that is not in the registry', async () => {
      mockFrom.mockReturnValue(buildChain({ data: schemeRow, error: null }));

      await expect(
        service.create(ORG, USER, {
          ...baseDto,
          selection: { ...baseDto.selection, components: ['not_a_component'] },
        } as never),
      ).rejects.toThrow(/Unknown backup component/);
    });

    it('rejects a schedule with no cron expression', async () => {
      mockFrom.mockReturnValue(buildChain({ data: schemeRow, error: null }));

      await expect(
        service.create(ORG, USER, {
          ...baseDto,
          schedule_enabled: true,
        } as never),
      ).rejects.toThrow(/requires a cron_expression/);
    });

    it('rejects an unparseable cron expression', async () => {
      mockFrom.mockReturnValue(buildChain({ data: schemeRow, error: null }));

      await expect(
        service.create(ORG, USER, {
          ...baseDto,
          schedule_enabled: true,
          cron_expression: 'not a cron',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a target belonging to another organization', async () => {
      // assertTargetBelongsToOrg resolves nothing for a foreign target id.
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));

      await expect(service.create(ORG, USER, baseDto as never)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('lets an operator narrow a scheme, storing the selection verbatim', async () => {
      // The half of the bug that made it permanent. While the selection was widened on save,
      // unticking a component that something else required simply put it back, so a scheme could
      // only ever grow and there was no way to undo an over-broad choice.
      const chain = buildChain({ data: schemeRow, error: null });

      mockFrom.mockReturnValue(chain);

      await service.update(ORG, 'sch-1', USER, {
        selection: { ...baseDto.selection, components: ['tasks'] },
      } as never);

      const [patch] = (chain.update as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];
      const selection = patch.selection as { components: string[] };

      expect(selection.components).toEqual(['tasks']);
      expect(selection.components).not.toContain('spaces');
    });

    it('bumps scheme_version when the selection changes', async () => {
      const chain = buildChain({ data: schemeRow, error: null });

      mockFrom.mockReturnValue(chain);

      await service.update(ORG, 'sch-1', USER, {
        selection: { ...baseDto.selection, components: ['tasks', 'wiki'] },
      } as never);

      const [patch] = (chain.update as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(patch.scheme_version).toBe(schemeRow.scheme_version + 1);
    });

    it('leaves scheme_version alone when only the name changes', async () => {
      const chain = buildChain({ data: schemeRow, error: null });

      mockFrom.mockReturnValue(chain);

      await service.update(ORG, 'sch-1', USER, { name: 'Renamed' } as never);

      const [patch] = (chain.update as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(patch.scheme_version).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('refuses to delete a scheme that already has runs', async () => {
      const chain = buildChain({ data: schemeRow, error: null, count: 2 });

      mockFrom.mockReturnValue(chain);

      await expect(service.remove(ORG, 'sch-1', USER)).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses to delete when the run count cannot be verified', async () => {
      // Fails CLOSED. Returning 0 here would delete the scheme, and backup_runs cascades into
      // backup_artifacts — orphaning archives already on the remote target, which retention finds
      // only through that ledger.
      // Keyed by table: the scheme must load cleanly so the failure is unambiguously the count.
      const schemes = buildChain({ data: schemeRow, error: null });
      const runs = buildChain({
        data: null,
        error: { message: 'connection reset' },
      });

      mockFrom.mockImplementation((table: string) =>
        table === 'backup_runs' ? runs : schemes,
      );

      await expect(service.remove(ORG, 'sch-1', USER)).rejects.toThrow(
        /Could not verify the run history/,
      );
      expect(schemes.delete).not.toHaveBeenCalled();
    });
  });

  describe('activation', () => {
    function withSchedule(row: Record<string, unknown>) {
      const chain = buildChain({ data: row, error: null });

      mockFrom.mockReturnValue(chain);

      const scheduleService = {
        upsertState: jest.fn().mockResolvedValue(undefined),
        nextRunByScheme: jest.fn().mockResolvedValue({}),
        now: jest.fn().mockResolvedValue(new Date('2026-08-03T12:00:00Z')),
      };

      const scoped = new BackupSchemesService(
        {
          getClient: () => ({ from: mockFrom }),
        } as unknown as SupabaseAdminService,
        new BackupSecretsService(),
        undefined,
        scheduleService as never,
      );

      return { chain, scheduleService, service: scoped };
    }

    it('mirrors the scheme onto the row the scheduler actually reads', async () => {
      const active = {
        ...schemeRow,
        status: 'active',
        schedule_enabled: true,
        cron_expression: '0 2 * * *',
        timezone: 'Europe/Berlin',
      };
      const { service: scoped, scheduleService } = withSchedule(active);

      await scoped.setStatus(ORG, 'sch-1', USER, 'active');

      expect(scheduleService.upsertState).toHaveBeenCalledWith(
        expect.objectContaining({
          schemeId: 'sch-1',
          organizationId: ORG,
          scheduleEnabled: true,
          status: 'active',
          timezone: 'Europe/Berlin',
        }),
      );
    });

    it('refuses to activate when the passphrase was sealed with another server key', async () => {
      // Otherwise every nightly run fails at packaging with a crypto error nobody is watching for.
      const { service: scoped } = withSchedule({
        ...schemeRow,
        encrypt_archive: true,
        key_fingerprint: 'a'.repeat(16),
      });

      await expect(
        scoped.setStatus(ORG, 'sch-1', USER, 'active'),
      ).rejects.toThrow(/different server key/);
    });

    it('re-validates a stored timezone that would throw inside the scheduler', async () => {
      // A scheme saved before the zone check tightened, or edited straight in the database.
      const { service: scoped } = withSchedule({
        ...schemeRow,
        schedule_enabled: true,
        cron_expression: '0 2 * * *',
        timezone: 'Europe/Berlin ',
      });

      await expect(
        scoped.setStatus(ORG, 'sch-1', USER, 'active'),
      ).rejects.toThrow(/time zone/);
    });

    it('reports no next run for a scheme that is scheduled but not active', async () => {
      // A draft never fires, so showing a time would be a lie.
      const { service: scoped } = withSchedule({
        ...schemeRow,
        status: 'draft',
        schedule_enabled: true,
        cron_expression: '0 2 * * *',
      });

      const result = await scoped.get(ORG, 'sch-1');

      expect(result.next_run_at).toBeNull();
    });

    it('pausing leaves the scheme readable and clears the schedule', async () => {
      const { service: scoped, scheduleService } = withSchedule({
        ...schemeRow,
        status: 'paused',
        schedule_enabled: true,
        cron_expression: '0 2 * * *',
      });

      const result = await scoped.setStatus(ORG, 'sch-1', USER, 'paused');

      expect(result.next_run_at).toBeNull();
      expect(scheduleService.upsertState).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'paused' }),
      );
    });
  });
});
