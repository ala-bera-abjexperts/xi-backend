/**
 * @fileoverview Trigger: fires the transition when a development event (GitHub / GitLab, through the
 * organization's Git integration) happens for the task: a branch is created, a pull request is opened,
 * marked ready, merged or closed, the build fails or passes, or a "Fixes <key>" commit reaches the default
 * branch. This handler owns the config SCHEMA only; the runtime is GitStatusAutomationService, driven by
 * the git-integrations webhooks. subscribe()/unsubscribe() are unused, as for the legacy git triggers.
 * @module src/workflow-engine/handlers/triggers/git-development-event.trigger
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IEvaluationContext,
  IRuleReference,
  ITriggerHandler,
} from '../handler.types';

export const GIT_DEVELOPMENT_EVENTS = [
  'branch_created',
  'pr_opened',
  'pr_ready_for_review',
  'pr_merged',
  'pr_closed',
  'build_failed',
  'build_passed',
  'commit_closes',
] as const;

export type GitDevelopmentEvent = (typeof GIT_DEVELOPMENT_EVENTS)[number];

const cfgSchema = z.object({
  type: z.literal('git_development_event'),
  event: z.enum(GIT_DEVELOPMENT_EVENTS),
  provider: z.enum(['any', 'github', 'gitlab', 'azure_devops']).default('any'),
  // Off: never moves a task to an earlier status category (a new pull request never reopens a Done task).
  allow_backward: z.boolean().default(false),
  // pr_merged only: wait until every linked pull request that is still open is merged.
  require_all_merged: z.boolean().default(true),
});

export type GitDevelopmentEventConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class GitDevelopmentEventTrigger implements ITriggerHandler<GitDevelopmentEventConfig> {
  readonly type = 'git_development_event';
  readonly phase = 'trigger' as const;
  readonly schema = cfgSchema;

  subscribe(
    cfg: GitDevelopmentEventConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('git_development_event is driven by the git integration'),
    );
  }

  unsubscribe(
    cfg: GitDevelopmentEventConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('git_development_event is driven by the git integration'),
    );
  }

  findReferences(cfg: GitDevelopmentEventConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
