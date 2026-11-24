/**
 * @fileoverview Trigger: fires on a cron expression in the given timezone.
 * Runtime delivery is owned centrally by {@link WorkflowCronService} (an
 * in-process @Cron dispatcher that scans due cron transitions every minute),
 * mirroring how the trigger registry owns `parent_transitioned`. This handler
 * therefore keeps its subscribe()/unsubscribe() stubs — no per-trigger
 * event-listener bookkeeping is needed here; only its schema and references
 * are exercised at edit time.
 * @module src/workflow-engine/handlers/triggers/cron.trigger
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
  type: z.literal('cron'),
  expression: z.string().min(5).max(100),
  timezone: z.string().min(1).max(80).default('UTC'),
});

export type CronConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class CronTrigger implements ITriggerHandler<CronConfig> {
  readonly type = 'cron';
  readonly phase = 'trigger' as const;
  readonly schema = cfgSchema;

  subscribe(cfg: CronConfig, ctx: IEvaluationContext): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(new Error('cron triggers not implemented in v1'));
  }

  unsubscribe(cfg: CronConfig, ctx: IEvaluationContext): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(new Error('cron triggers not implemented in v1'));
  }

  findReferences(cfg: CronConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
