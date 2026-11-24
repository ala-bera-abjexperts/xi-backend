import { matchesRelativeValue } from '../../common/utils/relative-date.util';

export interface IFilterRuleGroup {
  id?: string;
  combinator: 'and' | 'or';
  rules: (IFilterRule | IFilterRuleGroup)[];
  not?: boolean;
}

export interface IFilterRule {
  id?: string;
  field: string;
  operator: string;
  value: unknown;
  valueSource?: string;
}

/**
 * Field alias maps: filter engine field names → actual payload field names per entity type.
 * e.g., filter uses 'title' but task payload has 'summary'.
 */
const FIELD_ALIAS_MAP: Record<string, Record<string, string>> = {
  task: { title: 'summary' },
  process: { title: 'name' },
  asset: {},
  asset_object: {
    schemaId: 'schema_id',
    newObjectTypeId: 'new_object_type_id',
    oldObjectTypeId: 'old_object_type_id',
    newTypeId: 'new_type_id',
    oldTypeId: 'old_type_id',
  },
};

/** True when `field` is used by any rule in `group`, at any nesting depth. */
export function hasRuleForField(
  group: IFilterRuleGroup,
  field: string,
): boolean {
  // Stored queries are untrusted JSON: skip null / non-object entries rather than
  // throw (withLinkedTasks runs outside the evaluator's try/catch).
  if (!Array.isArray(group.rules)) return false;
  return group.rules.some((rule) => {
    if (rule === null || typeof rule !== 'object') return false;
    return 'combinator' in rule
      ? hasRuleForField(rule, field)
      : rule.field === field;
  });
}

/**
 * Keys named by a "Linked to" rule value: a comma string, an array, or the
 * Parent-style `{ keys }` object (`recursive` is ignored). Lowercased.
 */
function linkedToValues(value: unknown): string[] {
  const raw =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as { keys?: unknown }).keys
      : value;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  return list
    .map((v) =>
      String(v ?? '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

/**
 * Evaluates a react-querybuilder IFilterRuleGroup against an in-memory data object.
 * Used by the automation tick service to match trigger payloads against stored filter rules.
 * This does NOT query the database — purely in-memory evaluation.
 */
export class FilterEvaluator {
  private readonly aliasMap: Record<string, string>;

  constructor(entityType: string = '') {
    this.aliasMap = FIELD_ALIAS_MAP[entityType] ?? {};
  }

  /**
   * Evaluate a rule group against the given data object.
   * Returns true if the data matches the rules (or if rules is empty — match all).
   * Never throws — returns true on any error (fail-open to avoid blocking valid events).
   * @param contextUserId - The user who triggered the event (actor). Used by the 'currentUser' operator.
   */
  evaluate(
    group: IFilterRuleGroup,
    data: Record<string, unknown>,
    contextUserId?: string,
  ): boolean {
    try {
      return this.evaluateGroup(group, data, contextUserId);
    } catch {
      // Fail-open: log at call site
      return true;
    }
  }

  private evaluateGroup(
    group: IFilterRuleGroup,
    data: Record<string, unknown>,
    contextUserId?: string,
  ): boolean {
    if (!group.rules || group.rules.length === 0) {
      return true;
    }

    const results = group.rules.map((rule) => {
      if ('combinator' in rule) {
        return this.evaluateGroup(rule, data, contextUserId);
      }
      return this.evaluateRule(rule, data, contextUserId);
    });

    const combined =
      group.combinator === 'and'
        ? results.every((r) => r)
        : results.some((r) => r);

    return group.not ? !combined : combined;
  }

  private evaluateRule(
    rule: IFilterRule,
    data: Record<string, unknown>,
    contextUserId?: string,
  ): boolean {
    const { operator, value } = rule;
    // Apply field alias mapping (e.g., filter 'title' → payload 'summary' for tasks)
    const fieldName = this.aliasMap[rule.field] ?? rule.field;
    const actual = this.lookupField(data, fieldName);

    // "Linked to" (XE-T532): `linked_to` is an array of linked task ids + keys added
    // by the tick service. Any intersection counts; neq/notIn negate (mirrors Parent).
    // Missing data yields in → false / notIn → true, exactly as for any other field.
    if (
      rule.field === 'linked_to' &&
      operator !== 'null' &&
      operator !== 'notNull' &&
      operator !== 'isEmpty' &&
      operator !== 'isNotEmpty'
    ) {
      const linked = Array.isArray(actual)
        ? actual.map((v) => String(v).toLowerCase())
        : [];
      const hit = linkedToValues(value).some((v) => linked.includes(v));
      return operator === 'neq' || operator === 'notIn' ? !hit : hit;
    }

    switch (operator) {
      case 'eq':
        if (Array.isArray(value)) return value.includes(actual);
        // Handle comma-separated multi-select values stored by FilterQueryBuilder
        if (typeof value === 'string' && value.includes(',')) {
          return this.parseMultiValue(value).includes(actual);
        }
        return actual === value;

      case 'neq':
        if (Array.isArray(value)) return !value.includes(actual);
        // Handle comma-separated multi-select values stored by FilterQueryBuilder
        if (typeof value === 'string' && value.includes(',')) {
          return !this.parseMultiValue(value).includes(actual);
        }
        return actual !== value;

      case 'contains':
        return (
          typeof actual === 'string' &&
          actual.toLowerCase().includes(String(value).toLowerCase())
        );

      case 'notContains':
        if (typeof actual !== 'string') return true;
        return !actual.toLowerCase().includes(String(value).toLowerCase());

      case 'beginsWith':
        return (
          typeof actual === 'string' &&
          actual.toLowerCase().startsWith(String(value).toLowerCase())
        );

      case 'endsWith':
        return (
          typeof actual === 'string' &&
          actual.toLowerCase().endsWith(String(value).toLowerCase())
        );

      case 'gt': {
        const n = this.toComparable(actual),
          v = this.toComparable(value);
        if (n === null || v === null) return false;
        return n > v;
      }

      case 'gte': {
        const n = this.toComparable(actual),
          v = this.toComparable(value);
        if (n === null || v === null) return false;
        return n >= v;
      }

      case 'lt': {
        const n = this.toComparable(actual),
          v = this.toComparable(value);
        if (n === null || v === null) return false;
        return n < v;
      }

      case 'lte': {
        const n = this.toComparable(actual),
          v = this.toComparable(value);
        if (n === null || v === null) return false;
        return n <= v;
      }

      case 'between': {
        const arr = Array.isArray(value) ? (value as unknown[]) : [null, null];
        const [min, max] = arr;
        if (min === null || max === null) return false;
        const num = this.toComparable(actual);
        const lo = this.toComparable(min);
        const hi = this.toComparable(max);
        if (num === null || lo === null || hi === null) return false;
        return num >= lo && num <= hi;
      }

      case 'notBetween': {
        const arr = Array.isArray(value) ? (value as unknown[]) : [null, null];
        const [min, max] = arr;
        if (min === null || max === null) return false;
        const num = this.toComparable(actual);
        const lo = this.toComparable(min);
        const hi = this.toComparable(max);
        if (num === null || lo === null || hi === null) return false;
        return num < lo || num > hi;
      }

      case 'in':
        return this.parseMultiValue(value).includes(actual);

      case 'notIn':
        return !this.parseMultiValue(value).includes(actual);

      case 'null':
        return actual === null || actual === undefined;

      case 'notNull':
        return actual !== null && actual !== undefined;

      case 'isEmpty':
        return actual === null || actual === undefined || actual === '';

      case 'isNotEmpty':
        return actual !== null && actual !== undefined && actual !== '';

      case 'currentUser':
        // In automation tick context there is no active session; contextUserId is the
        // user who triggered the event (created_by / updated_by from the outbox payload).
        // Fail-open when no actor is available so non-task events are not accidentally blocked.
        return contextUserId != null ? actual === contextUserId : true;

      case 'relative': {
        // Previously MISSING here entirely, so a relative-date trigger filter fell through the
        // fail-open default and matched EVERY event. Recognised windows/cutoffs now evaluate via
        // the shared resolver; values it does not recognise keep this evaluator's fail-open
        // philosophy (bad config must not silently freeze automations).
        const t = this.toComparable(actual);

        if (t === null) return false;

        return matchesRelativeValue(t, value) ?? true;
      }

      default:
        // Unknown operator — safe default: do not block
        return true;
    }
  }

  /**
   * Convert a value to a number for ordered comparisons.
   * Tries numeric coercion first; falls back to Date.getTime() for ISO strings.
   * Returns null when neither conversion succeeds.
   */
  private toComparable(v: unknown): number | null {
    const n = Number(v);

    if (!isNaN(n)) return n;

    if (typeof v === 'string') {
      const d = new Date(v).getTime();

      if (!isNaN(d)) return d;
    }

    return null;
  }

  /**
   * Normalize a rule value to an array.
   * The frontend multiselect stores comma-separated strings ("uuid1,uuid2" or "in_progress,open").
   * Array values pass through unchanged; null/undefined → [].
   * Used by 'in'/'notIn' — these operators always come from the multiselect so CSV splitting is safe.
   */
  private parseMultiValue(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;

    if (typeof value === 'string' && value !== '') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return value != null ? [value] : [];
  }

  /**
   * Look up a field in data using dot notation.
   * 'task.status' → data['task']['status']
   * 'status' → data['status']
   */
  private lookupField(data: Record<string, unknown>, field: string): unknown {
    const parts = field.split('.');
    let current: unknown = data;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
