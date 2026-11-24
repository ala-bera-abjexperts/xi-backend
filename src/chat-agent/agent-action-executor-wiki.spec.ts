import { SPACE_PLACEHOLDER } from './pipeline/agent-wiki-render';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { ChatAccessService } from '../chat/chat-access.service';
import type { ChatConversationsService } from '../chat/chat-conversations.service';
import type { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { TasksMineWriteService } from '../tasks/tasks-mine-write.service';
import type { WikiLabelsService } from '../wiki/wiki-labels.service';
import type { WikiMineWriteService } from '../wiki/wiki-mine-write.service';
import { AgentActionExecutorService } from './agent-action-executor.service';
import type {
  AgentResolved,
  AgentResolverService,
  AgentWikiPlan,
} from './agent-resolver.service';
import type { AgentRunViewService } from './agent-run-view.service';
import type { AgentRunsRepository } from './agent-runs.repository';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => {
        filters.push((row) => row[col] === value);
        return q;
      },
      in: (col: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[col]));
        return q;
      },
      order: () => q,
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from };
}

const user = { userId: 'user-me', organizationId: 'org-1' } as RequestUser;
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

const pagePlan = (over: Partial<AgentWikiPlan> = {}): AgentWikiPlan => ({
  kind: 'wiki_page',
  spaceId: 'space-1',
  parentPageId: null,
  title: 'Release notes',
  doc: {
    type: 'doc',
    content: [
      { type: 'pageTree', attrs: { rootPageId: PLACEHOLDER, depth: 2 } },
      { type: 'taskCard', attrs: { config: { taskKey: '', spaceId: null, robertItem: 1 } } },
    ],
  },
  labelIds: ['lab-1'],
  publish: false,
  items: [1],
  readSpaces: [],
  restricted: false,
  ...over,
});
const taskPlan = {
  spaceId: 'space-1',
  summary: 'Fix the crash',
  description: null,
  taskTypeId: 'task',
  statusId: null,
  priorityKey: null,
  assigneeId: null,
  dueDate: null,
  labels: [],
  parentTaskId: null,
  customFieldValues: {},
};
const resolvedOf = (create: AgentResolved['create']): AgentResolved => ({
  title: 'x',
  description: null,
  confirmable: true,
  fields: [{ key: 'space', state: 'ok', value: 'space-1' }],
  create,
});
const row = (over: Row): Row => ({
  organization_id: 'org-1',
  run_id: 'run-1',
  status: 'proposed',
  version: 1,
  depends_on: null,
  intent: { object_language: 'en' },
  overrides: {},
  expires_at: '2999-01-01T00:00:00Z',
  ...over,
});

describe('AgentActionExecutorService wiki pages (1.15)', () => {
  let tables: Record<string, Row[]>;
  let runs: Record<string, jest.Mock>;
  let resolver: Record<string, jest.Mock>;
  let tasks: { createTask: jest.Mock };
  let wiki: { createWikiPage: jest.Mock };
  let labels: { setPageLabels: jest.Mock };
  let service: AgentActionExecutorService;

  const build = (actions: Row[]) => {
    tables = {
      agent_runs: [
        {
          id: 'run-1',
          organization_id: 'org-1',
          conversation_id: 'conv-1',
          invoker_id: 'user-me',
          status: 'completed',
          visibility: 'conversation',
          scope: { spaces: [], refs: [] },
          timezone: 'Europe/Vienna',
        },
      ],
      agent_actions: actions,
      tasks: [],
      wiki_pages: [],
    };
    const db = fakeDb(tables);
    runs = {
      patchAction: jest.fn().mockResolvedValue({ updated: true, version: 2 }),
      markConfirming: jest.fn().mockResolvedValue(undefined),
      claimActions: jest.fn((_o, _r, _a, versions: Record<string, number>) =>
        Promise.resolve(
          tables.agent_actions
            .filter((a) => versions[a.id as string] !== undefined)
            .map((a) => ({ ...a, status: 'executing', exec_token: `tok-${a.id as string}` })),
        ),
      ),
      completeAction: jest.fn().mockResolvedValue({ completed: true }),
      cancelActions: jest.fn().mockResolvedValue(1),
    };
    resolver = {
      batch: jest.fn((args: object) => ({ ...args, siblings: new Map(), memo: new Map() })),
      resolve: jest.fn((_b, action: { kind: string }) => {
        const stored = tables.agent_actions.find((a) => a.kind === action.kind);
        return Promise.resolve(stored?.resolved);
      }),
      hidesFromAudience: jest.fn().mockResolvedValue(false),
    };
    tasks = {
      createTask: jest.fn((_u, dto: { summary: string }, trusted: { taskId: string }) => {
        tables.tasks.push({ id: trusted.taskId, organization_id: 'org-1', key: 'AMBER-T50', space_id: 'space-1' });
        return Promise.resolve({ task: { id: trusted.taskId, key: 'AMBER-T50', summary: dto.summary, assignee: null } });
      }),
    };
    wiki = { createWikiPage: jest.fn().mockResolvedValue({ page: { id: 'x' } }) };
    labels = { setPageLabels: jest.fn().mockResolvedValue([]) };
    service = new AgentActionExecutorService(
      { getClient: () => ({ from: db.from }) } as unknown as SupabaseAdminService,
      runs as unknown as AgentRunsRepository,
      { viewOne: jest.fn().mockResolvedValue({ id: 'run-1' }), announce: jest.fn() } as unknown as AgentRunViewService,
      resolver as unknown as AgentResolverService,
      {
        getReadable: jest.fn().mockResolvedValue({ conversation: { id: 'conv-1', kind: 'group', space_id: null } }),
      } as unknown as ChatAccessService,
      { loadUsers: jest.fn().mockResolvedValue(new Map()) } as unknown as ChatConversationsService,
      tasks as unknown as TasksMineWriteService,
      { broadcastNotification: jest.fn() } as unknown as NotificationsBroadcastService,
      wiki as unknown as WikiMineWriteService,
      labels as unknown as WikiLabelsService,
    );
  };

  const page = (over: Row = {}) =>
    row({ id: 'act-page', ordinal: 2, kind: 'wiki_page', entity_id: 'page-new', resolved: resolvedOf(pagePlan()), ...over });
  const task = (over: Row = {}) =>
    row({ id: 'act-task', ordinal: 1, kind: 'task', entity_id: 'task-new', resolved: resolvedOf(taskPlan), ...over });

  it('creates the task first, then the page as the invoker, with the task card and its own id filled in', async () => {
    build([task(), page()]);

    await service.confirm(user, 'run-1', [
      { id: 'act-page', version: 1 },
      { id: 'act-task', version: 1 },
    ]);

    expect(tasks.createTask.mock.invocationCallOrder[0]).toBeLessThan(
      wiki.createWikiPage.mock.invocationCallOrder[0],
    );
    const [who, dto, trusted] = wiki.createWikiPage.mock.calls[0] as [RequestUser, Row, { pageId: string; doc: Row }];
    expect(who).toBe(user);
    expect(dto).toMatchObject({ spaceIdOrKey: 'space-1', title: 'Release notes', status: 'draft' });
    expect(trusted.pageId).toBe('page-new');
    const json = JSON.stringify(trusted.doc);
    expect(json).toContain('"rootPageId":"page-new"');
    expect(json).toContain('"taskKey":"AMBER-T50"');
    expect(json).not.toContain('robertItem');
    expect(labels.setPageLabels).toHaveBeenCalledWith('page-new', 'space-1', { label_ids: ['lab-1'] });
    // One claim per action, right before it runs.
    expect(runs.claimActions).toHaveBeenCalledTimes(2);
    expect(runs.claimActions.mock.calls.map((c) => Object.keys(c[3] as object))).toEqual([['act-task'], ['act-page']]);
  });

  it('points a live table at the space once it exists', async () => {
    const withTable = pagePlan({
      items: [],
      doc: { type: 'doc', content: [{ type: 'ticketTable', attrs: { config: { mode: 'space', spaceId: SPACE_PLACEHOLDER } } }] },
    });
    build([page({ id: 'act-page', ordinal: 1, entity_id: 'p1', resolved: resolvedOf(withTable) })]);

    await service.confirm(user, 'run-1', [{ id: 'act-page', version: 1 }]);

    const [call] = wiki.createWikiPage.mock.calls as [unknown, Row, { doc: unknown }][];
    const saved = JSON.stringify(call[2].doc);
    expect(saved).not.toContain(SPACE_PLACEHOLDER);
    expect(saved).toContain(`"spaceId":"${(withTable as { spaceId: string }).spaceId}"`);
  });

  it('lists the child pages of a parent created with them, live', async () => {
    const noTree = pagePlan({ items: [], doc: { type: 'doc', content: [{ type: 'paragraph' }] } });
    build([
      page({ id: 'act-parent', ordinal: 1, entity_id: 'p1', resolved: resolvedOf(noTree) }),
      page({ id: 'act-child', ordinal: 2, depends_on: 1, entity_id: 'p2', resolved: resolvedOf(noTree) }),
    ]);

    await service.confirm(user, 'run-1', [
      { id: 'act-parent', version: 1 },
      { id: 'act-child', version: 1 },
    ]);

    const [parentCall, childCall] = wiki.createWikiPage.mock.calls as [unknown, Row, { doc: Row }][];
    expect(JSON.stringify(parentCall[2].doc)).toContain('"rootPageId":"p1"');
    expect(JSON.stringify(childCall[2].doc)).not.toContain('pageTree');
    expect(childCall[1]).toMatchObject({ parentPageId: 'p1' });
  });

  it('adopts a page that already exists under the reserved id', async () => {
    build([page({ ordinal: 1, resolved: resolvedOf(pagePlan({ items: [] })) })]);
    tables.wiki_pages.push({ id: 'page-new', organization_id: 'org-1' });

    await service.confirm(user, 'run-1', [{ id: 'act-page', version: 1 }]);

    expect(wiki.createWikiPage).not.toHaveBeenCalled();
    expect(runs.completeAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'executed', audit: { adopted: true } }),
    );
  });

  it.each([
    [new BadRequestException('$.content[0]: unknown node type "rawHtml"'), 'invalid_content'],
    [new NotFoundException('Wiki page not found'), 'no_create_permission'],
    [new BadRequestException('Parent page not found'), 'parent_not_found'],
  ])('reports %s as %s', async (error, reason) => {
    build([page({ ordinal: 1, resolved: resolvedOf(pagePlan({ items: [] })) })]);
    wiki.createWikiPage.mockRejectedValue(error);

    await service.confirm(user, 'run-1', [{ id: 'act-page', version: 1 }]);

    expect(runs.completeAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason }));
  });

  it('refuses a child page confirmed alone before its parent (409, nothing claimed)', async () => {
    build([
      page({ id: 'act-parent', ordinal: 1, entity_id: 'p1' }),
      page({ id: 'act-child', ordinal: 2, depends_on: 1, entity_id: 'p2' }),
    ]);

    const err = (await service
      .confirm(user, 'run-1', [{ id: 'act-child', version: 1 }])
      .catch((e: unknown) => e)) as ConflictException;

    expect(err).toBeInstanceOf(ConflictException);
    expect((err.getResponse() as { code: string }).code).toBe('parent_first');
    expect(runs.claimActions).not.toHaveBeenCalled();
  });

  it('accepts only the fields a page has, with values of the right type', async () => {
    build([page({ ordinal: 1 })]);

    await expect(
      service.patch(user, 'run-1', [{ actionId: 'act-page', version: 1, fields: { type: 'bug' } }]),
    ).rejects.toThrow('Unknown field type');
    await expect(
      service.patch(user, 'run-1', [{ actionId: 'act-page', version: 1, fields: { publish: 'yes' } }]),
    ).rejects.toThrow('Invalid value for publish');
    await expect(
      service.patch(user, 'run-1', [{ actionId: 'act-page', version: 1, fields: { parentPage: 'VPN' } }]),
    ).rejects.toThrow('Invalid value for parentPage');
  });

  it('keeps the children of a created parent when the parent is cancelled through the API', async () => {
    build([
      page({ id: 'act-parent', ordinal: 1, status: 'executed' }),
      page({ id: 'act-child', ordinal: 2, depends_on: 1 }),
    ]);

    await service.cancel(user, 'act-parent');

    expect(runs.cancelActions).toHaveBeenCalledWith('org-1', 'user', {
      actionIds: ['act-parent'],
      actorId: 'user-me',
    });
  });
});
