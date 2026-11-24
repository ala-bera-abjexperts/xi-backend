/**
 * @fileoverview Helpers for accepting both persisted workflow-rule shapes.
 * @module src/workflow-engine/handlers/rule-config
 * @author Rajbha Manek
 */

type RuleRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RuleRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The React editor stores rules as `{ id, type, config }` to preserve stable
 * UI card ids. Backend handlers consume flat configs (`{ type, field_id }`).
 * Normalize at every backend boundary so validation, linting, triggers, and
 * runtime execution all understand both shapes.
 */
export function normalizeRuleConfig(rule: unknown): unknown {
  if (!isRecord(rule)) return rule;

  if (rule.kind === 'group') {
    return {
      type: 'group',
      op: rule.op,
      children: Array.isArray(rule.children)
        ? rule.children.map(normalizeRuleConfig)
        : rule.children,
    };
  }

  if (typeof rule.type !== 'string') return rule;
  if (!isRecord(rule.config)) return rule;

  const normalized: RuleRecord = {
    ...rule.config,
    type: typeof rule.config.type === 'string' ? rule.config.type : rule.type,
  };

  if (
    'failure_mode' in rule &&
    !('failure_mode' in normalized) &&
    typeof rule.failure_mode === 'string'
  ) {
    normalized.failure_mode = rule.failure_mode;
  }

  return normalized;
}
