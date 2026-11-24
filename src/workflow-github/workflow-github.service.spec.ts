/**
 * @fileoverview Unit tests for the workflow-owned GitHub connection service:
 * PAT validation, secret-free summaries (org & space scope), and repo listing.
 * The Supabase admin client and the global `fetch` are both mocked.
 * @module src/workflow-github/workflow-github.service.spec
 */

import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { WorkflowGithubService } from './workflow-github.service';
import { encryptApiKey } from '../lib/crypto/encryption';

// 64-char hex — required by getEncryptionKey() for AES-256-GCM.
const TEST_SECRET = 'a'.repeat(64);

interface ClientCfg {
  activeRow?: unknown;
  insertRow?: unknown;
  // Rows resolved by an awaited (non-single) query chain, e.g. listTriggerEvents.
  rows?: unknown;
  // Rows resolved by the org-scoped `from('tasks')` lookup in listTriggerEvents.
  taskRows?: Array<{ key: string; summary: string | null }>;
  error?: { message: string } | null;
}

function makeClient(cfg: ClientCfg) {
  const b: Record<string, unknown> = {};

  Object.assign(b, {
    select: () => b,
    insert: () => b,
    update: () => b,
    eq: () => b,
    in: () => b,
    // Org-scope queries use `.is('space_id', null)`; the mock ignores args.
    is: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: () =>
      Promise.resolve({
        data: cfg.activeRow ?? null,
        error: cfg.error ?? null,
      }),
    single: () =>
      Promise.resolve({
        data: cfg.insertRow ?? null,
        error: cfg.error ?? null,
      }),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: cfg.rows ?? null,
        error: cfg.error ?? null,
      }).then(onF, onR),
  });

  // Separate builder for the org-scoped `tasks` name lookup in listTriggerEvents
  // so it resolves to task rows, not the event rows.
  const tasks: Record<string, unknown> = {};

  Object.assign(tasks, {
    select: () => tasks,
    eq: () => tasks,
    in: () => tasks,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({ data: cfg.taskRows ?? [], error: null }).then(onF, onR),
  });

  return { from: (table: string) => (table === 'tasks' ? tasks : b) };
}

function makeService(cfg: ClientCfg) {
  const client = makeClient(cfg);
  const svc = new WorkflowGithubService(
    {
      getClient: () => client,
    } as never,
    {
      get: () => 'https://app.example.com/api/v1',
    } as never,
  );

  return svc;
}

function mockFetchOnce(value: { ok: boolean; status: number; body?: unknown }) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: value.ok,
    status: value.status,
    statusText: 'mocked',
    json: () => Promise.resolve(value.body ?? {}),
  });
}

describe('WorkflowGithubService', () => {
  beforeAll(() => {
    process.env.AI_ENCRYPTION_SECRET = TEST_SECRET;
  });

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('connect', () => {
    it('validates the PAT, stores it, and returns a secret-free result (space scope)', async () => {
      mockFetchOnce({ ok: true, status: 200, body: { login: 'octocat' } });
      const svc = makeService({
        insertRow: { id: 'conn-1', external_account_id: 'octocat' },
      });

      const result = await svc.connect({
        organizationId: 'org-1',
        spaceId: 'space-1',
        token: 'ghp_valid',
        createdBy: 'user-1',
      });

      expect(result).toEqual({
        id: 'conn-1',
        external_account_id: 'octocat',
        is_revoked: false,
      });
    });

    it('connects at ORG scope (no spaceId) and returns a secret-free result', async () => {
      mockFetchOnce({ ok: true, status: 200, body: { login: 'octo-org' } });
      const svc = makeService({
        insertRow: { id: 'conn-2', external_account_id: 'octo-org' },
      });

      const result = await svc.connect({
        organizationId: 'org-1',
        token: 'ghp_valid',
        createdBy: 'user-1',
      });

      expect(result).toEqual({
        id: 'conn-2',
        external_account_id: 'octo-org',
        is_revoked: false,
      });
    });

    it('rejects an invalid token with 400', async () => {
      mockFetchOnce({ ok: false, status: 401 });
      const svc = makeService({});

      await expect(
        svc.connect({
          organizationId: 'org-1',
          spaceId: 'space-1',
          token: 'ghp_bad',
          createdBy: 'user-1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects connect when organization context is missing (onboarding)', async () => {
      const svc = makeService({});

      await expect(
        svc.connect({
          organizationId: '',
          token: 'ghp_valid',
          createdBy: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getConnection', () => {
    it('reports not-connected when the scope has no active row', async () => {
      const svc = makeService({ activeRow: null });

      await expect(svc.getConnection('org-1', 'space-1')).resolves.toEqual({
        connected: false,
      });
    });

    it('returns a secret-free summary with scope=space when connected to a space', async () => {
      const svc = makeService({
        activeRow: {
          id: 'conn-1',
          external_account_id: 'octocat',
          display_name: 'octocat',
          space_id: 'space-1',
        },
      });

      await expect(svc.getConnection('org-1', 'space-1')).resolves.toEqual({
        connected: true,
        id: 'conn-1',
        external_account_id: 'octocat',
        display_name: 'octocat',
        scope: 'space',
      });
    });

    it('returns scope=org for an org-level connection (space_id null)', async () => {
      const svc = makeService({
        activeRow: {
          id: 'conn-2',
          external_account_id: 'octo-org',
          display_name: 'octo-org',
          space_id: null,
        },
      });

      await expect(svc.getConnection('org-1', null)).resolves.toEqual({
        connected: true,
        id: 'conn-2',
        external_account_id: 'octo-org',
        display_name: 'octo-org',
        scope: 'org',
      });
    });
  });

  describe('listRepos', () => {
    it('throws 404 when no active connection exists', async () => {
      const svc = makeService({ activeRow: null });

      await expect(svc.listRepos('org-1', 'space-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('decrypts the token and maps the repositories', async () => {
      const enc = encryptApiKey('ghp_stored');
      const svc = makeService({
        activeRow: {
          id: 'conn-1',
          space_id: 'space-1',
          encrypted_secret: enc.encrypted,
          encryption_iv: enc.iv,
          encryption_tag: enc.tag,
        },
      });

      mockFetchOnce({
        ok: true,
        status: 200,
        body: [
          {
            full_name: 'acme/app',
            name: 'app',
            owner: { login: 'acme' },
            private: true,
          },
        ],
      });

      await expect(svc.listRepos('org-1', 'space-1')).resolves.toEqual([
        { fullName: 'acme/app', name: 'app', owner: 'acme', isPrivate: true },
      ]);
    });

    it('lists repos for an ORG-level connection (no spaceId)', async () => {
      const enc = encryptApiKey('ghp_org');
      const svc = makeService({
        activeRow: {
          id: 'conn-2',
          space_id: null,
          encrypted_secret: enc.encrypted,
          encryption_iv: enc.iv,
          encryption_tag: enc.tag,
        },
      });

      mockFetchOnce({
        ok: true,
        status: 200,
        body: [
          {
            full_name: 'acme/org-repo',
            name: 'org-repo',
            owner: { login: 'acme' },
            private: false,
          },
        ],
      });

      await expect(svc.listRepos('org-1', null)).resolves.toEqual([
        {
          fullName: 'acme/org-repo',
          name: 'org-repo',
          owner: 'acme',
          isPrivate: false,
        },
      ]);
    });

    it('surfaces a 401 from GitHub as Unauthorized (reconnect)', async () => {
      const enc = encryptApiKey('ghp_revoked');
      const svc = makeService({
        activeRow: {
          id: 'conn-1',
          space_id: 'space-1',
          encrypted_secret: enc.encrypted,
          encryption_iv: enc.iv,
          encryption_tag: enc.tag,
        },
      });

      mockFetchOnce({ ok: false, status: 401 });

      await expect(svc.listRepos('org-1', 'space-1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('listTriggerEvents', () => {
    it('maps rows to camelCase and resolves the task name from the key', async () => {
      const svc = makeService({
        rows: [
          {
            id: 'evt-1',
            outcome: 'fired',
            repo_full_name: 'acme/app',
            branch: 'feature/x',
            task_key: 'TASK-1',
            event_name: 'git_branch_created',
            message: 'transition fired',
            created_at: '2026-07-15T00:00:00.000Z',
          },
        ],
        taskRows: [{ key: 'TASK-1', summary: 'Fix the login page' }],
      });

      await expect(svc.listTriggerEvents('org-1', 'space-1')).resolves.toEqual([
        {
          id: 'evt-1',
          outcome: 'fired',
          repoFullName: 'acme/app',
          branch: 'feature/x',
          taskKey: 'TASK-1',
          taskName: 'Fix the login page',
          eventName: 'git_branch_created',
          message: 'transition fired',
          createdAt: '2026-07-15T00:00:00.000Z',
        },
      ]);
    });

    it('leaves taskName null when the key resolves to no task', async () => {
      const svc = makeService({
        rows: [
          {
            id: 'evt-2',
            outcome: 'no_op',
            repo_full_name: 'acme/app',
            branch: 'feature/gone',
            task_key: 'TASK-9',
            event_name: 'git_branch_created',
            message: 'Condition failed: field_equals',
            created_at: '2026-07-15T00:00:00.000Z',
          },
        ],
        taskRows: [],
      });

      const [evt] = await svc.listTriggerEvents('org-1', 'space-1');

      expect(evt.taskKey).toBe('TASK-9');
      expect(evt.taskName).toBeNull();
    });
  });
});
