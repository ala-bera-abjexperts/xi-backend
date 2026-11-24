import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PublicFormBuilderService } from '../../form-builder/public/public-form-builder.service';
import { PublicFormService } from './public-form.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';

function chain(result: { data: unknown; error?: unknown }) {
  const c: Record<string, any> = {};
  const self = () => c;
  for (const method of ['select', 'eq', 'order']) c[method] = jest.fn(self);
  c.maybeSingle = jest.fn().mockResolvedValue({ error: null, ...result });
  c.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ error: null, ...result }).then(resolve);
  return c;
}

const form = {
  id: 'form-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  name: 'Form',
  description: null,
  status: 'published',
  settings: {},
  is_deleted: false,
};
const field = {
  id: 'field-1',
  field_key: 'name',
  field_type: 'short_text',
  label: 'Name',
  placeholder: null,
  help_text: null,
  description: null,
  required: false,
  options: null,
  validation_rules: null,
  page_index: 0,
  sort_order: 0,
  is_hidden: false,
  read_only: false,
  conditional_logic: null,
};
const user = (id: string) => ({ userId: id, isActive: true }) as RequestUser;

describe('embedded public form audience gate', () => {
  function setup(
    overrides: {
      form?: any;
      assignments?: any[];
      space?: any;
      org?: any;
      liveSpace?: any;
      liveOrg?: any;
    } = {},
  ) {
    const rows = {
      site_studio_funnels: [
        chain({
          data: { id: 'funnel-1', organization_id: 'org-1', published: true },
        }),
      ],
      site_studio_pages: [
        chain({
          data: [
            {
              id: 'page-1',
              content: [
                { type: 'formBuilderForm', content: { formId: 'form-1' } },
              ],
            },
          ],
        }),
      ],
      form_builder: [chain({ data: { ...form, ...overrides.form } })],
      form_builder_assignments: [chain({ data: overrides.assignments ?? [] })],
      form_builder_fields: [chain({ data: [field] })],
      organization_members: [chain({ data: overrides.org ?? null })],
      space_members: [chain({ data: overrides.space ?? null })],
      spaces: [
        chain({
          data: overrides.liveSpace ?? { is_active: true, is_archived: false },
        }),
      ],
      organizations: [
        chain({ data: overrides.liveOrg ?? { is_active: true } }),
      ],
    } as Record<string, ReturnType<typeof chain>[]>;
    const supabase = {
      getClient: () => ({ from: (table: string) => rows[table].shift() }),
    };
    const audience = new PublicFormBuilderService(
      supabase as never,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const embedded = new PublicFormService(
      supabase as never,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      audience,
      {} as any,
      {} as any,
      {} as any,
    );
    return embedded;
  }

  function resolve(service: PublicFormService, userArg?: RequestUser) {
    return service['resolvePublicForm'](
      'funnel-1',
      'form-1',
      'page-1',
      userArg,
    );
  }

  it('rejects anonymous visitors when require_login is enabled', async () => {
    await expect(
      resolve(setup({ form: { settings: { require_login: true } } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attributes an org member even without space membership', async () => {
    const result = await resolve(
      setup({
        form: { settings: { require_login: true } },
        org: { user_id: 'customer-1' },
      }),
      user('customer-1'),
    );
    expect(result.submitterUserId).toBe('customer-1');
  });

  it('rejects a signed-in user from another organization', async () => {
    await expect(
      resolve(
        setup({ form: { settings: { require_login: true } }, org: null }),
        user('outsider'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an assigned user whose space membership was revoked', async () => {
    await expect(
      resolve(
        setup({
          assignments: [{ assignee_user_id: 'assignee-1' }],
          space: null,
        }),
        user('assignee-1'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an archived owning space', async () => {
    await expect(
      resolve(setup({ liveSpace: { is_active: true, is_archived: true } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a deactivated owning organization', async () => {
    await expect(
      resolve(setup({ liveOrg: { is_active: false } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fails closed when the form has no owning space', async () => {
    await expect(
      resolve(setup({ form: { space_id: null } })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
