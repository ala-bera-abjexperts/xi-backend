/**
 * @fileoverview Unit tests for HierarchyConfigService.
 * @module src/hierarchy-config/hierarchy-config.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HierarchyConfigService } from './hierarchy-config.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  IHierarchyConfig,
  IHierarchyConfigRecord,
} from './models/hierarchy-config.model';
import {
  validateHierarchyConfig,
  sanitizeHierarchyConfig,
  getValidChildTypesFromConfig,
  FALLBACK_DEFAULT_HIERARCHY_CONFIG,
} from './models/hierarchy-config.model';

describe('validateHierarchyConfig (pure)', () => {
  const good: IHierarchyConfig = {
    version: '1.0',
    levels: [
      {
        id: 'a',
        name: 'A',
        requestType: 'Risiko',
        parentLevelId: null,
        allowedChildren: ['b'],
        columns: [],
        calculationFormula: { type: 'sum', params: {} },
      },
      {
        id: 'b',
        name: 'B',
        requestType: 'Maßnahme',
        parentLevelId: 'a',
        allowedChildren: [],
        columns: [],
        calculationFormula: { type: 'sum', params: {} },
      },
    ],
    columnGroups: [],
  };

  it('accepts a valid two-level tree', () => {
    const r = validateHierarchyConfig(good);
    expect(r.isValid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects duplicate level IDs', () => {
    const bad = structuredClone(good);
    bad.levels[1].id = 'a';
    const r = validateHierarchyConfig(bad);
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /Duplicate level IDs/.test(e.message))).toBe(
      true,
    );
  });

  it('rejects duplicate (requestType, parent) combos', () => {
    const bad = structuredClone(good);
    bad.levels[1].requestType = 'Risiko';
    bad.levels[1].parentLevelId = null;
    const r = validateHierarchyConfig(bad);
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /Duplicate request type/.test(e.message))).toBe(
      true,
    );
  });

  it('rejects invalid parentLevelId reference', () => {
    const bad = structuredClone(good);
    bad.levels[1].parentLevelId = 'ghost';
    const r = validateHierarchyConfig(bad);
    expect(r.errors.some((e) => /Invalid parent ID/.test(e.message))).toBe(
      true,
    );
  });

  it('rejects circular dependency', () => {
    const cyc: IHierarchyConfig = {
      version: '1.0',
      levels: [
        {
          id: 'x',
          name: 'X',
          requestType: 'A',
          parentLevelId: 'y',
          allowedChildren: [],
          columns: [],
          calculationFormula: { type: 'sum', params: {} },
        },
        {
          id: 'y',
          name: 'Y',
          requestType: 'B',
          parentLevelId: 'x',
          allowedChildren: [],
          columns: [],
          calculationFormula: { type: 'sum', params: {} },
        },
      ],
      columnGroups: [],
    };
    const r = validateHierarchyConfig(cyc);
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /Circular dependency/.test(e.message))).toBe(
      true,
    );
  });

  it('rejects broken allowedChildren reference', () => {
    const bad = structuredClone(good);
    bad.levels[0].allowedChildren = ['nope'];
    const r = validateHierarchyConfig(bad);
    expect(
      r.errors.some((e) => /Invalid child reference/.test(e.message)),
    ).toBe(true);
  });

  it('rejects mitigation multiplier outside [0,1]', () => {
    const bad = structuredClone(good);
    bad.levels[0].calculationFormula = {
      type: 'mitigation',
      params: { multiplier: 2 },
    };
    const r = validateHierarchyConfig(bad);
    expect(r.errors.some((e) => /Mitigation multiplier/.test(e.message))).toBe(
      true,
    );
  });

  it('rejects config with no root level', () => {
    const bad = structuredClone(good);
    bad.levels[0].parentLevelId = 'b';
    const r = validateHierarchyConfig(bad);
    expect(
      r.errors.some((e) => /At least one root level/.test(e.message)),
    ).toBe(true);
  });

  it('rejects duplicate column IDs in a level', () => {
    const bad = structuredClone(good);
    bad.levels[0].columns = [
      {
        id: 'c1',
        label: 'C1',
        fieldKey: 'k1',
        dataType: 'number',
        formulaTemplate: 'sum',
        isEditable: false,
        validationRules: { min: 0, max: 4, required: false },
      },
      {
        id: 'c1',
        label: 'C1 dup',
        fieldKey: 'k2',
        dataType: 'number',
        formulaTemplate: 'sum',
        isEditable: false,
        validationRules: { min: 0, max: 4, required: false },
      },
    ];
    const r = validateHierarchyConfig(bad);
    expect(r.errors.some((e) => /Duplicate column IDs/.test(e.message))).toBe(
      true,
    );
  });

  it('handles empty/malformed config gracefully', () => {
    // @ts-expect-error testing bad shape
    const r = validateHierarchyConfig({});
    expect(r.isValid).toBe(false);
  });
});

describe('sanitizeHierarchyConfig', () => {
  it('scrubs columnGroups[].label and nested columns', () => {
    const dirty: IHierarchyConfig = {
      version: '1.0',
      levels: [
        {
          id: 'a',
          name: 'A',
          requestType: 'Risiko',
          parentLevelId: null,
          allowedChildren: [],
          columns: [],
          calculationFormula: { type: 'sum', params: {} },
        },
      ],
      columnGroups: [
        {
          id: 'cg1<script>bad</script>',
          fieldGroupId: 'fg1',
          label: 'javascript:alert(1)',
          columns: [
            {
              id: 'c1',
              label: 'onclick=nope',
              fieldKey: 'k1',
              dataType: 'number',
              formulaTemplate: 'sum',
              isEditable: false,
              validationRules: { min: 0, max: 4, required: false },
            },
          ],
        },
      ],
    };
    const clean = sanitizeHierarchyConfig(dirty);
    expect(clean.columnGroups[0].id).not.toMatch(/script/i);
    expect(clean.columnGroups[0].label).not.toMatch(/javascript:/i);
    expect(clean.columnGroups[0].columns[0].label).not.toMatch(/onclick=/i);
  });

  it('strips script tags, javascript: URLs and onEvent handlers', () => {
    const dirty: IHierarchyConfig = {
      version: '1.0',
      levels: [
        {
          id: 'a<script>alert(1)</script>',
          name: 'javascript:alert(1)',
          requestType: 'onclick=boom',
          parentLevelId: null,
          allowedChildren: [],
          columns: [],
          calculationFormula: { type: 'sum', params: {} },
        },
      ],
      columnGroups: [],
    };
    const clean = sanitizeHierarchyConfig(dirty);
    expect(clean.levels[0].id).not.toMatch(/script/i);
    expect(clean.levels[0].name).not.toMatch(/javascript:/i);
    expect(clean.levels[0].requestType).not.toMatch(/onclick=/i);
  });
});

describe('getValidChildTypesFromConfig', () => {
  it('returns the requestTypes of allowed children', () => {
    const r = getValidChildTypesFromConfig(
      FALLBACK_DEFAULT_HIERARCHY_CONFIG,
      'Geschäftsprozessbewertung',
    );
    expect(r).toContain('Prozessbewertung');
  });
  it('returns [] for unknown requestType', () => {
    expect(
      getValidChildTypesFromConfig(FALLBACK_DEFAULT_HIERARCHY_CONFIG, 'nope'),
    ).toEqual([]);
  });
});

describe('HierarchyConfigService', () => {
  let service: HierarchyConfigService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;

  const mockConfig: IHierarchyConfig = {
    version: '1.0',
    levels: [
      {
        id: 'a',
        name: 'A',
        requestType: 'Risiko',
        parentLevelId: null,
        allowedChildren: [],
        columns: [],
        calculationFormula: { type: 'sum', params: {} },
      },
    ],
    columnGroups: [],
  };

  const mockRecord: IHierarchyConfigRecord = {
    id: '00000000-0000-0000-0000-000000000001',
    organization_id: '00000000-0000-0000-0000-000000000010',
    space_id: '00000000-0000-0000-0000-000000000020',
    config: mockConfig,
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
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockResolvedValue(resolved);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;
    service = new HierarchyConfigService(supa);
  });

  describe('getDefaultConfig', () => {
    it('returns RPC result when available', async () => {
      mockRpc.mockResolvedValue({ data: mockConfig, error: null });
      const r = await service.getDefaultConfig();
      expect(r.levels).toHaveLength(1);
      expect(mockRpc).toHaveBeenCalledWith('get_default_hierarchy_config_json');
    });

    it('falls back to local default when RPC fails', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
      const r = await service.getDefaultConfig();
      expect(r.levels.length).toBeGreaterThan(0);
    });
  });

  describe('getConfig', () => {
    it('returns existing config for the space', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const r = await service.getConfig(
        mockRecord.organization_id,
        mockRecord.space_id!,
      );
      expect(r.config).toEqual(mockConfig);
      expect(r.isDefault).toBe(false);
    });

    it('returns default config when no record exists (does NOT persist)', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      mockRpc.mockResolvedValue({ data: mockConfig, error: null });
      const r = await service.getConfig(
        mockRecord.organization_id,
        mockRecord.space_id!,
      );
      expect(r.isDefault).toBe(true);
      expect(r.record).toBeNull();
    });

    it('rejects invalid spaceId format at service level', async () => {
      await expect(
        service.getConfig(mockRecord.organization_id, 'not-a-uuid'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('saveConfig', () => {
    it('upserts a valid config (update path when record exists)', async () => {
      mockFrom
        // exists() count head
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 1 }))
        // update -> select -> single
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }));
      const r = await service.saveConfig(
        mockRecord.organization_id,
        mockRecord.space_id!,
        mockConfig,
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });

    it('creates when no record exists', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }))
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }));
      const r = await service.saveConfig(
        mockRecord.organization_id,
        mockRecord.space_id!,
        mockConfig,
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });

    it('rejects invalid config with BadRequest', async () => {
      const bad = {
        version: '1.0',
        levels: [],
        columnGroups: [],
      } as unknown as IHierarchyConfig;
      await expect(
        service.saveConfig(
          mockRecord.organization_id,
          mockRecord.space_id!,
          bad,
          null,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects malformed spaceId', async () => {
      await expect(
        service.saveConfig(mockRecord.organization_id, 'bad', mockConfig, null),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resetToDefault', () => {
    it('upserts the default config', async () => {
      mockRpc.mockResolvedValue({ data: mockConfig, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }))
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }));
      const r = await service.resetToDefault(
        mockRecord.organization_id,
        mockRecord.space_id!,
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });
  });

  describe('importConfig', () => {
    it('sanitizes then saves', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 1 }))
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }));
      const r = await service.importConfig(
        mockRecord.organization_id,
        mockRecord.space_id!,
        mockConfig,
        null,
      );
      expect(r.id).toBe(mockRecord.id);
    });
  });

  describe('exportConfig', () => {
    it('returns wrapped export payload', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const r = await service.exportConfig(
        mockRecord.organization_id,
        mockRecord.space_id!,
      );
      expect(r.organizationId).toBe(mockRecord.organization_id);
      expect(r.config).toEqual(mockConfig);
      expect(typeof r.exportedAt).toBe('string');
    });
  });

  describe('deleteConfig', () => {
    it('deletes when record exists', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // findBySpace
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      await expect(
        service.deleteConfig(mockRecord.organization_id, mockRecord.space_id!),
      ).resolves.toBeUndefined();
    });

    it('throws NotFound when nothing to delete', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.deleteConfig(mockRecord.organization_id, mockRecord.space_id!),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getValidChildTypes', () => {
    it('uses RPC result when it succeeds', async () => {
      mockRpc.mockResolvedValue({ data: ['Prozessbewertung'], error: null });
      const r = await service.getValidChildTypes(
        mockRecord.organization_id,
        mockRecord.space_id!,
        'Geschäftsprozessbewertung',
      );
      expect(r).toEqual(['Prozessbewertung']);
    });

    it('falls back to config lookup when RPC fails', async () => {
      mockRpc
        .mockResolvedValueOnce({ data: null, error: { message: 'nope' } }) // RPC child types
        .mockResolvedValueOnce({
          data: FALLBACK_DEFAULT_HIERARCHY_CONFIG,
          error: null,
        }); // default config RPC
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: {
            ...mockRecord,
            config: FALLBACK_DEFAULT_HIERARCHY_CONFIG,
          },
          error: null,
        }),
      );
      const r = await service.getValidChildTypes(
        mockRecord.organization_id,
        mockRecord.space_id!,
        'Geschäftsprozessbewertung',
      );
      expect(r).toContain('Prozessbewertung');
    });
  });

  describe('validateConfig (public)', () => {
    it('returns isValid:true on good config', () => {
      const r = service.validateConfig(mockConfig);
      expect(r.isValid).toBe(true);
    });

    it('returns isValid:false with errors on bad config', () => {
      const r = service.validateConfig({
        version: '1.0',
        levels: [],
        columnGroups: [],
      } as unknown as IHierarchyConfig);
      expect(r.isValid).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    });
  });
});
