/**
 * @fileoverview Trigger: fires when a pull request is merged into the configured
 * target branch in the configured repository. This handler owns the config
 * SCHEMA + reference collection only; the runtime is delivered by the git webhook
 * (POST /api/v1/git-triggers/pr-merged → GitTriggersService.handlePrMerged),
 * matched by `repo_id` (required) + optional `target_branch`, with the task
 * resolved from the PR's source branch name — mirroring git_branch_created.
 * subscribe()/unsubscribe() are unused for git triggers and remain stubs.
 * @module src/workflow-engine/handlers/triggers/git-pr-merged.trigger
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IEvaluationContext,
  IRuleReference,
  ITriggerHandler,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('git_pr_merged'),
  target_branch: z.string().min(1).max(200).optional(),
  // repo_id is REQUIRED (matches the frontend GitPrMergedTrigger schema): a
  // PR-merged trigger only fires for an explicitly-scoped repository.
  repo_id: z.string().min(1).max(100),
});

export type GitPrMergedConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class GitPrMergedTrigger implements ITriggerHandler<GitPrMergedConfig> {
  readonly type = 'git_pr_merged';
  readonly phase = 'trigger' as const;
  readonly schema = cfgSchema;

  subscribe(cfg: GitPrMergedConfig, ctx: IEvaluationContext): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('git_pr_merged triggers not implemented in v1'),
    );
  }

  unsubscribe(cfg: GitPrMergedConfig, ctx: IEvaluationContext): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('git_pr_merged triggers not implemented in v1'),
    );
  }

  findReferences(cfg: GitPrMergedConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
