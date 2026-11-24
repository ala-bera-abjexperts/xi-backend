/* eslint-disable @typescript-eslint/unbound-method -- asserting on jest mock fns, not invoking them */
import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TasksService } from '../tasks.service';
import { TaskPickerController } from './task-picker.controller';
import {
  TaskPickerLookupDto,
  TaskPickerSearchQueryDto,
} from './task-picker.dto';
import { TaskPickerService } from './task-picker.service';

const ORG = 'org-1';
const A = '11111111-1111-4111-8111-111111111111'; // accessible, tasks on
const B = '22222222-2222-4222-8222-222222222222'; // accessible, tasks module off
const C = '33333333-3333-4333-8333-333333333333'; // not accessible (non-member)
const user = { userId: 'u-1', organizationId: ORG } as RequestUser;

const row = (
  id: string,
  spaceId: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  key: `K-T${id.slice(-1)}`,
  summary: `Task ${id}`,
  space_id: spaceId,
  priority_id: 'p-1',
  priority: 'medium',
  updated_at: '2026-09-25T10:00:00Z',
  task_type_id: 'bug',
  description: 'secret description',
  custom_fields: { customer: 'x' },
  status_config: { name: 'In Progress', color: '#1e88e5', is_completed: false },
  assignee: {
    id: 'u-2',
    first_name: 'Ada',
    last_name: 'L',
    email: 'a@x',
    avatar_url: null,
  },
  ...extra,
});

function make(
  opts: { tenantOn?: boolean; getAllRows?: Record<string, unknown>[] } = {},
) {
  const tasks = {
    getAccessibleTaskSpaces: jest.fn().mockResolvedValue({
      spaceIds: [A, B],
      orgCanViewTasks: true,
      truncated: false,
      spacesById: new Map([
        [A, { id: A, key: 'ALPHA', name: 'Zeta space' }],
        [B, { id: B, key: 'BETA', name: 'Beta space' }],
      ]),
    }),
    getAll: jest.fn().mockResolvedValue({
      data: opts.getAllRows ?? [row('t-1', A)],
      page: 1,
      hasMore: true,
      total: 60,
    }),
  } as unknown as TasksService;

  const orgModules = {
    isEnabled: jest.fn().mockResolvedValue(opts.tenantOn ?? true),
    getEnabledSpaceIds: jest.fn().mockResolvedValue([A]),
  } as unknown as OrganizationModulesService;

  const inFn = jest.fn().mockResolvedValue({
    data: [{ id: 'p-1', name: 'Medium', color: '#f90', icon: 'bx-up' }],
    error: null,
  });
  const chain = { select: () => chain, eq: () => chain, in: inFn };
  const supabaseAdmin = {
    getClient: () => ({ from: () => chain }),
  } as unknown as SupabaseAdminService;

  return {
    service: new TaskPickerService(tasks, orgModules, supabaseAdmin),
    tasks,
    orgModules,
    inFn,
  };
}

describe('TaskPickerService', () => {
  it('lists only accessible spaces with the Tasks module on, sorted by name', async () => {
    const { service, orgModules } = make();

    await expect(service.listSpaces(user)).resolves.toEqual({
      spaces: [{ id: A, key: 'ALPHA', name: 'Zeta space' }],
      truncated: false,
    });
    expect(orgModules.getEnabledSpaceIds).toHaveBeenCalledWith(ORG, 'tasks', [
      A,
      B,
    ]);
  });

  it('returns no spaces when Tasks is off for the tenant', async () => {
    const { service, tasks } = make({ tenantOn: false });

    await expect(service.listSpaces(user)).resolves.toEqual({
      spaces: [],
      truncated: false,
    });
    expect(tasks.getAccessibleTaskSpaces).not.toHaveBeenCalled();
  });

  it('404s a space the caller cannot access, and one with the Tasks module off', async () => {
    const { service, tasks } = make();

    await expect(
      service.search(user, { spaceId: C, page: 1, pageSize: 25 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.search(user, { spaceId: B, page: 1, pageSize: 25 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tasks.getAll).not.toHaveBeenCalled();
  });

  it('searches one space via getAll (org-scoped, paged, newest first) and returns the minimal DTO', async () => {
    const { service, tasks } = make();

    const res = await service.search(user, {
      spaceId: A,
      search: '  T-42 ',
      page: 2,
      pageSize: 25,
    });

    expect(tasks.getAll).toHaveBeenCalledWith(ORG, {
      space_id: A,
      search: 'T-42',
      page: 2,
      pageSize: 25,
      withRelations: true,
      sortBy: 'updated_at',
      sortDir: 'desc',
    });
    expect(res).toMatchObject({ page: 1, hasMore: true, total: 60 });
    expect(res.items[0]).toEqual({
      id: 't-1',
      key: 'K-T1',
      summary: 'Task t-1',
      spaceId: A,
      spaceKey: 'ALPHA',
      status: { name: 'In Progress', color: '#1e88e5', isCompleted: false },
      priority: { name: 'Medium', color: '#f90', icon: 'bx-up' },
      assignee: { id: 'u-2', name: 'Ada L', avatarUrl: null },
      type: 'bug',
      updatedAt: '2026-09-25T10:00:00Z',
    });
    // Nothing beyond the card fields leaves the service.
    expect(JSON.stringify(res)).not.toContain('secret description');
    expect(JSON.stringify(res)).not.toContain('custom_fields');
  });

  it('falls back to legacy status/priority text and tolerates no assignee', async () => {
    const { service } = make({
      getAllRows: [
        row('t-2', A, {
          status_config: null,
          status: 'open',
          priority_id: null,
          assignee: null,
        }),
      ],
    });

    const [item] = (
      await service.search(user, { spaceId: A, page: 1, pageSize: 25 })
    ).items;

    expect(item.status).toEqual({
      name: 'open',
      color: null,
      isCompleted: false,
    });
    expect(item.priority).toEqual({ name: 'medium', color: null, icon: null });
    expect(item.assignee).toBeNull();
  });

  it('lookup returns only tasks in accessible spaces; the rest are missing', async () => {
    const { service } = make({
      getAllRows: [row('t-1', A), row('t-9', C), row('t-8', B)],
    });

    const res = await service.lookup(user, ['t-1', 't-9', 't-8', 't-7', 't-1']);

    expect(res.items.map((i) => i.id)).toEqual(['t-1']);
    expect(res.missing).toEqual(['t-9', 't-8', 't-7']);
  });

  it('lookup rejects empty and oversized id lists', async () => {
    const { service } = make();

    await expect(service.lookup(user, [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.lookup(
        user,
        Array.from({ length: 201 }, (_, i) => `id-${i}`),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Task picker DTOs', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  it('applies paging defaults and rejects a page size above 50', async () => {
    await expect(
      pipe.transform(
        { spaceId: A },
        { type: 'query', metatype: TaskPickerSearchQueryDto },
      ),
    ).resolves.toMatchObject({
      page: 1,
      pageSize: 25,
    });
    await expect(
      pipe.transform(
        { spaceId: A, pageSize: '51' },
        { type: 'query', metatype: TaskPickerSearchQueryDto },
      ),
    ).rejects.toBeDefined();
  });

  it('rejects a non-uuid space and non-uuid lookup ids', async () => {
    await expect(
      pipe.transform(
        { spaceId: 'DEFAULT' },
        { type: 'query', metatype: TaskPickerSearchQueryDto },
      ),
    ).rejects.toBeDefined();
    await expect(
      pipe.transform(
        { ids: [A, 'x'] },
        { type: 'body', metatype: TaskPickerLookupDto },
      ),
    ).rejects.toBeDefined();
  });
});

describe('TaskPickerController routing', () => {
  it('is mounted under the literal tasks/picker prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TaskPickerController)).toBe(
      'tasks/picker',
    );
  });
});
