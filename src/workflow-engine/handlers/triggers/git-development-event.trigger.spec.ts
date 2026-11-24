/**
 * @fileoverview Unit tests for GitDevelopmentEventTrigger (schema-only trigger).
 * @module src/workflow-engine/handlers/triggers/git-development-event.trigger.spec
 */

import {
  GIT_DEVELOPMENT_EVENTS,
  GitDevelopmentEventTrigger,
  type GitDevelopmentEventConfig,
} from './git-development-event.trigger';
import type { IEvaluationContext } from '../handler.types';

describe('GitDevelopmentEventTrigger', () => {
  const handler = new GitDevelopmentEventTrigger();

  const ctx: IEvaluationContext = {
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: null,
    task: null,
    transitionId: 'tx-1',
    transition: null,
    userId: null,
    user: null,
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
  };

  const cfg: GitDevelopmentEventConfig = {
    type: 'git_development_event',
    event: 'pr_merged',
    provider: 'any',
    allow_backward: false,
    require_all_merged: true,
  };

  describe('schema', () => {
    it.each(GIT_DEVELOPMENT_EVENTS)('accepts event %s', (event) => {
      expect(
        handler.schema.safeParse({ type: 'git_development_event', event })
          .success,
      ).toBe(true);
    });

    it('has the 8 events', () => {
      expect(GIT_DEVELOPMENT_EVENTS).toHaveLength(8);
    });

    it('applies defaults', () => {
      expect(
        handler.schema.parse({
          type: 'git_development_event',
          event: 'pr_opened',
        }),
      ).toEqual({
        type: 'git_development_event',
        event: 'pr_opened',
        provider: 'any',
        allow_backward: false,
        require_all_merged: true,
      });
    });

    it('keeps explicit values', () => {
      expect(
        handler.schema.parse({
          type: 'git_development_event',
          event: 'build_failed',
          provider: 'gitlab',
          allow_backward: true,
          require_all_merged: false,
        }),
      ).toMatchObject({
        provider: 'gitlab',
        allow_backward: true,
        require_all_merged: false,
      });
    });

    it.each([
      [
        'unknown event',
        { type: 'git_development_event', event: 'pr_reviewed' },
      ],
      ['missing event', { type: 'git_development_event' }],
      [
        'unknown provider',
        {
          type: 'git_development_event',
          event: 'pr_opened',
          provider: 'bitbucket',
        },
      ],
      ['wrong type', { type: 'git_pr_merged', event: 'pr_opened' }],
    ])('rejects %s', (_label, input) => {
      expect(handler.schema.safeParse(input).success).toBe(false);
    });
  });

  it('subscribe() rejects', async () => {
    await expect(handler.subscribe(cfg, ctx)).rejects.toThrow(
      /driven by the git integration/,
    );
  });

  it('unsubscribe() rejects', async () => {
    await expect(handler.unsubscribe(cfg, ctx)).rejects.toThrow(
      /driven by the git integration/,
    );
  });

  it('findReferences returns []', () => {
    expect(handler.findReferences(cfg)).toEqual([]);
  });
});
