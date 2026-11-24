import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { FormBuilderService } from './form-builder.service';
import { FormBuilderFieldsService } from './form-builder-fields.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('FormBuilderService', () => {
  let service: FormBuilderService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let fieldsService: { list: jest.Mock; replaceAll: jest.Mock };

  // Chainable Supabase query-builder mock: every builder method returns `this`;
  // maybeSingle/single resolve the terminal payload, and `then` makes the whole
  // chain directly awaitable (for methods that await the chain, e.g. .order()/.neq()).
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
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.contains = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn().mockResolvedValue({ data: 'FORM-1', error: null });
    fieldsService = {
      list: jest.fn().mockResolvedValue([]),
      replaceAll: jest.fn().mockResolvedValue(undefined),
    };

    const supabase = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderService(
      supabase,
      fieldsService as unknown as FormBuilderFieldsService,
    );
  });

  function queue(tableQueues: Record<string, ReturnType<typeof buildChain>[]>) {
    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());
  }

  describe('list', () => {
    it('returns non-archived, non-template forms for the space/org', async () => {
      const rows = [{ id: 'f1', name: 'Form 1' }];
      const chain = buildChain({ data: rows, error: null });

      queue({ form_builder: [chain] });

      await expect(service.list('space-1', 'org-1')).resolves.toEqual(rows);

      expect(mockFrom).toHaveBeenCalledWith('form_builder');
      expect(chain.eq).toHaveBeenCalledWith('space_id', 'space-1');
      expect(chain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(chain.eq).toHaveBeenCalledWith('is_deleted', false);
      expect(chain.eq).toHaveBeenCalledWith('is_template', false);
      expect(chain.order).toHaveBeenCalledWith('updated_at', {
        ascending: false,
      });
      // default (includeArchived=false) must exclude archived rows
      expect(chain.neq).toHaveBeenCalledWith('status', 'archived');
    });

    it('throws BadRequestException when the query errors', async () => {
      const chain = buildChain({ data: null, error: { message: 'db down' } });

      queue({ form_builder: [chain] });

      await expect(service.list('space-1', 'org-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getOne', () => {
    it('returns the form when found', async () => {
      const form = { id: 'f1', name: 'Form 1' };
      const chain = buildChain({ data: form, error: null });

      queue({ form_builder: [chain] });

      await expect(service.getOne('f1', 'space-1', 'org-1')).resolves.toEqual(
        form,
      );

      expect(chain.eq).toHaveBeenCalledWith('id', 'f1');
      expect(chain.maybeSingle).toHaveBeenCalled();
    });

    it('throws NotFoundException when no row matches', async () => {
      const chain = buildChain({ data: null, error: null });

      queue({ form_builder: [chain] });

      await expect(
        service.getOne('missing', 'space-1', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('allocates a form key via rpc and inserts a draft', async () => {
      const created = { id: 'new-1', name: 'My Form', form_key: 'FORM-1' };
      const chain = buildChain({ data: created, error: null });

      queue({ form_builder: [chain] });

      await expect(
        service.create(
          { name: 'My Form', description: 'desc' } as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).resolves.toEqual(created);

      expect(mockRpc).toHaveBeenCalledWith('generate_form_builder_key', {
        p_space_id: 'space-1',
      });
      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org-1',
          space_id: 'space-1',
          name: 'My Form',
          description: 'desc',
          status: 'draft',
          form_key: 'FORM-1',
          version: 1,
          created_by: 'user-1',
          updated_by: 'user-1',
        }),
      );
      expect(chain.single).toHaveBeenCalled();
    });

    it('throws BadRequestException when the form key cannot be allocated', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });

      await expect(
        service.create(
          { name: 'My Form' } as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('bumps the version and applies the patch', async () => {
      const updated = { id: 'f1', name: 'Renamed', version: 3 };
      const chain = buildChain({ data: updated, error: null });

      queue({ form_builder: [chain] });

      await expect(
        service.update(
          'f1',
          { version: 2, name: 'Renamed' } as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).resolves.toEqual(updated);

      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          updated_by: 'user-1',
          version: 3,
          name: 'Renamed',
        }),
      );
      // optimistic lock on the supplied version
      expect(chain.eq).toHaveBeenCalledWith('version', 2);
    });

    it('throws ConflictException when the version is stale but the form exists', async () => {
      const updateChain = buildChain({ data: null, error: null });
      const existsChain = buildChain({ data: { id: 'f1' }, error: null });

      queue({ form_builder: [updateChain, existsChain] });

      await expect(
        service.update(
          'f1',
          { version: 1, name: 'Renamed' } as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when the row does not exist at all', async () => {
      const updateChain = buildChain({ data: null, error: null });
      const existsChain = buildChain({ data: null, error: null });

      queue({ form_builder: [updateChain, existsChain] });

      await expect(
        service.update(
          'gone',
          { version: 1 } as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('soft-deletes and returns success', async () => {
      const chain = buildChain({ data: { id: 'f1' }, error: null });

      queue({ form_builder: [chain] });

      await expect(
        service.remove('f1', 'space-1', 'org-1', 'user-1'),
      ).resolves.toEqual({ success: true });

      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({ is_deleted: true, deleted_by: 'user-1' }),
      );
    });

    it('throws NotFoundException when nothing was soft-deleted', async () => {
      const chain = buildChain({ data: null, error: null });

      queue({ form_builder: [chain] });

      await expect(
        service.remove('missing', 'space-1', 'org-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('duplicate', () => {
    it('clones the form, copies field definitions via the fields service, and re-reads', async () => {
      const source = {
        id: 'src-1',
        name: 'Original',
        description: 'd',
        icon: null,
        settings: { theme: 'x' },
      };
      const newForm = { id: 'new-1', name: 'Original (copy)', version: 1 };
      const finalForm = { id: 'new-1', name: 'Original (copy)', version: 2 };

      const sourceChain = buildChain({ data: source, error: null }); // getOne(source)
      const insertChain = buildChain({ data: newForm, error: null }); // cloneForm insert
      const finalChain = buildChain({ data: finalForm, error: null }); // getOne(new)

      queue({ form_builder: [sourceChain, insertChain, finalChain] });

      fieldsService.list.mockResolvedValueOnce([
        {
          id: 'field-1',
          form_id: 'src-1',
          field_key: 'q1',
          field_type: 'short_text',
          label: 'Q1',
          required: true,
          sort_order: 0,
        },
      ]);

      await expect(
        service.duplicate('src-1', 'space-1', 'org-1', 'user-1'),
      ).resolves.toEqual(finalForm);

      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Original (copy)',
          is_template: false,
          form_key: 'FORM-1',
          version: 1,
        }),
      );
      // field definitions copied verbatim (id/form_id stripped by pickFieldColumns)
      expect(fieldsService.replaceAll).toHaveBeenCalledWith(
        'new-1',
        expect.objectContaining({
          version: 1,
          fields: [
            expect.objectContaining({
              field_key: 'q1',
              field_type: 'short_text',
              label: 'Q1',
              required: true,
              sort_order: 0,
            }),
          ],
        }),
        'space-1',
        'org-1',
        'user-1',
      );
    });
  });
});
