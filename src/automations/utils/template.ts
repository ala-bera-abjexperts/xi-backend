// Requires: npm install jexl @types/jexl
import jexl from 'jexl';

// Side-effect import: registers the answersTable/answersJson/answersText transforms on the shared
// jexl singleton. Must be imported wherever an expression is evaluated.
import './submission-answers';

import type { EvalContext } from './expression';

/**
 * True when a substituted string still carries a {{ … }} placeholder.
 *
 * substitute() leaves the placeholder text in place when an expression resolves to null — that is
 * fine for a message body, but a field that feeds an external API needs to notice, because the API
 * then rejects the literal "{{ trigger.task.due_date }}" with an error that says nothing about
 * which field was empty.
 */
export function hasUnresolvedPlaceholder(value: string): boolean {
  // A complete `{{ … }}` that substitute() could not resolve — the original case.
  const unresolved = /\{\{\s*[^}]+?\s*\}\}/.test(value);

  // A DANGLING `{{` counts too. Someone half-types a variable and saves; because that is not a
  // complete placeholder it satisfied none of the guards calling this, so it sailed through every
  // check and reached Postgres verbatim — `assignedTo: "{{"` is
  // `invalid input syntax for type uuid: "{{"`. A value that really resolved carries no braces at
  // all, so any `{{` still present means the field was never filled in.
  const dangling = value.includes('{{');

  return unresolved || dangling;
}

/**
 * Matches a `{{ … .task.id }}` placeholder, capturing the path up to `.task` so the same rewrite
 * works for a trigger (`trigger.task.id`) and for a previous step's output
 * (`nodes['x'].output.task.id`).
 */
const TASK_ID_PLACEHOLDER = /\{\{\s*([\w[\]'".]*?task)\.id\s*\}\}/g;

/**
 * Rewrites a task **id** placeholder into a human-readable task reference — key first, then summary.
 *
 * Why this exists: a UUID means nothing to the person reading a Teams/Slack message, and the variable
 * picker used to offer `task.id` as the only identifier, so message templates were written around it.
 * Rather than silently editing the automations people already saved, the id is expanded *at send
 * time* for the handful of fields a human actually reads.
 *
 * **Only ever apply this to human-facing text.** A webhook body, an `entityId`, or any field an API
 * parses needs the real UUID — expanding it there would corrupt the request. The caller decides, via
 * the field allow-list in `automation-worker.service.ts`.
 *
 * `{{ trigger.task.id }}` → `{{ trigger.task.key }} — {{ trigger.task.summary }}`
 *
 * Substitution then runs as normal, so an absent key or summary degrades exactly the way every other
 * placeholder does.
 */
export function expandTaskIdToReadable(template: string): string {
  return template.replace(
    TASK_ID_PLACEHOLDER,
    (_m, path: string) => `{{ ${path}.key }} — {{ ${path}.summary }}`,
  );
}

function stringifyValue(value: object): string {
  const json = JSON.stringify(value, null, 2);

  // JSON.stringify returns undefined for a lone function/symbol; nothing sensible to print.
  return typeof json === 'string' ? json : '';
}

/**
 * Renders one resolved object as text. Returning undefined falls back to JSON.
 *
 * Lets the caller decide how a specific object should read — the automation worker uses it so
 * `{{ trigger.submission.data }}` honours the Answer format chosen on the Form submitted trigger,
 * while every other object keeps the JSON default.
 */
export type ObjectFormatter = (value: object) => string | undefined;

/** Renders any resolved value as text before the defaults run. Returning undefined keeps the default. */
export type ValueFormatter = (value: unknown) => string | undefined;

/**
 * Substitutes {{ field.path }} placeholders in template strings with runtime values.
 * Unknown paths resolve to the original placeholder rather than throwing.
 */
export function substitute(
  template: string,
  ctx: EvalContext,
  formatObject?: ObjectFormatter,
  formatValue?: ValueFormatter,
  emptyMarker?: string,
): string {
  const evalFn = jexl.evalSync.bind(jexl) as (e: string, c: unknown) => unknown;
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
    try {
      const value: unknown = evalFn(expr.trim(), ctx);

      // `emptyMarker` is opt-in, and only the fields a person reads pass it: in a Slack message or a
      // task summary the raw "{{ … }}" is meaningless to the reader, while everywhere else the
      // leftover placeholder is what tells the action the value is missing (see the note below).
      if (value == null || typeof value === 'symbol')
        return emptyMarker ?? _match;

      const custom = formatValue?.(value);
      if (custom !== undefined) return custom;

      // An object used to fall through to the literal placeholder, which meant a token like
      // `{{ trigger.submission.data }}` posted the raw text "{{ trigger.submission.data }}" into
      // Slack/Teams. JSON is at least usable, and it repairs automations already saved that way.
      // null/undefined deliberately still degrade to the placeholder — see the note above, an
      // empty required value has to stay visible to whatever consumes it.
      if (typeof value === 'object') {
        const formatted = formatObject?.(value);

        return formatted === undefined ? stringifyValue(value) : formatted;
      }

      return String(value as string | number | boolean | bigint);
    } catch {
      return emptyMarker ?? _match;
    }
  });
}

/** Resolved values of every {{ … }} placeholder in a template, evaluated the same way substitute() does. */
export function collectPlaceholderValues(
  template: string,
  ctx: EvalContext,
): unknown[] {
  const evalFn = jexl.evalSync.bind(jexl) as (e: string, c: unknown) => unknown;
  const values: unknown[] = [];

  for (const [, expr] of template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    try {
      const value: unknown = evalFn(expr.trim(), ctx);

      if (value != null && typeof value !== 'symbol') values.push(value);
    } catch {
      // Unresolvable expressions stay as placeholders in substitute(); nothing to collect.
    }
  }

  return values;
}
