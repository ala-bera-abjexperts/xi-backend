/**
 * @fileoverview Unit tests for GitBranchCreatedTrigger (stub).
 * @module src/workflow-engine/handlers/triggers/git-branch-created.trigger.spec
 * @author Rajbha Manek
 */

import { GitBranchCreatedTrigger } from './git-branch-created.trigger';
import type { IEvaluationContext } from '../handler.types';

describe('GitBranchCreatedTrigger', () => {
  const handler = new GitBranchCreatedTrigger();

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
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
    ...overrides,
  });

  describe('schema', () => {
    it('rejects a config without repo_id (repo_id is required)', () => {
      const r = handler.schema.safeParse({
        type: 'git_branch_created',
        branch_pattern: 'feature/*',
      });

      expect(r.success).toBe(false);
    });

    it('accepts a config with repo_id', () => {
      const r = handler.schema.safeParse({
        type: 'git_branch_created',
        branch_pattern: 'release/*',
        repo_id: 'org/repo',
      });

      expect(r.success).toBe(true);
    });

    it('rejects empty branch_pattern', () => {
      const r = handler.schema.safeParse({
        type: 'git_branch_created',
        branch_pattern: '',
      });

      expect(r.success).toBe(false);
    });

    it('rejects branch_pattern longer than 200 chars', () => {
      const r = handler.schema.safeParse({
        type: 'git_branch_created',
        branch_pattern: 'x'.repeat(201),
      });

      expect(r.success).toBe(false);
    });

    it('rejects empty repo_id when provided', () => {
      const r = handler.schema.safeParse({
        type: 'git_branch_created',
        branch_pattern: 'feature/*',
        repo_id: '',
      });

      expect(r.success).toBe(false);
    });

    it('rejects repo_id longer than 100 chars', () => {
      const r = handler.schema.safeParse({
        type: 'git_branch_created',
        branch_pattern: 'feature/*',
        repo_id: 'x'.repeat(101),
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        branch_pattern: 'feature/*',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns an empty array', () => {
      const refs = handler.findReferences({
        type: 'git_branch_created',
        branch_pattern: 'feature/*',
        repo_id: 'org/repo',
      });

      expect(refs).toEqual([]);
    });
  });

  describe('subscribe (stub)', () => {
    it('subscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.subscribe(
          {
            type: 'git_branch_created',
            branch_pattern: 'feature/*',
            repo_id: 'org/repo',
          },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });

    it('unsubscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.unsubscribe(
          {
            type: 'git_branch_created',
            branch_pattern: 'feature/*',
            repo_id: 'org/repo',
          },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });
  });
});
