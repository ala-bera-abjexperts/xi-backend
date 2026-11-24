import { randomUUID } from 'crypto';
import { businessMilliseconds, advanceBusinessMilliseconds } from './sla-clock';
import { evaluateRules } from './sla-rules';
import type { SlaCalendar, SlaFieldMetadata, SlaRuleGroup } from './sla.types';

export interface SlaConfig {
  version: 1;
  cycle_mode: 'once' | 'on_reopen';
  fulfillment: 'condition' | 'customer_reply';
  start: SlaRuleGroup | null;
  pause: SlaRuleGroup | null;
  stop: SlaRuleGroup | null;
  goals: {
    id: string;
    filter: SlaRuleGroup | null;
    target_ms: number;
    calendar_revision_id: string;
  }[];
  field_metadata?: SlaFieldMetadata[];
}
export interface SlaMetricTerms {
  metric_id: string;
  revision_id: string;
  space_id: string;
  enabled: boolean;
  config: SlaConfig;
  configuration_error?: string;
  calendars: Record<string, SlaCalendar>;
  metadata: SlaFieldMetadata[];
}
export interface SlaEvent {
  id?: string;
  task_id: string;
  organization_id: string;
  kind: string;
  effective_at: string;
  before_snapshot: Record<string, unknown>;
  after_snapshot: Record<string, unknown>;
}
export interface SlaCycle {
  id: string;
  task_id: string;
  organization_id: string;
  space_id: string;
  metric_id: string;
  metric_revision_id: string;
  cycle_number: number;
  lifecycle:
    | 'active'
    | 'completed'
    | 'cancelled'
    | 'not_applicable'
    | 'invalid';
  outcome: 'met' | 'breached' | null;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number;
  target_ms: number;
  deadline_at: string | null;
  updated_at: string;
  state: {
    terms: SlaMetricTerms;
    calendar: SlaCalendar | null;
    goal_id: string | null;
    elapsed_ms: number;
    running_since: number | null;
    paused: boolean;
    error: string | null;
    error_event_id?: string;
    error_at?: string;
    not_applicable_reason?: 'request_unlinked';
    observed_at?: number;
    observed_elapsed_ms?: number;
    deadline_search_at?: number;
    deadline_remaining_ms?: number;
    deadline_pending?: boolean;
    fulfillment_evidence_id?: string;
  };
}
const DAY = 86400000;
export function referencedCustomFields(config: SlaConfig): string[] {
  const fields = new Set<string>();
  const visit = (group: SlaRuleGroup | null) => {
    for (const rule of group?.rules ?? []) {
      if ('rules' in rule) visit(rule);
      else if (rule.field.startsWith('cf_')) fields.add(rule.field);
    }
  };
  [
    config.start,
    config.pause,
    config.stop,
    ...config.goals.map((goal) => goal.filter),
  ].forEach(visit);
  return [...fields];
}
function matches(
  rule: SlaRuleGroup | null,
  event: SlaEvent,
  terms: SlaMetricTerms,
  fallback: boolean,
): boolean {
  if (rule === null) return fallback;
  const result = evaluateRules(rule, event.after_snapshot, terms.metadata);
  const refs = referencedCustomFields({
    ...terms.config,
    start: rule,
    pause: null,
    stop: null,
    goals: [],
  });
  if (
    refs.some(
      (field) =>
        !Object.prototype.hasOwnProperty.call(event.after_snapshot, field),
    )
  )
    throw new Error('SLA condition references an unavailable custom field');
  return result;
}
function elapsed(cycle: SlaCycle, at: number): number {
  if (!cycle.state.calendar || cycle.state.running_since === null)
    return cycle.state.elapsed_ms;
  const reusable =
    cycle.state.observed_at !== undefined && cycle.state.observed_at <= at;
  const base = reusable ? cycle.state.observed_at! : cycle.state.running_since;
  const amount = reusable
    ? cycle.state.observed_elapsed_ms!
    : cycle.state.elapsed_ms;
  return (
    amount +
    businessMilliseconds(cycle.state.calendar, base, Math.max(at, base))
  );
}
export function projectCycle(cycle: SlaCycle, at: number): SlaCycle {
  if (cycle.lifecycle !== 'active') return cycle;
  const elapsed_ms = elapsed(cycle, at);
  let deadline_at = cycle.deadline_at;
  let state = {
    ...cycle.state,
    observed_at: at,
    observed_elapsed_ms: elapsed_ms,
  };
  if (
    !state.paused &&
    state.calendar &&
    state.running_since !== null &&
    !deadline_at
  ) {
    const from = state.deadline_search_at ?? state.running_since;
    const remaining =
      state.deadline_remaining_ms ??
      Math.max(0, cycle.target_ms - state.elapsed_ms);
    // Search one year per checkpoint; calendars with distant working dates resume durably.
    const until = from + 366 * DAY;
    const deadline = advanceBusinessMilliseconds(
      state.calendar,
      from,
      remaining,
      until,
    );
    if (deadline !== null) {
      deadline_at = new Date(deadline).toISOString();
      state = { ...state, deadline_pending: false };
    } else {
      state = {
        ...state,
        deadline_pending: true,
        deadline_search_at: until,
        deadline_remaining_ms: Math.max(
          0,
          remaining - businessMilliseconds(state.calendar, from, until),
        ),
      };
    }
  }
  return {
    ...cycle,
    elapsed_ms,
    outcome: elapsed_ms > cycle.target_ms ? 'breached' : null,
    deadline_at,
    updated_at: new Date(at).toISOString(),
    state,
  };
}
function updateActive(cycle: SlaCycle, event: SlaEvent): SlaCycle {
  const at = Date.parse(event.effective_at),
    terms = cycle.state.terms;
  const elapsed_ms = elapsed(cycle, at);
  const cancelled =
    event.after_snapshot.scope_active !== true ||
    event.after_snapshot.space_id !== cycle.space_id ||
    (terms.config.fulfillment === 'customer_reply' &&
      !event.after_snapshot.request_id);
  const fulfilled =
    !cancelled &&
    (terms.config.fulfillment === 'customer_reply'
      ? event.kind === 'customer_reply_published' &&
        typeof event.after_snapshot.reply_evidence_id === 'string'
      : matches(terms.config.stop, event, terms, false));
  const paused =
    !cancelled &&
    !fulfilled &&
    matches(terms.config.pause, event, terms, false);
  return {
    ...cycle,
    elapsed_ms,
    lifecycle: cancelled ? 'cancelled' : fulfilled ? 'completed' : 'active',
    outcome: cancelled
      ? null
      : fulfilled
        ? elapsed_ms > cycle.target_ms
          ? 'breached'
          : 'met'
        : elapsed_ms > cycle.target_ms
          ? 'breached'
          : null,
    completed_at: cancelled || fulfilled ? event.effective_at : null,
    updated_at: event.effective_at,
    deadline_at: paused || cycle.state.paused ? null : cycle.deadline_at,
    state: {
      ...cycle.state,
      not_applicable_reason:
        terms.config.fulfillment === 'customer_reply' &&
        !event.after_snapshot.request_id
          ? 'request_unlinked'
          : undefined,
      elapsed_ms,
      observed_at: undefined,
      observed_elapsed_ms: undefined,
      deadline_search_at:
        paused || cycle.state.paused
          ? undefined
          : cycle.state.deadline_search_at,
      deadline_remaining_ms:
        paused || cycle.state.paused
          ? undefined
          : cycle.state.deadline_remaining_ms,
      deadline_pending: paused ? false : cycle.state.deadline_pending,
      fulfillment_evidence_id:
        fulfilled && terms.config.fulfillment === 'customer_reply'
          ? (event.after_snapshot.reply_evidence_id as string)
          : cycle.state.fulfillment_evidence_id,
      running_since: cancelled || fulfilled || paused ? null : at,
      paused,
    },
  };
}
function enroll(
  history: SlaCycle[],
  event: SlaEvent,
  terms: SlaMetricTerms,
): SlaCycle | null {
  if (
    !terms.enabled ||
    event.after_snapshot.scope_active !== true ||
    event.after_snapshot.space_id !== terms.space_id ||
    event.after_snapshot.is_completed === true
  )
    return null;
  if (
    terms.config.fulfillment === 'customer_reply' &&
    (event.kind === 'customer_reply_published' ||
      event.after_snapshot.customer_reply_published === true)
  )
    return null;
  const latest = history.at(-1);
  if (
    history.some((c) => c.lifecycle === 'completed') &&
    (terms.config.cycle_mode === 'once' ||
      terms.config.fulfillment === 'customer_reply')
  )
    return null;
  if (
    latest?.lifecycle === 'completed' &&
    !(
      event.before_snapshot.is_completed === true &&
      event.after_snapshot.is_completed === false
    )
  )
    return null;
  if (
    !matches(terms.config.start, event, terms, true) ||
    (terms.config.fulfillment === 'condition' &&
      matches(terms.config.stop, event, terms, false))
  )
    return null;
  const applicable =
    terms.config.fulfillment !== 'customer_reply' ||
    !!event.after_snapshot.request_id;
  const goal = applicable
    ? terms.config.goals.find((g) => matches(g.filter, event, terms, true))
    : undefined;
  const calendar = goal ? terms.calendars[goal.calendar_revision_id] : null;
  if (goal && !calendar) throw new Error('SLA calendar revision is missing');
  const paused = !!goal && matches(terms.config.pause, event, terms, false);
  return {
    id: randomUUID(),
    task_id: event.task_id,
    organization_id: event.organization_id,
    space_id: terms.space_id,
    metric_id: terms.metric_id,
    metric_revision_id: terms.revision_id,
    cycle_number: (latest?.cycle_number ?? 0) + 1,
    lifecycle: goal ? 'active' : 'not_applicable',
    outcome: null,
    started_at: goal ? event.effective_at : null,
    completed_at: null,
    elapsed_ms: 0,
    target_ms: goal?.target_ms ?? 0,
    deadline_at: null,
    updated_at: event.effective_at,
    state: {
      terms,
      calendar: calendar ?? null,
      goal_id: goal?.id ?? null,
      elapsed_ms: 0,
      running_since: goal && !paused ? Date.parse(event.effective_at) : null,
      paused,
      error: null,
    },
  };
}
export function invalidateCycle(
  cycle: SlaCycle,
  error: unknown,
  at: string,
  eventId?: string,
): SlaCycle {
  return {
    ...cycle,
    lifecycle: 'invalid',
    outcome: null,
    completed_at: null,
    deadline_at: null,
    elapsed_ms: cycle.state.elapsed_ms,
    updated_at: at,
    state: {
      ...cycle.state,
      running_since: null,
      error: error instanceof Error ? error.message : String(error),
      error_at: at,
      error_event_id: eventId,
    },
  };
}
function invalidEnrollment(
  history: SlaCycle[],
  event: SlaEvent,
  terms: SlaMetricTerms,
  error: unknown,
): SlaCycle {
  return invalidateCycle(
    {
      id: randomUUID(),
      task_id: event.task_id,
      organization_id: event.organization_id,
      space_id: terms.space_id,
      metric_id: terms.metric_id,
      metric_revision_id: terms.revision_id,
      cycle_number: (history.at(-1)?.cycle_number ?? 0) + 1,
      lifecycle: 'invalid',
      outcome: null,
      started_at: null,
      completed_at: null,
      elapsed_ms: 0,
      target_ms: 0,
      deadline_at: null,
      updated_at: event.effective_at,
      state: {
        terms,
        calendar: null,
        goal_id: null,
        elapsed_ms: 0,
        running_since: null,
        paused: false,
        error: null,
      },
    },
    error,
    event.effective_at,
    event.id,
  );
}
export function reduceSlaEvent(
  cycles: SlaCycle[],
  event: SlaEvent,
  metrics: SlaMetricTerms[],
): SlaCycle[] {
  event = {
    ...event,
    before_snapshot: event.before_snapshot ?? {},
    after_snapshot: event.after_snapshot ?? { scope_active: false },
  };
  if (!Number.isFinite(Date.parse(event.effective_at)))
    throw new Error('Invalid SLA event timestamp');
  let result = cycles.map((c) => {
    if (c.lifecycle !== 'active') return c;
    try {
      return updateActive(c, event);
    } catch (error) {
      return invalidateCycle(c, error, event.effective_at, event.id);
    }
  });
  for (const terms of metrics) {
    if (
      !terms.enabled ||
      event.after_snapshot.scope_active !== true ||
      event.after_snapshot.space_id !== terms.space_id
    )
      continue;
    const history = result
      .filter((c) => c.metric_id === terms.metric_id)
      .sort((a, b) => a.cycle_number - b.cycle_number);
    if (history.some((c) => c.lifecycle === 'active')) continue;
    // A completion in this same event cannot also enroll a replacement.
    if (
      cycles.some(
        (c) => c.metric_id === terms.metric_id && c.lifecycle === 'active',
      )
    )
      continue;
    if (
      history.some(
        (c) =>
          c.lifecycle === 'invalid' &&
          c.metric_revision_id === terms.revision_id,
      )
    )
      continue;
    let next: SlaCycle | null;
    try {
      if (terms.configuration_error) throw new Error(terms.configuration_error);
      next = enroll(history, event, terms);
      if (next) next = projectCycle(next, Date.parse(event.effective_at));
    } catch (error) {
      next = invalidEnrollment(history, event, terms, error);
    }
    if (!next) continue;
    const previous = history.at(-1);
    if (
      previous?.lifecycle === 'not_applicable' &&
      next.lifecycle === 'not_applicable'
    )
      continue;
    result = [...result, next];
  }
  return result;
}
