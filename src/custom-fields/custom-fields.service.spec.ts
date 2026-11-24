/**
 * @fileoverview Unit tests for CustomFieldsService — CRUD, soft/hard delete,
 * restore, permission/system-field rules, and unique field-key generation.
 * @module src/custom-fields/custom-fields.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CustomFieldsService, generateFieldKey } from './custom-fields.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('generateFieldKey', () => {
  it('slugifies a simple name', () => {
    expect(generateFieldKey('Hello World')).toBe('hello_world');
  });
  it('prefixes numeric start', () => {
    expect(generateFieldKey('123 foo')).toBe('f_123_foo');
  });
  it('collapses punctuation', () => {
    expect(generateFieldKey('Foo - Bar!!')).toBe('foo_bar');
  });
  it('falls back to "field" for empty input', () => {
    expect(generateFieldKey('')).toBe('field');
    expect(generateFieldKey('***')).toBe('field');
  });
});

describe('CustomFieldsService', () => {
  let service: CustomFieldsService;
  let mockFrom: jest.Mock;

  const mockField = {
    id: 'cf-1',
    organization_id: 'org-1',
    space_id: null,
    scope: 'organization',
    name: 'Owner',
    field_key: 'owner',
    field_type: 'string',
    description: null,
    description_i18n: {},
    name_i18n: {},
    default_value: null,
    options: [],
    validation_rules: {},
    contexts: [],
    is_system: false,
    is_active: true,
    sort_order: 0,
    created_by: null,
    updated_by: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
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
    chain.ilike = jest.fn().mockImplementation(self);
    chain.contains = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    // Make the chain thenable so terminal `.eq()` calls resolve directly
    // (used by count/head queries where there is no .single()).
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new CustomFieldsService(supa);
  });

  describe('getAll', () => {
    it('returns list of fields', async () => {
      mockFrom.mockReturnValue(buildChain({ data: [mockField], error: null }));
      const result = await service.getAll('org-1');
      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.data[0].id).toBe('cf-1');
    });

    it('throws BadRequest on error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'boom' } }),
      );
      await expect(service.getAll('org-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getBySpace', () => {
    it('returns combined org + space fields', async () => {
      mockFrom.mockReturnValue(buildChain({ data: [mockField], error: null }));
      const result = await service.getBySpace('org-1', 'space-1');
      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
    });
  });

  describe('getById', () => {
    it('returns the field when found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: mockField, error: null }));
      const result = await service.getById('cf-1');
      expect(result.id).toBe('cf-1');
    });
    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));
      await expect(service.getById('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a field with auto-generated key', async () => {
      // 1st call: generateUniqueFieldKey lookup (no conflict)
      // 2nd call: conflict check (no conflict)
      // 3rd call: insert
      const noConflict = buildChain({ data: null, error: null });
      const inserted = buildChain({ data: mockField, error: null });
      mockFrom
        .mockReturnValueOnce(noConflict) // generateUniqueFieldKey
        .mockReturnValueOnce(noConflict) // explicit conflict check
        .mockReturnValueOnce(inserted); // insert
      const result = await service.create('org-1', 'user-1', {
        name: 'Owner',
        field_type: 'string',
      });
      expect(result.id).toBe('cf-1');
    });

    it('throws Conflict when field_key already exists', async () => {
      // The conflict check uses .limit(1), not .maybeSingle(): for an org-level
      // field no space filter applies, so it legitimately matches every
      // space-level row sharing the key. maybeSingle() turned that into a
      // PGRST116 "multiple rows returned" 400 instead of this 409.
      const conflict = buildChain({
        data: [{ id: 'dup' }],
        error: null,
      });
      mockFrom.mockReturnValueOnce(conflict); // explicit conflict check only
      await expect(
        service.create('org-1', 'user-1', {
          name: 'Owner',
          field_type: 'string',
          field_key: 'owner',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('requires space_id when scope=space', async () => {
      await expect(
        service.create('org-1', null, {
          name: 'X',
          field_type: 'string',
          scope: 'space',
        }),
      ).rejects.toThrow(/space_id is required/);
    });

    it('requires options for select field type', async () => {
      await expect(
        service.create('org-1', null, {
          name: 'Prio',
          field_type: 'select',
        }),
      ).rejects.toThrow(/non-empty options/);
    });
  });

  describe('update', () => {
    it('updates allowed fields', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockField, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockField, name: 'New' },
            error: null,
          }),
        );
      const result = await service.update('cf-1', 'user-1', {
        name: 'New',
      });
      expect(result.name).toBe('New');
    });

    it('rejects field_type change', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockField, error: null }),
      );
      await expect(
        service.update('cf-1', 'user-1', { field_type: 'number' }),
      ).rejects.toThrow(/field_type cannot be changed/);
    });

    it('rejects field_key change', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockField, error: null }),
      );
      await expect(
        service.update('cf-1', 'user-1', { field_key: 'x' }),
      ).rejects.toThrow(/field_key cannot be changed/);
    });

    it('rejects system field modification', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...mockField, is_system: true },
          error: null,
        }),
      );
      await expect(
        service.update('cf-1', 'user-1', { name: 'x' }),
      ).rejects.toThrow(/system fields/);
    });
  });

  describe('softDelete', () => {
    it('marks field as deleted', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockField, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // update
      await expect(
        service.softDelete('cf-1', 'user-1'),
      ).resolves.toBeUndefined();
    });

    it('blocks system fields', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...mockField, is_system: true },
          error: null,
        }),
      );
      await expect(service.softDelete('cf-1', 'user-1')).rejects.toThrow(
        /system fields/,
      );
    });
  });

  describe('restore', () => {
    it('restores a deleted field', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockField, is_deleted: true },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: mockField, error: null }));
      const result = await service.restore('cf-1');
      expect(result.id).toBe('cf-1');
    });

    it('rejects active field', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockField, error: null }),
      );
      await expect(service.restore('cf-1')).rejects.toThrow(/not deleted/);
    });
  });

  describe('permanentDelete', () => {
    it('deletes when not in use', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockField, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // isFieldInUse
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      await expect(service.permanentDelete('cf-1')).resolves.toBeUndefined();
    });

    it('blocks when in use', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockField, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 3 }));
      await expect(service.permanentDelete('cf-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('toggleActive', () => {
    it('toggles active flag', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockField, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockField, is_active: false },
            error: null,
          }),
        );
      const result = await service.toggleActive('cf-1', false);
      expect(result.is_active).toBe(false);
    });
    it('blocks deactivating system fields', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...mockField, is_system: true },
          error: null,
        }),
      );
      await expect(service.toggleActive('cf-1', false)).rejects.toThrow(
        /system fields/,
      );
    });
  });

  describe('generateUniqueFieldKey', () => {
    it('returns base key when unused', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const key = await service.generateUniqueFieldKey('org-1', 'Foo Bar');
      expect(key).toBe('foo_bar');
    });
    it('appends counter on conflict', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'x' }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const key = await service.generateUniqueFieldKey('org-1', 'Foo');
      expect(key).toBe('foo_1');
    });
  });

  describe('isFieldInUse', () => {
    it('returns inUse=false when count is 0', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: null, count: 0 }),
      );
      const r = await service.isFieldInUse('cf-1');
      expect(r.inUse).toBe(false);
      expect(r.count).toBe(0);
    });
    it('returns inUse=true with positive count', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: null, count: 2 }),
      );
      const r = await service.isFieldInUse('cf-1');
      expect(r.inUse).toBe(true);
      expect(r.count).toBe(2);
    });
  });
});

describe('SLA custom field lifecycle permissions', () => {
  const field = {
    id: 'sla',
    field_type: 'sla_time',
    scope: 'space',
    space_id: 'space',
    organization_id: 'org',
    is_system: false,
    is_deleted: true,
  };
  const denied = {
    isAdmin: false,
    isMember: true,
    spaceRole: null,
    explicit: { manage_sla: false },
    basePermissions: {},
  };
  function setup(grant = denied, spaceOrg = 'org') {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      returns: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({
          data: { id: 'space', organization_id: spaceOrg },
          error: null,
        }),
    };
    const db = { getClient: () => ({ from: jest.fn(() => chain) }) };
    const permissions = {
      resolveSpaceBaseGrant: jest.fn().mockResolvedValue(grant),
    };
    const service = new CustomFieldsService(
      db as never,
      undefined,
      undefined,
      permissions as never,
    );
    jest.spyOn(service, 'getById').mockResolvedValue(field as never);
    return { service, chain, permissions };
  }
  it.each([
    'update',
    'softDelete',
    'restore',
    'permanentDelete',
    'toggleActive',
  ])('requires manage_sla for %s through generic CRUD', async (method) => {
    const { service, chain } = setup();
    const action =
      method === 'update'
        ? service.update('sla', 'user', { is_active: false }, 'org')
        : method === 'softDelete'
          ? service.softDelete('sla', 'user', 'org')
          : method === 'restore'
            ? service.restore('sla', 'org', 'user')
            : method === 'toggleActive'
              ? service.toggleActive('sla', false, 'org', 'user')
              : service.permanentDelete('sla', 'org', 'user');
    await expect(action).rejects.toThrow('manage_sla');
    expect(chain.select).toHaveBeenCalledTimes(1);
  });
  it('requires manage_sla before creating SLA fields', async () => {
    const { service } = setup();
    await expect(
      service.create('org', 'user', {
        name: 'SLA',
        field_type: 'sla_time',
        scope: 'space',
        space_id: 'space',
      }),
    ).rejects.toThrow('manage_sla');
  });
  it('allows explicit SLA managers and leaves ordinary field permissions unchanged', async () => {
    const allowed = setup({ ...denied, explicit: { manage_sla: true } });
    Object.assign(allowed.chain, {
      update: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: field, error: null }),
    });
    await expect(
      allowed.service.update('sla', 'user', { is_active: false }, 'org'),
    ).resolves.toEqual(field);
    expect(allowed.permissions.resolveSpaceBaseGrant).toHaveBeenCalledWith(
      'user',
      'org',
      'space',
    );
    const ordinary = setup();
    jest
      .spyOn(ordinary.service, 'getById')
      .mockResolvedValue({ ...field, field_type: 'string' } as never);
    Object.assign(ordinary.chain, {
      update: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: field, error: null }),
    });
    await expect(
      ordinary.service.update('ordinary', 'user', { is_active: false }, 'org'),
    ).resolves.toEqual(field);
    expect(ordinary.permissions.resolveSpaceBaseGrant).not.toHaveBeenCalled();
  });
  it('validates actual space tenant before accepting an admin grant', async () => {
    const { service, permissions } = setup(
      { ...denied, isAdmin: true },
      'other',
    );
    await expect(
      service.create('org', 'user', {
        name: 'SLA',
        field_type: 'sla_time',
        scope: 'space',
        space_id: 'space',
      }),
    ).rejects.toThrow('Space not found');
    expect(permissions.resolveSpaceBaseGrant).not.toHaveBeenCalled();
  });
});
