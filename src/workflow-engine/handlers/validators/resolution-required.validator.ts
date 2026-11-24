/**
 * @fileoverview Validator: requires the task to have a resolution set.
 * If `resolution_id` is supplied, the task's resolution must match exactly;
 * otherwise any non-null resolution is accepted.
 * @module src/workflow-engine/handlers/validators/resolution-required.validator
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IValidatorHandler,
  IEvaluationContext,
  IValidatorResult,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('resolution_required'),
  resolution_id: z.string().uuid().optional(),
  message: z.string().max(200).optional(),
});

export type ResolutionRequiredConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class ResolutionRequiredValidator implements IValidatorHandler<ResolutionRequiredConfig> {
  readonly type = 'resolution_required';
  readonly phase = 'validator' as const;
  readonly schema = cfgSchema;

  validate(
    cfg: ResolutionRequiredConfig,
    ctx: IEvaluationContext,
  ): Promise<IValidatorResult> {
    if (!ctx.task) {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? 'A resolution is required',
        fieldPath: 'resolution_id',
      });
    }

    const taskResolutionId = (ctx.task as { resolution_id?: string | null })
      .resolution_id;

    if (cfg.resolution_id) {
      if (taskResolutionId !== cfg.resolution_id) {
        return Promise.resolve({
          ok: false,
          message: cfg.message ?? 'A specific resolution is required',
          fieldPath: 'resolution_id',
        });
      }

      return Promise.resolve({ ok: true });
    }

    if (taskResolutionId == null) {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? 'A resolution is required',
        fieldPath: 'resolution_id',
      });
    }

    return Promise.resolve({ ok: true });
  }

  findReferences(cfg: ResolutionRequiredConfig): IRuleReference[] {
    if (!cfg.resolution_id) return [];

    return [{ kind: 'resolution', id: cfg.resolution_id }];
  }
}
