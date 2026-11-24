/**
 * @fileoverview Trigger (stub): fires when a branch matching a glob pattern is
 * created in the configured repository. Runtime is not implemented in v1;
 * subscribe()/unsubscribe() throw immediately. Only schema and references
 * are exercised.
 * @module src/workflow-engine/handlers/triggers/git-branch-created.trigger
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
  type: z.literal('git_branch_created'),
  branch_pattern: z.string().min(1).max(200),
  repo_id: z.string().min(1).max(100),
});

export type GitBranchCreatedConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class GitBranchCreatedTrigger implements ITriggerHandler<GitBranchCreatedConfig> {
  readonly type = 'git_branch_created';
  readonly phase = 'trigger' as const;
  readonly schema = cfgSchema;

  subscribe(
    cfg: GitBranchCreatedConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('git_branch_created triggers not implemented in v1'),
    );
  }

  unsubscribe(
    cfg: GitBranchCreatedConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('git_branch_created triggers not implemented in v1'),
    );
  }

  findReferences(cfg: GitBranchCreatedConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
