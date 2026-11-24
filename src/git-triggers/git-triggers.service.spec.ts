/**
 * @fileoverview Unit tests for the git-branch-created trigger runtime and its
 * glob matcher.
 * @module src/git-triggers/git-triggers.service.spec
 */

import { createHmac } from 'crypto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { GitTriggersService } from './git-triggers.service';
import { globMatch, globToRegExp } from './glob-match.util';

jest.mock('../lib/crypto/encryption', () => ({
  decryptApiKey: () => 'test-secret',
  encryptApiKey: () => ({ encrypted: 'e', iv: 'i', tag: 't' }),
}));

describe('globMatch', () => {
  it('matches feature/* against nested branch names', () => {
    expect(globMatch('feature/*', 'feature/DEFAULT-T29-login')).toBe(true);
    expect(globMatch('feature/*', 'feature/a/b')).toBe(true);
    expect(globMatch('feature/*', 'release/1')).toBe(false);
  });

  it('matches a prefix glob', () => {
    expect(globMatch('feature/test-demo*', 'feature/test-demo-1')).toBe(true);
    expect(globMatch('feature/test-demo*', 'feature/other')).toBe(false);
  });

  it('treats regex metacharacters in the pattern literally', () => {
    expect(globMatch('release/v.*', 'release/v.2')).toBe(true);
    expect(globMatch('release/v.*', 'release/vX2')).toBe(false);
    expect(globToRegExp('main').test('main')).toBe(true);
    expect(globToRegExp('main').test('maintenance')).toBe(false);
  });

  it('? matches exactly one character', () => {
    expect(globMatch('v?', 'v1')).toBe(true);
    expect(globMatch('v?', 'v12')).toBe(false);
  });
});

describe('GitTriggersService', () => {
  const TX = {
    id: 'tx-1',
    workflow_id: 'wf-1',
    triggers: [
      {
        type: 'git_branch_created',
        branch_pattern: 'feature/*',
        repo_id: 'acme/app',
      },
    ],
    workflows: {
      id: 'wf-1',
      organization_id: 'org-1',
      space_id: 'space-1',
      is_archived: false,
      is_active: true,
      is_draft: false,
      created_by: 'user-1',
    },
  };

  function makeService(cfg: {
    transitions?: unknown[];
    task?: { id: string } | null;
    engine?: { executeTransition: jest.Mock };
    webhooks?: unknown[];
  }) {
    // Captures every `.insert(values)` call together with its table name so
    // tests can assert the trigger-event audit rows written by logTriggerEvent.
    const insertSpy = jest.fn();
    // Minimal chainable Supabase mock: table queries are awaited directly
    // (thenable) — transitions for workflow_transitions, webhook rows for
    // workflow_github_webhooks — while tasks/users end with maybeSingle().
    const client = {
      from(table: string) {
        const b: Record<string, unknown> = {};
        Object.assign(b, {
          select: () => b,
          filter: () => b,
          ilike: () => b,
          update: () => b,
          insert: (values: unknown) => {
            insertSpy(table, values);

            return b;
          },
          eq: () => b,
          maybeSingle: () =>
            Promise.resolve(
              table === 'tasks'
                ? { data: cfg.task ?? null, error: null }
                : table === 'users'
                  ? {
                      data: {
                        id: 'user-1',
                        email: 'u@x.com',
                        role: 'member',
                        is_active: true,
                      },
                      error: null,
                    }
                  : { data: null, error: null },
            ),
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve(
              table === 'workflow_github_webhooks'
                ? { data: cfg.webhooks ?? [], error: null }
                : { data: cfg.transitions ?? [], error: null },
            ).then(onF, onR),
        });

        return b;
      },
    };

    const engine = cfg.engine ?? {
      executeTransition: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new GitTriggersService(
      { getClient: () => client } as never,
      engine as never,
    );

    return { svc, engine, insertSpy };
  }

  it('fires the matching transition on the task resolved from the branch name', async () => {
    const { svc, engine } = makeService({
      transitions: [TX],
      task: { id: 'task-1' },
    });

    const r = await svc.handleBranchCreated({
      payload: {
        repository_id: 'acme/app',
        branch: 'feature/DEFAULT-T29-login',
      },
    });

    expect(r).toEqual({ accepted: true, fired: 1 });
    expect(engine.executeTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        transitionId: 'tx-1',
        screenInput: {},
      }),
    );
  });

  it('logs a fired outcome to workflow_github_trigger_events when a logSource is provided', async () => {
    const { svc, engine, insertSpy } = makeService({
      transitions: [TX],
      task: { id: 'task-1' },
    });

    const r = await svc.handleBranchCreated(
      {
        payload: {
          repository_id: 'acme/app',
          branch: 'feature/DEFAULT-T29-login',
        },
      },
      { deliveryId: 'd1', eventName: 'create' },
    );

    expect(r).toEqual({ accepted: true, fired: 1 });
    expect(engine.executeTransition).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(
      'workflow_github_trigger_events',
      expect.objectContaining({
        outcome: 'fired',
        delivery_id: 'd1',
        event_name: 'create',
        workflow_id: 'wf-1',
        transition_id: 'tx-1',
        space_id: 'space-1',
        task_key: 'DEFAULT-T29',
        repo_full_name: 'acme/app',
      }),
    );
  });

  it('does not log trigger events when no logSource is provided', async () => {
    const { svc, insertSpy } = makeService({
      transitions: [TX],
      task: { id: 'task-1' },
    });

    const r = await svc.handleBranchCreated({
      payload: {
        repository_id: 'acme/app',
        branch: 'feature/DEFAULT-T29-login',
      },
    });

    expect(r).toEqual({ accepted: true, fired: 1 });
    expect(insertSpy).not.toHaveBeenCalledWith(
      'workflow_github_trigger_events',
      expect.anything(),
    );
  });

  it('no-ops (fired:0) when the engine rejects the transition as not-firable', async () => {
    const engine = {
      executeTransition: jest
        .fn()
        .mockRejectedValue(
          new BadRequestException(
            'Transition not available from current status',
          ),
        ),
    };
    const { svc } = makeService({
      transitions: [TX],
      task: { id: 'task-1' },
      engine,
    });

    const r = await svc.handleBranchCreated({
      payload: {
        repository_id: 'acme/app',
        branch: 'feature/DEFAULT-T29-login',
      },
    });

    expect(r).toEqual({ accepted: true, fired: 0 });
  });

  it('does not fire when the repository does not match', async () => {
    const { svc, engine } = makeService({
      transitions: [TX],
      task: { id: 'task-1' },
    });

    const r = await svc.handleBranchCreated({
      payload: {
        repository_id: 'other/repo',
        branch: 'feature/DEFAULT-T29-login',
      },
    });

    expect(r).toEqual({ accepted: true, fired: 0 });
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });

  it('does not fire when the branch carries no task key', async () => {
    const { svc, engine } = makeService({
      transitions: [TX],
      task: { id: 'task-1' },
    });

    const r = await svc.handleBranchCreated({
      payload: { repository_id: 'acme/app', branch: 'feature/no-key-here' },
    });

    expect(r).toEqual({ accepted: true, fired: 0 });
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });

  it('ignores draft / inactive / archived workflows', async () => {
    const draftTx = {
      ...TX,
      workflows: { ...TX.workflows, is_draft: true },
    };
    const { svc, engine } = makeService({
      transitions: [draftTx],
      task: { id: 'task-1' },
    });

    const r = await svc.handleBranchCreated({
      payload: { repository_id: 'acme/app', branch: 'feature/DEFAULT-T29' },
    });

    expect(r).toEqual({ accepted: true, fired: 0 });
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });

  it('throws 400 when repository or branch is missing', async () => {
    const { svc } = makeService({ transitions: [TX] });

    await expect(
      svc.handleBranchCreated({ payload: { branch: 'feature/DEFAULT-T29' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.handleBranchCreated({ payload: { repository_id: 'acme/app' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('handlePrMerged', () => {
    const PR_TX = {
      id: 'tx-1',
      workflow_id: 'wf-1',
      triggers: [
        {
          type: 'git_pr_merged',
          target_branch: 'main',
          repo_id: 'acme/app',
        },
      ],
      workflows: {
        id: 'wf-1',
        organization_id: 'org-1',
        space_id: 'space-1',
        is_archived: false,
        is_active: true,
        is_draft: false,
        created_by: 'user-1',
      },
    };

    it('fires on repo + target(base) + source-branch task key match', async () => {
      const { svc, engine } = makeService({
        transitions: [PR_TX],
        task: { id: 'task-1' },
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'acme/app',
          target_branch: 'main',
          source_branch: 'feature/DEFAULT-T29-login',
          merged: true,
        },
      });

      expect(r).toEqual({ accepted: true, fired: 1 });
      expect(engine.executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          transitionId: 'tx-1',
          screenInput: {},
        }),
      );
    });

    it('fires against any base branch when target_branch is not configured', async () => {
      const anyBaseTx = {
        ...PR_TX,
        triggers: [{ type: 'git_pr_merged', repo_id: 'acme/app' }],
      };
      const { svc, engine } = makeService({
        transitions: [anyBaseTx],
        task: { id: 'task-1' },
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'acme/app',
          target_branch: 'release/9',
          source_branch: 'feature/DEFAULT-T29-login',
        },
      });

      expect(r).toEqual({ accepted: true, fired: 1 });
      expect(engine.executeTransition).toHaveBeenCalledTimes(1);
    });

    it('does not fire when the repository does not match', async () => {
      const { svc, engine } = makeService({
        transitions: [PR_TX],
        task: { id: 'task-1' },
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'other/repo',
          target_branch: 'main',
          source_branch: 'feature/DEFAULT-T29-login',
          merged: true,
        },
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('does not fire when the trigger config lacks the required repo_id', async () => {
      const noRepoTx = {
        ...PR_TX,
        triggers: [{ type: 'git_pr_merged', target_branch: 'main' }],
      };
      const { svc, engine } = makeService({
        transitions: [noRepoTx],
        task: { id: 'task-1' },
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'acme/app',
          target_branch: 'main',
          source_branch: 'feature/DEFAULT-T29-login',
          merged: true,
        },
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('does not fire when the target (base) branch does not match', async () => {
      const { svc, engine } = makeService({
        transitions: [PR_TX],
        task: { id: 'task-1' },
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'acme/app',
          target_branch: 'develop',
          source_branch: 'feature/DEFAULT-T29-login',
          merged: true,
        },
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('does not fire when the PR was closed without merging (merged:false)', async () => {
      const { svc, engine } = makeService({
        transitions: [PR_TX],
        task: { id: 'task-1' },
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'acme/app',
          target_branch: 'main',
          source_branch: 'feature/DEFAULT-T29-login',
          merged: false,
        },
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('does not fire when the source branch carries no task key', async () => {
      const { svc, engine } = makeService({
        transitions: [PR_TX],
        task: { id: 'task-1' },
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'acme/app',
          target_branch: 'main',
          source_branch: 'feature/no-key-here',
          merged: true,
        },
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('does not fire when the task cannot be resolved', async () => {
      const { svc, engine } = makeService({
        transitions: [PR_TX],
        task: null,
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'acme/app',
          target_branch: 'main',
          source_branch: 'feature/DEFAULT-T29-login',
          merged: true,
        },
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('no-ops (fired:0) when the engine rejects the transition as not-firable', async () => {
      const engine = {
        executeTransition: jest
          .fn()
          .mockRejectedValue(
            new BadRequestException(
              'Transition not available from current status',
            ),
          ),
      };
      const { svc } = makeService({
        transitions: [PR_TX],
        task: { id: 'task-1' },
        engine,
      });

      const r = await svc.handlePrMerged({
        payload: {
          repository_id: 'acme/app',
          target_branch: 'main',
          source_branch: 'feature/DEFAULT-T29-login',
          merged: true,
        },
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
    });

    it('throws 400 when repository or source branch is missing', async () => {
      const { svc } = makeService({ transitions: [PR_TX] });

      await expect(
        svc.handlePrMerged({
          payload: { source_branch: 'feature/DEFAULT-T29' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.handlePrMerged({ payload: { repository_id: 'acme/app' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('handleGithubEvent', () => {
    const WEBHOOK_ROWS = [
      { id: 'wh-1', secret_encrypted: 'e', secret_iv: 'i', secret_tag: 't' },
    ];

    // Signature over the RAW body with the (mock-decrypted) secret 'test-secret'.
    const sign = (rawBody: string) =>
      'sha256=' +
      createHmac('sha256', 'test-secret').update(rawBody, 'utf8').digest('hex');

    it('fires the transition on a signed `create` branch event', async () => {
      const { svc, engine } = makeService({
        transitions: [TX],
        task: { id: 'task-1' },
        webhooks: WEBHOOK_ROWS,
      });
      const rawBody = JSON.stringify({
        repository: { full_name: 'acme/app', id: 42 },
        ref: 'feature/DEFAULT-T29-login',
        ref_type: 'branch',
      });

      const r = await svc.handleGithubEvent({
        eventName: 'create',
        deliveryId: 'gh-1',
        signature: sign(rawBody),
        rawBody,
      });

      expect(r).toEqual({ accepted: true, fired: 1 });
      expect(engine.executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1', transitionId: 'tx-1' }),
      );
    });

    it('rejects a delivery whose signature matches no registered secret', async () => {
      const { svc } = makeService({ webhooks: WEBHOOK_ROWS });
      const rawBody = JSON.stringify({
        repository: { full_name: 'acme/app' },
        ref: 'feature/DEFAULT-T29',
        ref_type: 'branch',
      });

      await expect(
        svc.handleGithubEvent({
          eventName: 'create',
          deliveryId: 'gh-2',
          signature: 'sha256=deadbeef',
          rawBody,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the repo has no registered webhook (no secret)', async () => {
      const { svc } = makeService({ webhooks: [] });
      const rawBody = JSON.stringify({
        repository: { full_name: 'acme/app' },
        ref: 'feature/DEFAULT-T29',
        ref_type: 'branch',
      });

      await expect(
        svc.handleGithubEvent({
          eventName: 'create',
          deliveryId: 'gh-3',
          signature: sign(rawBody),
          rawBody,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('accepts via the WORKFLOW_GIT_TRIGGER_SECRET fallback when no repo secret is registered', async () => {
      process.env.WORKFLOW_GIT_TRIGGER_SECRET = 'env-secret';

      try {
        const { svc, engine } = makeService({
          transitions: [TX],
          task: { id: 'task-1' },
          webhooks: [],
        });
        const rawBody = JSON.stringify({
          repository: { full_name: 'acme/app', id: 42 },
          ref: 'feature/DEFAULT-T29-login',
          ref_type: 'branch',
        });
        const signature =
          'sha256=' +
          createHmac('sha256', 'env-secret')
            .update(rawBody, 'utf8')
            .digest('hex');

        const r = await svc.handleGithubEvent({
          eventName: 'create',
          deliveryId: 'gh-env-1',
          signature,
          rawBody,
        });

        expect(r).toEqual({ accepted: true, fired: 1 });
        expect(engine.executeTransition).toHaveBeenCalledWith(
          expect.objectContaining({ taskId: 'task-1', transitionId: 'tx-1' }),
        );
      } finally {
        delete process.env.WORKFLOW_GIT_TRIGGER_SECRET;
      }
    });

    it('still rejects when the fallback secret is set but the signature is wrong', async () => {
      process.env.WORKFLOW_GIT_TRIGGER_SECRET = 'env-secret';

      try {
        const { svc } = makeService({ webhooks: [] });
        const rawBody = JSON.stringify({
          repository: { full_name: 'acme/app' },
          ref: 'feature/DEFAULT-T29',
          ref_type: 'branch',
        });
        const wrong =
          'sha256=' +
          createHmac('sha256', 'not-the-secret')
            .update(rawBody, 'utf8')
            .digest('hex');

        await expect(
          svc.handleGithubEvent({
            eventName: 'create',
            deliveryId: 'gh-env-2',
            signature: wrong,
            rawBody,
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      } finally {
        delete process.env.WORKFLOW_GIT_TRIGGER_SECRET;
      }
    });

    it('acknowledges a signed `ping` without firing', async () => {
      const { svc, engine } = makeService({ webhooks: WEBHOOK_ROWS });
      const rawBody = JSON.stringify({
        repository: { full_name: 'acme/app' },
        zen: 'hi',
      });

      const r = await svc.handleGithubEvent({
        eventName: 'ping',
        deliveryId: 'gh-4',
        signature: sign(rawBody),
        rawBody,
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('ignores a `create` for a tag (ref_type != branch)', async () => {
      const { svc, engine } = makeService({
        transitions: [TX],
        task: { id: 'task-1' },
        webhooks: WEBHOOK_ROWS,
      });
      const rawBody = JSON.stringify({
        repository: { full_name: 'acme/app' },
        ref: 'v1.0.0',
        ref_type: 'tag',
      });

      const r = await svc.handleGithubEvent({
        eventName: 'create',
        deliveryId: 'gh-5',
        signature: sign(rawBody),
        rawBody,
      });

      expect(r).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('dedupes a repeated delivery id', async () => {
      const { svc, engine } = makeService({
        transitions: [TX],
        task: { id: 'task-1' },
        webhooks: WEBHOOK_ROWS,
      });
      const rawBody = JSON.stringify({
        repository: { full_name: 'acme/app' },
        ref: 'feature/DEFAULT-T29-login',
        ref_type: 'branch',
      });
      const args = {
        eventName: 'create',
        deliveryId: 'gh-dupe',
        signature: sign(rawBody),
        rawBody,
      };

      await svc.handleGithubEvent(args);
      const second = await svc.handleGithubEvent(args);

      expect(second).toEqual({ accepted: true, fired: 0 });
      expect(engine.executeTransition).toHaveBeenCalledTimes(1);
    });
  });
});
