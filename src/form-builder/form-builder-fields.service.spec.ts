import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { FormBuilderFieldsService } from './form-builder-fields.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('FormBuilderFieldsService', () => {
  let service: FormBuilderFieldsService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;

  // Chainable Supabase query-builder mock (see form-builder.service.spec for the
  // shared pattern). Terminal `.order()` etc. are awaited directly via `then`.
  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
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
    mockRpc = jest.fn();

    // Default: the form is not shared publicly, so `replaceAll`'s public-safety lookup is a no-op.
    // Tests that care override this with their own chain.
    mockFrom.mockReturnValue(
      buildChain({ data: { is_public: false }, error: null }),
    );

    const supabase = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderFieldsService(supabase);
  });

  describe('list', () => {
    it('returns fields ordered by sort_order for the form/space/org', async () => {
      const rows = [
        { id: 'field-1', field_key: 'q1', sort_order: 0 },
        { id: 'field-2', field_key: 'q2', sort_order: 1 },
      ];
      const chain = buildChain({ data: rows, error: null });

      mockFrom.mockReturnValue(chain);

      await expect(service.list('form-1', 'space-1', 'org-1')).resolves.toEqual(
        rows,
      );

      expect(mockFrom).toHaveBeenCalledWith('form_builder_fields');
      expect(chain.eq).toHaveBeenCalledWith('form_id', 'form-1');
      expect(chain.eq).toHaveBeenCalledWith('space_id', 'space-1');
      expect(chain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(chain.order).toHaveBeenCalledWith('sort_order', {
        ascending: true,
      });
    });

    it('throws BadRequestException on a query error', async () => {
      const chain = buildChain({ data: null, error: { message: 'boom' } });

      mockFrom.mockReturnValue(chain);

      await expect(service.list('form-1', 'space-1', 'org-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('replaceAll', () => {
    const simpleDto = {
      version: 2,
      fields: [
        {
          field_key: 'q1',
          field_type: 'short_text',
          label: 'Q1',
          sort_order: 0,
        },
      ],
    };

    // A live public link is validated for unsafe field types when it is ENABLED, but nothing used to
    // re-check afterwards. Adding e.g. a Products field to an already-shared form silently killed the
    // link: the public resolver 404s on the same rule, and every public failure deliberately collapses
    // to an opaque "Form not found", so the author had no way to see why.
    describe('public-safety re-check', () => {
      const productsDto = {
        version: 2,
        fields: [
          {
            field_key: 'q1',
            field_type: 'short_text',
            label: 'Q1',
            sort_order: 0,
          },
          {
            field_key: 'buy',
            field_type: 'products',
            label: 'Buy',
            sort_order: 1,
          },
        ],
      };

      function wireForm(is_public: boolean) {
        mockFrom.mockReturnValue(
          buildChain({ data: { is_public }, error: null }),
        );
      }

      // Products became unconditionally publishable on 2026-09-10 (owner decision), so the
      // re-check is exercised with a type the whitelist has never assessed.
      it('rejects a form containing an unrecognised field type when it is public', async () => {
        wireForm(true);

        const unknownTypeDto = {
          version: 2,
          fields: [
            {
              field_key: 'q1',
              field_type: 'short_text',
              label: 'Q1',
              sort_order: 0,
            },
            {
              field_key: 'mystery',
              field_type: 'not_a_real_type',
              label: 'Mystery',
              sort_order: 1,
            },
          ],
        };

        await expect(
          service.replaceAll(
            'form-1',
            unknownTypeDto as any,
            'space-1',
            'org-1',
            'user-1',
          ),
        ).rejects.toThrow(BadRequestException);

        await expect(
          service.replaceAll(
            'form-1',
            unknownTypeDto as any,
            'space-1',
            'org-1',
            'user-1',
          ),
        ).rejects.toThrow(/not_a_real_type/);

        expect(mockRpc).not.toHaveBeenCalled();
      });

      it('accepts a Products field on a public form with no gateway — products is now publishable', async () => {
        wireForm(true);
        mockRpc.mockResolvedValueOnce({ data: [], error: null });

        await expect(
          service.replaceAll(
            'form-1',
            productsDto as any,
            'space-1',
            'org-1',
            'user-1',
          ),
        ).resolves.toEqual([]);

        expect(mockRpc).toHaveBeenCalled();
      });

      it('allows a Products field on a public form once a gateway is connected', async () => {
        wireForm(true);
        mockRpc.mockResolvedValueOnce({ data: [], error: null });

        const withGateway = new FormBuilderFieldsService(
          { getClient: () => ({ from: mockFrom, rpc: mockRpc }) } as any,
          {
            getFillConfig: jest.fn().mockResolvedValue({ enabled: true }),
          } as any,
        );

        await expect(
          withGateway.replaceAll(
            'form-1',
            productsDto as any,
            'space-1',
            'org-1',
            'user-1',
          ),
        ).resolves.toEqual([]);

        expect(mockRpc).toHaveBeenCalled();
      });

      // Every palette type is publishable by owner decision, so a formerly refused type saves.
      it('accepts a formerly blocked type on a public form', async () => {
        wireForm(true);
        mockRpc.mockResolvedValueOnce({ data: [], error: null });

        const withGateway = new FormBuilderFieldsService(
          { getClient: () => ({ from: mockFrom, rpc: mockRpc }) } as any,
          {
            getFillConfig: jest.fn().mockResolvedValue({ enabled: true }),
          } as any,
        );

        await expect(
          withGateway.replaceAll(
            'form-1',
            {
              version: 2,
              fields: [
                {
                  field_key: 'assignee',
                  field_type: 'user_select',
                  label: 'Assignee',
                  sort_order: 0,
                },
              ],
            } as any,
            'space-1',
            'org-1',
            'user-1',
          ),
        ).resolves.toEqual([]);

        expect(mockRpc).toHaveBeenCalled();
      });

      it('allows the same field types on a form that is not shared publicly', async () => {
        wireForm(false);
        mockRpc.mockResolvedValueOnce({ data: [], error: null });

        await expect(
          service.replaceAll(
            'form-1',
            productsDto as any,
            'space-1',
            'org-1',
            'user-1',
          ),
        ).resolves.toEqual([]);

        expect(mockRpc).toHaveBeenCalled();
      });

      // The check runs on the INCOMING fields, so the save that fixes a broken form must go through.
      it('allows a save that removes the offending field from a public form', async () => {
        wireForm(true);
        mockRpc.mockResolvedValueOnce({ data: [], error: null });

        await expect(
          service.replaceAll(
            'form-1',
            simpleDto as any,
            'space-1',
            'org-1',
            'user-1',
          ),
        ).resolves.toEqual([]);

        expect(mockRpc).toHaveBeenCalled();
      });
    });

    it('calls the replace_form_builder_fields rpc and returns its data', async () => {
      const rpcData = [{ id: 'field-1', field_key: 'q1' }];

      mockRpc.mockResolvedValueOnce({ data: rpcData, error: null });

      await expect(
        service.replaceAll(
          'form-1',
          simpleDto as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).resolves.toEqual(rpcData);

      expect(mockRpc).toHaveBeenCalledWith(
        'replace_form_builder_fields',
        expect.objectContaining({
          p_form_id: 'form-1',
          p_space_id: 'space-1',
          p_organization_id: 'org-1',
          p_user_id: 'user-1',
          p_expected_version: 2,
          p_fields: simpleDto.fields,
        }),
      );
    });

    it('maps the P0001 optimistic-lock error to ConflictException', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'stale' },
      });

      await expect(
        service.replaceAll(
          'form-1',
          simpleDto as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('maps a 23505 unique-violation to a duplicate field_key BadRequestException', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      });

      await expect(
        service.replaceAll(
          'form-1',
          simpleDto as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(/Duplicate field_key/);
    });

    it('maps PGRST116 to NotFoundException', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST116', message: 'no rows' },
      });

      await expect(
        service.replaceAll(
          'form-1',
          simpleDto as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects an over-long validation pattern before hitting the rpc', async () => {
      const badDto = {
        version: 1,
        fields: [
          {
            field_key: 'q1',
            field_type: 'short_text',
            label: 'Q1',
            sort_order: 0,
            validation_rules: { pattern: 'a'.repeat(201) },
          },
        ],
      };

      await expect(
        service.replaceAll(
          'form-1',
          badDto as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(/too long/);

      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects a conditional rule referencing an unknown field', async () => {
      const badDto = {
        version: 1,
        fields: [
          {
            field_key: 'q1',
            field_type: 'short_text',
            label: 'Q1',
            sort_order: 0,
            conditional_logic: {
              action: 'show',
              ruleGroup: {
                combinator: 'and',
                rules: [{ field: 'ghost', operator: 'eq', value: '1' }],
              },
            },
          },
        ],
      };

      await expect(
        service.replaceAll(
          'form-1',
          badDto as any,
          'space-1',
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(/unknown field/);

      expect(mockRpc).not.toHaveBeenCalled();
    });
  });
});
