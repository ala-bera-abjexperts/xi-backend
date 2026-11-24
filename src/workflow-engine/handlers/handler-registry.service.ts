/**
 * @fileoverview Registry that indexes all workflow rule handlers by phase + type
 * and exposes schema-validation, runtime evaluation lookup, and reference collection.
 * @module src/workflow-engine/handlers/handler-registry.service
 * @author Rajbha Manek
 */

import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  AnyHandler,
  IBaseHandler,
  IRuleReference,
  RulePhase,
  WORKFLOW_HANDLERS,
} from './handler.types';
import { normalizeRuleConfig } from './rule-config';

interface RuleIssue {
  phase: RulePhase;
  index: number;
  type?: string;
  path?: (string | number)[];
  message: string;
}

@Injectable()
export class HandlerRegistryService {
  private readonly byTypePhase = new Map<string, AnyHandler>();

  constructor(
    @Inject(WORKFLOW_HANDLERS) private readonly handlers: AnyHandler[],
  ) {
    for (const h of handlers) {
      const key = this.key(h.phase, h.type);

      if (this.byTypePhase.has(key)) {
        throw new Error(`Duplicate workflow handler registered: ${key}`);
      }
      this.byTypePhase.set(key, h);
      // Group-style handlers (e.g. the recursive condition group) need a
      // back-reference to the registry to dispatch into other handlers.
      // We inject it via setRegistry() to break the constructor cycle.
      const maybeSetRegistry = (
        h as unknown as {
          setRegistry?: (r: HandlerRegistryService) => void;
        }
      ).setRegistry;

      if (typeof maybeSetRegistry === 'function') {
        maybeSetRegistry.call(h, this);
      }
    }
  }

  private key(phase: RulePhase, type: string): string {
    return `${phase}:${type}`;
  }

  get<Cfg = unknown>(
    phase: RulePhase,
    type: string,
  ): (AnyHandler & IBaseHandler<Cfg>) | undefined {
    return this.byTypePhase.get(this.key(phase, type)) as
      | (AnyHandler & IBaseHandler<Cfg>)
      | undefined;
  }

  /**
   * Return every handler instance registered under the given phase. Used by
   * the engine to iterate handlers without separate lookups. Order is
   * stable across calls (matches DI provider order in the module).
   */
  getAll(phase: RulePhase): AnyHandler[] {
    const result: AnyHandler[] = [];

    for (const [key, handler] of this.byTypePhase.entries()) {
      if (key.startsWith(`${phase}:`)) result.push(handler);
    }

    return result;
  }

  /**
   * Validate one rule's config against its handler's Zod schema.
   * Returns a list of issues (empty if valid).
   */
  validateRule(phase: RulePhase, index: number, rule: unknown): RuleIssue[] {
    if (!rule || typeof rule !== 'object') {
      return [{ phase, index, message: 'Rule must be an object' }];
    }
    const normalized = normalizeRuleConfig(rule);
    const r = normalized as { type?: unknown };

    if (typeof r.type !== 'string') {
      return [
        { phase, index, message: 'Rule is missing a string `type` field' },
      ];
    }

    // Special case: in the 'condition' phase, a node may be a recursive group.
    // Group handler is registered as type='group' under the 'condition' phase.
    const handler = this.byTypePhase.get(this.key(phase, r.type));

    if (!handler) {
      return [
        {
          phase,
          index,
          type: r.type,
          message: `Unknown ${phase} type: ${r.type}`,
        },
      ];
    }

    const parsed = handler.schema.safeParse(normalized);

    if (parsed.success) return [];

    return parsed.error.issues.map(
      (iss) =>
        ({
          phase,
          index,
          type: r.type,
          path: iss.path as (string | number)[],
          message: iss.message,
        }) as RuleIssue,
    );
  }

  /**
   * Validate every rule in every phase. Throws 422 UnprocessableEntityException
   * with a structured payload listing all issues across all phases.
   */
  validatePayload(payload: {
    conditions: unknown[];
    validators: unknown[];
    post_functions: unknown[];
    triggers: unknown[];
  }): void {
    const issues: RuleIssue[] = [];

    payload.conditions.forEach((r, i) =>
      issues.push(...this.validateRule('condition', i, r)),
    );
    payload.validators.forEach((r, i) =>
      issues.push(...this.validateRule('validator', i, r)),
    );
    payload.post_functions.forEach((r, i) =>
      issues.push(...this.validateRule('post_function', i, r)),
    );
    payload.triggers.forEach((r, i) =>
      issues.push(...this.validateRule('trigger', i, r)),
    );

    if (issues.length === 0) return;

    throw new UnprocessableEntityException({
      message: 'Rule validation failed',
      data: { issues },
    });
  }

  /**
   * Collect every external reference (field, user, group, role, status,
   * resolution) across all rules in a payload. Used by the rules-save
   * endpoint to batch-check that referenced IDs belong to the same org.
   */
  collectReferences(payload: {
    conditions: unknown[];
    validators: unknown[];
    post_functions: unknown[];
    triggers: unknown[];
  }): IRuleReference[] {
    const refs: IRuleReference[] = [];

    const walk = (phase: RulePhase, rules: unknown[]) => {
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const normalized = normalizeRuleConfig(rule);
        const r = normalized as { type?: string };

        if (!r.type) continue;
        const handler = this.byTypePhase.get(this.key(phase, r.type));

        if (!handler) continue;
        try {
          refs.push(...handler.findReferences(normalized as never));
        } catch {
          // ignore; references are best-effort
        }
      }
    };

    walk('condition', payload.conditions);
    walk('validator', payload.validators);
    walk('post_function', payload.post_functions);
    walk('trigger', payload.triggers);

    // Dedupe
    const seen = new Set<string>();
    const out: IRuleReference[] = [];

    for (const ref of refs) {
      if (typeof ref.id !== 'string' || ref.id.length === 0) continue;
      const k = `${ref.kind}:${ref.id}`;

      if (!seen.has(k)) {
        seen.add(k);
        out.push(ref);
      }
    }

    return out;
  }

  /**
   * Helpful for the rules-save endpoint to list available types per phase.
   */
  listTypes(phase: RulePhase): string[] {
    const prefix = `${phase}:`;
    const out: string[] = [];

    for (const k of this.byTypePhase.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }

    return out;
  }
}
