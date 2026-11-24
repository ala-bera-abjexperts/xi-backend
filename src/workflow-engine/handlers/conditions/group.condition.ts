/**
 * @fileoverview Condition: a recursive ANY/ALL group of child conditions.
 * Each child is itself a condition (including a nested group). Depth is capped at 5.
 *
 * Wiring note: GroupCondition needs to dispatch back into the registry to
 * evaluate each child by type. Directly injecting HandlerRegistryService into
 * the constructor would create a circular DI dependency (the registry depends
 * on all handlers, including this one). To break the cycle, the registry
 * detects GroupCondition during its own construction and calls setRegistry().
 *
 * @module src/workflow-engine/handlers/conditions/group.condition
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IConditionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';
import { normalizeRuleConfig } from '../rule-config';

const MAX_GROUP_DEPTH = 5;
const MAX_CHILDREN = 50;

/**
 * Minimal surface of HandlerRegistryService that GroupCondition needs at runtime.
 * Defined as a structural type to avoid a hard import that would re-introduce
 * the circular dependency at module-resolution time.
 */
export interface IGroupChildRegistry {
  get(
    phase: 'condition',
    type: string,
  ):
    | {
        readonly phase: string;
        evaluate?: (cfg: unknown, ctx: IEvaluationContext) => Promise<boolean>;
        findReferences: (cfg: unknown) => IRuleReference[];
      }
    | undefined;
}

interface RawChild {
  type?: unknown;
  op?: unknown;
  children?: unknown;
}

function nestedGroupDepth(node: unknown, current: number): number {
  if (current > MAX_GROUP_DEPTH) return current;
  const normalized = normalizeRuleConfig(node);

  if (!normalized || typeof normalized !== 'object') return current;
  const r = normalized as RawChild;

  if (r.type !== 'group' || !Array.isArray(r.children)) return current;
  let deepest = current;

  for (const child of r.children) {
    const normalizedChild = normalizeRuleConfig(child);

    if (
      !normalizedChild ||
      typeof normalizedChild !== 'object' ||
      (normalizedChild as RawChild).type !== 'group'
    ) {
      continue;
    }

    const d = nestedGroupDepth(child, current + 1);

    if (d > deepest) deepest = d;
  }

  return deepest;
}

const groupSchemaBase = z.object({
  type: z.literal('group'),
  op: z.enum(['all', 'any']),
  children: z.array(z.unknown()).max(MAX_CHILDREN),
});

const groupSchema = groupSchemaBase.refine(
  (v) => nestedGroupDepth(v, 1) <= MAX_GROUP_DEPTH,
  { message: `Group depth exceeds maximum of ${MAX_GROUP_DEPTH}` },
);

export type GroupConfig = z.infer<typeof groupSchemaBase>;

@Injectable()
export class GroupCondition implements IConditionHandler<GroupConfig> {
  readonly type = 'group';
  readonly phase = 'condition' as const;
  readonly schema = groupSchema;

  private registry: IGroupChildRegistry | null = null;

  /**
   * Called by HandlerRegistryService during its own construction. After this
   * runs, evaluate()/findReferences() can dispatch into the registry.
   */
  setRegistry(registry: IGroupChildRegistry): void {
    this.registry = registry;
  }

  async evaluate(cfg: GroupConfig, ctx: IEvaluationContext): Promise<boolean> {
    if (cfg.children.length === 0) {
      return cfg.op === 'all';
    }

    for (const child of cfg.children) {
      const result = await this.evaluateChild(child, ctx);

      // Short-circuit
      if (cfg.op === 'all' && !result) return false;
      if (cfg.op === 'any' && result) return true;
    }

    // No short-circuit hit — for 'all' every child was true; for 'any' all were false.
    return cfg.op === 'all';
  }

  private async evaluateChild(
    child: unknown,
    ctx: IEvaluationContext,
  ): Promise<boolean> {
    if (this.registry === null) return false;
    const normalized = normalizeRuleConfig(child);

    if (!normalized || typeof normalized !== 'object') return false;
    const r = normalized as { type?: string };

    if (typeof r.type !== 'string') return false;
    const handler = this.registry.get('condition', r.type);

    if (!handler || handler.phase !== 'condition') return false;
    if (typeof handler.evaluate !== 'function') return false;

    return handler.evaluate(normalized, ctx);
  }

  findReferences(cfg: GroupConfig): IRuleReference[] {
    if (this.registry === null) return [];
    const refs: IRuleReference[] = [];

    for (const child of cfg.children) {
      const normalized = normalizeRuleConfig(child);

      if (!normalized || typeof normalized !== 'object') continue;
      const r = normalized as { type?: string };

      if (typeof r.type !== 'string') continue;
      const handler = this.registry.get('condition', r.type);

      if (!handler) continue;
      try {
        refs.push(...handler.findReferences(normalized));
      } catch {
        // best-effort
      }
    }

    return refs;
  }
}
