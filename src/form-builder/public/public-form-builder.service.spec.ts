import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { PublicFormBuilderService } from './public-form-builder.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { FormBuilderSubmissionEventsService } from '../form-builder-submission-events.service';
import type { FormBuilderAssignmentsService } from '../form-builder-assignments.service';
import type { FormBuilderPaymentConfigService } from '../form-builder-payment-config.service';
import type { FormBuilderPaymentsService } from '../form-builder-payments.service';
import type { RecaptchaVerifierService } from './recaptcha-verifier.service';
import type { FormBuilderUploadsService } from '../form-builder-uploads.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';

function buildChain(resolved: {
  data: unknown;
  error?: unknown;
  count?: number;
}) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  const settled = { error: null, ...resolved };

  for (const method of [
    'select',
    'eq',
    'neq',
    'is',
    'in',
    'gte',
    'order',
    'limit',
    'insert',
    'update',
  ]) {
    chain[method] = jest.fn().mockImplementation(self);
  }

  chain.single = jest.fn().mockResolvedValue(settled);
  chain.maybeSingle = jest.fn().mockResolvedValue(settled);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(settled).then(onFulfilled);

  return chain;
}

const SLUG = 'employee-onboarding';
const SPACE_ID = 'space-1';
const ORG_ID = 'org-1';

const publishedForm = {
  id: 'form-1',
  organization_id: ORG_ID,
  space_id: SPACE_ID,
  name: 'Employee Onboarding',
  description: null,
  status: 'published',
  settings: {},
  is_deleted: false,
  is_public: true,
  public_slug: SLUG,
};

const safeField = {
  id: 'f1',
  field_key: 'full_name',
  field_type: 'short_text',
  label: 'Your name',
  placeholder: null,
  help_text: null,
  required: false,
  options: null,
  validation_rules: null,
  page_index: 0,
  section: null,
  column_span: null,
  sort_order: 0,
  conditional_logic: null,
  calculation: null,
  default_value: null,
};

const liveSpace = { is_active: true, is_archived: false };
const liveOrg = { is_active: true };

const assignee: RequestUser = {
  userId: 'user-assignee',
  isActive: true,
} as RequestUser;

describe('PublicFormBuilderService — gate ladder', () => {
  let service: PublicFormBuilderService;
  let mockFrom: jest.Mock;
  let orgModules: { isEnabled: jest.Mock };

  /**
   * Queues one chain per `from(table)` call, in call order.
   * resolvePublicForm's order is: form_builder -> spaces -> organizations ->
   * form_builder_fields -> form_builder_assignments -> [space_members | organization_members]
   */
  function wire(queues: Record<string, ReturnType<typeof buildChain>[]>) {
    mockFrom.mockImplementation((table: string) => {
      const queue = queues[table];

      if (!queue?.length) throw new Error(`unexpected from('${table}')`);

      return queue.shift();
    });
  }

  function baseQueues(
    overrides: Partial<{
      form: unknown;
      space: unknown;
      org: unknown;
      fields: unknown[];
      assignments: unknown[];
      spaceMember: unknown;
      orgMember: unknown;
    }> = {},
  ) {
    return {
      form_builder: [buildChain({ data: overrides.form ?? publishedForm })],
      spaces: [buildChain({ data: overrides.space ?? liveSpace })],
      organizations: [buildChain({ data: overrides.org ?? liveOrg })],
      form_builder_fields: [
        buildChain({ data: overrides.fields ?? [safeField] }),
      ],
      form_builder_assignments: [
        buildChain({ data: overrides.assignments ?? [] }),
      ],
      space_members: [buildChain({ data: overrides.spaceMember ?? null })],
      organization_members: [buildChain({ data: overrides.orgMember ?? null })],
    };
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    orgModules = { isEnabled: jest.fn().mockResolvedValue(true) };

    service = new PublicFormBuilderService(
      {
        getClient: () => ({ from: mockFrom }),
      } as unknown as SupabaseAdminService,
      orgModules as unknown as OrganizationModulesService,
      { dispatch: jest.fn() } as unknown as FormBuilderSubmissionEventsService,
      {
        markCompletedOnSubmit: jest.fn(),
      } as unknown as FormBuilderAssignmentsService,
      // Unused by the gate-ladder/definition tests in this file — only the
      // `products`/`recaptcha`/upload paths touch these.
      {} as unknown as FormBuilderPaymentConfigService,
      {} as unknown as FormBuilderPaymentsService,
      {} as unknown as RecaptchaVerifierService,
      {} as unknown as FormBuilderUploadsService,
    );
  });

  describe('serving at all', () => {
    it('serves an anonymous form with no assignees', async () => {
      wire(baseQueues());

      const def = await service.getDefinition(SLUG);

      expect(def.audience).toBe('anonymous');
      expect(def.fields).toHaveLength(1);
    });

    // The slug is interpolated into a PostgREST filter, so the format check must
    // happen BEFORE any query is issued.
    it.each(['../etc', 'Has Spaces', 'UPPER', '-leading', 'trailing-', 'ab'])(
      'rejects malformed slug %s without querying',
      async (bad) => {
        wire({});

        await expect(service.getDefinition(bad)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(mockFrom).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['not marked public', { ...publishedForm, is_public: false }],
      ['still a draft', { ...publishedForm, status: 'draft' }],
      ['disabled', { ...publishedForm, status: 'disabled' }],
      ['soft-deleted', { ...publishedForm, is_deleted: true }],
    ])('404s when the form is %s', async (_label, form) => {
      wire(baseQueues({ form }));

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when the space is archived', async () => {
      wire(baseQueues({ space: { is_active: true, is_archived: true } }));

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when the organization is deactivated', async () => {
      wire(baseQueues({ org: { is_active: false } }));

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // Fails CLOSED — a licensing outage must not un-gate a paid module.
    it('404s when the form builder module is not enabled for the org', async () => {
      orgModules.isEnabled.mockResolvedValueOnce(false);
      wire(baseQueues());

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orgModules.isEnabled).toHaveBeenCalledWith(ORG_ID, 'form_builder');
    });

    it('404s when the form contains a field type unsafe for public filling', async () => {
      // `user_select` and every other palette type are publishable by the 2026-09-10 owner
      // decision; an unrecognised type is the remaining thing the whitelist still rejects.
      wire(
        baseQueues({
          fields: [
            safeField,
            { ...safeField, field_key: 'mystery', field_type: 'not_a_real_type' },
          ],
        }),
      );

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('assignment gate', () => {
    const assignments = [{ assignee_user_id: 'user-assignee' }];

    it('401s an anonymous visitor so the page can offer sign-in', async () => {
      wire(baseQueues({ assignments }));

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('403s a signed-in user who is not an assignee', async () => {
      wire(baseQueues({ assignments }));

      await expect(
        service.getDefinition(SLUG, {
          userId: 'someone-else',
          isActive: true,
        } as RequestUser),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403s a deactivated assignee', async () => {
      wire(baseQueues({ assignments }));

      await expect(
        service.getDefinition(SLUG, {
          ...assignee,
          isActive: false,
        } as RequestUser),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // The assignment row outlives space membership (FK cascades only on user
    // DELETE), so an offboarded assignee would otherwise keep a working link.
    it('403s an assignee who is no longer an active space member', async () => {
      wire(baseQueues({ assignments, spaceMember: null }));

      await expect(
        service.getDefinition(SLUG, assignee),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('serves an active assignee and attributes them', async () => {
      wire(
        baseQueues({ assignments, spaceMember: { user_id: 'user-assignee' } }),
      );

      const def = await service.getDefinition(SLUG, assignee);

      expect(def.audience).toBe('assignee');
    });

    // assign() always expands roles to per-user rows, so this shape is not
    // reachable through the API — but RLS permits a direct insert, and treating
    // "rows exist, no user ids" as ungated would serve an assigned form to the
    // whole internet.
    it('treats role-only assignment rows as gated, not open', async () => {
      wire(
        baseQueues({
          assignments: [{ assignee_user_id: null }],
        }),
      );

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('require_login (no assignees)', () => {
    const form = { ...publishedForm, settings: { require_login: true } };

    it('401s an anonymous visitor', async () => {
      wire(baseQueues({ form }));

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('403s a signed-in user from another organization', async () => {
      wire(baseQueues({ form, orgMember: null }));

      await expect(
        service.getDefinition(SLUG, {
          userId: 'outsider',
          isActive: true,
        } as RequestUser),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('serves a member of the form organization', async () => {
      wire(baseQueues({ form, orgMember: { user_id: 'insider' } }));

      const def = await service.getDefinition(SLUG, {
        userId: 'insider',
        isActive: true,
      } as RequestUser);

      expect(def.audience).toBe('org_member');
    });
  });

  describe('definition payload', () => {
    // Regression: the serializer allowlists top-level `settings` keys one by one, and the card
    // options were missing — a card-layout form published with "2 fields per card" reached the
    // public page with only `layout: 'card'` and silently rendered one question per card.
    it('carries the card-layout options through', async () => {
      wire(
        baseQueues({
          form: {
            ...publishedForm,
            settings: {
              layout: 'card',
              card_fields_per_card: 3,
              card_cards_per_view: 2,
              card_welcome: false,
              card_stepper: true,
              card_orientation: 'vertical',
            },
          },
        }),
      );

      const def = await service.getDefinition(SLUG);

      expect(def.form).toMatchObject({
        layout: 'card',
        card_fields_per_card: 3,
        card_cards_per_view: 2,
        card_welcome: false,
        card_stepper: true,
        card_orientation: 'vertical',
      });
    });

    // A form saved before these settings existed must land on the same defaults the authenticated
    // preview uses, or the two renderers disagree for every pre-existing form.
    it('defaults the card options when settings predate them', async () => {
      wire(baseQueues());

      const def = await service.getDefinition(SLUG);

      expect(def.form).toMatchObject({
        layout: 'classic',
        card_fields_per_card: 1,
        card_cards_per_view: 1,
        card_welcome: true,
        card_stepper: false,
        card_orientation: 'horizontal',
      });
    });

    it('never exposes redirect_url', async () => {
      wire(
        baseQueues({
          form: {
            ...publishedForm,
            settings: { redirect_url: 'https://example.com/thanks' },
          },
        }),
      );

      const def = await service.getDefinition(SLUG);

      expect(JSON.stringify(def)).not.toContain('example.com');
    });

    // validation_rules also carries task_field mappings and provider config.
    it('strips unsafe validation_rules keys but keeps layout ones', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              validation_rules: {
                maxLength: 50,
                width: 'half',
                task_field: 'assigned_to',
                calendlyUrl: 'https://calendly.com/secret',
              },
            },
          ],
        }),
      );

      const def = await service.getDefinition(SLUG);
      const rules = def.fields[0].validation_rules as Record<string, unknown>;

      expect(rules).toEqual({ maxLength: 50, width: 'half' });
    });

    it('does not leak internal field ids', async () => {
      wire(baseQueues());

      const def = await service.getDefinition(SLUG);

      expect(def.fields[0]).not.toHaveProperty('id');
    });

    // Regression: `image`'s src lives at validation_rules.url, which the type-agnostic allowlist
    // stripped — the field then rendered nothing at all on a published form.
    it('keeps validation_rules.url on an image field', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              field_type: 'image',
              validation_rules: { url: 'https://cdn.example.com/logo.png' },
            },
          ],
        }),
      );

      const def = await service.getDefinition(SLUG);

      expect(def.fields[0].validation_rules).toEqual({
        url: 'https://cdn.example.com/logo.png',
      });
    });

    // Type gating: a per-type extra key must not leak onto an unrelated type through the same key
    // name — url/calendlyUrl living in two different maps must stay isolated per field_type.
    it('does not carry an image field type extra key onto calendly_scheduler, or vice versa', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              field_key: 'logo',
              field_type: 'image',
              validation_rules: {
                url: 'https://cdn.example.com/logo.png',
                calendlyUrl: 'https://calendly.com/you/30min',
              },
            },
            {
              ...safeField,
              field_key: 'booking',
              field_type: 'calendly_scheduler',
              validation_rules: {
                url: 'https://cdn.example.com/logo.png',
                calendlyUrl: 'https://calendly.com/you/30min',
              },
            },
          ],
        }),
      );

      const def = await service.getDefinition(SLUG);
      const image = def.fields.find((f) => f.field_key === 'logo');
      const booking = def.fields.find((f) => f.field_key === 'booking');

      expect(image?.validation_rules).toEqual({
        url: 'https://cdn.example.com/logo.png',
      });
      expect(booking?.validation_rules).toEqual({
        calendlyUrl: 'https://calendly.com/you/30min',
      });
    });

    // Security regression guard: the reCAPTCHA secret must never reach the public payload,
    // regardless of any other allowlist change.
    it('never exposes recaptcha_secret_key', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              field_type: 'recaptcha',
              validation_rules: {
                recaptcha_site_key: 'site-key-123',
                recaptcha_secret_key: 'super-secret',
              },
            },
          ],
        }),
      );

      const def = await service.getDefinition(SLUG);

      expect(JSON.stringify(def)).not.toContain('super-secret');
      expect(def.fields[0].validation_rules).toEqual({
        recaptcha_site_key: 'site-key-123',
      });
    });

    // image_select renders a per-option thumbnail — a string image must survive, a non-string one
    // (which has no meaningful <img src>) must not.
    it('keeps a string option image on image_select and drops a non-string one', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              field_type: 'image_select',
              options: [
                {
                  label: 'Cat',
                  value: 'cat',
                  image: 'https://cdn.example.com/cat.png',
                },
                { label: 'Dog', value: 'dog', image: 42 },
              ],
            },
          ],
        }),
      );

      const def = await service.getDefinition(SLUG);

      expect(def.fields[0].options).toEqual([
        {
          label: 'Cat',
          value: 'cat',
          image: 'https://cdn.example.com/cat.png',
        },
        { label: 'Dog', value: 'dog' },
      ]);
    });

    // Regression: layout's `options.rows`/`options.columns` are CELL COUNTS (numbers), not
    // `{label,value}` arrays like matrix's — the generic reducer's shape check therefore always
    // failed for a layout field, and the entire grid (and every element inside it) vanished on a
    // published form.
    it('preserves a layout grid and its cells', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              field_type: 'layout',
              options: {
                rows: 1,
                columns: 2,
                gap: 12,
                rowGap: 12,
                align: 'stretch',
                columnPreset: 'equal',
                mode: 'grid',
                flexDirection: 'row',
                wrap: true,
                justify: 'start',
                cells: [
                  [
                    {
                      type: 'short_text',
                      label: 'First name',
                      fieldKey: 'cell-a',
                    },
                    { type: 'email', label: 'Email', fieldKey: 'cell-b' },
                  ],
                ],
              },
            },
          ],
        }),
      );

      const def = await service.getDefinition(SLUG);
      const options = def.fields[0].options as Record<string, unknown>;

      expect(options.cells).toEqual([
        [
          { type: 'short_text', label: 'First name', fieldKey: 'cell-a' },
          { type: 'email', label: 'Email', fieldKey: 'cell-b' },
        ],
      ]);
      expect(options).toMatchObject({ rows: 1, columns: 2, mode: 'grid' });
    });

    // `hidden` is publishable now, so the cell scan is proven with a type the whitelist has never
    // assessed — that is the case the 404 still exists for.
    it('404s a form whose layout grid nests an unrecognised cell type', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              field_type: 'layout',
              options: {
                rows: 1,
                columns: 1,
                cells: [[{ type: 'not_a_real_type', label: 'Secret' }]],
              },
            },
          ],
        }),
      );

      await expect(service.getDefinition(SLUG)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // A `user_select` scoped to a custom, author-curated list is safe to serve — it never touches
    // the space/organization directory.
    it('serves a custom-source user_select with its curated options', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              field_type: 'user_select',
              validation_rules: { userSource: 'custom' },
              options: [{ label: 'Jane', value: 'user_abc123' }],
            },
          ],
        }),
      );

      const def = await service.getDefinition(SLUG);

      expect(def.fields[0].options).toEqual([
        { label: 'Jane', value: 'user_abc123' },
      ]);
    });

    // Was a 404 — space/organization sources resolve the member directory. Published by owner
    // decision. The anonymous page still cannot read that directory, so the picker serves empty
    // until the options are resolved server-side the way assets are.
    it('serves a user_select scoped to the space/organization directory', async () => {
      wire(
        baseQueues({
          fields: [
            {
              ...safeField,
              field_type: 'user_select',
              validation_rules: { userSource: 'space' },
            },
          ],
        }),
      );

      const def = await service.getDefinition(SLUG);

      expect(def.fields).toHaveLength(1);
    });
  });

  describe('sanitizeValue size budget', () => {
    // Data-URI capture types (camera/signature) legitimately produce answers far larger than the
    // default 10 000-char cap — they get a dedicated, larger budget; every other type keeps the
    // original cap unchanged.
    it('allows a large data URI for camera/signature but rejects the same length for short_text', () => {
      const dataUri = `data:image/jpeg;base64,${'A'.repeat(50_000)}`;

      expect(() =>
        (
          service as unknown as {
            sanitizeValue: (v: unknown, t?: string) => unknown;
          }
        ).sanitizeValue(dataUri, 'camera'),
      ).not.toThrow();

      expect(() =>
        (
          service as unknown as {
            sanitizeValue: (v: unknown, t?: string) => unknown;
          }
        ).sanitizeValue(dataUri, 'short_text'),
      ).toThrow(/too long/i);
    });

    // multi_photo is bounded on TOTAL combined length, not per-entry — otherwise
    // MAX_ARRAY_LENGTH × a per-entry cap could approach the 10 MB body-parser limit.
    it('caps multi_photo on total combined length across the array', () => {
      const photos = Array.from({ length: 5 }, () => 'A'.repeat(500_000));

      expect(() =>
        (
          service as unknown as {
            sanitizeValue: (v: unknown, t?: string) => unknown;
          }
        ).sanitizeValue(photos, 'multi_photo'),
      ).toThrow(/total size/i);
    });
  });
});
