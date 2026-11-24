import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AgentRunsRepository } from './agent-runs.repository';
import { MAX_ACTIONS_PER_RUN } from './agent.constants';
import { MAX_PLAN_INTENTS } from './pipeline/agent-schemas';

const MIGRATIONS = resolve(
  process.cwd(),
  '..',
  'risk-management-app',
  'supabase',
  'migrations',
);
/** The first migration of Robert; a later file may redefine one of his functions. */
const FIRST_AGENT_MIGRATION = '20261014130000';

function setup(data: unknown = null) {
  const rpc = jest.fn().mockResolvedValue({ data, error: null });
  const repository = new AgentRunsRepository({
    getClient: () => ({ rpc }),
  } as unknown as SupabaseAdminService);

  return { repository, rpc };
}

const SCOPE = { spaces: [{ id: 'space-1', perm: 'view_tasks' }], refs: [] };

/**
 * Every wrapper, called with every argument it has, and the exact call it must make.
 * Contract sections 2.3 and 2.4 name the functions and their arguments.
 */
const CALLS: Array<{
  fn: string;
  call: (repository: AgentRunsRepository) => Promise<unknown>;
  args: Record<string, unknown>;
}> = [
  {
    fn: 'agent_start_run',
    call: (r) =>
      r.startRun({
        organizationId: 'org-1',
        triggerMessageId: 'msg-1',
        invokerId: 'user-1',
        timezone: 'Europe/Vienna',
        rerunOf: 'run-0',
        refusal: 'not_configured',
      }),
    args: {
      p_organization_id: 'org-1',
      p_trigger_message_id: 'msg-1',
      p_invoker_id: 'user-1',
      p_reserve: 60_000,
      p_timezone: 'Europe/Vienna',
      p_rerun_of: 'run-0',
      p_refusal: 'not_configured',
      p_rate: 6,
      p_max_running: 20,
    },
  },
  {
    fn: 'agent_claim_runs',
    call: (r) => r.claimRuns(3),
    args: { p_limit: 3, p_max_running: 20 },
  },
  {
    fn: 'agent_heartbeat',
    call: (r) => r.heartbeat(['lease-1', 'lease-2']),
    args: { p_lease_tokens: ['lease-1', 'lease-2'] },
  },
  {
    fn: 'agent_set_step',
    call: (r) => r.setStep('run-1', 'lease-1', 'checking'),
    args: { p_run_id: 'run-1', p_lease_token: 'lease-1', p_step: 'checking' },
  },
  {
    fn: 'agent_record_model_call',
    call: (r) =>
      r.recordModelCall({
        runId: 'run-1',
        leaseToken: 'lease-1',
        tokensIn: 900,
        tokensOut: 100,
        promptHash: 'abc',
        ok: false,
        errorKind: 'rate_limited',
        durationMs: 1200,
      }),
    args: {
      p_run_id: 'run-1',
      p_lease_token: 'lease-1',
      p_tokens_in: 900,
      p_tokens_out: 100,
      p_prompt_hash: 'abc',
      p_ok: false,
      p_error_kind: 'rate_limited',
      p_duration_ms: 1200,
    },
  },
  {
    fn: 'agent_finalize_run',
    call: (r) =>
      r.finalizeRun({
        runId: 'run-1',
        leaseToken: 'lease-1',
        status: 'completed',
        errorCode: null,
        visibility: 'conversation',
        result: { reply_text: 'Done', scope: SCOPE },
        actions: [{ kind: 'task', intent: { title: 'x' }, resolved: {} }],
        audit: { intents: 1 },
      }),
    args: {
      p_run_id: 'run-1',
      p_lease_token: 'lease-1',
      p_status: 'completed',
      p_error_code: null,
      p_visibility: 'conversation',
      p_result: { reply_text: 'Done', scope: SCOPE },
      p_actions: [{ kind: 'task', intent: { title: 'x' }, resolved: {} }],
      p_audit: { intents: 1 },
    },
  },
  { fn: 'agent_reap_runs', call: (r) => r.reapRuns(), args: {} },
  {
    fn: 'agent_cancel_run',
    call: (r) => r.cancelRun('org-1', 'run-1', 'user-1'),
    args: {
      p_organization_id: 'org-1',
      p_run_id: 'run-1',
      p_actor_id: 'user-1',
    },
  },
  {
    fn: 'agent_patch_action',
    call: (r) =>
      r.patchAction({
        organizationId: 'org-1',
        actionId: 'action-1',
        actorId: 'user-1',
        version: 2,
        overrides: { title: 'New' },
        resolved: { title: 'New', fields: [] },
        targetSpaceId: 'space-1',
        scope: SCOPE,
        narrow: true,
        audit: { fields: ['title'] },
      }),
    args: {
      p_organization_id: 'org-1',
      p_action_id: 'action-1',
      p_actor_id: 'user-1',
      p_version: 2,
      p_overrides: { title: 'New' },
      p_resolved: { title: 'New', fields: [] },
      p_target_space_id: 'space-1',
      p_scope: SCOPE,
      p_narrow: true,
      p_audit: { fields: ['title'] },
    },
  },
  {
    fn: 'agent_claim_actions',
    call: (r) => r.claimActions('org-1', 'run-1', 'user-1', { 'action-1': 2 }),
    args: {
      p_organization_id: 'org-1',
      p_run_id: 'run-1',
      p_actor_id: 'user-1',
      p_versions: { 'action-1': 2 },
    },
  },
  {
    fn: 'agent_complete_action',
    call: (r) =>
      r.completeAction({
        actionId: 'action-1',
        execToken: 'token-1',
        outcome: 'failed',
        reason: 'no_create_permission',
        reasonParams: { space: 'space-1' },
        audit: { attempt: 1 },
      }),
    args: {
      p_action_id: 'action-1',
      p_exec_token: 'token-1',
      p_outcome: 'failed',
      p_reason: 'no_create_permission',
      p_reason_params: { space: 'space-1' },
      p_audit: { attempt: 1 },
    },
  },
  {
    fn: 'agent_link_action',
    call: (r) =>
      r.linkAction({
        organizationId: 'org-1',
        actionId: 'action-1',
        actorId: 'user-1',
        version: 2,
        linkedEntityType: 'task',
        linkedEntityId: 'task-9',
        scope: SCOPE,
        narrow: false,
      }),
    args: {
      p_organization_id: 'org-1',
      p_action_id: 'action-1',
      p_actor_id: 'user-1',
      p_version: 2,
      p_linked_entity_type: 'task',
      p_linked_entity_id: 'task-9',
      p_scope: SCOPE,
      p_narrow: false,
    },
  },
  {
    fn: 'agent_claim_undo',
    call: (r) => r.claimUndo('org-1', 'user-1', true, ['action-1']),
    args: {
      p_organization_id: 'org-1',
      p_actor_id: 'user-1',
      p_is_admin: true,
      p_action_ids: ['action-1'],
    },
  },
  {
    fn: 'agent_complete_undo',
    call: (r) =>
      r.completeUndo({
        actionId: 'action-1',
        execToken: 'token-1',
        outcome: 'blocked',
        reason: 'has_comments',
        reasonParams: { count: 1 },
        actorId: 'user-1',
      }),
    args: {
      p_action_id: 'action-1',
      p_exec_token: 'token-1',
      p_outcome: 'blocked',
      p_reason: 'has_comments',
      p_reason_params: { count: 1 },
      p_actor_id: 'user-1',
    },
  },
  {
    fn: 'agent_cancel_actions',
    call: (r) =>
      r.cancelActions('org-1', 'requester_no_access', {
        actionIds: ['action-1'],
        triggerMessageId: 'msg-1',
        conversationId: 'conv-1',
        userId: 'user-2',
        actorId: 'user-1',
      }),
    args: {
      p_organization_id: 'org-1',
      p_reason: 'requester_no_access',
      p_action_ids: ['action-1'],
      p_trigger_message_id: 'msg-1',
      p_conversation_id: 'conv-1',
      p_user_id: 'user-2',
      p_actor_id: 'user-1',
    },
  },
  {
    fn: 'agent_expire_actions',
    call: (r) => r.expireActions(200),
    args: { p_limit: 200 },
  },
  {
    fn: 'agent_reclaim_stuck_actions',
    call: (r) => r.reclaimStuckActions(50),
    args: { p_limit: 50 },
  },
  {
    fn: 'chat_get_or_create_agent_dm',
    call: (r) => r.getOrCreateAgentDm('org-1', 'user-1'),
    args: {
      p_organization_id: 'org-1',
      p_user_id: 'user-1',
      p_agent_id: '0b3e7000-0000-4000-8000-000000000001',
    },
  },
  {
    fn: 'agent_find_members',
    call: (r) => r.findMembers('org-1', 'Michael', 4),
    args: { p_organization_id: 'org-1', p_name: 'Michael', p_limit: 4 },
  },
  {
    fn: 'agent_space_labels',
    call: (r) => r.spaceLabels('org-1', 'space-1', 50),
    args: { p_organization_id: 'org-1', p_space_id: 'space-1', p_limit: 50 },
  },
  {
    fn: 'agent_find_similar',
    call: (r) =>
      r.findSimilar({
        organizationId: 'org-1',
        entityType: 'asset_object',
        spaceIds: ['space-1'],
        title: 'Laptop 12',
        scopeId: 'type-1',
        identifiers: { serial: 'X1' },
        min: 0.5,
        limit: 3,
      }),
    args: {
      p_organization_id: 'org-1',
      p_entity_type: 'asset_object',
      p_space_ids: ['space-1'],
      p_title: 'Laptop 12',
      p_scope_id: 'type-1',
      p_identifiers: { serial: 'X1' },
      p_min: 0.5,
      p_limit: 3,
    },
  },
  {
    fn: 'agent_undo_blockers',
    call: (r) =>
      r.undoBlockers({
        organizationId: 'org-1',
        entityType: 'task',
        entityId: 'task-1',
        actorId: 'user-1',
        since: '2026-10-11T10:00:00Z',
        runId: 'run-1',
      }),
    args: {
      p_organization_id: 'org-1',
      p_entity_type: 'task',
      p_entity_id: 'task-1',
      p_actor_id: 'user-1',
      p_since: '2026-10-11T10:00:00Z',
      p_run_id: 'run-1',
    },
  },
  {
    fn: 'agent_undo_task',
    call: (r) =>
      r.undoTask({
        organizationId: 'org-1',
        taskId: 'task-1',
        actorId: 'user-1',
        since: '2026-10-11T10:00:00Z',
        runId: 'run-1',
      }),
    args: {
      p_organization_id: 'org-1',
      p_task_id: 'task-1',
      p_actor_id: 'user-1',
      p_since: '2026-10-11T10:00:00Z',
      p_run_id: 'run-1',
    },
  },
];

/** What supabase-js really sends: JSON drops the arguments left undefined. */
const sent = (rpc: jest.Mock): [string, Record<string, unknown>] => {
  const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];

  return [fn, JSON.parse(JSON.stringify(args)) as Record<string, unknown>];
};

describe('AgentRunsRepository', () => {
  it('wraps every function of contract sections 2.3 and 2.4', () => {
    expect(CALLS.map((entry) => entry.fn).sort()).toEqual(
      [
        'agent_cancel_actions',
        'agent_cancel_run',
        'agent_claim_actions',
        'agent_claim_runs',
        'agent_claim_undo',
        'agent_complete_action',
        'agent_complete_undo',
        'agent_expire_actions',
        'agent_finalize_run',
        'agent_find_members',
        'agent_find_similar',
        'agent_heartbeat',
        'agent_link_action',
        'agent_patch_action',
        'agent_reap_runs',
        'agent_reclaim_stuck_actions',
        'agent_record_model_call',
        'agent_set_step',
        'agent_space_labels',
        'agent_start_run',
        'agent_undo_blockers',
        'agent_undo_task',
        'chat_get_or_create_agent_dm',
      ].sort(),
    );
  });

  it.each(CALLS)(
    'calls $fn with the argument names of the contract',
    async ({ fn, call, args }) => {
      const { repository, rpc } = setup();

      await call(repository);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(sent(rpc)).toEqual([fn, args]);
    },
  );

  it('leaves optional arguments out so the database default applies', async () => {
    const { repository, rpc } = setup();

    await repository.findMembers('org-1', 'Anna');
    expect(sent(rpc)[1]).toEqual({
      p_organization_id: 'org-1',
      p_name: 'Anna',
    });

    rpc.mockClear();
    await repository.findSimilar({
      organizationId: 'org-1',
      entityType: 'task',
      spaceIds: ['space-1'],
      title: 'Fix login',
    });
    expect(Object.keys(sent(rpc)[1]).sort()).toEqual([
      'p_entity_type',
      'p_identifiers',
      'p_organization_id',
      'p_scope_id',
      'p_space_ids',
      'p_title',
    ]);
  });

  it('starts a plain send with no timezone, re-run or refusal', async () => {
    const { repository, rpc } = setup();

    await repository.startRun({
      organizationId: 'org-1',
      triggerMessageId: 'msg-1',
      invokerId: 'user-1',
    });

    expect(sent(rpc)[1]).toMatchObject({
      p_timezone: null,
      p_rerun_of: null,
      p_refusal: null,
    });
  });

  it('cancels by one filter and sends the others as null', async () => {
    const { repository, rpc } = setup(2);

    await expect(
      repository.cancelActions('org-1', 'request_deleted', {
        triggerMessageId: 'msg-1',
      }),
    ).resolves.toBe(2);
    expect(sent(rpc)[1]).toEqual({
      p_organization_id: 'org-1',
      p_reason: 'request_deleted',
      p_action_ids: null,
      p_trigger_message_id: 'msg-1',
      p_conversation_id: null,
      p_user_id: null,
      p_actor_id: null,
    });
  });

  describe('results', () => {
    it('returns what the function returned', async () => {
      const result = { run_id: 'run-1', status: 'running', created: true };
      const { repository } = setup(result);

      await expect(
        repository.startRun({
          organizationId: 'org-1',
          triggerMessageId: 'msg-1',
          invokerId: 'user-1',
        }),
      ).resolves.toBe(result);
    });

    it('returns the rows of a set-returning function, and none as an empty list', async () => {
      const rows = [{ id: 'run-1' }];

      await expect(setup(rows).repository.reapRuns()).resolves.toBe(rows);
      await expect(setup(null).repository.reapRuns()).resolves.toEqual([]);
      await expect(setup(null).repository.claimRuns(5)).resolves.toEqual([]);
      await expect(
        setup(null).repository.claimActions('org-1', 'run-1', 'user-1', {}),
      ).resolves.toEqual([]);
    });

    it('returns labels as plain strings and counts as numbers', async () => {
      await expect(
        setup([{ label: 'bug' }, { label: 'q4' }]).repository.spaceLabels(
          'org-1',
          'space-1',
        ),
      ).resolves.toEqual(['bug', 'q4']);
      await expect(setup(3).repository.expireActions(100)).resolves.toBe(3);
      await expect(setup(null).repository.expireActions(100)).resolves.toBe(0);
    });
  });

  describe('errors', () => {
    it.each([
      ['P0002', NotFoundException, 'run not found'],
      ['42501', ForbiddenException, 'run not found'],
      ['22023', BadRequestException, 'run not found'],
      ['23505', ConflictException, 'run not found'],
    ])(
      'maps SQLSTATE %s like the chat functions',
      async (code, exception, text) => {
        const { repository, rpc } = setup();
        rpc.mockResolvedValue({
          data: null,
          error: { code, message: 'chat: run not found' },
        });

        const call = repository.cancelRun('org-1', 'run-1', 'user-2');

        await expect(call).rejects.toThrow(exception);
        await expect(call).rejects.toThrow(text);
      },
    );
  });

  describe('with the worker switched off (ROBERT_WORKER_ENABLED=false)', () => {
    const previous = process.env.ROBERT_WORKER_ENABLED;
    let Isolated: typeof AgentRunsRepository;

    beforeAll(() => {
      process.env.ROBERT_WORKER_ENABLED = 'false';
      // The switch is read once per process: load a fresh copy of the modules.
      jest.isolateModules(() => {
        Isolated = jest.requireActual<{
          AgentRunsRepository: typeof AgentRunsRepository;
        }>('./agent-runs.repository').AgentRunsRepository;
      });
    });

    afterAll(() => {
      if (previous === undefined) delete process.env.ROBERT_WORKER_ENABLED;
      else process.env.ROBERT_WORKER_ENABLED = previous;
    });

    const isolated = () => {
      const rpc = jest.fn().mockResolvedValue({ data: [], error: null });
      const repository = new Isolated({
        getClient: () => ({ rpc }),
      } as unknown as SupabaseAdminService);

      return { repository, rpc };
    };

    it('never claims a run', async () => {
      const { repository, rpc } = isolated();

      await expect(repository.claimRuns(5)).resolves.toEqual([]);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('starts a run without a slot, so it is queued for another instance', async () => {
      const { repository, rpc } = isolated();

      await repository.startRun({
        organizationId: 'org-1',
        triggerMessageId: 'msg-1',
        invokerId: 'user-1',
      });

      expect(sent(rpc)[1]).toMatchObject({ p_max_running: 0 });
    });
  });
});

describe('agent constants', () => {
  it('allows as many actions per run as the plan schema allows intents', () => {
    expect(MAX_ACTIONS_PER_RUN).toBe(MAX_PLAN_INTENTS);
  });
});

// ---------------------------------------------------------------------------
// The functions are not in the local database while this module is built, so
// nothing here can call them. What can be proved without a database: every call
// names a function that the migration files define, with argument names it has.
// A wrong name would otherwise only show as a 404 from PostgREST at run time.
// ---------------------------------------------------------------------------

interface SqlFunction {
  all: string[];
  required: string[];
}

function sqlFunctions(): Map<string, SqlFunction> {
  const found = new Map<string, SqlFunction>();

  // In file order, so the newest definition of a function is the one that counts.
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql') && name >= FIRST_AGENT_MIGRATION)
    .sort()) {
    const sql = readFileSync(resolve(MIGRATIONS, file), 'utf-8').replace(
      /--.*$/gm,
      '',
    );

    for (const match of sql.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\s*\(/g,
    )) {
      // The argument list up to its closing bracket, split at top-level commas:
      // a type or a default may hold brackets and commas of its own.
      const params: string[] = [''];
      let depth = 1;

      for (
        let i = match.index + match[0].length;
        depth > 0 && i < sql.length;
        i += 1
      ) {
        const char = sql[i];

        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (char === ',' && depth === 1) params.push('');
        else if (depth > 0) params[params.length - 1] += char;
      }

      const named = params.map((param) => param.trim()).filter(Boolean);

      found.set(match[1], {
        all: named.map((param) => param.split(/\s+/)[0]),
        required: named
          .filter((param) => !/\bDEFAULT\b/i.test(param))
          .map((param) => param.split(/\s+/)[0]),
      });
    }
  }

  return found;
}

// Skipped only where the frontend repository (it owns the migrations) is not checked out.
const describeIfSibling = existsSync(MIGRATIONS) ? describe : describe.skip;

describeIfSibling('agent functions in the migration files', () => {
  const declared = sqlFunctions();

  it('parses the files (guards against a vacuous pass)', () => {
    expect(declared.get('agent_start_run')?.all).toEqual([
      'p_organization_id',
      'p_trigger_message_id',
      'p_invoker_id',
      'p_reserve',
      'p_timezone',
      'p_rerun_of',
      'p_refusal',
      'p_rate',
      'p_max_running',
    ]);
    expect(declared.get('agent_start_run')?.required).toHaveLength(4);
    expect(declared.get('agent_reap_runs')?.all).toEqual([]);
    expect(declared.get('agent_heartbeat')?.all).toEqual(['p_lease_tokens']);
  });

  it.each(CALLS)(
    'defines $fn with the arguments the repository sends',
    async ({ fn, call }) => {
      const { repository, rpc } = setup();
      await call(repository);
      const names = Object.keys(sent(rpc)[1]);
      const sql = declared.get(fn);

      expect(sql).toBeDefined();
      // Sent but unknown to the function: PostgREST finds no such function.
      expect(names.filter((name) => !sql?.all.includes(name))).toEqual([]);
      // Required by the function but never sent.
      expect(sql?.required.filter((name) => !names.includes(name))).toEqual([]);
    },
  );
});
