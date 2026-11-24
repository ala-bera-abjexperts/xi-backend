import {
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TaskHierarchyConfigService } from '../../task-hierarchy-config/task-hierarchy-config.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import { TEST_STATUSES } from '../dto/test-status.dto';
import { TestManagementSettingsService } from './test-management-settings.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of ['select', 'eq', 'upsert']) {
    chain[name] = jest.fn(() => chain);
  }

  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);

  return chain;
}

function firstArg(mock: jest.Mock): unknown {
  return (mock.mock.calls as unknown[][])[0]?.[0];
}

describe('TestManagementSettingsService', () => {
  let service: TestManagementSettingsService;
  let from: jest.Mock;
  let assertAvailable: jest.Mock;
  let log: jest.Mock;

  beforeEach(() => {
    from = jest.fn();
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    log = jest.fn().mockResolvedValue(undefined);

    service = new TestManagementSettingsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
    );
  });

  describe('getSettings', () => {
    it('returns the defaults when the space has no settings row', async () => {
      const chain = buildChain({ data: null, error: null });

      from.mockReturnValueOnce(chain);

      await expect(service.getSettings(ORG, SPACE)).resolves.toEqual({
        assignee_only: false,
        coverable_task_type_ids: [],
        defect_task_type_id: null,
        case_task_type_id: null,
        set_task_type_id: null,
        plan_task_type_id: null,
        execution_task_type_id: null,
        precondition_task_type_id: null,
        test_types: [],
        requirement_link_task_type_ids: [],
      });
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);
      expect(from).toHaveBeenCalledWith('test_management_space_settings');
      expect(chain.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    });

    it('returns the stored values', async () => {
      const row = {
        assignee_only: true,
        coverable_task_type_ids: ['story'],
        defect_task_type_id: 'bug',
      };

      from.mockReturnValueOnce(buildChain({ data: row, error: null }));

      await expect(service.getSettings(ORG, SPACE)).resolves.toEqual({
        ...row,
        case_task_type_id: null,
        set_task_type_id: null,
        plan_task_type_id: null,
        execution_task_type_id: null,
        precondition_task_type_id: null,
        test_types: [],
        requirement_link_task_type_ids: [],
      });
    });

    it('does not read when the module is not available', async () => {
      assertAvailable.mockRejectedValueOnce(new ForbiddenException());

      await expect(service.getSettings(ORG, SPACE)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(from).not.toHaveBeenCalled();
    });

    it('turns a database error into a 500', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: null, error: { code: 'XX000', message: 'boom' } }),
      );

      await expect(service.getSettings(ORG, SPACE)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('getSettings mapping repair', () => {
    const mapped = {
      case_task_type_id: 'test_case',
      set_task_type_id: 'test_set',
      plan_task_type_id: 'test_plan',
      execution_task_type_id: 'test_execution',
      precondition_task_type_id: 'test_precondition',
    };
    let repairing: TestManagementSettingsService;
    let sync: jest.SpyInstance;

    beforeEach(() => {
      repairing = new TestManagementSettingsService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        { assertAvailable } as unknown as TestManagementAccessService,
        { logActionForRequest: log } as unknown as AuditLogsService,
        { ensureTaskTypes: jest.fn() } as unknown as TaskHierarchyConfigService,
      );
      sync = jest
        .spyOn(repairing, 'syncTaskTypes')
        .mockResolvedValue(undefined);
    });

    it('restores a missing mapping once and returns the re-read row', async () => {
      from
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: mapped, error: null }));

      await expect(repairing.getSettings(ORG, SPACE)).resolves.toMatchObject(
        mapped,
      );
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith(ORG, SPACE, true, null);
      expect(from).toHaveBeenCalledTimes(2);
    });

    it('returns the re-read row without another sync when the mapping is still missing', async () => {
      from
        .mockReturnValueOnce(
          buildChain({
            data: { ...mapped, plan_task_type_id: null },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: { ...mapped, plan_task_type_id: null },
            error: null,
          }),
        );

      await expect(repairing.getSettings(ORG, SPACE)).resolves.toMatchObject({
        plan_task_type_id: null,
      });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledTimes(2);
    });

    it('does not sync when every kind is mapped', async () => {
      from.mockReturnValueOnce(buildChain({ data: mapped, error: null }));

      await expect(repairing.getSettings(ORG, SPACE)).resolves.toMatchObject(
        mapped,
      );
      expect(sync).not.toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('returns the loaded settings and warns when the sync fails', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      sync.mockRejectedValueOnce(new Error('boom'));
      from.mockReturnValueOnce(
        buildChain({
          data: { ...mapped, case_task_type_id: null },
          error: null,
        }),
      );

      await expect(repairing.getSettings(ORG, SPACE)).resolves.toMatchObject({
        ...mapped,
        case_task_type_id: null,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
      expect(from).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('does not sync without the task hierarchy service', async () => {
      const noSync = jest.spyOn(service, 'syncTaskTypes');

      from.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(service.getSettings(ORG, SPACE)).resolves.toMatchObject({
        case_task_type_id: null,
      });
      expect(noSync).not.toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateSettings', () => {
    it('upserts only assignee_only and logs the change', async () => {
      const chain = buildChain({
        data: {
          assignee_only: true,
          coverable_task_type_ids: ['story'],
          defect_task_type_id: null,
        },
        error: null,
      });

      from.mockReturnValueOnce(chain);

      const result = await service.updateSettings(user, SPACE, {
        assignee_only: true,
      });

      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, {
        write: true,
      });
      expect(firstArg(chain.upsert)).toEqual({
        space_id: SPACE,
        organization_id: ORG,
        assignee_only: true,
        updated_by: 'user-1',
      });
      expect((chain.upsert.mock.calls as unknown[][])[0][1]).toEqual({
        onConflict: 'space_id',
      });
      expect(result.coverable_task_type_ids).toEqual(['story']);
      expect(log).toHaveBeenCalledWith(
        user,
        'test_management_settings',
        SPACE,
        'update',
        { assignee_only: true },
      );
    });

    it('does not log when the save fails', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: null, error: { code: '23514', message: 'check' } }),
      );

      await expect(
        service.updateSettings(user, SPACE, { assignee_only: false }),
      ).rejects.toMatchObject({ status: 400 });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('updateSettings traceability', () => {
    let getActiveTypes: jest.Mock;
    let checking: TestManagementSettingsService;

    // One chain answers the saved-settings read (maybeSingle) and the upsert (single).
    function settingsChain(saved: Record<string, unknown> | null): Chain {
      const chain = buildChain({ data: saved, error: null });

      chain.single = jest.fn().mockResolvedValue({ data: {}, error: null });

      return chain;
    }

    function rejection(field: string, ids: string[], message: string) {
      return {
        status: 400,
        response: expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message,
          data: { field, task_type_ids: ids },
        }) as unknown,
      };
    }

    beforeEach(() => {
      getActiveTypes = jest
        .fn()
        .mockResolvedValue([{ id: 'story' }, { id: 'bug' }, { id: 'task' }]);
      checking = new TestManagementSettingsService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        { assertAvailable } as unknown as TestManagementAccessService,
        { logActionForRequest: log } as unknown as AuditLogsService,
        { getActiveTypes } as unknown as TaskHierarchyConfigService,
      );
    });

    it('rejects an empty body with 400 VALIDATION_FAILED and logs nothing', async () => {
      const empty = {
        status: 400,
        response: expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: 'Send at least one setting',
        }) as unknown,
      };

      await expect(
        checking.updateSettings(user, SPACE, {}),
      ).rejects.toMatchObject(empty);
      await expect(
        checking.updateSettings(user, SPACE, {
          assignee_only: undefined,
          coverable_task_type_ids: undefined,
          defect_task_type_id: undefined,
        }),
      ).rejects.toMatchObject(empty);
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(from).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('saves requirement types that are active', async () => {
      const chain = settingsChain(null);

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        coverable_task_type_ids: ['story'],
      });

      expect(getActiveTypes).toHaveBeenCalledWith(ORG, SPACE);
      expect(firstArg(chain.upsert)).toEqual({
        space_id: SPACE,
        organization_id: ORG,
        coverable_task_type_ids: ['story'],
        updated_by: 'user-1',
      });
      expect((chain.upsert.mock.calls as unknown[][])[0][1]).toEqual({
        onConflict: 'space_id',
      });
      expect(log).toHaveBeenCalledWith(
        user,
        'test_management_settings',
        SPACE,
        'update',
        { coverable_task_type_ids: ['story'] },
      );
    });

    it('rejects an unknown type', async () => {
      const chain = settingsChain(null);

      from.mockReturnValue(chain);

      await expect(
        checking.updateSettings(user, SPACE, {
          coverable_task_type_ids: ['story', 'ghost'],
        }),
      ).rejects.toMatchObject(
        rejection(
          'coverable_task_type_ids',
          ['ghost'],
          'Unknown or inactive ticket type',
        ),
      );
      expect(chain.upsert).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('keeps an inactive type that is already saved in the same field', async () => {
      const chain = settingsChain({ coverable_task_type_ids: ['old'] });

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        coverable_task_type_ids: ['old', 'story'],
      });

      expect(firstArg(chain.upsert)).toMatchObject({
        coverable_task_type_ids: ['old', 'story'],
      });
    });

    it('rejects an inactive type saved only in the other field', async () => {
      const chain = settingsChain({ defect_task_type_id: 'old' });

      from.mockReturnValue(chain);

      await expect(
        checking.updateSettings(user, SPACE, {
          coverable_task_type_ids: ['old'],
        }),
      ).rejects.toMatchObject(
        rejection(
          'coverable_task_type_ids',
          ['old'],
          'Unknown or inactive ticket type',
        ),
      );
      expect(chain.upsert).not.toHaveBeenCalled();
    });

    it('rejects a Test Management ticket type', async () => {
      const chain = settingsChain({ case_task_type_id: 'test_case' });

      getActiveTypes.mockResolvedValue([{ id: 'story' }, { id: 'test_case' }]);
      from.mockReturnValue(chain);

      await expect(
        checking.updateSettings(user, SPACE, {
          defect_task_type_id: 'test_case',
        }),
      ).rejects.toMatchObject(
        rejection(
          'defect_task_type_id',
          ['test_case'],
          'A Test Management ticket type cannot be a requirement or defect type',
        ),
      );
      expect(chain.upsert).not.toHaveBeenCalled();
    });

    it('allows a defect type that is already a requirement type', async () => {
      const chain = settingsChain({ coverable_task_type_ids: ['bug'] });

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        defect_task_type_id: 'bug',
      });

      expect(firstArg(chain.upsert)).toMatchObject({
        defect_task_type_id: 'bug',
      });
    });

    it('allows requirement types that contain the saved defect type', async () => {
      const chain = settingsChain({ defect_task_type_id: 'bug' });

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        coverable_task_type_ids: ['story', 'bug'],
      });

      expect(firstArg(chain.upsert)).toMatchObject({
        coverable_task_type_ids: ['story', 'bug'],
      });
    });

    it('clears the defect type with null', async () => {
      const chain = settingsChain({ defect_task_type_id: 'bug' });

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, { defect_task_type_id: null });

      expect(firstArg(chain.upsert)).toEqual({
        space_id: SPACE,
        organization_id: ORG,
        defect_task_type_id: null,
        updated_by: 'user-1',
      });
      expect(log).toHaveBeenCalledWith(
        user,
        'test_management_settings',
        SPACE,
        'update',
        { defect_task_type_id: null },
      );
    });

    it('does not check ticket types for an assignee_only change', async () => {
      const chain = settingsChain(null);

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, { assignee_only: true });

      expect(from).toHaveBeenCalledTimes(1);
      expect(chain.maybeSingle).not.toHaveBeenCalled();
      expect(getActiveTypes).not.toHaveBeenCalled();
    });

    it('saves link requirement types that are active', async () => {
      const chain = settingsChain(null);

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        requirement_link_task_type_ids: ['story', 'task'],
      });

      expect(getActiveTypes).toHaveBeenCalledWith(ORG, SPACE);
      expect(firstArg(chain.upsert)).toEqual({
        space_id: SPACE,
        organization_id: ORG,
        requirement_link_task_type_ids: ['story', 'task'],
        updated_by: 'user-1',
      });
      expect(log).toHaveBeenCalledWith(
        user,
        'test_management_settings',
        SPACE,
        'update',
        { requirement_link_task_type_ids: ['story', 'task'] },
      );
    });

    it('saves an empty link requirement list without checking types', async () => {
      const chain = settingsChain(null);

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        requirement_link_task_type_ids: [],
      });

      expect(firstArg(chain.upsert)).toEqual({
        space_id: SPACE,
        organization_id: ORG,
        requirement_link_task_type_ids: [],
        updated_by: 'user-1',
      });
    });

    it('rejects an unknown link requirement type', async () => {
      const chain = settingsChain(null);

      from.mockReturnValue(chain);

      await expect(
        checking.updateSettings(user, SPACE, {
          requirement_link_task_type_ids: ['story', 'ghost'],
        }),
      ).rejects.toMatchObject(
        rejection(
          'requirement_link_task_type_ids',
          ['ghost'],
          'Unknown or inactive ticket type',
        ),
      );
      expect(chain.upsert).not.toHaveBeenCalled();
    });

    it('keeps an inactive link requirement type already saved in that field', async () => {
      const chain = settingsChain({ requirement_link_task_type_ids: ['old'] });

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        requirement_link_task_type_ids: ['old', 'story'],
      });

      expect(firstArg(chain.upsert)).toMatchObject({
        requirement_link_task_type_ids: ['old', 'story'],
      });
    });

    it('allows a Test Management ticket type as a link requirement type', async () => {
      const chain = settingsChain({ case_task_type_id: 'test_case' });

      getActiveTypes.mockResolvedValue([{ id: 'story' }, { id: 'test_case' }]);
      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        requirement_link_task_type_ids: ['story', 'test_case'],
      });

      expect(firstArg(chain.upsert)).toMatchObject({
        requirement_link_task_type_ids: ['story', 'test_case'],
      });
    });

    it('still rejects a Test Management ticket type as a requirement type', async () => {
      const chain = settingsChain({ case_task_type_id: 'test_case' });

      getActiveTypes.mockResolvedValue([{ id: 'story' }, { id: 'test_case' }]);
      from.mockReturnValue(chain);

      await expect(
        checking.updateSettings(user, SPACE, {
          coverable_task_type_ids: ['test_case'],
        }),
      ).rejects.toMatchObject(
        rejection(
          'coverable_task_type_ids',
          ['test_case'],
          'A Test Management ticket type cannot be a requirement or defect type',
        ),
      );
      expect(chain.upsert).not.toHaveBeenCalled();
    });

    it('allows the defect type as a link requirement type', async () => {
      const chain = settingsChain({ defect_task_type_id: 'bug' });

      from.mockReturnValue(chain);

      await checking.updateSettings(user, SPACE, {
        requirement_link_task_type_ids: ['bug'],
      });

      expect(firstArg(chain.upsert)).toMatchObject({
        requirement_link_task_type_ids: ['bug'],
      });
    });

    it('fails with a 500 when the task hierarchy service is missing', async () => {
      from.mockReturnValue(settingsChain(null));

      await expect(
        service.updateSettings(user, SPACE, {
          coverable_task_type_ids: ['story'],
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('listStatuses', () => {
    it('returns the fixed status list as a copy', async () => {
      const statuses = await service.listStatuses(ORG, SPACE);

      expect(statuses).toEqual([...TEST_STATUSES]);
      expect(statuses).not.toBe(TEST_STATUSES);
      expect(statuses.map((status) => status.code)).toContain('PASS');
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);
    });
  });

  describe('syncTaskTypes', () => {
    const caseLevel = {
      id: 'test_case',
      name: 'Test case',
      color: '#00A3BF',
      icon: 'lucide:file',
      sort_order: 100,
    };
    // The case type is always offered as "Test cases"; the old names "Test case" and "Test" are renamed.
    const syncedCase = {
      level: {
        ...caseLevel,
        name: 'Test cases',
        name_i18n: { de: 'Testfälle' },
      },
      renameFrom: ['Test case', 'Test'],
    };
    const setLevel = {
      id: 'test_set',
      name: 'Test set',
      color: '#6554C0',
      icon: 'lucide:folder',
      sort_order: 101,
    };
    const defaults = [
      { kind: 'cases', ...caseLevel },
      { kind: 'sets', ...setLevel },
      { kind: 'unknown', id: 'other', name: 'Other' },
    ];
    let ensureTaskTypes: jest.Mock;
    let syncing: TestManagementSettingsService;

    function writable(resolved: Resolved): Chain {
      const chain = buildChain(resolved);

      chain.insert = jest.fn(() => chain);
      chain.update = jest.fn(() => chain);

      return chain;
    }

    beforeEach(() => {
      ensureTaskTypes = jest.fn();
      syncing = new TestManagementSettingsService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        { assertAvailable } as unknown as TestManagementAccessService,
        { logActionForRequest: log } as unknown as AuditLogsService,
        { ensureTaskTypes } as unknown as TaskHierarchyConfigService,
      );
    });

    it('creates the settings row and saves the new type ids', async () => {
      const created = writable({
        data: {
          case_task_type_id: null,
          set_task_type_id: null,
          task_type_defaults: defaults,
        },
        error: null,
      });
      const saved = writable({ data: null, error: null });

      from
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(created)
        .mockReturnValueOnce(saved);
      ensureTaskTypes.mockResolvedValue({
        case_task_type_id: 'test_case',
        set_task_type_id: 'test_set',
      });

      await syncing.syncTaskTypes(ORG, SPACE, true, 'user-1');

      expect(firstArg(created.insert)).toEqual({
        space_id: SPACE,
        organization_id: ORG,
        updated_by: 'user-1',
      });
      expect(ensureTaskTypes).toHaveBeenCalledWith(
        ORG,
        SPACE,
        [
          { key: 'case_task_type_id', currentId: null, ...syncedCase },
          { key: 'set_task_type_id', currentId: null, level: setLevel },
        ],
        true,
        'user-1',
      );
      expect(firstArg(saved.update)).toEqual({
        case_task_type_id: 'test_case',
        set_task_type_id: 'test_set',
        updated_by: 'user-1',
      });
      expect(assertAvailable).not.toHaveBeenCalled();
    });

    it('saves only the mapping columns that changed', async () => {
      const saved = writable({ data: null, error: null });

      from
        .mockReturnValueOnce(
          buildChain({
            data: {
              case_task_type_id: 'test_case',
              set_task_type_id: 'test_set',
              task_type_defaults: defaults,
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(saved);
      ensureTaskTypes.mockResolvedValue({
        case_task_type_id: 'test_case',
        set_task_type_id: 'test_set_2',
      });

      await syncing.syncTaskTypes(ORG, SPACE, true, 'user-1');

      expect(ensureTaskTypes).toHaveBeenCalledWith(
        ORG,
        SPACE,
        [
          {
            key: 'case_task_type_id',
            currentId: 'test_case',
            ...syncedCase,
          },
          { key: 'set_task_type_id', currentId: 'test_set', level: setLevel },
        ],
        true,
        'user-1',
      );
      expect(firstArg(saved.update)).toEqual({
        set_task_type_id: 'test_set_2',
        updated_by: 'user-1',
      });
    });

    it('deactivates the types without a settings write when the ids are unchanged', async () => {
      from.mockReturnValueOnce(
        buildChain({
          data: {
            case_task_type_id: 'test_case',
            set_task_type_id: 'test_set',
            task_type_defaults: defaults,
          },
          error: null,
        }),
      );
      ensureTaskTypes.mockResolvedValue({
        case_task_type_id: 'test_case',
        set_task_type_id: 'test_set',
      });

      await syncing.syncTaskTypes(ORG, SPACE, false, 'user-1');

      expect((ensureTaskTypes.mock.calls as unknown[][])[0]?.[3]).toBe(false);
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('does nothing when switched off for a space without settings', async () => {
      from.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await syncing.syncTaskTypes(ORG, SPACE, false, 'user-1');

      expect(ensureTaskTypes).not.toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('fails clearly when the task hierarchy service is missing', async () => {
      await expect(
        service.syncTaskTypes(ORG, SPACE, true, 'user-1'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('mappedTaskTypeIds', () => {
    it('returns the set type ids without a module check', async () => {
      from.mockReturnValueOnce(
        buildChain({
          data: {
            case_task_type_id: 'test_case',
            set_task_type_id: null,
            precondition_task_type_id: 'test_precondition',
          },
          error: null,
        }),
      );

      await expect(service.mappedTaskTypeIds(ORG, SPACE)).resolves.toEqual([
        'test_case',
        'test_precondition',
      ]);
      expect(assertAvailable).not.toHaveBeenCalled();
    });

    it('returns nothing for a space without settings', async () => {
      from.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(service.mappedTaskTypeIds(ORG, SPACE)).resolves.toEqual([]);
    });

    it('returns nothing while the mapping columns are not migrated', async () => {
      from.mockReturnValueOnce(
        buildChain({
          data: null,
          error: { code: '42703', message: 'column does not exist' },
        }),
      );

      await expect(service.mappedTaskTypeIds(ORG, SPACE)).resolves.toEqual([]);
    });

    it('turns any other database error into a 500', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: null, error: { code: 'XX000', message: 'boom' } }),
      );

      await expect(
        service.mappedTaskTypeIds(ORG, SPACE),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });
});
