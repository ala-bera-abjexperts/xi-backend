import { writeWorkflowTask } from '../write-task';
/**
 * @fileoverview Post-function: sets a single custom-field value on the task.
 * Fetches the current `tasks.custom_field_values` JSONB, merges the new key,
 * and writes it back. The org/task scoping uses `ctx.txn` so the update
 * participates in the engine's relaxed-atomicity transition.
 * @module src/workflow-engine/handlers/post-functions/set-field-value.post
 * @author Rajbha Manek
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import type { FieldOption } from '../../../custom-fields/models/custom-field.model';
import { issueGroupValueError } from '../../../custom-fields/utils/issue-group.util';

import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('set_field_value'),
  field_id: z.string().uuid(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
  ]),
});

export type SetFieldValueConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class SetFieldValuePostFunction implements IPostFunctionHandler<SetFieldValueConfig> {
  readonly type = 'set_field_value';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  private readonly logger = new Logger(SetFieldValuePostFunction.name);

  async run(cfg: SetFieldValueConfig, ctx: IEvaluationContext): Promise<void> {
    if (!ctx.txn) {
      throw new BadRequestException('set_field_value requires ctx.txn');
    }
    if (!ctx.taskId) {
      throw new BadRequestException('set_field_value requires ctx.taskId');
    }
    // Defensive: schema enforces uuid, but a runtime empty/whitespace string
    // sneaks past the union when the rule config is hand-edited. Skip the
    // write rather than corrupt the JSONB blob with a "" key.
    if (!cfg.field_id || !cfg.field_id.trim()) {
      this.logger.warn(
        `set_field_value skipped on task ${ctx.taskId}: empty field_id`,
      );

      return;
    }

    // The rule config stores the custom field's UUID (field_id), but the rest
    // of the app keys tasks.custom_field_values by the field's slug (field_key)
    // — the task's own field editor reads/writes custom_field_values[field_key].
    // Resolve the key here so a workflow-set value lands where the task can read
    // it; keying by the UUID silently orphans the value.
    const fieldRes = await ctx.txn
      .from('custom_fields')
      .select('field_key, field_type, name, options, validation_rules')
      .eq('id', cfg.field_id)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();

    if (fieldRes.error) {
      throw new BadRequestException(
        `set_field_value field lookup failed: ${fieldRes.error.message}`,
      );
    }

    const field = fieldRes.data as {
      field_key?: string;
      field_type?: string;
      name?: string;
      options?: FieldOption[] | null;
      validation_rules?: Record<string, unknown> | null;
    } | null;
    const fieldKey = field?.field_key;

    if (!fieldKey) {
      this.logger.warn(
        `set_field_value skipped on task ${ctx.taskId}: field ${cfg.field_id} not found`,
      );

      return;
    }

    const fetchRes = await ctx.txn
      .from('tasks')
      .select('custom_field_values')
      .eq('id', ctx.taskId)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();

    if (fetchRes.error) {
      throw new BadRequestException(
        `set_field_value lookup failed: ${fetchRes.error.message}`,
      );
    }
    if (!fetchRes.data) {
      throw new BadRequestException(
        `set_field_value: task ${ctx.taskId} not found in org ${ctx.organizationId}`,
      );
    }

    const current =
      (
        fetchRes.data as {
          custom_field_values?: Record<string, unknown> | null;
        }
      ).custom_field_values ?? {};

    // Issue groups get the same rules as the task write path (TasksService.assertIssueGroupValues):
    // an id array, single mode honoured, known options, no archived option the task did not hold.
    if (field?.field_type === 'issue_group') {
      const held = new Set(
        Array.isArray(current[fieldKey]) ? (current[fieldKey] as string[]) : [],
      );
      const archived = new Set(
        (field.options ?? [])
          .filter((o) => o.status === 'archived')
          .map((o) => o.value),
      );
      const error =
        issueGroupValueError(
          { name: field.name ?? fieldKey, ...field },
          cfg.value,
        ) ??
        ((cfg.value as string[]).some((v) => archived.has(v) && !held.has(v))
          ? `${field.name} option is archived`
          : null);

      if (error) {
        this.logger.warn(
          `set_field_value skipped on task ${ctx.taskId}: ${error}`,
        );

        return;
      }
    }

    const merged: Record<string, unknown> = {
      ...current,
      [fieldKey]: cfg.value,
    };

    await writeWorkflowTask(ctx, { custom_field_values: merged });
  }

  findReferences(cfg: SetFieldValueConfig): IRuleReference[] {
    return [{ kind: 'field', id: cfg.field_id }];
  }
}
