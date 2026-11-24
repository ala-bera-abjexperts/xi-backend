/**
 * @fileoverview Unit tests for GitPrMergedTrigger (stub).
 * @module src/workflow-engine/handlers/triggers/git-pr-merged.trigger.spec
 * @author Rajbha Manek
 */

import { GitPrMergedTrigger } from './git-pr-merged.trigger';
import type { IEvaluationContext } from '../handler.types';

describe('GitPrMergedTrigger', () => {
  const handler = new GitPrMergedTrigger();

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
    it('rejects an empty config (repo_id is required)', () => {
      const r = handler.schema.safeParse({
        type: 'git_pr_merged',
      });

      expect(r.success).toBe(false);
    });

    it('rejects a config with target_branch only (repo_id is required)', () => {
      const r = handler.schema.safeParse({
        type: 'git_pr_merged',
        target_branch: 'main',
      });

      expect(r.success).toBe(false);
    });

    it('accepts a config with repo_id only', () => {
      const r = handler.schema.safeParse({
        type: 'git_pr_merged',
        repo_id: 'org/repo',
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with both fields', () => {
      const r = handler.schema.safeParse({
        type: 'git_pr_merged',
        target_branch: 'main',
        repo_id: 'org/repo',
      });

      expect(r.success).toBe(true);
    });

    it('rejects empty target_branch when provided', () => {
      const r = handler.schema.safeParse({
        type: 'git_pr_merged',
        target_branch: '',
      });

      expect(r.success).toBe(false);
    });

    it('rejects target_branch longer than 200 chars', () => {
      const r = handler.schema.safeParse({
        type: 'git_pr_merged',
        target_branch: 'x'.repeat(201),
      });

      expect(r.success).toBe(false);
    });

    it('rejects empty repo_id when provided', () => {
      const r = handler.schema.safeParse({
        type: 'git_pr_merged',
        repo_id: '',
      });

      expect(r.success).toBe(false);
    });

    it('rejects repo_id longer than 100 chars', () => {
      const r = handler.schema.safeParse({
        type: 'git_pr_merged',
        repo_id: 'x'.repeat(101),
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        target_branch: 'main',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns an empty array', () => {
      const refs = handler.findReferences({
        type: 'git_pr_merged',
        target_branch: 'main',
        repo_id: 'org/repo',
      });

      expect(refs).toEqual([]);
    });
  });

  describe('subscribe (stub)', () => {
    it('subscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.subscribe(
          { type: 'git_pr_merged', target_branch: 'main', repo_id: 'org/repo' },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });

    it('unsubscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.unsubscribe(
          { type: 'git_pr_merged', target_branch: 'main', repo_id: 'org/repo' },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });
  });
});
