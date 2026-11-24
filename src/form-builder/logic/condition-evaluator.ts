/**
 * Conditional-logic evaluator for Form Builder fields. Given the saved-filter
 * rule-group model (reused as the condition shape) and the current answer map,
 * decides each field's `{visible, required}` state. Pure + deterministic so the
 * server and the client (`src/lib/form-builder/condition-evaluator.ts`) reach
 * byte-identical decisions — the server value is authoritative.
 *
 * Operator coercion is parity-critical: keep this table in lockstep with the frontend copy.
 */

export interface Rule {
  field: string;
  operator: string;
  value?: unknown;
}

export interface RuleGroup {
  combinator: 'and' | 'or';
  rules: (Rule | RuleGroup)[];
  not?: boolean;
}

export interface ConditionalLogic {
  action: 'show' | 'hide' | 'require' | 'skip_page';
  ruleGroup: RuleGroup;
}

export interface LogicField {
  field_key: string;
  field_type: string;
  required?: boolean | null;
  is_hidden?: boolean | null;
  read_only?: boolean | null;
  conditional_logic?: ConditionalLogic | null;
}

// One element nested inside a Layout field's `options.cells`. Mirrors ILayoutCell on the client.
export interface LayoutCellLogic {
  type?: string;
  fieldKey?: string;
  required?: boolean;
  conditionalLogic?: ConditionalLogic | null;
}

export interface FieldLogicState {
  visible: boolean;
  required: boolean;
}

// these types never carry a required answer
const NON_INPUT_TYPES = new Set([
  'heading',
  'paragraph',
  'divider',
  'page_break',
  'image',
  'calculated',
  'hidden',
]);

// file_upload/signature are now validated normally — this set is empty, kept as a
// forward-compatible hook for any future never-required input type
const DEFERRED_INPUT_TYPES = new Set<string>();

/** `undefined | null | '' | []` all count as empty. */
function isEmptyValue(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === '' ||
    (Array.isArray(v) && v.length === 0)
  );
}

function toStr(v: unknown): string {
  if (v === undefined || v === null) return '';

  return String(v as string | number | boolean);
}

/** Numeric coercion; empty/non-numeric -> NaN (so it fails numeric ops). */
function toNum(v: unknown): number {
  if (typeof v === 'number') return v;

  if (typeof v === 'boolean') return v ? 1 : 0;

  const s = toStr(v).trim();

  if (s === '') return NaN;

  return Number(s);
}

function numericPair(a: unknown, b: unknown): boolean {
  return Number.isFinite(toNum(a)) && Number.isFinite(toNum(b));
}

/**
 * Epoch-millis coercion for date/time/datetime ordinal compares. Parses ISO date
 * (`YYYY-MM-DD`) and datetime (`YYYY-MM-DDTHH:mm`) directly, and anchors a bare
 * `HH:mm(:ss)` time to a fixed day so times order correctly. NaN when unparseable —
 * only ISO shapes are ever fed here, so Node and browsers agree byte-for-byte.
 */
function toDateMs(v: unknown): number {
  const s = toStr(v).trim();

  if (s === '') return NaN;

  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return Date.parse(`1970-01-01T${s}`);

  return Date.parse(s);
}

function datePair(a: unknown, b: unknown): boolean {
  return Number.isFinite(toDateMs(a)) && Number.isFinite(toDateMs(b));
}

/**
 * Evaluate one operator against a field value + target. Unknown operators fail
 * closed (return false) so a malformed rule never silently reveals a field.
 */
function compare(value: unknown, operator: string, target: unknown): boolean {
  switch (operator) {
    case 'eq':
      if (numericPair(value, target)) return toNum(value) === toNum(target);

      return toStr(value) === toStr(target);
    case 'neq':
      return !compare(value, 'eq', target);
    case 'contains':
      if (Array.isArray(value)) return value.map(toStr).includes(toStr(target));

      return toStr(value).includes(toStr(target));
    case 'notContains':
      return !compare(value, 'contains', target);
    case 'beginsWith':
      return toStr(value).startsWith(toStr(target));
    case 'endsWith':
      return toStr(value).endsWith(toStr(target));
    case 'gt':
      if (numericPair(value, target)) return toNum(value) > toNum(target);
      if (datePair(value, target)) return toDateMs(value) > toDateMs(target);

      return false;
    case 'gte':
      if (numericPair(value, target)) return toNum(value) >= toNum(target);
      if (datePair(value, target)) return toDateMs(value) >= toDateMs(target);

      return false;
    case 'lt':
      if (numericPair(value, target)) return toNum(value) < toNum(target);
      if (datePair(value, target)) return toDateMs(value) < toDateMs(target);

      return false;
    case 'lte':
      if (numericPair(value, target)) return toNum(value) <= toNum(target);
      if (datePair(value, target)) return toDateMs(value) <= toDateMs(target);

      return false;
    case 'between':
    case 'notBetween': {
      const arr = Array.isArray(target) ? target : [];

      if (arr.length < 2) return false;

      let v = toNum(value);
      let lo = toNum(arr[0]);
      let hi = toNum(arr[1]);

      // fall back to date/time ordering when the operands aren't plain numbers
      if (![v, lo, hi].every(Number.isFinite)) {
        v = toDateMs(value);
        lo = toDateMs(arr[0]);
        hi = toDateMs(arr[1]);

        if (![v, lo, hi].every(Number.isFinite)) return false;
      }

      const inside = v >= lo && v <= hi;

      return operator === 'between' ? inside : !inside;
    }
    case 'in':
    case 'notIn': {
      const arr = Array.isArray(target) ? target : toStr(target).split(',');
      const hit = arr.map(toStr).includes(toStr(value));

      return operator === 'in' ? hit : !hit;
    }
    case 'null':
    case 'isEmpty':
      return isEmptyValue(value);
    case 'notNull':
    case 'isNotEmpty':
      return !isEmptyValue(value);
    default:
      // currentUser/relative and any unrecognised operator are unsupported here
      return false;
  }
}

function isRule(node: Rule | RuleGroup): node is Rule {
  return (node as RuleGroup).combinator === undefined;
}

function hasRules(group: RuleGroup | null | undefined): group is RuleGroup {
  return !!group && Array.isArray(group.rules) && group.rules.length > 0;
}

/**
 * Evaluate a rule group against the answer map. `and` -> every, `or` -> some,
 * `not` inverts. An empty group evaluates to `true` (neutral) — callers gate on
 * {@link hasRules} so an empty condition becomes a no-op, never a forced reveal.
 */
export function evaluateRuleGroup(
  group: RuleGroup | null | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!hasRules(group)) return true;

  const results = group.rules.map((node) =>
    isRule(node)
      ? compare(values[node.field], node.operator, node.value)
      : evaluateRuleGroup(node, values),
  );

  const combined =
    group.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);

  return group.not ? !combined : combined;
}

/**
 * True when a `page_break` field carries an active `skip_page` condition that is
 * currently met (so its page should be removed from the flow).
 */
export function isPageSkipped(
  field: LogicField,
  values: Record<string, unknown>,
): boolean {
  const logic = field.conditional_logic;

  if (!logic || logic.action !== 'skip_page' || !hasRules(logic.ruleGroup))
    return false;

  return evaluateRuleGroup(logic.ruleGroup, values);
}

/**
 * Compute `{visible, required}` for every field. Precedence:
 * - static `is_hidden`/`hidden`-type always win (conditional show/hide can't override them);
 * - conditional `show` (default-hidden) / `hide` (default-visible) apply only to otherwise-visible fields;
 * - `required` holds only for visible, editable input fields (never layout/deferred/read-only/hidden);
 * - `skip_page` is a page-level action, resolved by the paginator, not here.
 */
function computeOneFieldState(
  field: LogicField,
  values: Record<string, unknown>,
  applyLogic = true,
): FieldLogicState {
  const type = field.field_type;
  const staticHidden = field.is_hidden === true || type === 'hidden';

  let visible = !staticHidden;
  let required = field.required === true;

  const logic = field.conditional_logic;
  const active = !!logic && hasRules(logic.ruleGroup);

  if (applyLogic && active && logic && !staticHidden) {
    const met = evaluateRuleGroup(logic.ruleGroup, values);

    if (logic.action === 'show') visible = met;
    else if (logic.action === 'hide') visible = !met;
    else if (logic.action === 'require' && met) required = true;
  }

  if (
    NON_INPUT_TYPES.has(type) ||
    DEFERRED_INPUT_TYPES.has(type) ||
    field.read_only
  )
    required = false;

  if (!visible) required = false;

  return { visible, required };
}

function computeStatesOnce(
  fields: LogicField[],
  values: Record<string, unknown>,
  applyLogic = true,
): Record<string, FieldLogicState> {
  const states: Record<string, FieldLogicState> = {};

  for (const field of fields) {
    const state = computeOneFieldState(field, values, applyLogic);

    states[field.field_key] = state;

    if (field.field_type !== 'layout') continue;

    // Layout children are nested in the container's `options.cells`, not rows of their own, so a flat loop
    // would leave them stateless — which is why they used to inherit the container's visibility wholesale.
    // Mirrors the client (`src/lib/form-builder/condition-evaluator.ts`); keep the two in lockstep.
    //
    // A child is visible only if its container is. Parent wins: a container the user never saw must not
    // contribute an answer, and a hidden parent's required child would otherwise block submission forever.
    const cells =
      ((field as { options?: { cells?: unknown } }).options?.cells as
        | Array<Array<LayoutCellLogic>>
        | undefined) ?? [];

    cells.forEach((row, r) =>
      (row ?? []).forEach((cell, c) => {
        if (!cell?.type) return;

        const key = cell.fieldKey || `${field.field_key}__cell_r${r}_c${c}`;

        const own = computeOneFieldState(
          {
            field_key: key,
            field_type: cell.type,
            required: cell.required ?? false,
            is_hidden: false,
            read_only: false,
            conditional_logic: cell.conditionalLogic ?? null,
          } as LogicField,
          values,
          applyLogic,
        );

        const visible = state.visible && own.visible;

        states[key] = { visible, required: visible && own.required };
      }),
    );
  }

  return states;
}

const hiddenKeys = (states: Record<string, FieldLogicState>): string[] =>
  Object.keys(states).filter((k) => !states[k].visible);

/**
 * `{visible, required}` for every field, layout cells included. A conditionally hidden field keeps its answer
 * in memory but must not drive other rules with it, so evaluation repeats without those answers until it
 * settles. Statically hidden fields (`is_hidden` / `hidden` type) are data carriers and keep feeding rules.
 */
export function computeFieldStates(
  fields: LogicField[],
  values: Record<string, unknown>,
): Record<string, FieldLogicState> {
  const carriers = new Set(
    hiddenKeys(computeStatesOnce(fields, values, false)),
  );
  let states = computeStatesOnce(fields, values);
  let removed: string[] = [];

  // ponytail: pass cap stops cyclic rules oscillating; add a save-time cycle check if both sides must agree on them
  for (let pass = 0; pass <= Object.keys(states).length; pass++) {
    const hide = hiddenKeys(states).filter(
      (k) => !carriers.has(k) && k in values,
    );

    // `states` was computed without exactly these answers, so it is already self-consistent
    if (
      hide.length === removed.length &&
      hide.every((k) => removed.includes(k))
    )
      break;

    const effective = { ...values };

    for (const key of hide) delete effective[key];

    states = computeStatesOnce(fields, effective);
    removed = hide;
  }

  return states;
}
