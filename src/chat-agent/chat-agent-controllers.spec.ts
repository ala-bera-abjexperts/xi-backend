/**
 * @fileoverview Route metadata of EVERY controller under src/chat-agent (found on
 * disk, so a new controller or route is covered without touching this file), held to
 * contract section 4:
 *  - reading routes: the chat licence and `can_use_chat` only, open while impersonating;
 *  - routes that start or change something: also the AI licence and `can_use_robert`,
 *    closed during impersonation;
 *  - admin routes: exactly `can_manage_robert` or `can_view_ai_audit`, the chat licence
 *    only, and closed during impersonation when they change something.
 * The origins controller of a later step is gated by object visibility alone (no chat
 * licence, no chat permission): it has to be named here as an exception when it arrives.
 * @module src/chat-agent/chat-agent-controllers.spec
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Post,
  Put,
  RequestMethod,
  SetMetadata,
} from '@nestjs/common';
// Not re-exported from the `@nestjs/common` root barrel in the pinned NestJS.
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  IMPERSONATION_BLOCKED_KEY,
  ImpersonationBlocked,
} from '../auth/decorators/impersonation-blocked.decorator';
import {
  REQUIRE_FEATURE_KEY,
  RequireFeature,
} from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  CHAT_PERMISSION_KEY,
  ChatPermissionGuard,
  RequireChatPermission,
} from '../chat/chat-permission.guard';
import type { ChatRealtimeService } from '../chat/chat-realtime.service';
import type { AgentGatesService } from './agent-gates.service';
import type { ChatAccessService } from '../chat/chat-access.service';
import type { AgentActionExecutorService } from './agent-action-executor.service';
import type { AgentAuditService } from './agent-audit.service';
import type { AgentRunStarterService } from './agent-run-starter.service';
import type { AgentRunViewService } from './agent-run-view.service';
import type { AgentRunWorkerService } from './agent-run-worker.service';
import type { AgentRunsRepository } from './agent-runs.repository';
import { ROBERT_ID } from './agent.constants';
import { ChatAgentAuditController } from './chat-agent-audit.controller';
import { ChatAgentRunsController } from './chat-agent-runs.controller';
import { ChatAgentController } from './chat-agent.controller';

// jsdom-backed DOMPurify is ESM; the real sanitiser has its own spec.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: jest.fn(),
}));

/**
 * The only handlers that are not GET and still read and change nothing, so they
 * answer during impersonation and without the AI licence (contract section 4: the
 * reading routes are status, runs/resolve and runs/open).
 */
const READ_ONLY_POSTS = ['POST runs/resolve'];

const ADMIN_KEYS = ['can_manage_robert', 'can_view_ai_audit'];

type ControllerClass = { name: string; prototype: Record<string, object> };

interface Route {
  id: string;
  route: string;
  keys: string[];
  features: string[];
  blocked: boolean;
  guarded: boolean;
}

const meta = <T>(key: string, target: object): T | undefined =>
  Reflect.getMetadata(key, target) as T | undefined;

function routesOf(controller: ControllerClass): Route[] {
  return Object.getOwnPropertyNames(controller.prototype)
    .map((name) => ({ name, handler: controller.prototype[name] }))
    .filter(
      ({ handler }) =>
        typeof handler === 'function' &&
        Reflect.hasMetadata(METHOD_METADATA, handler),
    )
    .map(({ name, handler }) => ({
      id: `${controller.name}.${name}`,
      route: `${RequestMethod[meta<RequestMethod>(METHOD_METADATA, handler) ?? 0]} ${
        meta<string>(PATH_METADATA, handler) ?? ''
      }`,
      // Class key AND handler key, as ChatPermissionGuard reads them.
      keys: [
        meta<string>(CHAT_PERMISSION_KEY, controller),
        meta<string>(CHAT_PERMISSION_KEY, handler),
      ].filter((key): key is string => !!key),
      // Class features AND handler features, as FeatureGuard reads them.
      features: [
        ...new Set([
          ...(meta<string[]>(REQUIRE_FEATURE_KEY, controller) ?? []),
          ...(meta<string[]>(REQUIRE_FEATURE_KEY, handler) ?? []),
        ]),
      ],
      blocked:
        meta<boolean>(IMPERSONATION_BLOCKED_KEY, controller) === true ||
        meta<boolean>(IMPERSONATION_BLOCKED_KEY, handler) === true,
      // A key nobody enforces is no gate: the guard itself must be attached.
      guarded: [
        ...(meta<unknown[]>(GUARDS_METADATA, controller) ?? []),
        ...(meta<unknown[]>(GUARDS_METADATA, handler) ?? []),
      ].includes(ChatPermissionGuard),
    }));
}

/** What is wrong with a route; empty when it follows contract section 4. */
function violations({ route, keys, features, blocked, guarded }: Route) {
  const found: string[] = [];
  const reads = route.startsWith('GET ') || READ_ONLY_POSTS.includes(route);
  const needsAi = features.includes('feature_ai_assist');

  if (!features.includes('module_chat')) found.push('needs the chat licence');
  if (!guarded || keys.length === 0) found.push('has no chat permission');

  if (keys.some((key) => ADMIN_KEYS.includes(key))) {
    if (keys.length !== 1) found.push('admin: exactly one admin permission');
    if (needsAi) found.push('admin: must work without the AI licence');
  } else if (reads) {
    if (keys.join() !== 'can_use_chat') found.push('read: can_use_chat only');
    if (needsAi) found.push('read: must work without the AI licence');
    if (blocked) found.push('read: must stay open during impersonation');
  } else {
    if (keys.join() !== 'can_use_chat,can_use_robert')
      found.push('change: can_use_chat and can_use_robert');
    if (!needsAi) found.push('change: needs the AI licence');
  }

  if (!reads && !blocked) found.push('change: closed during impersonation');

  return found;
}

const controllers = (readdirSync(__dirname, { recursive: true }) as string[])
  .filter((file) => file.endsWith('.controller.ts'))
  .flatMap((file) =>
    Object.values(
      jest.requireActual<Record<string, unknown>>(join(__dirname, file)),
    ),
  )
  .filter(
    (exported): exported is ControllerClass =>
      typeof exported === 'function' &&
      Reflect.hasMetadata(PATH_METADATA, exported),
  );

const routes = controllers.flatMap(routesOf);

describe('chat-agent controllers', () => {
  it('finds the controllers and their routes (guards against a vacuous pass)', () => {
    expect(controllers.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'ChatAgentController',
        'ChatAgentAdminController',
        'ChatAgentRunsController',
        'ChatAgentAuditController',
      ]),
    );
    expect(routes.map((r) => r.route)).toEqual(
      expect.arrayContaining([
        'GET status',
        'POST dm',
        'GET settings',
        'PUT settings',
        'GET usage',
        'POST runs/resolve',
        'POST runs/:id/cancel',
        'POST runs/:id/rerun',
        'PATCH runs/:id/actions',
        'POST runs/:id/confirm',
        'POST runs/:id/undo',
        'POST actions/:id/cancel',
        'POST actions/:id/retry',
        'POST runs/:id/feedback',
        'GET actions/:id/options',
        'GET audit',
        'GET audit/export',
      ]),
    );
  });

  it('serves every controller under /chat/agent', () => {
    expect(
      controllers
        .filter((c) => meta<string>(PATH_METADATA, c) !== 'chat/agent')
        .map((c) => c.name),
    ).toEqual([]);
  });

  it('holds every route to the guards of its kind', () => {
    expect(
      routes.flatMap((route) =>
        violations(route).map(
          (problem) => `${route.id} (${route.route}): ${problem}`,
        ),
      ),
    ).toEqual([]);
  });

  // The routes of steps 2, 1.13 and 1.14, spelled out: the rules above cannot drift unnoticed.
  it.each([
    ['GET status', ['can_use_chat'], ['module_chat'], false],
    [
      'POST dm',
      ['can_use_chat', 'can_use_robert'],
      ['module_chat', 'feature_ai_assist'],
      true,
    ],
    ['GET settings', ['can_manage_robert'], ['module_chat'], false],
    ['PUT settings', ['can_manage_robert'], ['module_chat'], true],
    ['GET usage', ['can_manage_robert'], ['module_chat'], false],
    ['POST runs/resolve', ['can_use_chat'], ['module_chat'], false],
    [
      'POST runs/:id/cancel',
      ['can_use_chat', 'can_use_robert'],
      ['module_chat', 'feature_ai_assist'],
      true,
    ],
    [
      'POST runs/:id/rerun',
      ['can_use_chat', 'can_use_robert'],
      ['module_chat', 'feature_ai_assist'],
      true,
    ],
    ...[
      'PATCH runs/:id/actions',
      'POST runs/:id/confirm',
      'POST runs/:id/undo',
      'POST actions/:id/cancel',
      'POST actions/:id/retry',
      'POST runs/:id/feedback',
    ].map((path) => [
      path,
      ['can_use_chat', 'can_use_robert'],
      ['module_chat', 'feature_ai_assist'],
      true,
    ]),
    ['GET audit', ['can_view_ai_audit'], ['module_chat'], false],
    ['GET audit/export', ['can_view_ai_audit'], ['module_chat'], true],
  ] as [string, string[], string[], boolean][])(
    '%s needs %j, the features %j, impersonation blocked: %s',
    (path, keys, features, blocked) => {
      expect(routes.find((r) => r.route === path)).toMatchObject({
        keys,
        features,
        blocked,
        guarded: true,
      });
    },
  );

  describe('the rules catch a route that is added without its guards', () => {
    @RequireFeature('module_chat')
    @RequireChatPermission('can_use_chat')
    @Controller('chat/agent')
    class Careless {
      @Post('runs/:id/confirm')
      forgotEverything() {}

      @Post('runs/:id/undo')
      @RequireFeature('feature_ai_assist')
      @RequireChatPermission('can_use_robert')
      forgotImpersonation() {}

      @Get('runs/open')
      @RequireFeature('feature_ai_assist')
      @RequireChatPermission('can_use_robert')
      @ImpersonationBlocked()
      readNeedsTooMuch() {}

      @Put('settings')
      @RequireChatPermission('can_manage_robert')
      adminWithChatKeyAndOpen() {}
    }

    @Controller('chat/agent')
    class Unguarded {
      @Get('audit')
      nothingAtAll() {}

      @Get('audit/export')
      @RequireFeature('module_chat', 'feature_ai_assist')
      @SetMetadata(CHAT_PERMISSION_KEY, 'can_view_ai_audit')
      keyWithoutTheGuard() {}
    }

    const problems = (controller: unknown, handler: string) =>
      violations(
        routesOf(controller as ControllerClass).find((r) =>
          r.id.endsWith(`.${handler}`),
        ) as Route,
      );

    it.each([
      [
        Careless,
        'forgotEverything',
        [
          'change: can_use_chat and can_use_robert',
          'change: needs the AI licence',
          'change: closed during impersonation',
        ],
      ],
      [
        Careless,
        'forgotImpersonation',
        ['change: closed during impersonation'],
      ],
      [
        Careless,
        'readNeedsTooMuch',
        [
          'read: can_use_chat only',
          'read: must work without the AI licence',
          'read: must stay open during impersonation',
        ],
      ],
      [
        Careless,
        'adminWithChatKeyAndOpen',
        [
          'admin: exactly one admin permission',
          'change: closed during impersonation',
        ],
      ],
      [
        Unguarded,
        'nothingAtAll',
        [
          'needs the chat licence',
          'has no chat permission',
          'read: can_use_chat only',
        ],
      ],
      [
        Unguarded,
        'keyWithoutTheGuard',
        ['has no chat permission', 'admin: must work without the AI licence'],
      ],
    ])('%p.%s', (controller, handler, expected) => {
      expect(problems(controller, handler)).toEqual(expected);
    });
  });
});

describe('POST /chat/agent/dm', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

  it('opens the caller conversation with Robert and tells their other tabs', async () => {
    const getOrCreateAgentDm = jest.fn().mockResolvedValue('conv-9');
    const inboxChanged = jest.fn().mockResolvedValue(undefined);
    const controller = new ChatAgentController(
      {} as AgentGatesService,
      { getOrCreateAgentDm } as unknown as AgentRunsRepository,
      { inboxChanged } as unknown as ChatRealtimeService,
    );

    await expect(controller.openDm(user)).resolves.toEqual({
      conversationId: 'conv-9',
    });
    // Organization and person come from the session, never from the request.
    expect(getOrCreateAgentDm).toHaveBeenCalledWith('org-1', 'user-1');
    expect(inboxChanged).toHaveBeenCalledWith('conv-9', 'org-1');
  });

  it('answers the status of the gates service', async () => {
    const view = {
      state: 'ok',
      provider: 'openai',
      dmAllowed: true,
      robertId: ROBERT_ID,
    };
    const status = jest.fn().mockResolvedValue(view);
    const controller = new ChatAgentController(
      { status } as unknown as AgentGatesService,
      {} as AgentRunsRepository,
      {} as ChatRealtimeService,
    );

    await expect(controller.getStatus(user)).resolves.toBe(view);
    expect(status).toHaveBeenCalledWith(user);
  });
});

describe('ChatAgentRunsController', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;
  const view = { id: 'run-1', phase: 'cancelled' };
  let views: Record<string, jest.Mock>;
  let runs: Record<string, jest.Mock>;
  let worker: Record<string, jest.Mock>;
  let starter: Record<string, jest.Mock>;
  let access: Record<string, jest.Mock>;
  let executor: Record<string, jest.Mock>;
  let controller: ChatAgentRunsController;

  beforeEach(() => {
    views = {
      resolve: jest.fn().mockResolvedValue([view]),
      viewOne: jest.fn().mockResolvedValue(view),
      announce: jest.fn().mockResolvedValue(undefined),
      getOwnRun: jest.fn().mockResolvedValue({
        id: 'run-1',
        conversation_id: 'conv-1',
        trigger_message_id: 'msg-1',
        timezone: 'Europe/Vienna',
      }),
    };
    runs = { cancelRun: jest.fn().mockResolvedValue({ status: 'running' }) };
    worker = { abort: jest.fn().mockReturnValue(true) };
    starter = {
      start: jest.fn().mockResolvedValue({ id: 'run-2', messageId: 'a2' }),
    };
    access = {
      getReadable: jest
        .fn()
        .mockResolvedValue({ conversation: { id: 'conv-1' } }),
    };
    executor = {
      patch: jest.fn().mockResolvedValue(view),
      confirm: jest.fn().mockResolvedValue(view),
      cancel: jest.fn().mockResolvedValue(view),
      retry: jest.fn().mockResolvedValue(view),
      feedback: jest.fn().mockResolvedValue(undefined),
    };
    controller = new ChatAgentRunsController(
      views as unknown as AgentRunViewService,
      runs as unknown as AgentRunsRepository,
      worker as unknown as AgentRunWorkerService,
      starter as unknown as AgentRunStarterService,
      access as unknown as ChatAccessService,
      executor as unknown as AgentActionExecutorService,
    );
  });

  it('resolves the views of the caller', async () => {
    const ids = { runIds: ['run-1'], triggerMessageIds: ['msg-1'] };
    await expect(controller.resolve(user, ids)).resolves.toEqual({
      runs: [view],
    });
    expect(views.resolve).toHaveBeenCalledWith(user, ids);
  });

  it('cancels as the invoker, aborts a run in flight here at once and answers the fresh view', async () => {
    await expect(controller.cancel(user, 'run-1')).resolves.toBe(view);

    expect(runs.cancelRun).toHaveBeenCalledWith('org-1', 'run-1', 'user-1');
    expect(worker.abort).toHaveBeenCalledWith('run-1');
    expect(views.announce).toHaveBeenCalledWith('run-1');
    expect(views.viewOne).toHaveBeenCalledWith(user, 'run-1');
  });

  it('answers 404 to anyone but the invoker and aborts nothing', async () => {
    runs.cancelRun.mockRejectedValue(new NotFoundException());

    await expect(controller.cancel(user, 'run-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(worker.abort).not.toHaveBeenCalled();
  });

  it('re-runs the request of an own run, with its timezone', async () => {
    await expect(controller.rerun(user, 'run-1')).resolves.toEqual({
      agentRun: { id: 'run-2', messageId: 'a2' },
    });

    expect(views.getOwnRun).toHaveBeenCalledWith(user, 'run-1');
    expect(access.getReadable).toHaveBeenCalledWith(user, 'conv-1');
    expect(starter.start).toHaveBeenCalledWith(
      user,
      { id: 'conv-1' },
      'msg-1',
      { rerunOf: 'run-1', timezone: 'Europe/Vienna' },
    );
  });

  it('does not re-run a run of someone else or of another organization (404)', async () => {
    views.getOwnRun.mockRejectedValue(new NotFoundException());

    await expect(controller.rerun(user, 'run-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(starter.start).not.toHaveBeenCalled();
  });

  it('hands every proposal route to the executor with the session user', async () => {
    const changes = [{ actionId: 'a1', version: 2, fields: { due: null } }];
    await expect(
      controller.patchActions(user, 'run-1', { changes }),
    ).resolves.toBe(view);
    expect(executor.patch).toHaveBeenCalledWith(user, 'run-1', changes);

    const actions = [{ id: 'a1', version: 3 }];
    await expect(controller.confirm(user, 'run-1', { actions })).resolves.toBe(
      view,
    );
    expect(executor.confirm).toHaveBeenCalledWith(user, 'run-1', actions);

    await expect(controller.cancelAction(user, 'a1')).resolves.toBe(view);
    expect(executor.cancel).toHaveBeenCalledWith(user, 'a1');

    await expect(
      controller.retryAction(user, 'a1', { version: 4 }),
    ).resolves.toBe(view);
    expect(executor.retry).toHaveBeenCalledWith(user, 'a1', 4);

    await expect(
      controller.feedback(user, 'run-1', { rating: 'down' }),
    ).resolves.toBeUndefined();
    expect(executor.feedback).toHaveBeenCalledWith(user, 'run-1', 'down');
  });

  it('passes a 409 with the fresh run through untouched', async () => {
    const conflict = new ConflictException({
      message: 'stale',
      code: 'stale',
      data: { run: view },
    });
    executor.confirm.mockRejectedValue(conflict);

    await expect(
      controller.confirm(user, 'run-1', {
        actions: [{ id: 'a1', version: 1 }],
      }),
    ).rejects.toBe(conflict);
  });
});

describe('ChatAgentAuditController', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

  it('lists a page of the audit log', async () => {
    const page = { events: [], nextCursor: null };
    const list = jest.fn().mockResolvedValue(page);
    const controller = new ChatAgentAuditController({
      list,
    } as unknown as AgentAuditService);

    await expect(controller.list(user, { limit: 10 })).resolves.toBe(page);
    expect(list).toHaveBeenCalledWith(user, { limit: 10 });
  });

  it('sends the export as an attachment and says whether it was cut', async () => {
    const exportFn = jest
      .fn()
      .mockResolvedValue({ body: 'seq\r\n', capped: true });
    const controller = new ChatAgentAuditController({
      export: exportFn,
    } as unknown as AgentAuditService);
    const res = { set: jest.fn(), send: jest.fn() };

    await controller.export(
      user,
      { format: 'csv' },
      res as unknown as Parameters<ChatAgentAuditController['export']>[2],
    );

    const headers = (res.set.mock.calls[0] as unknown[])[0] as Record<
      string,
      string
    >;
    expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(headers['Content-Disposition']).toMatch(
      /^attachment; filename="robert-audit-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(headers['X-Export-Capped']).toBe('true');
    expect(res.send).toHaveBeenCalledWith('seq\r\n');
  });
});
