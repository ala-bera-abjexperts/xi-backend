/**
 * @fileoverview Unit tests for GitStatusAutomationService: which transitions a development event picks
 * (event, provider, live workflow, editor rule shape), who it runs as, the guards (space switch, archived
 * space, assignment, already there, backwards, target missing, other open pull requests), how engine refusals
 * become one `git_automation_skipped` History row, the History annotation, tenant filters, and that
 * `handle()` never throws. The database and the engine are mocked.
 * @module src/git-integrations/git-status-automation.service.spec
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { WorkflowAssignmentsService } from '../workflow-assignments/workflow-assignments.service';
import type { GitIdentitiesService } from './git-identities.service';
import type { IGitDevEvent } from './git-integrations.types';
import {
  GitStatusAutomationService,
  skipReasonOf,
} from './git-status-automation.service';

// Every task counts as being in a space with the Development module on. The gate is an RPC with its own
// tests; these specs are about what happens behind it.
jest.mock('./git-integrations.util', () => ({
  ...jest.requireActual('./git-integrations.util'),
  developmentTaskIds: jest.fn((_db: unknown, _org: string, ids: string[]) =>
    Promise.resolve(new Set(ids)),
  ),
}));

const ORG = 'org-1';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ICall {
  method: string;
  args: unknown[];
}

interface IChain {
  table: string;
  calls: ICall[];
}

interface IResult {
  data?: unknown;
  error?: { message: string } | null;
}

/** Chainable Supabase mock; each table answers from `respond(table, chain)` once the chain is awaited. */
function makeDb(respond: (table: string, chain: IChain) => IResult) {
  const chains: IChain[] = [];
  const from = (table: string) => {
    const chain: IChain = { table, calls: [] };
    let resolved: { data: unknown; error: unknown } | undefined;
    const resolve = () => {
      if (!resolved) {
        const result = respond(table, chain);

        resolved = { data: result.data ?? null, error: result.error ?? null };
      }

      return resolved;
    };
    const builder: Record<string, unknown> = {};

    chains.push(chain);

    for (const method of [
      'select',
      'insert',
      'update',
      'eq',
      'in',
      'is',
      'gte',
      'filter',
      'order',
      'limit',
    ]) {
      builder[method] = (...args: unknown[]) => {
        chain.calls.push({ method, args });

        return builder;
      };
    }

    builder.maybeSingle = () => Promise.resolve(resolve());
    builder.then = (
      onF: (v: unknown) => unknown,
      onR?: (e: unknown) => unknown,
    ) => Promise.resolve(resolve()).then(onF, onR);

    return builder;
  };

  return {
    client: { from },
    from: jest.fn(from),
    on(table: string) {
      return chains.filter((chain) => chain.table === table);
    },
    all: chains,
  };
}

const args = (chain: IChain, method: string) =>
  chain.calls.filter((call) => call.method === method).map((call) => call.args);
const eqOf = (chain: IChain, column: string) =>
  args(chain, 'eq').find(([c]) => c === column)?.[1];
const inOf = (chain: IChain, column: string) =>
  (args(chain, 'in').find(([c]) => c === column)?.[1] ?? []) as string[];
const has = (chain: IChain, method: string) =>
  chain.calls.some((call) => call.method === method);

// -----------------------------------------------------------------------------
// World
// -----------------------------------------------------------------------------

const trigger = (overrides: Record<string, unknown> = {}) => ({
  type: 'git_development_event',
  event: 'pr_opened',
  provider: 'any',
  ...overrides,
});

const transition = (
  id: string,
  overrides: {
    workflowId?: string;
    toNode?: string | null;
    triggers?: unknown[];
    workflow?: Record<string, unknown>;
  } = {},
) => {
  const workflowId = overrides.workflowId ?? 'wf-1';

  return {
    id,
    workflow_id: workflowId,
    sort_order: 0,
    to_node_id:
      overrides.toNode === undefined ? 'node-review' : overrides.toNode,
    triggers: overrides.triggers ?? [trigger()],
    workflows: {
      id: workflowId,
      organization_id: ORG,
      is_archived: false,
      is_active: true,
      is_draft: false,
      created_by: 'creator-1',
      ...overrides.workflow,
    },
  };
};

interface IWorld {
  transitions: unknown[];
  transitionsError?: { message: string };
  nodes: { id: string; status_id: string | null }[];
  users: {
    id: string;
    auth_user_id: string;
    email: string;
    role: string;
    is_active: boolean;
  }[];
  tasks: {
    id: string;
    organization_id: string;
    space_id: string | null;
    task_type_id: string | null;
    status_id: string | null;
  }[];
  spaces: {
    id: string;
    organization_id: string;
    is_archived: boolean;
    settings: Record<string, unknown> | null;
  }[];
  statuses: {
    id: string;
    organization_id: string;
    name: string;
    is_active: boolean;
    category_id: string | null;
  }[];
  categories: { id: string; organization_id: string; sort_order: number }[];
  overrides: { status_id: string; is_enabled: boolean }[];
  prLinks: Record<
    string,
    { pull_request: { id: string; number: number; state: string } | null }[]
  >;
  historyRow: { id: string } | null;
  members: { organization_id: string; user_id: string }[];
}

function world(): IWorld {
  return {
    transitions: [transition('tr-1')],
    nodes: [
      { id: 'node-todo', status_id: 'st-todo' },
      { id: 'node-review', status_id: 'st-review' },
      { id: 'node-qa', status_id: 'st-qa' },
      { id: 'node-done', status_id: 'st-done' },
      { id: 'node-empty', status_id: null },
    ],
    users: ['dev-user', 'creator-1'].map((id) => ({
      id,
      auth_user_id: `auth-${id}`,
      email: `${id}@x.test`,
      role: 'member',
      is_active: true,
    })),
    tasks: ['task-1', 'task-2'].map((id) => ({
      id,
      organization_id: ORG,
      space_id: 'space-1',
      task_type_id: 'type-1',
      status_id: 'st-dev',
    })),
    spaces: [
      { id: 'space-1', organization_id: ORG, is_archived: false, settings: {} },
    ],
    statuses: [
      ['st-todo', 'To do', 'cat-todo'],
      ['st-dev', 'In development', 'cat-progress'],
      ['st-review', 'In review', 'cat-progress'],
      ['st-qa', 'QA', 'cat-progress'],
      ['st-done', 'Done', 'cat-done'],
    ].map(([id, name, category_id]) => ({
      id,
      organization_id: ORG,
      name,
      is_active: true,
      category_id,
    })),
    categories: [
      { id: 'cat-todo', organization_id: ORG, sort_order: 1 },
      { id: 'cat-progress', organization_id: ORG, sort_order: 2 },
      { id: 'cat-done', organization_id: ORG, sort_order: 3 },
    ],
    overrides: [],
    prLinks: {},
    historyRow: { id: 'h-1' },
    members: ['dev-user', 'creator-1'].map((user_id) => ({
      organization_id: ORG,
      user_id,
    })),
  };
}

function respond(w: IWorld) {
  return (table: string, chain: IChain): IResult => {
    const org = eqOf(chain, 'organization_id');

    switch (table) {
      case 'workflow_transitions':
        return w.transitionsError
          ? { error: w.transitionsError }
          : { data: w.transitions };
      case 'workflow_nodes':
        return {
          data: w.nodes.filter((n) => inOf(chain, 'id').includes(n.id)),
        };
      case 'organization_members':
        return {
          data:
            w.members.find(
              (m) =>
                m.organization_id === org &&
                m.user_id === eqOf(chain, 'user_id'),
            ) ?? null,
        };
      case 'users':
        return {
          data: w.users.find((u) => u.id === eqOf(chain, 'id')) ?? null,
        };
      case 'tasks':
        return {
          data:
            w.tasks.find(
              (t) => t.id === eqOf(chain, 'id') && t.organization_id === org,
            ) ?? null,
        };
      case 'spaces':
        return {
          data:
            w.spaces.find(
              (s) => s.id === eqOf(chain, 'id') && s.organization_id === org,
            ) ?? null,
        };
      case 'task_statuses':
        return {
          data: w.statuses
            .filter(
              (s) =>
                inOf(chain, 'id').includes(s.id) && s.organization_id === org,
            )
            .map(({ organization_id: _o, ...s }) => s),
        };
      case 'status_categories':
        return {
          data: w.categories.filter(
            (c) =>
              inOf(chain, 'id').includes(c.id) && c.organization_id === org,
          ),
        };
      case 'space_status_overrides':
        return { data: w.overrides };
      case 'git_pull_request_tasks':
        return { data: w.prLinks[eqOf(chain, 'task_id') as string] ?? [] };
      case 'task_history':
        return has(chain, 'insert') || has(chain, 'update')
          ? {}
          : { data: w.historyRow };
      default:
        throw new Error(`unexpected table ${table}`);
    }
  };
}

const event = (overrides: Partial<IGitDevEvent> = {}): IGitDevEvent => ({
  organizationId: ORG,
  repositoryId: 'repo-1',
  provider: 'github',
  event: 'pr_opened',
  taskIds: ['task-1'],
  subject: {
    kind: 'pull_request',
    number: 12,
    title: 'XE-T1 add login',
    url: 'https://github.com/acme/api/pull/12',
    pullRequestId: 'pr-1',
  },
  actor: { externalId: '7', login: 'dev' },
  ...overrides,
});

function setup(
  configure: (w: IWorld) => void = () => {},
  options: { engine?: boolean } = {},
) {
  const w = world();

  configure(w);

  const db = makeDb(respond(w));
  const identities = {
    resolveAuthors: jest
      .fn()
      .mockResolvedValue(new Map([['7', { userId: 'dev-user', name: 'Dev' }]])),
    resolveLogins: jest.fn().mockResolvedValue(new Map()),
  };
  const assignments = {
    findActiveAssignmentForType: jest
      .fn()
      .mockResolvedValue({ workflow_id: 'wf-1' }),
  };
  const engine = { executeTransition: jest.fn().mockResolvedValue({}) };
  const service = new GitStatusAutomationService(
    { getClient: () => ({ from: db.from }) } as never,
    identities as unknown as GitIdentitiesService,
    assignments as unknown as WorkflowAssignmentsService,
    options.engine === false ? undefined : (engine as never),
  );

  const skipRows = () =>
    db
      .on('task_history')
      .filter((c) => has(c, 'insert'))
      .map((c) => args(c, 'insert')[0][0] as Record<string, unknown>)
      .filter((row) => row.action === 'git_automation_skipped');
  const inserted = () =>
    db
      .on('task_history')
      .filter((c) => has(c, 'insert'))
      .map((c) => args(c, 'insert')[0][0] as Record<string, unknown>)
      .filter((row) => row.action === 'status_change');
  const updates = () => db.on('task_history').filter((c) => has(c, 'update'));
  const writes = () =>
    db.all.filter((c) => has(c, 'insert') || has(c, 'update'));

  return {
    service,
    db,
    w,
    identities,
    assignments,
    engine,
    skipRows,
    inserted,
    updates,
    writes,
  };
}

// -----------------------------------------------------------------------------

describe('GitStatusAutomationService', () => {
  describe('nothing to do', () => {
    it('makes no database call without tasks or without an engine', async () => {
      const noTasks = setup();

      await noTasks.service.handle(event({ taskIds: [] }));
      expect(noTasks.db.from).not.toHaveBeenCalled();

      const noEngine = setup(undefined, { engine: false });

      await noEngine.service.handle(event());
      expect(noEngine.db.from).not.toHaveBeenCalled();
    });

    it.each<[string, (w: IWorld) => void, Partial<IGitDevEvent>?]>([
      [
        'another event',
        (w) =>
          (w.transitions = [
            transition('tr-1', { triggers: [trigger({ event: 'pr_merged' })] }),
          ]),
      ],
      [
        'another provider',
        (w) =>
          (w.transitions = [
            transition('tr-1', { triggers: [trigger({ provider: 'gitlab' })] }),
          ]),
      ],
      [
        'another trigger type',
        (w) =>
          (w.transitions = [
            transition('tr-1', {
              triggers: [{ type: 'manual', event: 'pr_opened' }],
            }),
          ]),
      ],
      [
        'an inactive workflow',
        (w) =>
          (w.transitions = [
            transition('tr-1', { workflow: { is_active: false } }),
          ]),
      ],
      [
        'a draft workflow',
        (w) =>
          (w.transitions = [
            transition('tr-1', { workflow: { is_draft: true } }),
          ]),
      ],
      [
        'an archived workflow',
        (w) =>
          (w.transitions = [
            transition('tr-1', { workflow: { is_archived: true } }),
          ]),
      ],
      [
        'a workflow of another organization',
        (w) =>
          (w.transitions = [
            transition('tr-1', { workflow: { organization_id: 'org-2' } }),
          ]),
      ],
      ['no transitions at all', (w) => (w.transitions = [])],
    ])('does nothing for %s', async (_name, configure) => {
      const { service, engine, writes, db } = setup(configure);

      await service.handle(event());

      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
      expect(db.on('tasks')).toHaveLength(0);
    });
  });

  describe('trigger matching', () => {
    it.each([
      ['provider any', trigger({ provider: 'any' })],
      ['no provider', { type: 'git_development_event', event: 'pr_opened' }],
      ['the same provider', trigger({ provider: 'github' })],
      [
        'the editor shape { id, type, config }',
        {
          id: 'card-1',
          type: 'git_development_event',
          config: { event: 'pr_opened', provider: 'github' },
        },
      ],
    ])('fires for %s', async (_name, rule) => {
      const { service, engine } = setup((w) => {
        w.transitions = [
          transition('tr-1', { triggers: [{ type: 'manual' }, rule] }),
        ];
      });

      await service.handle(event());

      expect(engine.executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: 'tr-1' }),
      );
    });

    it('asks only for transitions carrying a git_development_event trigger in the organization', async () => {
      const { service, db } = setup();

      await service.handle(event());

      const [query] = db.on('workflow_transitions');

      expect(eqOf(query, 'workflows.organization_id')).toBe(ORG);
      expect(args(query, 'filter')[0]).toEqual([
        'triggers',
        'cs',
        JSON.stringify([{ type: 'git_development_event' }]),
      ]);
    });
  });

  describe('happy path', () => {
    it('runs the transition as the developer and marks the status change in History', async () => {
      const { service, engine, identities, db, updates, skipRows, inserted } =
        setup();
      const ev = event();

      await service.handle(ev);

      // No host on the event: the built-in host (the identities service's default).
      expect(identities.resolveAuthors).toHaveBeenCalledWith(
        ORG,
        'github',
        [{ externalId: '7', login: 'dev' }],
        undefined,
      );
      expect(engine.executeTransition).toHaveBeenCalledTimes(1);

      const call = engine.executeTransition.mock.calls[0][0];

      expect(call).toMatchObject({
        taskId: 'task-1',
        transitionId: 'tr-1',
        screenInput: {},
        user: {
          userId: 'dev-user',
          authUserId: 'auth-dev-user',
          organizationId: ORG,
          appMetadata: { fired_by: 'git_development_event' },
        },
      });
      expect(call.executionId).toMatch(UUID);

      const [lookup] = db
        .on('task_history')
        .filter((c) => !has(c, 'update') && !has(c, 'insert'));

      expect(eqOf(lookup, 'task_id')).toBe('task-1');
      expect(eqOf(lookup, 'action')).toBe('status_change');
      expect(eqOf(lookup, 'changed_by')).toBe('dev-user');
      expect(args(lookup, 'is')).toEqual([['metadata', null]]);
      expect(args(lookup, 'order')).toEqual([
        ['changed_at', { ascending: false }],
      ]);
      expect(args(lookup, 'limit')).toEqual([[1]]);

      const since = args(lookup, 'gte')[0];

      expect(since[0]).toBe('changed_at');
      // A clock-skew margin of a minute before the move started.
      expect(Date.parse(since[1] as string)).toBeLessThanOrEqual(
        Date.now() - 59_000,
      );
      expect(Date.parse(since[1] as string)).toBeGreaterThan(
        Date.now() - 120_000,
      );

      const [update] = updates();

      expect(eqOf(update, 'id')).toBe('h-1');
      expect(args(update, 'update')[0][0]).toEqual({
        // The trigger's legacy status text is replaced by the real names.
        old_value: 'In development',
        new_value: 'In review',
        metadata: {
          source: 'git',
          provider: 'github',
          event: 'pr_opened',
          subject: ev.subject,
          actor: { login: 'dev', userId: 'dev-user', name: 'Dev' },
        },
      });
      expect(skipRows()).toHaveLength(0);
      expect(inserted()).toHaveLength(0);
    });

    it('uses a fresh execution id per move', async () => {
      const { service, engine } = setup();

      await service.handle(event({ taskIds: ['task-1', 'task-2'] }));

      const [a, b] = engine.executeTransition.mock.calls.map(
        ([c]) => c.executionId,
      );

      expect(a).toMatch(UUID);
      expect(b).toMatch(UUID);
      expect(a).not.toBe(b);
    });

    it('writes the status change row itself when the engine logged none', async () => {
      const { service, engine, updates, inserted, skipRows } = setup(
        (w) => (w.historyRow = null),
      );
      const ev = event();

      await service.handle(ev);

      expect(engine.executeTransition).toHaveBeenCalled();
      expect(updates()).toHaveLength(0);
      expect(skipRows()).toHaveLength(0);
      expect(inserted()).toEqual([
        {
          task_id: 'task-1',
          organization_id: ORG,
          action: 'status_change',
          field_name: 'status',
          old_value: 'In development',
          new_value: 'In review',
          changed_by: 'dev-user',
          metadata: {
            source: 'git',
            provider: 'github',
            event: 'pr_opened',
            subject: ev.subject,
            actor: { login: 'dev', userId: 'dev-user', name: 'Dev' },
          },
        },
      ]);
    });
  });

  describe('who it runs as', () => {
    it('falls back to the workflow creator when the developer is not linked, keeping the login', async () => {
      const { service, engine, identities, updates } = setup();

      identities.resolveAuthors.mockResolvedValue(new Map());

      await service.handle(event());

      expect(identities.resolveLogins).toHaveBeenCalledWith(
        ORG,
        'github',
        ['dev'],
        undefined,
      );
      expect(engine.executeTransition.mock.calls[0][0].user.userId).toBe(
        'creator-1',
      );
      expect(
        (args(updates()[0], 'update')[0][0] as { metadata: { actor: unknown } })
          .metadata.actor,
      ).toEqual({ login: 'dev', userId: null, name: null });
    });

    it('resolves by login when the provider user id is missing', async () => {
      const { service, engine, identities } = setup();

      identities.resolveLogins.mockResolvedValue(
        new Map([['dev', { userId: 'dev-user', name: 'Dev' }]]),
      );

      await service.handle(
        event({ actor: { externalId: null, login: 'dev' } }),
      );

      expect(identities.resolveAuthors).not.toHaveBeenCalled();
      expect(engine.executeTransition.mock.calls[0][0].user.userId).toBe(
        'dev-user',
      );
    });

    it('does nothing when there is neither a developer nor a workflow creator', async () => {
      const { service, engine, identities, writes } = setup((w) => {
        w.transitions = [
          transition('tr-1', { workflow: { created_by: null } }),
        ];
      });

      identities.resolveAuthors.mockResolvedValue(new Map());

      await service.handle(event());

      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    });
  });

  describe('membership', () => {
    it('does nothing when the creator left the organization and there is no developer', async () => {
      const { service, engine, identities, writes, db } = setup((w) => {
        w.members = w.members.filter((m) => m.user_id !== 'creator-1');
      });

      identities.resolveAuthors.mockResolvedValue(new Map());

      await service.handle(event());

      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
      expect(db.on('users')).toHaveLength(0);
    });

    it('runs as the creator when the developer is not a member any more', async () => {
      const { service, engine } = setup((w) => {
        w.members = w.members.filter((m) => m.user_id !== 'dev-user');
      });

      await service.handle(event());

      expect(engine.executeTransition.mock.calls[0][0].user.userId).toBe(
        'creator-1',
      );
    });

    it('runs as the creator when the developer has no users row', async () => {
      const { service, engine, updates } = setup((w) => {
        w.users = w.users.filter((u) => u.id !== 'dev-user');
      });

      await service.handle(event());

      expect(engine.executeTransition).toHaveBeenCalledTimes(1);
      expect(engine.executeTransition.mock.calls[0][0].user.userId).toBe(
        'creator-1',
      );
      expect(updates()).toHaveLength(1);
    });

    it('checks membership within the organization', async () => {
      const { service, db } = setup();

      await service.handle(event());

      const chains = db.on('organization_members');

      expect(chains.length).toBeGreaterThan(0);
      for (const chain of chains) {
        expect(eqOf(chain, 'organization_id')).toBe(ORG);
        expect(eqOf(chain, 'user_id')).toBe('dev-user');
      }
    });
  });

  describe('guards', () => {
    it.each<[string, (w: IWorld) => void]>([
      [
        'the task is not in the organization',
        (w) => (w.tasks[0].organization_id = 'org-2'),
      ],
      ['the task has no space', (w) => (w.tasks[0].space_id = null)],
      ['the space is archived', (w) => (w.spaces[0].is_archived = true)],
      [
        'the space is in another organization',
        (w) => (w.spaces[0].organization_id = 'org-2'),
      ],
      [
        'the space switched the automation off',
        (w) => (w.spaces[0].settings = { gitStatusAutomation: false }),
      ],
    ])('does nothing when %s', async (_name, configure) => {
      const { service, engine, writes } = setup(configure);

      await service.handle(event());

      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    });

    it('does nothing without a workflow assignment or when the candidates belong to another workflow', async () => {
      for (const assignment of [null, { workflow_id: 'wf-other' }]) {
        const { service, engine, assignments, writes } = setup();

        assignments.findActiveAssignmentForType.mockResolvedValue(assignment);

        await service.handle(event());

        expect(assignments.findActiveAssignmentForType).toHaveBeenCalledWith(
          ORG,
          'space-1',
          'type-1',
        );
        expect(engine.executeTransition).not.toHaveBeenCalled();
        expect(writes()).toHaveLength(0);
      }
    });

    it('looks up the "*" assignment for a task without a type', async () => {
      const { service, assignments } = setup(
        (w) => (w.tasks[0].task_type_id = null),
      );

      await service.handle(event());

      expect(assignments.findActiveAssignmentForType).toHaveBeenCalledWith(
        ORG,
        'space-1',
        '*',
      );
    });

    it('stays silent when the task is already in the target status', async () => {
      const { service, engine, writes } = setup(
        (w) => (w.tasks[0].status_id = 'st-review'),
      );

      await service.handle(event());

      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    });

    it('never moves backwards silently, unless the trigger allows it', async () => {
      const back = (allow?: boolean) => (w: IWorld) => {
        w.transitions = [
          transition('tr-1', {
            toNode: 'node-todo',
            triggers: [
              trigger(allow === undefined ? {} : { allow_backward: allow }),
            ],
          }),
        ];
      };
      const blocked = setup(back());

      await blocked.service.handle(event());
      expect(blocked.engine.executeTransition).not.toHaveBeenCalled();
      expect(blocked.writes()).toHaveLength(0);

      const allowed = setup(back(true));

      await allowed.service.handle(event());
      expect(allowed.engine.executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: 'tr-1' }),
      );
    });

    it.each<[string, (w: IWorld) => void, unknown]>([
      [
        'inactive',
        (w) =>
          (w.statuses.find((s) => s.id === 'st-review')!.is_active = false),
        { id: 'st-review', name: 'In review' },
      ],
      [
        'switched off in the space',
        (w) => (w.overrides = [{ status_id: 'st-review', is_enabled: false }]),
        { id: 'st-review', name: 'In review' },
      ],
      [
        'not set on the node',
        (w) => (w.transitions = [transition('tr-1', { toNode: 'node-empty' })]),
        null,
      ],
      [
        'missing (no target node)',
        (w) => (w.transitions = [transition('tr-1', { toNode: null })]),
        null,
      ],
    ])(
      'logs target_missing when the target status is %s',
      async (_name, configure, newValue) => {
        const { service, engine, skipRows } = setup(configure);

        await service.handle(event());

        expect(engine.executeTransition).not.toHaveBeenCalled();

        const rows = skipRows();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'git_automation_skipped',
          old_value: { id: 'st-dev', name: 'In development' },
          new_value: newValue,
          metadata: { reason: 'target_missing' },
        });
      },
    );
  });

  describe('engine refusals', () => {
    it.each([
      [
        new BadRequestException('Transition not available from current status'),
        'not_allowed_from_current',
      ],
      [new ForbiddenException('Conditions not met'), 'condition_failed'],
      [
        new UnprocessableEntityException('Validator failed'),
        'validator_failed',
      ],
    ])('explains %p as %s in History', async (error, reason) => {
      const { service, engine, skipRows, updates } = setup();

      engine.executeTransition.mockRejectedValue(error);

      await service.handle(event());

      expect(updates()).toHaveLength(0);
      expect(skipRows()).toEqual([
        {
          task_id: 'task-1',
          organization_id: ORG,
          action: 'git_automation_skipped',
          field_name: 'status',
          old_value: { id: 'st-dev', name: 'In development' },
          new_value: { id: 'st-review', name: 'In review' },
          changed_by: 'dev-user',
          metadata: {
            source: 'git',
            provider: 'github',
            event: 'pr_opened',
            subject: event().subject,
            actor: { login: 'dev', userId: 'dev-user', name: 'Dev' },
            reason,
          },
        },
      ]);
    });

    it('tries the next candidate after a refusal and logs nothing when one succeeds', async () => {
      const { service, engine, skipRows, updates } = setup((w) => {
        w.transitions = [
          transition('tr-1'),
          transition('tr-2', { toNode: 'node-qa' }),
        ];
      });

      engine.executeTransition
        .mockRejectedValueOnce(
          new BadRequestException(
            'Transition not available from current status',
          ),
        )
        .mockResolvedValueOnce({});

      await service.handle(event());

      expect(
        engine.executeTransition.mock.calls.map(([c]) => c.transitionId),
      ).toEqual(['tr-1', 'tr-2']);
      expect(updates()).toHaveLength(1);
      expect(skipRows()).toHaveLength(0);
    });

    it('logs one row with the most specific reason when every candidate is refused', async () => {
      const { service, engine, skipRows } = setup((w) => {
        w.transitions = [
          transition('tr-1'),
          transition('tr-2', { toNode: 'node-qa' }),
        ];
      });

      engine.executeTransition
        .mockRejectedValueOnce(
          new BadRequestException(
            'Transition not available from current status',
          ),
        )
        .mockRejectedValueOnce(new ForbiddenException('nope'));

      await service.handle(event());

      const rows = skipRows();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        new_value: { id: 'st-qa', name: 'QA' },
        metadata: { reason: 'condition_failed' },
      });
    });
  });

  describe('pr_merged and the other linked pull requests', () => {
    const merged =
      (config: Record<string, unknown> = {}) =>
      (w: IWorld) => {
        w.transitions = [
          transition('tr-1', {
            toNode: 'node-done',
            triggers: [trigger({ event: 'pr_merged', ...config })],
          }),
        ];
        w.prLinks['task-1'] = [
          // The merged pull request itself (still "open" in a racing read) is never waited for.
          { pull_request: { id: 'pr-1', number: 12, state: 'open' } },
          { pull_request: { id: 'pr-3', number: 30, state: 'open' } },
          { pull_request: { id: 'pr-2', number: 7, state: 'open' } },
          { pull_request: { id: 'pr-4', number: 2, state: 'merged' } },
          { pull_request: null },
        ];
      };

    it('waits for the other open pull requests by default and says which', async () => {
      const { service, engine, skipRows, db } = setup(merged());

      await service.handle(event({ event: 'pr_merged' }));

      expect(engine.executeTransition).not.toHaveBeenCalled();

      const [links] = db.on('git_pull_request_tasks');

      expect(eqOf(links, 'task_id')).toBe('task-1');
      expect(eqOf(links, 'state')).toBe('linked');

      const rows = skipRows();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        new_value: { id: 'st-done', name: 'Done' },
        metadata: { reason: 'waiting_other_prs', waitingFor: [7, 30] },
      });
    });

    it('moves at once when require_all_merged is off', async () => {
      const { service, engine, db } = setup(
        merged({ require_all_merged: false }),
      );

      await service.handle(event({ event: 'pr_merged' }));

      expect(db.on('git_pull_request_tasks')).toHaveLength(0);
      expect(engine.executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({ transitionId: 'tr-1' }),
      );
    });

    it('is not blocked by another pull request that was closed without merging', async () => {
      const { service, engine, skipRows } = setup((w) => {
        merged()(w);
        w.prLinks['task-1'] = [
          { pull_request: { id: 'pr-1', number: 12, state: 'merged' } },
          { pull_request: { id: 'pr-2', number: 7, state: 'closed' } },
        ];
      });

      await service.handle(event({ event: 'pr_merged' }));

      expect(engine.executeTransition).toHaveBeenCalled();
      expect(skipRows()).toHaveLength(0);
    });
  });

  describe('failures', () => {
    it.each([
      ['a NotFoundException', new NotFoundException('Task not found')],
      ['a plain Error', new Error('boom')],
    ])(
      'keeps going with the next task after %s and never throws',
      async (_name, error) => {
        const { service, engine, updates, skipRows } = setup();

        engine.executeTransition
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce({});

        await expect(
          service.handle(event({ taskIds: ['task-1', 'task-2'] })),
        ).resolves.toBeUndefined();

        expect(
          engine.executeTransition.mock.calls.map(([c]) => c.taskId),
        ).toEqual(['task-1', 'task-2']);
        expect(updates().map((u) => eqOf(u, 'id'))).toEqual(['h-1']);
        expect(skipRows()).toHaveLength(0);
      },
    );

    it('never throws when the candidates query fails', async () => {
      const { service, engine } = setup(
        (w) => (w.transitionsError = { message: 'db down' }),
      );

      await expect(service.handle(event())).resolves.toBeUndefined();
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('never throws when resolving the developer fails', async () => {
      const { service, engine, identities } = setup();

      identities.resolveAuthors.mockRejectedValue(new Error('identities down'));

      await expect(service.handle(event())).resolves.toBeUndefined();
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });
  });

  describe('tenant filters', () => {
    it('filters every tenant table by the organization', async () => {
      const moved = setup();

      await moved.service.handle(event());

      for (const table of [
        'tasks',
        'spaces',
        'task_statuses',
        'status_categories',
      ]) {
        const chains = moved.db.on(table);

        expect(chains.length).toBeGreaterThan(0);
        for (const chain of chains)
          expect(eqOf(chain, 'organization_id')).toBe(ORG);
      }
      for (const chain of moved.db.on('task_history'))
        expect(eqOf(chain, 'organization_id')).toBe(ORG);
      expect(moved.updates()).toHaveLength(1);

      const waiting = setup((w) => {
        w.transitions = [
          transition('tr-1', {
            toNode: 'node-done',
            triggers: [trigger({ event: 'pr_merged' })],
          }),
        ];
        w.prLinks['task-1'] = [
          { pull_request: { id: 'pr-2', number: 7, state: 'open' } },
        ];
      });

      await waiting.service.handle(event({ event: 'pr_merged' }));

      const [links] = waiting.db.on('git_pull_request_tasks');

      expect(eqOf(links, 'organization_id')).toBe(ORG);
      expect(waiting.skipRows()[0].organization_id).toBe(ORG);
    });
  });
});

describe('skipReasonOf', () => {
  it.each<[unknown, string | null]>([
    [new ForbiddenException('x'), 'condition_failed'],
    [new UnprocessableEntityException('x'), 'validator_failed'],
    [
      new BadRequestException('Transition not available from current status'),
      'not_allowed_from_current',
    ],
    [new BadRequestException('Required field missing'), 'validator_failed'],
    [new NotFoundException('Task not found'), null],
    [new Error('boom'), null],
    ['string', null],
    [undefined, null],
  ])('maps %p to %p', (error, reason) => {
    expect(skipReasonOf(error)).toBe(reason);
  });
});
