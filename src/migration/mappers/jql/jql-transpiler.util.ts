/**
 * @fileoverview JQL AST → react-querybuilder RuleGroup, in TWO dialects.
 *
 * XISUITE has two engines that consume RuleGroups and they genuinely disagree (verified line by
 * line, see the dialect table in the migration plan):
 *
 *  - `board` — the frontend Kanban evaluator (`KanbanBoard.tsx`). Compares `status`/`priority` by
 *    KEY, custom fields by raw `custom_field_values` bag key, wants camelCase relative tokens
 *    (`last7Days`), and fails CLOSED on `reporter`/`created_by` (not joined into board tasks).
 *  - `filters` — the backend saved-filters engine (`filter-query-engine.ts`). Compares by
 *    `status_id`/`priority_id` UUID, wants `cf_`-prefixed custom fields, snake_case relative
 *    tokens (`last_7_days`), and supports `reporter`.
 *
 * Migration stores the `board` output (that is what swimlanes/quick filters evaluate against); the
 * `filters` output exists so a translated query can be EXECUTED server-side via
 * `POST /filters/execute` and diffed against Jira's own search for the same JQL — the semantic
 * proof that the translation means the same thing.
 *
 * ALL-OR-NOTHING (user-confirmed policy): a query translates completely or not at all. Dropping one
 * AND-conjunct widens the filter — more cards match than the customer asked for — which is a silent
 * correctness lie. The only permitted reductions are provably membership-neutral: the `ORDER BY`
 * tail, and a `project` clause that is tautological inside a single-project space.
 *
 * VALUES ARE ALWAYS JSON ARRAYS for multi-value rules, never CSV strings: the board evaluator's
 * `toCmpArr` does NOT split commas (a CSV value silently matches nothing there), while both engines
 * handle real arrays.
 *
 * @module src/migration/mappers/jql/jql-transpiler.util
 */

import {
  parseJql,
  type JqlClause,
  type JqlField,
  type JqlNode,
  type JqlValue,
} from './jql-parser.util';
import type {
  RelativeAnchor,
  RelativeCutoff,
} from '../../../common/utils/relative-date.util';

// ─── Output shapes ───────────────────────────────────────────────────────────

export interface RuleJson {
  field: string;
  operator: string;
  value: unknown;
}

export interface RuleGroupJson {
  combinator: 'and' | 'or';
  rules: (RuleJson | RuleGroupJson)[];
  not?: boolean;
}

export type EmitOutcome =
  | { ok: true; query: RuleGroupJson }
  | { ok: false; reason: string };

export interface TranspileOutput {
  board: EmitOutcome;
  filters: EmitOutcome;
  /** Membership-neutral drops (ORDER BY, tautological project clause) — for the description. */
  stripped: string[];
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface ResolvedLookup {
  key: string;
  id: string;
  /** Priorities only: urgency rank, 0 = Highest (smaller = MORE urgent). Live-verified. */
  rank?: number;
  /**
   * The migrated display name. Statuses carry it because `status WAS X` matches against
   * `task_history.old_value`/`new_value`, which store status DISPLAY names (see history.stage).
   */
  name?: string;
}

export interface CustomFieldLookup {
  fieldKey: string;
  fieldType: string;
  /**
   * Option label (lowercased) → stored option value (the Jira option id — see
   * custom-field-value.mapper: task bags store IDS, and the engines look options up by that id).
   * Present only for option-bearing types; loaded from `custom_fields.options` by boards.stage.
   */
  options?: Map<string, string>;
}

export interface TranspileContext {
  /** The migrated project's key (e.g. "KAN") — for the tautological `project =` strip. */
  projectKey: string;
  projectName?: string;
  /** lc(name) AND lc(key) → {key, id}. */
  statuses: Map<string, ResolvedLookup>;
  priorities: Map<string, ResolvedLookup>;
  /** lc(name) → target task_type id. */
  issueTypes: Map<string, string>;
  /** lc(username | display name | email) → user uuid; null marks an AMBIGUOUS name. */
  users: Map<string, string | null>;
  /** lc(name) AND numeric cf id → {fieldKey, fieldType}. */
  customFields: Map<string, CustomFieldLookup>;
}

type Dialect = 'board' | 'filters';

/** The stored artifact. Only affects the reduce-to-match-all edge (see emitters). */
export type BoardArtifact = 'swimlane' | 'quickfilter';

// ─── Dialect vocabularies ────────────────────────────────────────────────────

/**
 * JQL date anchors → the shared cutoff-anchor vocabulary (`relative-date.util.ts`), used by every
 * evaluator. A JQL relative comparison is an INSTANT comparison (`updated >= -1d` is
 * `updated_at >= now − 1 day`), so cutoffs are the exact translation for every comparison
 * operator, on every date column — including `due`, whose future values the old preset windows
 * wrongly excluded, and for every duration (`-1d`, `-4h`, `"-1w 2d"`), not just the two that
 * happened to have preset tokens.
 */
const ANCHOR_FUNCTIONS: Record<string, string> = {
  now: 'now',
  startofday: 'start_of_day',
  endofday: 'end_of_day',
  startofweek: 'start_of_week',
  endofweek: 'end_of_week',
  startofmonth: 'start_of_month',
  endofmonth: 'end_of_month',
  startofyear: 'start_of_year',
  endofyear: 'end_of_year',
};

/** One JQL duration atom: `-7d`, `4h`, `+2w`, `30m`. */
const DURATION_ATOM_RE = /^([+-]?)(\d+)([dwhm])$/i;

const DURATION_UNIT_MINUTES: Record<string, number> = {
  m: 1,
  h: 60,
  d: 1440,
  w: 10_080,
};

/**
 * Parse a JQL duration expression to signed minutes. Accepts a single unquoted atom (`-7d`) or a
 * quoted multi-atom string (`"-1h 30m"`, where JQL applies the leading sign to every atom).
 * Returns null when any atom fails to parse.
 */
function durationMinutes(text: string): number | null {
  const atoms = text.trim().split(/\s+/);

  if (atoms.length === 0) return null;

  let total = 0;
  let leadingSign = 1;

  for (let i = 0; i < atoms.length; i++) {
    const m = DURATION_ATOM_RE.exec(atoms[i]);

    if (!m) return null;

    const sign =
      m[1] === '-' ? -1 : m[1] === '+' ? 1 : i === 0 ? 1 : leadingSign;

    if (i === 0) leadingSign = sign;

    total += sign * Number(m[2]) * DURATION_UNIT_MINUTES[m[3].toLowerCase()];
  }

  return total;
}

/**
 * JQL range operators → the cutoff's folded op. `=`/`!=` are deliberately absent: a relative
 * comparison is an instant, and equality-to-an-instant is not a filter anyone writes (day-granular
 * equality is an ABSOLUTE-date concept, handled separately).
 */
const CUTOFF_OPS: Record<string, RelativeCutoff['op'] | undefined> = {
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

/** JQL date-ish field names → the shared task column. */
const DATE_FIELDS: Record<string, string> = {
  created: 'created_at',
  createddate: 'created_at',
  updated: 'updated_at',
  updateddate: 'updated_at',
  due: 'due_date',
  duedate: 'due_date',
};

const ABSOLUTE_DATE_RE =
  /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

// ─── Internal failure signal ────────────────────────────────────────────────

class Untranslatable extends Error {}

function refuse(reason: string): never {
  throw new Untranslatable(reason);
}

// ─── Value helpers ──────────────────────────────────────────────────────────

function textOf(value: JqlValue, what: string): string {
  if (value.kind !== 'text') {
    refuse(`${what}: the function ${value.name}() has no equivalent here`);
  }

  return value.text;
}

function lc(s: string): string {
  return s.trim().toLowerCase();
}

// ─── The emitter ─────────────────────────────────────────────────────────────

class Emitter {
  constructor(
    private readonly ctx: TranspileContext,
    private readonly dialect: Dialect,
    private readonly stripped: string[],
  ) {}

  emit(node: JqlNode, topLevelAnd: boolean): RuleGroupJson | RuleJson | null {
    if (node.kind === 'group') {
      const isAndChain = node.op === 'and' && !node.not && topLevelAnd;
      const rules: (RuleJson | RuleGroupJson)[] = [];

      for (const child of node.children) {
        const emitted = this.emit(child, isAndChain);

        if (emitted !== null) rules.push(emitted);
      }

      // Every child was a membership-neutral strip: the group reduces away entirely.
      if (rules.length === 0) return null;

      return {
        combinator: node.op,
        rules,
        ...(node.not ? { not: true } : {}),
      };
    }

    return this.emitClause(node, topLevelAnd);
  }

  private emitClause(
    clause: JqlClause,
    topLevelAnd: boolean,
  ): RuleJson | RuleGroupJson | null {
    if (clause.kind === 'history') {
      refuse(
        `"${clause.raw}": issue history (WAS/CHANGED) has no XISUITE equivalent`,
      );
    }

    if (clause.kind === 'was') {
      return this.emitWas(clause);
    }

    const concept = this.resolveField(clause.field);

    switch (concept.kind) {
      case 'project':
        return this.emitProject(clause, topLevelAnd);
      case 'lookup':
        return this.emitLookup(clause, concept.which);
      case 'user':
        return this.emitUser(clause, concept.field);
      case 'labels':
        return this.emitLabels(clause);
      case 'summary':
        return this.emitSummary(clause);
      case 'date':
        return this.emitDate(clause, concept.column);
      case 'custom':
        return this.emitCustomField(clause, concept.lookup);
    }
  }

  // ── Field dispatch ──

  private resolveField(
    field: JqlField,
  ):
    | { kind: 'project' }
    | { kind: 'lookup'; which: 'status' | 'priority' | 'issuetype' }
    | { kind: 'user'; field: 'assignee' | 'reporter' }
    | { kind: 'labels' }
    | { kind: 'summary' }
    | { kind: 'date'; column: string }
    | { kind: 'custom'; lookup: CustomFieldLookup } {
    // cf[NNNNN] — always a custom field.
    if (field.cfId) {
      const hit = this.ctx.customFields.get(field.cfId);

      if (!hit) {
        refuse(`cf[${field.cfId}] was not migrated as a custom field`);
      }

      return { kind: 'custom', lookup: hit };
    }

    // Quoted names refer to custom fields first ("Compliance Category"), then fall through to the
    // system vocabulary ("Status" is still the status field in JQL).
    if (field.quoted) {
      const hit = this.ctx.customFields.get(lc(field.name));

      if (hit) return { kind: 'custom', lookup: hit };
    }

    const name = lc(field.name);

    switch (name) {
      case 'project':
        return { kind: 'project' };
      case 'status':
        return { kind: 'lookup', which: 'status' };
      case 'priority':
        return { kind: 'lookup', which: 'priority' };
      case 'issuetype':
      case 'type':
        return { kind: 'lookup', which: 'issuetype' };
      case 'assignee':
        return { kind: 'user', field: 'assignee' };
      case 'reporter':
        return { kind: 'user', field: 'reporter' };
      case 'labels':
      case 'label':
        return { kind: 'labels' };
      case 'summary':
        return { kind: 'summary' };
    }

    if (DATE_FIELDS[name]) return { kind: 'date', column: DATE_FIELDS[name] };

    // Named refusals for fields the client's own data WILL contain. Each has a concrete XISUITE
    // story, and the generic "no equivalent" line would misreport it in the audit trail.
    if (name === 'description') {
      refuse(
        'description is not queryable: neither the board evaluator nor the filters engine exposes it',
      );
    }

    if (name === 'resolution') {
      refuse(
        'resolutions migrate onto tasks, but neither query engine exposes a resolution field',
      );
    }

    if (name === 'sprint') {
      refuse(
        'sprints migrate, but neither query engine exposes a sprint field',
      );
    }

    if (name === 'key' || name === 'issuekey') {
      refuse(
        'task keys are re-issued by XISUITE; a filter on Jira keys would reference keys that no longer exist',
      );
    }

    const cf = this.ctx.customFields.get(name);

    if (cf) return { kind: 'custom', lookup: cf };

    refuse(`the field "${field.name}" has no XISUITE equivalent`);
  }

  // ── project: the one clause that may STRIP ──

  private emitProject(clause: JqlClause, topLevelAnd: boolean): null {
    const matchesUs = (raw: string): boolean => {
      const v = lc(raw);

      return (
        v === lc(this.ctx.projectKey) ||
        (!!this.ctx.projectName && v === lc(this.ctx.projectName))
      );
    };

    // Anywhere but a top-level AND chain, dropping a clause changes membership (inside OR a
    // tautology makes the whole group always-true, and a contradiction erases the branch).
    // Real board filters put `project = X AND ...` at the top, so this covers the actual data;
    // anything cleverer falls back rather than guessing.
    if (!topLevelAnd) {
      refuse(
        'a project clause outside the top-level AND cannot be safely reduced',
      );
    }

    if (clause.kind === 'cmp' && clause.op === '=') {
      if (matchesUs(textOf(clause.value, 'project'))) {
        this.stripped.push(
          `project = ${this.ctx.projectKey} (tautological inside the migrated space)`,
        );

        return null;
      }

      refuse(
        'the query is scoped to a DIFFERENT project than the migrated one',
      );
    }

    if (clause.kind === 'list' && !clause.negated) {
      // Tasks in this space ARE project <key>; a list containing us is a tautology here, one
      // without us is a contradiction (would match nothing in this space).
      const texts = clause.values.map((v) => textOf(v, 'project'));

      if (texts.some(matchesUs)) {
        this.stripped.push(
          `project in (...) (contains ${this.ctx.projectKey}; tautological inside the migrated space)`,
        );

        return null;
      }

      refuse('the query is scoped to DIFFERENT projects than the migrated one');
    }

    refuse('only "project =" and "project in" can be reduced safely');
  }

  // ── status / priority / issuetype ──

  private emitLookup(
    clause: JqlClause,
    which: 'status' | 'priority' | 'issuetype',
  ): RuleJson {
    const fieldName =
      which === 'issuetype'
        ? 'task_type_id'
        : this.dialect === 'board'
          ? which
          : `${which}_id`;

    const resolve = (raw: string): string => {
      if (which === 'issuetype') {
        const id = this.ctx.issueTypes.get(lc(raw));

        if (!id) refuse(`the issue type "${raw}" was not migrated`);

        return id;
      }

      const map = which === 'status' ? this.ctx.statuses : this.ctx.priorities;
      const hit = map.get(lc(raw));

      if (!hit) refuse(`the ${which} "${raw}" was not migrated`);

      // Board compares keys; the filters engine compares id columns.
      return this.dialect === 'board' ? hit.key : hit.id;
    };

    if (clause.kind === 'is') {
      return {
        field: fieldName,
        operator: clause.negated ? 'notNull' : 'null',
        value: null,
      };
    }

    if (clause.kind === 'list') {
      return {
        field: fieldName,
        operator: clause.negated ? 'notIn' : 'in',
        value: clause.values.map((v) => resolve(textOf(v, which))),
      };
    }

    // History clauses are refused before dispatch; the guard narrows the union for tsc AND makes a
    // future dispatch bug loud instead of silently mis-typed.
    if (clause.kind !== 'cmp') refuse('unsupported clause shape here');

    if (clause.op === '=' || clause.op === '!=') {
      return {
        field: fieldName,
        operator: clause.op === '=' ? 'eq' : 'neq',
        value: resolve(textOf(clause.value, which)),
      };
    }

    // Ordered comparisons — PRIORITY ONLY, and an EXACT translation, not an approximation: the
    // domain is finite, so `priority > High` IS `priority in (everything more urgent)`. JQL
    // "greater" means MORE urgent, and rank is smaller-is-more-urgent (0 = Highest,
    // live-verified), so the comparison INVERTS: JQL `>` selects rank `<`. JQL itself forbids
    // ordering on status/type, so those fall through to the refusal below.
    if (
      which === 'priority' &&
      (clause.op === '>' ||
        clause.op === '>=' ||
        clause.op === '<' ||
        clause.op === '<=')
    ) {
      const raw = textOf(clause.value, which);
      const operand = this.ctx.priorities.get(lc(raw));

      if (!operand || operand.rank === undefined) {
        refuse(`the priority "${raw}" has no migrated rank to compare against`);
      }

      const pivot = operand.rank;
      // The name AND key aliases point at the same entry objects — dedupe by key.
      const byKey = new Map<string, ResolvedLookup>();

      for (const entry of this.ctx.priorities.values()) {
        if (entry.rank !== undefined) byKey.set(entry.key, entry);
      }

      const qualifying = [...byKey.values()]
        .filter((entry) => {
          const r = entry.rank!;

          if (clause.op === '>') return r < pivot;
          if (clause.op === '>=') return r <= pivot;
          if (clause.op === '<') return r > pivot;

          return r >= pivot;
        })
        .sort((a, b) => a.rank! - b.rank!);

      if (qualifying.length === 0) {
        refuse(`"priority ${clause.op} ${raw}" matches no migrated priority`);
      }

      return {
        field: fieldName,
        operator: 'in',
        value: qualifying.map((entry) =>
          this.dialect === 'board' ? entry.key : entry.id,
        ),
      };
    }

    refuse(`"${clause.op}" is not translatable for ${which}`);
  }

  // ── status WAS (history) ──

  /**
   * `status WAS X` / `WAS NOT X` / `WAS IN (…)` → a `was`/`wasNot` rule evaluated against
   * `task_history` status DISPLAY names (the only field whose history the migration records — see
   * history.stage). Dialect-independent: both engines resolve the same history, so board and filters
   * emit the identical rule. Only status is queryable, and a temporal predicate (`… BEFORE now()`)
   * has no equivalent — both refuse by name rather than approximate.
   */
  private emitWas(clause: Extract<JqlClause, { kind: 'was' }>): RuleJson {
    // Board only. The stored/rendered artifact is the board dialect, whose evaluator reads each
    // task's loaded status_history. The filters (saved-filters) engine has no status-history query
    // surface — evaluating `was` there needs a request-scoped task_history prefetch threaded through
    // its whole rule pipeline, which its own UI never authors and which would silently mis-count if
    // that threading were ever incomplete. Refusing that dialect beats risking a silent lie; the
    // board translation (below) is what the swimlane/quick filter actually runs.
    if (this.dialect === 'filters') {
      refuse(
        'the filters engine has no status-history surface to evaluate WAS against',
      );
    }

    if (lc(clause.field.name) !== 'status') {
      refuse(
        `WAS is only translatable for status; no history is queryable for "${clause.field.name}"`,
      );
    }

    if (clause.predicate) {
      refuse(
        `"status WAS … ${clause.predicate}": time-qualified history has no XISUITE equivalent`,
      );
    }

    const resolve = (raw: string): string => {
      const hit = this.ctx.statuses.get(lc(raw));

      if (!hit) refuse(`the status "${raw}" was not migrated`);
      if (!hit.name) {
        refuse(
          `the status "${raw}" has no migrated name to match history against`,
        );
      }

      return hit.name;
    };

    const values = clause.values.map((v) => resolve(textOf(v, 'status')));

    return {
      field: 'status',
      operator: clause.negated ? 'wasNot' : 'was',
      value: values.length === 1 ? values[0] : values,
    };
  }

  // ── assignee / reporter ──

  private emitUser(
    clause: JqlClause,
    which: 'assignee' | 'reporter',
  ): RuleJson | RuleGroupJson {
    // The board evaluator now joins `reporter` (and `created_by`) into its task rows and reads them
    // in getTaskFieldValue, so reporter clauses evaluate correctly in BOTH dialects. (Previously the
    // board dropped reporter to null and any reporter rule silently matched nothing, so this
    // dialect refused it — that limitation is gone.)
    const fieldName = which === 'assignee' ? 'assigned_to' : 'reporter';

    const resolve = (raw: string): string => {
      const hit = this.ctx.users.get(lc(raw));

      if (hit === undefined) refuse(`the user "${raw}" was not migrated`);
      if (hit === null)
        refuse(`the user name "${raw}" is ambiguous across migrated users`);

      return hit;
    };

    // membersOf() is evaluated LIVE by Jira — membership changes are picked up at query time. A
    // migrated filter can only freeze today's member list, which silently diverges the first time
    // the group changes. Refusal over approximation (user-confirmed policy).
    const userValue = (v: JqlValue): string => {
      if (v.kind === 'func' && v.name === 'membersof') {
        refuse(
          "membersOf() is evaluated live in Jira; a migrated filter would freeze today's membership",
        );
      }

      return textOf(v, which);
    };

    if (clause.kind === 'is') {
      return {
        field: fieldName,
        operator: clause.negated ? 'notNull' : 'null',
        value: null,
      };
    }

    if (clause.kind === 'list') {
      return {
        field: fieldName,
        operator: clause.negated ? 'notIn' : 'in',
        value: clause.values.map((v) => resolve(userValue(v))),
      };
    }

    // History clauses are refused before dispatch; the guard narrows the union for tsc AND makes a
    // future dispatch bug loud instead of silently mis-typed.
    if (clause.kind !== 'cmp') refuse('unsupported clause shape here');

    // currentUser() — an OPERATOR in both dialects, not a value.
    if (clause.value.kind === 'func' && clause.value.name === 'currentuser') {
      const rule: RuleJson = {
        field: fieldName,
        operator: 'currentUser',
        value: null,
      };

      if (clause.op === '=') return rule;

      // `!= currentUser()`: neither engine has a negated-currentUser operator, but both honor
      // `not` at group level — wrap.
      if (clause.op === '!=') {
        return { combinator: 'and', rules: [rule], not: true };
      }

      refuse(`"${clause.op}" is not translatable with currentUser()`);
    }

    if (clause.op === '=' || clause.op === '!=') {
      return {
        field: fieldName,
        operator: clause.op === '=' ? 'eq' : 'neq',
        value: resolve(userValue(clause.value)),
      };
    }

    refuse(`"${clause.op}" is not translatable for ${which}`);
  }

  // ── labels ──

  private emitLabels(clause: JqlClause): RuleJson {
    // `labels` is a jsonb ARRAY on the task. Both engines now evaluate it as a set: the board
    // evaluator compares array-vs-array, and the filters engine compiles containment predicates
    // (`labels.cs.["x"]`) via applyJsonbArrayRule / jsonbArrayFragment — replacing the old scalar
    // dispatch that raised "invalid input syntax for type json" and silently matched nothing.
    // Emission is therefore identical in both dialects.
    if (clause.kind === 'is') {
      return {
        field: 'labels',
        operator: clause.negated ? 'isNotEmpty' : 'isEmpty',
        value: null,
      };
    }

    if (clause.kind === 'list') {
      return {
        field: 'labels',
        operator: clause.negated ? 'notIn' : 'in',
        value: clause.values.map((v) => textOf(v, 'labels')),
      };
    }

    // History clauses are refused before dispatch; the guard narrows the union for tsc AND makes a
    // future dispatch bug loud instead of silently mis-typed.
    if (clause.kind !== 'cmp') refuse('unsupported clause shape here');

    // JQL `labels = x` means "x is one of the labels" — the board evaluator's array-vs-array
    // `in` has exactly that some-of semantics.
    if (clause.op === '=' || clause.op === '!=') {
      return {
        field: 'labels',
        operator: clause.op === '=' ? 'in' : 'notIn',
        value: [textOf(clause.value, 'labels')],
      };
    }

    refuse(`"${clause.op}" is not translatable for labels`);
  }

  // ── summary ──

  private emitSummary(clause: JqlClause): RuleJson {
    if (clause.kind === 'cmp' && (clause.op === '~' || clause.op === '!~')) {
      // Documented approximation: JQL `~` is a Lucene term match, ours is a case-insensitive
      // substring. The closest available semantics; recorded in the filter description.
      return {
        field: 'title',
        operator: clause.op === '~' ? 'contains' : 'notContains',
        value: textOf(clause.value, 'summary'),
      };
    }

    refuse('only "~" and "!~" are translatable for summary');
  }

  // ── dates ──

  private emitDate(
    clause: JqlClause,
    column: string,
  ): RuleJson | RuleGroupJson {
    if (clause.kind === 'is') {
      return {
        field: column,
        operator: clause.negated ? 'notNull' : 'null',
        value: null,
      };
    }

    if (clause.kind !== 'cmp') {
      refuse(`IN lists are not translatable for ${column}`);
    }

    // Relative forms: `>= -7d`, `< startOfWeek()`, `<= startOfMonth(-1)`. A JQL relative comparison
    // is a comparison against an INSTANT, so it translates for every range operator and every date
    // column (due included) via a shared cutoff object — identical in both dialects, no windows, no
    // approximation.
    const cutoff = this.relativeCutoff(clause.value, clause.op);

    if (cutoff !== null) {
      return { field: column, operator: 'relative', value: cutoff };
    }

    // Absolute dates.
    const raw = textOf(clause.value, column);
    const abs = ABSOLUTE_DATE_RE.exec(raw.trim());

    if (!abs) {
      refuse(`the date value "${raw}" has no translatable equivalent`);
    }

    const timed = !!abs[4];
    const iso = `${abs[1]}-${abs[2]}-${abs[3]}${timed ? `T${abs[4]}:${abs[5]}:00` : ''}`;

    switch (clause.op) {
      case '>':
        return { field: column, operator: 'gt', value: iso };
      case '>=':
        return { field: column, operator: 'gte', value: iso };
      case '<':
        return { field: column, operator: 'lt', value: iso };
      case '<=':
        return { field: column, operator: 'lte', value: iso };
      case '=':
      case '!=': {
        if (timed) {
          // A value with a time component is a minute-exact instant. The board evaluator compares
          // dates day-granular while the filters engine compares the raw timestamp, so an exact
          // equality would mean different things in each dialect. It never appears in a board quick
          // filter; refuse rather than translate two different filters from one clause.
          refuse(
            `"${column} ${clause.op} ${raw}": timed date equality has no single day-granular meaning`,
          );
        }

        // Day-granular equality, exact and dialect-independent: the calendar day is the half-open
        // interval [day 00:00, next-day 00:00). Both engines evaluate gte/lt on dates identically,
        // so this is `field = day` (and its complement for `!=`) with no engine-specific behaviour.
        const dayStart = `${abs[1]}-${abs[2]}-${abs[3]}T00:00:00`;
        const base = new Date(
          Number(abs[1]),
          Number(abs[2]) - 1,
          Number(abs[3]),
        );
        const next = new Date(
          base.getFullYear(),
          base.getMonth(),
          base.getDate() + 1,
        );
        const pad = (n: number): string => String(n).padStart(2, '0');
        const nextStart = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T00:00:00`;

        if (clause.op === '=') {
          return {
            combinator: 'and',
            rules: [
              { field: column, operator: 'gte', value: dayStart },
              { field: column, operator: 'lt', value: nextStart },
            ],
          };
        }

        return {
          combinator: 'or',
          rules: [
            { field: column, operator: 'lt', value: dayStart },
            { field: column, operator: 'gte', value: nextStart },
          ],
        };
      }
      default:
        refuse(`"${clause.op}" is not translatable for ${column}`);
    }
  }

  /**
   * Build the shared cutoff object for a relative date value + operator, or null when the value is
   * not a relative form (the caller then tries the absolute-date path).
   *
   * A bare integer argument to an anchor function is a CALENDAR shift in that anchor's natural unit
   * (`startOfMonth(-1)` = start of LAST month, a variable number of days) and becomes `periods`; a
   * duration argument (`startOfDay("-3d")`) or a bare duration value (`-7d`, `"-1w 2d"`) is a FIXED
   * shift and becomes `offsetMinutes`, anchored at `now`.
   */
  private relativeCutoff(value: JqlValue, op: string): RelativeCutoff | null {
    const cutoffOp = CUTOFF_OPS[op];

    if (value.kind === 'func') {
      const anchor = ANCHOR_FUNCTIONS[value.name];

      // currentUser(), membersOf(), unreleasedVersions()… are not date anchors — not relative.
      if (!anchor) return null;

      if (!cutoffOp) {
        refuse(
          `"${op}" needs a range operator (>, >=, <, <=) with ${value.name}()`,
        );
      }

      if (value.args.length > 1) {
        refuse(`${value.name}() takes at most one offset argument`);
      }

      const cutoff: RelativeCutoff = {
        kind: 'cutoff',
        anchor: anchor as RelativeAnchor,
        op: cutoffOp,
      };

      if (value.args.length === 1) {
        const arg = value.args[0].trim();

        if (/^[+-]?\d+$/.test(arg)) {
          cutoff.periods = Number(arg);
        } else {
          const mins = durationMinutes(arg);

          if (mins === null) {
            refuse(
              `${value.name}(${arg}) offset is neither a whole period nor a duration`,
            );
          }

          cutoff.offsetMinutes = mins;
        }
      }

      return cutoff;
    }

    // Bare or quoted duration: `-7d`, `"-1w 2d"`, `4h`. Anchored at `now`.
    const mins = durationMinutes(value.text);

    if (mins === null) return null;

    if (!cutoffOp) {
      refuse(
        `"${op}" needs a range operator (>, >=, <, <=) with "${value.text}"`,
      );
    }

    return { kind: 'cutoff', anchor: 'now', offsetMinutes: mins, op: cutoffOp };
  }

  // ── custom fields ──

  private emitCustomField(
    clause: JqlClause,
    lookup: CustomFieldLookup,
  ): RuleJson {
    // Board: the evaluator reads `custom_field_values[field]` with the rule's field name as-is,
    // and the bag is keyed by field_key. Filters: the engine expects `cf_` + field_key and strips
    // the prefix before the JSONB lookup.
    const fieldName =
      this.dialect === 'board' ? lookup.fieldKey : `cf_${lookup.fieldKey}`;

    if (clause.kind === 'is') {
      return {
        field: fieldName,
        operator: clause.negated ? 'notNull' : 'null',
        value: null,
      };
    }

    // Single-select / radio: the bag stores ONE option id (custom-field-value.mapper), so both
    // engines compare it as a scalar. JQL names the option by its label, so name→id resolution
    // needs the field's option list (loaded into `lookup.options` by the context builder). `in`
    // lists and `=`/`!=` are the natural operators; anything ordered is refused.
    if (lookup.fieldType === 'select' || lookup.fieldType === 'radio') {
      const resolveOption = (raw: string): string => {
        const id = lookup.options?.get(lc(raw));

        if (id === undefined) {
          refuse(
            `"${raw}" is not an option of the ${lookup.fieldType} field "${lookup.fieldKey}"`,
          );
        }

        return id;
      };

      if (clause.kind === 'list') {
        return {
          field: fieldName,
          operator: clause.negated ? 'notIn' : 'in',
          value: clause.values.map((v) =>
            resolveOption(textOf(v, lookup.fieldKey)),
          ),
        };
      }

      if (clause.kind === 'cmp' && (clause.op === '=' || clause.op === '!=')) {
        return {
          field: fieldName,
          operator: clause.op === '=' ? 'eq' : 'neq',
          value: resolveOption(textOf(clause.value, lookup.fieldKey)),
        };
      }

      refuse(
        `only "=", "!=" and "in" are translatable for the ${lookup.fieldType} field "${lookup.fieldKey}"`,
      );
    }

    // History clauses are refused before dispatch; the guard narrows the union for tsc AND makes a
    // future dispatch bug loud instead of silently mis-typed.
    if (clause.kind !== 'cmp') refuse('unsupported clause shape here');

    // The REAL FieldType vocabulary (custom-field.model.ts): plain text is 'string', rich text is
    // 'editor', links are 'url' — there is no 'text'. Verified the hard way: a live run fell back
    // on a text field because this check guessed the wrong names.
    if (
      lookup.fieldType === 'string' ||
      lookup.fieldType === 'editor' ||
      lookup.fieldType === 'url'
    ) {
      if (clause.kind === 'cmp' && (clause.op === '~' || clause.op === '!~')) {
        return {
          field: fieldName,
          operator: clause.op === '~' ? 'contains' : 'notContains',
          value: textOf(clause.value, lookup.fieldKey),
        };
      }

      refuse(
        `only "~" and "!~" are translatable for the text field "${lookup.fieldKey}"`,
      );
    }

    if (lookup.fieldType === 'number') {
      if (clause.kind === 'cmp') {
        const num = Number(textOf(clause.value, lookup.fieldKey));

        if (Number.isNaN(num)) {
          refuse(
            `"${lookup.fieldKey}" is numeric but the value is not a number`,
          );
        }

        const ops: Record<string, string> = {
          '=': 'eq',
          '!=': 'neq',
          '>': 'gt',
          '>=': 'gte',
          '<': 'lt',
          '<=': 'lte',
        };

        if (ops[clause.op]) {
          return { field: fieldName, operator: ops[clause.op], value: num };
        }
      }

      refuse(
        `"${lookup.fieldKey}": the operator is not translatable for numbers`,
      );
    }

    // Remaining option-bearing types refuse for a concrete, type-specific reason: a `multiselect`
    // bag is a jsonb ARRAY and a `cascading_select` bag is a `{levels:[…]}` object, and neither
    // engine's generic scalar path compares those element-wise — an emitted rule would look right
    // and match nothing. `checkbox`/`user_select`/`date`/`datetime` and the link types likewise
    // have value semantics the scalar path does not evaluate. Refusing beats a silent lie.
    if (
      lookup.fieldType === 'multiselect' ||
      lookup.fieldType === 'cascading_select'
    ) {
      refuse(
        `the ${lookup.fieldType} field "${lookup.fieldKey}" stores a multi-value bag the query engines do not compare element-wise`,
      );
    }

    refuse(
      `the ${lookup.fieldType} field "${lookup.fieldKey}" has no faithful value mapping built`,
    );
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function emitDialect(
  ast: JqlNode,
  ctx: TranspileContext,
  dialect: Dialect,
  artifact: BoardArtifact,
  stripped: string[],
): EmitOutcome {
  try {
    const emitted = new Emitter(ctx, dialect, stripped).emit(ast, true);

    // The whole query reduced to membership-neutral strips → "match everything".
    if (emitted === null) {
      if (dialect === 'board' && artifact === 'swimlane') {
        // A swimlane whose query has no rules renders EMPTY on the board (queryHasRules gates it),
        // the opposite of match-everything — the one place an empty group is not the right encoding.
        return {
          ok: false,
          reason:
            'the query reduces to match-everything, which a swimlane cannot express',
        };
      }

      return { ok: true, query: { combinator: 'and', rules: [] } };
    }

    // A bare clause at the root still needs a group wrapper — every consumer expects
    // {combinator, rules} at the top.
    const query: RuleGroupJson =
      'combinator' in emitted
        ? emitted
        : { combinator: 'and', rules: [emitted] };

    return { ok: true, query };
  } catch (err) {
    if (err instanceof Untranslatable) {
      return { ok: false, reason: err.message };
    }

    throw err;
  }
}

/**
 * Transpile one JQL string into both dialects.
 *
 * Never throws. A parse failure fails BOTH dialects with the same reason; emit failures are
 * per-dialect (the two vocabularies genuinely differ — e.g. `startOfWeek()` exists on the board,
 * `startOfYear()` only on the filters engine).
 */
export function transpileJql(
  jql: string,
  ctx: TranspileContext,
  artifact: BoardArtifact,
): TranspileOutput {
  const parsed = parseJql(jql);

  if (!parsed.ok) {
    return {
      board: { ok: false, reason: parsed.error },
      filters: { ok: false, reason: parsed.error },
      stripped: [],
    };
  }

  const stripped: string[] = [];

  if (parsed.orderBy) {
    stripped.push(`${parsed.orderBy} (ordering does not affect membership)`);
  }

  // Each dialect gets its own strip list run; they record identical entries, so keep the first.
  const boardStrips: string[] = [...stripped];
  const filtersStrips: string[] = [...stripped];
  const board = emitDialect(parsed.ast, ctx, 'board', artifact, boardStrips);
  const filters = emitDialect(
    parsed.ast,
    ctx,
    'filters',
    artifact,
    filtersStrips,
  );

  return {
    board,
    filters,
    stripped: board.ok ? boardStrips : filtersStrips,
  };
}
