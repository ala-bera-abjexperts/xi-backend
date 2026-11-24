/**
 * @fileoverview Unit tests for TaskHierarchyConfigService.
 * @module src/task-hierarchy-config/task-hierarchy-config.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TaskHierarchyConfigService } from './task-hierarchy-config.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import {
  validateTaskHierarchyConfig,
  getValidChildTypes,
  getValidParentTypes,
  DEFAULT_TASK_HIERARCHY_CONFIG,
  type ITaskHierarchyConfig,
  type ITaskHierarchyConfigRecord,
  type ITaskTypeLevel,
} from './models/task-hierarchy-config.model';

// ------------------------------------------------------------------
// Pure validator tests
// ------------------------------------------------------------------

describe('validateTaskHierarchyConfig (pure)', () => {
  it('accepts the DEFAULT config', () => {
    const r = validateTaskHierarchyConfig(DEFAULT_TASK_HIERARCHY_CONFIG);
    expect(r.isValid).toBe(true);
  });

  it('rejects duplicate task type IDs', () => {
    const bad = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
    bad.levels[1].id = 'epic';
    const r = validateTaskHierarchyConfig(bad);
    expect(r.isValid).toBe(false);
    expect(
      r.errors.some((e) => /Duplicate task type IDs/.test(e.message)),
    ).toBe(true);
  });

  it('rejects invalid parent_level_id', () => {
    const bad = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
    bad.levels[0].parent_level_id = 'ghost';
    const r = validateTaskHierarchyConfig(bad);
    expect(r.errors.some((e) => /Invalid parent ID/.test(e.message))).toBe(
      true,
    );
  });

  it('rejects circular dependencies', () => {
    const bad = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
    bad.levels[0].parent_level_id = 'story';
    const r = validateTaskHierarchyConfig(bad);
    expect(r.errors.some((e) => /Circular dependency/.test(e.message))).toBe(
      true,
    );
  });

  it('rejects bad hex colors', () => {
    const bad = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
    bad.levels[0].color = 'red';
    const r = validateTaskHierarchyConfig(bad);
    expect(r.errors.some((e) => /valid hex color/.test(e.message))).toBe(true);
  });

  it('rejects config with zero root levels', () => {
    const bad = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
    bad.levels.forEach((l) => {
      l.parent_level_id = 'epic';
    });
    const r = validateTaskHierarchyConfig(bad);
    expect(
      r.errors.some((e) => /At least one root task type/.test(e.message)),
    ).toBe(true);
  });

  it('rejects unknown allowed_parent_types reference', () => {
    const bad = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
    bad.levels[0].allowed_parent_types = ['phantom'];
    const r = validateTaskHierarchyConfig(bad);
    expect(
      r.errors.some((e) => /Invalid parent type reference/.test(e.message)),
    ).toBe(true);
  });
});

// ------------------------------------------------------------------
// Pure lookup tests
// ------------------------------------------------------------------

describe('getValidParentTypes / getValidChildTypes (bidirectional)', () => {
  it('story can be parented under epic', () => {
    const parents = getValidParentTypes(DEFAULT_TASK_HIERARCHY_CONFIG, 'story');
    expect(parents.map((p) => p.id)).toContain('epic');
  });

  it('epic has story, task as valid children', () => {
    const children = getValidChildTypes(DEFAULT_TASK_HIERARCHY_CONFIG, 'epic');
    const ids = children.map((c) => c.id);
    expect(ids).toContain('story');
    expect(ids).toContain('task');
  });

  it('inactive parents are excluded', () => {
    const cfg = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
    const epic = cfg.levels.find((l) => l.id === 'epic')!;
    epic.is_active = false;
    const parents = getValidParentTypes(cfg, 'story');
    expect(parents.map((p) => p.id)).not.toContain('epic');
  });
});

// ------------------------------------------------------------------
// Service tests
// ------------------------------------------------------------------

describe('TaskHierarchyConfigService', () => {
  let service: TaskHierarchyConfigService;
  let mockFrom: jest.Mock;

  const ORG = '00000000-0000-0000-0000-0000000000aa';
  const SPACE = '00000000-0000-0000-0000-0000000000bb';

  const mockRecord: ITaskHierarchyConfigRecord = {
    id: '00000000-0000-0000-0000-0000000000cc',
    organization_id: ORG,
    space_id: SPACE,
    config: DEFAULT_TASK_HIERARCHY_CONFIG,
    version: '1.0',
    created_by: null,
    updated_by: null,
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
    chain.not = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
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
    service = new TaskHierarchyConfigService(supa);
  });

  // Saves read the test settings first; answer that read on its own so queued mocks stay in order.
  function serviceWith(
    settings: { data: unknown; error: unknown },
    orgModules?: Pick<OrganizationModulesService, 'isSpaceModuleEnabled'>,
  ): TaskHierarchyConfigService {
    const supa = {
      getClient: () => ({
        from: (table: string) =>
          table === 'test_management_space_settings'
            ? buildChain(settings)
            : (mockFrom(table) as unknown),
      }),
    } as unknown as SupabaseAdminService;

    return new TaskHierarchyConfigService(
      supa,
      orgModules as OrganizationModulesService | undefined,
    );
  }

  beforeEach(() => {
    service = serviceWith({ data: null, error: null });
  });

  // -------- getConfig -----------------------------------------------------

  describe('getConfig', () => {
    it('returns existing record', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const r = await service.getConfig(ORG, SPACE);
      expect(r.record?.id).toBe(mockRecord.id);
      expect(r.isDefault).toBe(false);
    });

    it('returns default when no record', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.getConfig(ORG, SPACE);
      expect(r.isDefault).toBe(true);
      expect(r.config.levels.length).toBeGreaterThan(0);
    });

    it('rejects non-UUID spaceId', async () => {
      await expect(service.getConfig(ORG, 'x')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // -------- saveConfig -----------------------------------------------------

  describe('saveConfig', () => {
    it('creates when no record exists', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // findBySpace
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })); // insert
      const r = await service.saveConfig(
        ORG,
        SPACE,
        DEFAULT_TASK_HIERARCHY_CONFIG,
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });

    it('updates when record exists', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }));
      const r = await service.saveConfig(
        ORG,
        SPACE,
        DEFAULT_TASK_HIERARCHY_CONFIG,
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });

    it('rejects invalid config', async () => {
      const bad = {
        version: '1.0',
        levels: [],
      } as unknown as ITaskHierarchyConfig;
      await expect(service.saveConfig(ORG, SPACE, bad, null)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // -------- resetToDefault -------------------------------------------------

  describe('resetToDefault', () => {
    it('blocks reset while tasks exist in the space', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: null, count: 1 }),
      );

      await expect(service.resetToDefault(ORG, SPACE, null)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('resets when no tasks exist', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // fetch tasks (empty)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // findBySpace
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })); // insert
      const r = await service.resetToDefault(ORG, SPACE, null);
      expect(r.id).toBe(mockRecord.id);
    });
  });

  // -------- addTaskType ----------------------------------------------------

  describe('addTaskType', () => {
    const newType: ITaskTypeLevel = {
      id: 'spike',
      name: 'Spike',
      name_i18n: {},
      description: null,
      description_i18n: {},
      icon: null,
      color: '#000000',
      text_color: '#FFFFFF',
      parent_level_id: null,
      allowed_parent_types: [],
      allowed_child_types: [],
      max_depth: 10,
      default_status: 'open',
      default_priority: 'medium',
      field_group_ids: [],
      allowed_statuses: ['open', 'done'],
      sort_order: 5,
      is_active: true,
    };

    it('appends the type and saves', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // findBySpace for getConfig
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // findBySpace in saveConfig
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })); // update
      const r = await service.addTaskType(ORG, SPACE, newType, null);
      expect(r.id).toBe(mockRecord.id);
    });

    it('rejects duplicate ID', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const dup = { ...newType, id: 'epic' };
      await expect(service.addTaskType(ORG, SPACE, dup, null)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // -------- updateTaskType ------------------------------------------------

  describe('updateTaskType', () => {
    it('prevents changing the id field', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      await expect(
        service.updateTaskType(
          ORG,
          SPACE,
          'epic',
          { id: 'nope' } as unknown as Partial<ITaskTypeLevel>,
          null,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates other fields and saves', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getConfig
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // saveConfig findBySpace
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })); // update
      const r = await service.updateTaskType(
        ORG,
        SPACE,
        'epic',
        { color: '#123456' },
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });

    it('throws NotFound when task type missing', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      await expect(
        service.updateTaskType(ORG, SPACE, 'ghost', { color: '#000000' }, null),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------- removeTaskType ------------------------------------------------

  describe('removeTaskType', () => {
    it('blocks removal when tasks of that type exist', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getConfig
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 1 })); // tasks count
      await expect(
        service.removeTaskType(ORG, SPACE, 'epic', null),
      ).rejects.toThrow(ConflictException);
    });

    it('removes and scrubs references from other types', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getConfig
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // tasks count
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // saveConfig findBySpace
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // saveConfig removed type usage check
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })); // update
      const r = await service.removeTaskType(ORG, SPACE, 'bug', null);
      expect(r.id).toBe(mockRecord.id);
    });

    it('throws NotFound when task type missing', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      await expect(
        service.removeTaskType(ORG, SPACE, 'ghost', null),
      ).rejects.toThrow(NotFoundException);
    });

    it('blocks removal that would leave the config with zero root types', async () => {
      // Craft a config where only ONE root exists — removing it should
      // fail because validateTaskHierarchyConfig requires ≥1 root.
      const singleRoot: ITaskHierarchyConfig = {
        version: '1.0',
        levels: [
          {
            id: 'only',
            name: 'Only',
            name_i18n: {},
            description: null,
            description_i18n: {},
            icon: null,
            color: '#000000',
            text_color: '#FFFFFF',
            parent_level_id: null,
            allowed_parent_types: [],
            allowed_child_types: [],
            max_depth: 10,
            default_status: 'open',
            default_priority: 'medium',
            field_group_ids: [],
            allowed_statuses: ['open'],
            sort_order: 0,
            is_active: true,
          },
        ],
      };
      const rec = { ...mockRecord, config: singleRoot };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: rec, error: null })) // getConfig
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })); // tasks count
      await expect(
        service.removeTaskType(ORG, SPACE, 'only', null),
      ).rejects.toThrow(ConflictException);
    });
  });

  // -------- reorder --------------------------------------------------------

  describe('reorder', () => {
    it('assigns sort_order by position in the supplied list', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getConfig
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // saveConfig findBySpace
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })); // update
      const r = await service.reorder(
        ORG,
        SPACE,
        ['bug', 'epic', 'story', 'task', 'subtask'],
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });

    it('rejects reorder list missing one or more known IDs', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      await expect(service.reorder(ORG, SPACE, ['epic'], null)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // -------- query variants ------------------------------------------------

  describe('query helpers', () => {
    it('getActiveTypes filters out is_active=false', async () => {
      const cfg = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
      cfg.levels[0].is_active = false;
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockRecord, config: cfg }, error: null }),
      );
      const r = await service.getActiveTypes(ORG, SPACE);
      expect(r.map((t) => t.id)).not.toContain('epic');
    });

    it('getRootTypes returns only types with no parent_level_id', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const r = await service.getRootTypes(ORG, SPACE);
      expect(r.every((t) => t.parent_level_id === null)).toBe(true);
    });

    it('getTypeById returns the matching type or null', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }));
      const found = await service.getTypeById(ORG, SPACE, 'epic');
      expect(found?.id).toBe('epic');
      const missing = await service.getTypeById(ORG, SPACE, 'nope');
      expect(missing).toBeNull();
    });
  });

  // -------- validateConfig (public) ---------------------------------------

  describe('validateConfig (public)', () => {
    it('returns isValid:true on good', () => {
      const r = service.validateConfig(DEFAULT_TASK_HIERARCHY_CONFIG);
      expect(r.isValid).toBe(true);
    });
    it('returns isValid:false on bad', () => {
      const r = service.validateConfig({
        version: '1.0',
        levels: [],
      } as unknown as ITaskHierarchyConfig);
      expect(r.isValid).toBe(false);
    });
  });

  describe('ensureTaskTypes', () => {
    const testCase = {
      key: 'cases',
      currentId: null,
      level: { id: 'test_case', name: 'Test case', color: '#00A3BF' },
    };

    type SavedRow = { config: ITaskHierarchyConfig };

    function savedLevels(chain: Record<string, unknown>): ITaskTypeLevel[] {
      const update = chain.update as jest.Mock<unknown, [SavedRow]>;

      return update.mock.calls[0][0].config.levels;
    }

    it('adds a missing type and returns its id', async () => {
      const updateChain = buildChain({ data: mockRecord, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // findBySpace
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // saveConfig findBySpace
        .mockReturnValueOnce(updateChain);
      const ids = await service.ensureTaskTypes(
        ORG,
        SPACE,
        [testCase],
        true,
        null,
      );
      expect(ids).toEqual({ cases: 'test_case' });
      const added = savedLevels(updateChain).find((l) => l.id === 'test_case');
      expect(added).toMatchObject({ parent_level_id: null, is_active: true });
    });

    it('adopts an active type with the default id instead of adding a copy', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const ids = await service.ensureTaskTypes(
        ORG,
        SPACE,
        [{ ...testCase, level: { ...testCase.level, id: 'task' } }],
        true,
        null,
      );
      expect(ids).toEqual({ cases: 'task' });
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('adopts and reactivates an inactive type with the default id when the mapping is lost', async () => {
      const config = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
      config.levels.find((l) => l.id === 'bug')!.is_active = false;
      const record = { ...mockRecord, config };
      const updateChain = buildChain({ data: record, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: record, error: null }))
        .mockReturnValueOnce(buildChain({ data: record, error: null }))
        .mockReturnValueOnce(updateChain);
      const ids = await service.ensureTaskTypes(
        ORG,
        SPACE,
        [{ ...testCase, level: { ...testCase.level, id: 'bug' } }],
        true,
        null,
      );
      expect(ids).toEqual({ cases: 'bug' });
      const levels = savedLevels(updateChain);
      expect(levels).toHaveLength(config.levels.length);
      expect(levels.find((l) => l.id === 'bug')?.is_active).toBe(true);
      expect(levels.some((l) => l.id === 'bug_2')).toBe(false);
    });

    it('adopts the type with the default id when the mapped id is gone', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const ids = await service.ensureTaskTypes(
        ORG,
        SPACE,
        [
          {
            ...testCase,
            currentId: 'removed_type',
            level: { ...testCase.level, id: 'task' },
          },
        ],
        true,
        null,
      );
      expect(ids).toEqual({ cases: 'task' });
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('reactivates a linked type that was switched off', async () => {
      const config = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
      config.levels.find((l) => l.id === 'bug')!.is_active = false;
      const record = { ...mockRecord, config };
      const updateChain = buildChain({ data: record, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: record, error: null }))
        .mockReturnValueOnce(buildChain({ data: record, error: null }))
        .mockReturnValueOnce(updateChain);
      const ids = await service.ensureTaskTypes(
        ORG,
        SPACE,
        [{ ...testCase, currentId: 'bug' }],
        true,
        null,
      );
      expect(ids).toEqual({ cases: 'bug' });
      expect(
        savedLevels(updateChain).find((l) => l.id === 'bug')?.is_active,
      ).toBe(true);
    });

    it('saves nothing when switching off a space without its own row', async () => {
      const orgChain = buildChain({ data: null, error: null });
      orgChain.limit = jest.fn().mockReturnValue(orgChain);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // findBySpace
        .mockReturnValueOnce(orgChain);
      const ids = await service.ensureTaskTypes(
        ORG,
        SPACE,
        [testCase],
        false,
        null,
      );
      expect(ids).toEqual({});
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });

    it('starts from the org row and adds missing built-in types', async () => {
      const orgLevel = {
        ...DEFAULT_TASK_HIERARCHY_CONFIG.levels.find((l) => l.id === 'task')!,
        id: 'org_type',
        name: 'Org type',
      };
      const orgChain = buildChain({
        data: { config: { version: '1.0', levels: [orgLevel] } },
        error: null,
      });
      orgChain.limit = jest.fn().mockReturnValue(orgChain);
      const insertChain = buildChain({ data: mockRecord, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // findBySpace
        .mockReturnValueOnce(orgChain)
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // saveConfig findBySpace
        .mockReturnValueOnce(insertChain);
      await service.ensureTaskTypes(ORG, SPACE, [testCase], true, null);
      const insert = insertChain.insert as jest.Mock<unknown, [SavedRow]>;
      const inserted = insert.mock.calls[0][0];
      expect(inserted.config.levels.map((l) => l.id)).toEqual([
        'org_type',
        ...DEFAULT_TASK_HIERARCHY_CONFIG.levels.map((l) => l.id),
        'test_case',
      ]);
    });

    it('renames a linked type that still has an old default name', async () => {
      const config = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
      config.levels.find((l) => l.id === 'bug')!.name = 'Test case';
      const record = { ...mockRecord, config };
      const updateChain = buildChain({ data: record, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: record, error: null }))
        .mockReturnValueOnce(buildChain({ data: record, error: null }))
        .mockReturnValueOnce(updateChain);
      await service.ensureTaskTypes(
        ORG,
        SPACE,
        [
          {
            ...testCase,
            currentId: 'bug',
            level: {
              ...testCase.level,
              name: 'Test',
              name_i18n: { de: 'Test' },
            },
            renameFrom: ['Test case'],
          },
        ],
        true,
        null,
      );
      expect(
        savedLevels(updateChain).find((l) => l.id === 'bug'),
      ).toMatchObject({
        name: 'Test',
        name_i18n: { de: 'Test' },
      });
    });

    it('keeps a name the user changed', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      await service.ensureTaskTypes(
        ORG,
        SPACE,
        [
          {
            ...testCase,
            currentId: 'bug',
            level: { ...testCase.level, name: 'Test' },
            renameFrom: ['Test case'],
          },
        ],
        true,
        null,
      );
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });
  });

  describe('reserved task type name', () => {
    const reserved = { response: { code: 'TASK_TYPE_NAME_RESERVED' } };
    const spike = (overrides: Partial<ITaskTypeLevel>): ITaskTypeLevel => ({
      ...DEFAULT_TASK_HIERARCHY_CONFIG.levels.find((l) => l.id === 'task')!,
      id: 'spike',
      name: 'Spike',
      sort_order: 50,
      ...overrides,
    });

    function recordWithTestType() {
      const config = structuredClone(DEFAULT_TASK_HIERARCHY_CONFIG);
      config.levels.find((l) => l.id === 'bug')!.name = 'Test';

      return { ...mockRecord, config };
    }

    it('refuses adding a type named Test in any case or spacing', async () => {
      for (const name of ['Test', ' TEST ']) {
        mockFrom.mockReturnValueOnce(
          buildChain({ data: mockRecord, error: null }),
        );
        await expect(
          service.addTaskType(ORG, SPACE, spike({ name }), null),
        ).rejects.toMatchObject(reserved);
      }
    });

    it('refuses adding a type with the id test', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      await expect(
        service.addTaskType(
          ORG,
          SPACE,
          spike({ id: 'test', name: 'QA' }),
          null,
        ),
      ).rejects.toMatchObject(reserved);
    });

    it('allows names that only contain test', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }));
      const r = await service.addTaskType(
        ORG,
        SPACE,
        spike({ name: 'Testing' }),
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });

    it('refuses renaming a type to Test', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      await expect(
        service.updateTaskType(ORG, SPACE, 'bug', { name: 'Test' }, null),
      ).rejects.toMatchObject(reserved);
    });

    it('keeps an existing type named Test editable', async () => {
      const record = recordWithTestType();
      mockFrom
        .mockReturnValueOnce(buildChain({ data: record, error: null }))
        .mockReturnValueOnce(buildChain({ data: record, error: null }))
        .mockReturnValueOnce(buildChain({ data: record, error: null }));
      const r = await service.updateTaskType(
        ORG,
        SPACE,
        'bug',
        { color: '#123456' },
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });

    it('refuses a full save that adds a type named Test', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const next = {
        ...DEFAULT_TASK_HIERARCHY_CONFIG,
        levels: [
          ...DEFAULT_TASK_HIERARCHY_CONFIG.levels,
          spike({ name: 'test' }),
        ],
      };
      await expect(
        service.assertNoReservedTypeNames(ORG, SPACE, next),
      ).rejects.toMatchObject(reserved);
    });

    it('accepts a full save that keeps an existing type named Test', async () => {
      const record = recordWithTestType();
      mockFrom.mockReturnValueOnce(buildChain({ data: record, error: null }));
      await expect(
        service.assertNoReservedTypeNames(ORG, SPACE, record.config),
      ).resolves.toBeUndefined();
    });

    it('does not check names when saving directly, as imports do', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }));
      const next = {
        ...DEFAULT_TASK_HIERARCHY_CONFIG,
        levels: [
          ...DEFAULT_TASK_HIERARCHY_CONFIG.levels,
          spike({ id: 'xray_test', name: 'Test' }),
        ],
      };
      const r = await service.saveConfig(ORG, SPACE, next, null);
      expect(r.id).toBe(mockRecord.id);
    });
  });

  describe('saveConfig test task types', () => {
    const testLevel: ITaskTypeLevel = {
      ...DEFAULT_TASK_HIERARCHY_CONFIG.levels.find((l) => l.id === 'task')!,
      id: 'test_case',
      name: 'Test case',
      parent_level_id: null,
      allowed_parent_types: [],
      allowed_child_types: [],
      is_active: true,
    };
    const mapped = { data: { case_task_type_id: 'test_case' }, error: null };
    let isSpaceModuleEnabled: jest.Mock<
      Promise<boolean>,
      [string, string, string]
    >;

    function configWith(level: ITaskTypeLevel): ITaskHierarchyConfig {
      return {
        ...DEFAULT_TASK_HIERARCHY_CONFIG,
        levels: [...DEFAULT_TASK_HIERARCHY_CONFIG.levels, level],
      };
    }

    function useModule(
      on: boolean,
      settings: { data: unknown; error: unknown } = mapped,
    ): void {
      isSpaceModuleEnabled = jest
        .fn<Promise<boolean>, [string, string, string]>()
        .mockResolvedValue(on);
      service = serviceWith(settings, { isSpaceModuleEnabled });
    }

    function queueSave(existing: ITaskHierarchyConfig): void {
      const record = { ...mockRecord, config: existing };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: record, error: null })) // findBySpace
        .mockReturnValueOnce(buildChain({ data: record, error: null })); // update
    }

    async function rejection(promise: Promise<unknown>): Promise<unknown> {
      const err: unknown = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);

      return (err as BadRequestException).getResponse();
    }

    const managed = (ids: string[]) => ({
      code: 'TEST_TYPE_MANAGED',
      data: { task_type_ids: ids },
    });

    it('rejects removing a mapped type while the module is on', async () => {
      useModule(true);
      queueSave(configWith(testLevel));
      const r = await rejection(
        service.saveConfig(ORG, SPACE, DEFAULT_TASK_HIERARCHY_CONFIG, null),
      );
      expect(r).toMatchObject(managed(['test_case']));
      expect(isSpaceModuleEnabled).toHaveBeenCalledWith(
        ORG,
        SPACE,
        'test_management',
      );
    });

    it('rejects deactivating a mapped type while the module is on', async () => {
      useModule(true);
      queueSave(configWith(testLevel));
      const next = configWith({ ...testLevel, is_active: false });
      expect(
        await rejection(service.saveConfig(ORG, SPACE, next, null)),
      ).toMatchObject(managed(['test_case']));
    });

    it('rejects giving a mapped type child types while the module is on', async () => {
      useModule(true);
      queueSave(configWith(testLevel));
      const next = configWith({ ...testLevel, allowed_child_types: ['task'] });
      expect(
        await rejection(service.saveConfig(ORG, SPACE, next, null)),
      ).toMatchObject(managed(['test_case']));
    });

    it('rejects another type listing a mapped type as its parent while the module is on', async () => {
      useModule(true);
      queueSave(configWith(testLevel));
      const next = configWith(testLevel);
      next.levels = next.levels.map((l) =>
        l.id === 'task'
          ? {
              ...l,
              allowed_parent_types: [...l.allowed_parent_types, 'test_case'],
            }
          : l,
      );
      expect(
        await rejection(service.saveConfig(ORG, SPACE, next, null)),
      ).toMatchObject(managed(['task']));
    });

    it('allows renaming and recolouring a mapped type while the module is on', async () => {
      useModule(true);
      queueSave(configWith(testLevel));
      const next = configWith({ ...testLevel, name: 'Test', color: '#123456' });
      const r = await service.saveConfig(ORG, SPACE, next, null);
      expect(r.id).toBe(mockRecord.id);
    });

    it('rejects activating an inactive mapped type while the module is off', async () => {
      useModule(false);
      queueSave(configWith({ ...testLevel, is_active: false }));
      const next = configWith(testLevel);
      expect(
        await rejection(service.saveConfig(ORG, SPACE, next, null)),
      ).toMatchObject(managed(['test_case']));
    });

    it('allows saving with a mapped type kept inactive while the module is off', async () => {
      useModule(false);
      const inactive = { ...testLevel, is_active: false };
      queueSave(configWith(inactive));
      const next = configWith({ ...inactive, name: 'Old tests' });
      const r = await service.saveConfig(ORG, SPACE, next, null);
      expect(r.id).toBe(mockRecord.id);
    });

    it('keeps the old behaviour when the space has no test settings', async () => {
      useModule(true, { data: null, error: null });
      queueSave(configWith(testLevel));
      const next = configWith({
        ...testLevel,
        is_active: false,
        allowed_child_types: ['task'],
      });
      const r = await service.saveConfig(ORG, SPACE, next, null);
      expect(r.id).toBe(mockRecord.id);
      expect(isSpaceModuleEnabled).not.toHaveBeenCalled();
    });

    it('lets ensureTaskTypes switch a mapped type off without the check', async () => {
      useModule(true);
      const record = { ...mockRecord, config: configWith(testLevel) };
      const updateChain = buildChain({ data: record, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: record, error: null })) // findBySpace
        .mockReturnValueOnce(buildChain({ data: record, error: null })) // saveConfig findBySpace
        .mockReturnValueOnce(updateChain);
      const ids = await service.ensureTaskTypes(
        ORG,
        SPACE,
        [
          {
            key: 'cases',
            currentId: 'test_case',
            level: { id: 'test_case', name: 'Test case' },
          },
        ],
        false,
        null,
      );
      expect(ids).toEqual({ cases: 'test_case' });
      const update = updateChain.update as jest.Mock<
        unknown,
        [{ config: ITaskHierarchyConfig }]
      >;
      expect(
        update.mock.calls[0][0].config.levels.find((l) => l.id === 'test_case')
          ?.is_active,
      ).toBe(false);
      expect(isSpaceModuleEnabled).not.toHaveBeenCalled();
    });
  });
});
