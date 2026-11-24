import { SlaFieldMetadata, SlaRule, SlaRuleGroup } from './sla.types';

const TASK_FIELDS = new Set([
  'id',
  'title',
  'summary',
  'description',
  'status',
  'status_id',
  'priority',
  'priority_id',
  'assigned_to',
  'created_by',
  'request_id',
  'assignee_id',
  'assignee_ids',
  'reporter_id',
  'task_type_id',
  'parent_task_id',
  'labels',
  'label_ids',
  'created_at',
  'due_date',
  'start_date',
  'completed_at',
  'is_completed',
  'support_request_id',
]);
const OPERATORS = ['=', '!=', 'in', 'notIn', 'null', 'notNull'];
const FORBIDDEN_VALUE =
  /^(?:current_user|currentUser|\{\{.*\}\}|today|tomorrow|yesterday|now)$/i;

function metadata(fields: SlaFieldMetadata[], id: string): SlaFieldMetadata {
  const field = fields.find((candidate) => candidate.id === id);
  if (
    !field ||
    field.sla ||
    (!TASK_FIELDS.has(id) && !/^cf_[a-zA-Z0-9_-]+$/.test(id)) ||
    !['string', 'number', 'boolean', 'date', 'string[]'].includes(field.type)
  )
    throw new Error(`Unsupported SLA condition field: ${id}`);
  return field;
}

function scalar(value: unknown, type: SlaFieldMetadata['type']): boolean {
  if (type === 'number')
    return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (
    typeof value !== 'string' ||
    value.length > 10000 ||
    FORBIDDEN_VALUE.test(value)
  )
    return false;
  if (type !== 'date') return true;
  return (
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value.slice(0, 10)).toISOString().slice(0, 10) ===
      value.slice(0, 10)
  );
}

function validateLeaf(
  input: Record<string, unknown>,
  fields: SlaFieldMetadata[],
): SlaRule {
  if (typeof input.field !== 'string' || typeof input.operator !== 'string')
    throw new Error('Invalid SLA condition');
  const field = metadata(fields, input.field);
  const allowed = [
    ...OPERATORS,
    ...(['number', 'date'].includes(field.type) ? ['<', '<=', '>', '>='] : []),
    ...(['string', 'string[]'].includes(field.type)
      ? ['contains', 'doesNotContain']
      : []),
    ...(field.type === 'string' ? ['beginsWith', 'endsWith'] : []),
  ];
  if (!allowed.includes(input.operator))
    throw new Error(`Unsupported SLA condition operator: ${input.operator}`);
  if (!['null', 'notNull'].includes(input.operator)) {
    const value = input.value;
    const list =
      ['in', 'notIn'].includes(input.operator) ||
      (field.type === 'string[]' && ['=', '!='].includes(input.operator));
    if (
      list
        ? !Array.isArray(value) ||
          !value.length ||
          value.length > 1000 ||
          value.some((v) => !scalar(v, field.type))
        : !scalar(value, field.type)
    )
      throw new Error(`Invalid SLA condition value for ${input.field}`);
  }
  if (input.valueSource !== undefined && input.valueSource !== 'value')
    throw new Error('SLA conditions require literal values');
  return {
    field: input.field,
    operator: input.operator,
    ...(input.value === undefined
      ? {}
      : { value: structuredClone(input.value) }),
  };
}

export function validateRules(
  input: unknown,
  fields: SlaFieldMetadata[],
): SlaRuleGroup {
  let count = 0;
  function group(value: unknown, depth: number): SlaRuleGroup {
    if (
      ++count > 500 ||
      depth > 12 ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      throw new Error('Invalid or oversized SLA conditions');
    const candidate = value as Record<string, unknown>;
    if (
      !['and', 'or'].includes(candidate.combinator as string) ||
      !Array.isArray(candidate.rules) ||
      candidate.rules.length > 100 ||
      (candidate.not !== undefined && typeof candidate.not !== 'boolean')
    )
      throw new Error('Invalid SLA condition group');
    return {
      combinator: candidate.combinator as 'and' | 'or',
      ...(candidate.not === undefined ? {} : { not: candidate.not }),
      rules: (candidate.rules as unknown[]).map((child) => {
        if (!child || typeof child !== 'object' || Array.isArray(child))
          throw new Error('Invalid SLA condition');
        if ('rules' in child) return group(child, depth + 1);
        if (++count > 500) throw new Error('Too many SLA conditions');
        return validateLeaf(child as Record<string, unknown>, fields);
      }),
    };
  }
  return group(input, 0);
}

function evaluateLeaf(
  rule: SlaRule,
  values: Record<string, unknown>,
  fields: SlaFieldMetadata[],
): boolean {
  const actual = Object.hasOwn(values, rule.field)
    ? values[rule.field]
    : undefined;
  if (rule.operator === 'null') return actual === null || actual === undefined;
  if (rule.operator === 'notNull')
    return actual !== null && actual !== undefined;
  const field = metadata(fields, rule.field);
  if (
    field.type === 'string[]'
      ? !Array.isArray(actual) || actual.some((v) => typeof v !== 'string')
      : !scalar(actual, field.type)
  )
    return false;
  const expected = rule.value;
  const left = field.type === 'date' ? Date.parse(actual as string) : actual;
  const right =
    field.type === 'date' && typeof expected === 'string'
      ? Date.parse(expected)
      : expected;
  const equals =
    Array.isArray(left) && Array.isArray(right)
      ? JSON.stringify([...(left as string[])].sort()) ===
        JSON.stringify([...(right as string[])].sort())
      : left === right;
  switch (rule.operator) {
    case '=':
      return equals;
    case '!=':
      return !equals;
    case '<':
      return (left as number) < (right as number);
    case '<=':
      return (left as number) <= (right as number);
    case '>':
      return (left as number) > (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case 'in':
      return (expected as unknown[]).some((value) =>
        Array.isArray(actual)
          ? actual.includes(value)
          : field.type === 'date'
            ? Date.parse(value as string) === left
            : value === actual,
      );
    case 'notIn':
      return !(expected as unknown[]).some((value) =>
        Array.isArray(actual)
          ? actual.includes(value)
          : field.type === 'date'
            ? Date.parse(value as string) === left
            : value === actual,
      );
    case 'contains':
      return (actual as string & string[]).includes(expected as string);
    case 'doesNotContain':
      return !(actual as string & string[]).includes(expected as string);
    case 'beginsWith':
      return (actual as string).startsWith(expected as string);
    case 'endsWith':
      return (actual as string).endsWith(expected as string);
    default:
      throw new Error('Unsupported SLA condition');
  }
}

export function evaluateRules(
  input: unknown,
  values: Record<string, unknown>,
  fields: SlaFieldMetadata[],
): boolean {
  const validated = validateRules(input, fields);
  function evaluate(group: SlaRuleGroup): boolean {
    const results = group.rules.map((rule) =>
      'rules' in rule ? evaluate(rule) : evaluateLeaf(rule, values, fields),
    );
    const matches =
      group.combinator === 'and'
        ? results.every(Boolean)
        : results.some(Boolean);
    return group.not ? !matches : matches;
  }
  return evaluate(validated);
}
