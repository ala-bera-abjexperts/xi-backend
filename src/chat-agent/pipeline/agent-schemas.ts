/**
 * @fileoverview The two answers Robert asks a provider for: the plan (first call) and the asset
 * fill (one call per asset type). Each is a hand-written JSON schema — what the provider is sent —
 * with a zod schema beside it that parses every answer.
 *
 * The JSON schemas are flat on purpose, so one constant works for all five providers: every key
 * required, no extra keys, nullable values as type [T, "null"], no nullable objects, no anyOf/oneOf,
 * no $ref. (zod's own generator writes anyOf for a nullable value, which toGeminiSchema would turn
 * into an invalid type.) agent-schemas.spec.ts enforces all of this.
 *
 * The model never outputs an id. People and messages are per-run handles ("P2", "m7"); everything
 * else is the words used, which the server resolves as the invoker.
 */
import { z } from 'zod';

import type { JsonSchema } from '../../ai-automation/tenant-ai.service';
import { WIKI_BLOCK_TYPES } from './agent-wiki-render';

export const MAX_PLAN_INTENTS = 50;

export const AGENT_INTENT_KINDS = [
  'task',
  'subtask',
  'asset_object',
  'wiki_page',
  'plan_item',
  'plan',
  'plan_link',
  // 1.23: suggestions for an existing plan.
  'plan_dependency',
  'plan_dates',
  'plan_risk',
  'plan_stakeholder',
  'plan_baseline',
  'space',
  'process',
  'space_member_add',
  'space_member_role',
  'space_member_permissions',
  'space_member_remove',
] as const;

const LANGUAGES = ['de', 'en', 'other'] as const;
export const DEPENDENCY_TYPES = [
  'finish_to_start',
  'start_to_start',
  'finish_to_finish',
  'start_to_finish',
  'unclear',
] as const;
const CONTEXT_ACTIONS = ['ok', 'last_n', 'since', 'earlier'] as const;
const PRIORITY_LEVELS = [
  'none',
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
] as const;
export const WIKI_PAGE_TYPES = [
  'meeting_notes',
  'how_to',
  'decision',
  'release_notes',
  'project',
  'retro',
  'runbook',
  'spec',
  'faq',
  'onboarding',
  'other',
] as const;
const UNSUPPORTED = [
  'none',
  'delete',
  'update',
  'permissions',
  'other',
] as const;

const text = (description: string): JsonSchema => ({
  type: 'string',
  description,
});

const nullableText = (description: string): JsonSchema => ({
  type: ['string', 'null'],
  description,
});

const flag = (description: string): JsonSchema => ({
  type: 'boolean',
  description,
});

const list = (items: JsonSchema, description: string): JsonSchema => ({
  type: 'array',
  description,
  items,
});

// ponytail: toGeminiSchema drops `enum`, so the values are also named in the description. Copy
// `enum` through there if Gemini answers start to drift.
const oneOf = (values: readonly string[], description: string): JsonSchema => ({
  type: 'string',
  enum: [...values],
  description: `${description} One of: ${values.join(', ')}.`,
});

// Every key required and no extra keys — by construction, so a new field cannot forget either.
const object = (
  properties: Record<string, JsonSchema>,
  description?: string,
): JsonSchema => ({
  type: 'object',
  ...(description ? { description } : {}),
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const personOf = (description: string): JsonSchema =>
  object(
    {
      said: nullableText(
        'The name or words used for the person; null when nobody was named.',
      ),
      participant: nullableText(
        'Handle of the person in the people list ("P2") when it is certain who is meant; else null.',
      ),
      is_requester: flag(
        'True when the requester means themselves ("me", "ich").',
      ),
    },
    description,
  );

const dateOf = (description: string): JsonSchema =>
  object(
    {
      said: nullableText(
        'The words used for the date ("by Friday"); null when no date was given.',
      ),
      iso: nullableText(
        'That date as YYYY-MM-DD, read from the calendar; null when unsure.',
      ),
    },
    description,
  );

const INTENT = object({
  ref: text('Handle of this item: "i1", "i2", … in order.'),
  kind: oneOf(AGENT_INTENT_KINDS, 'What to create.'),
  title: text('Title or name of the object, in the object language.'),
  description: nullableText(
    'Plain text without HTML or markdown; null when there is nothing to add.',
  ),
  sources: list(
    text('Message handle ("m7").'),
    'The messages this item is based on.',
  ),
  space: nullableText('The space as it was named; null when none was named.'),
  type: nullableText(
    'task, subtask: the task type as it was named ("Bug"); else null.',
  ),
  status: nullableText(
    'task, subtask, plan: the status as it was named; null when none was named.',
  ),
  priority: object(
    {
      said: nullableText('The words used ("urgent"); null when none.'),
      level: oneOf(
        PRIORITY_LEVELS,
        'The nearest level; "none" when no priority was given.',
      ),
    },
    'task, subtask: the priority.',
  ),
  assignee: personOf('task, subtask: who should do it. process: its owner.'),
  due: dateOf('task, subtask: the due date.'),
  labels: list(
    text('Label as it was named.'),
    'task, subtask: labels; empty when none.',
  ),
  parent: object(
    {
      item: nullableText(
        'ref of another item in this answer ("i1") when that is the parent.',
      ),
      key: nullableText(
        'Key of an existing object exactly as written in the messages ("ABC-12").',
      ),
      said: nullableText('Otherwise the words used for the parent.'),
    },
    'subtask: the parent task. process: the process above it, item for one of this answer (earlier in the list), key for one that exists. All null otherwise.',
  ),
  asset_type: list(
    text('Noun.'),
    'asset_object: generic nouns for the kind of asset, German and English ("Laptop", "Notebook"); else empty.',
  ),
  facts: list(
    object({
      label: text('What the value is ("Serial number").'),
      value: text('The value exactly as written.'),
      unsure: flag('True when the value may be wrong or incomplete.'),
    }),
    'asset_object: facts about the asset found in the messages; else empty.',
  ),
  owner: personOf(
    'asset_object, plan, plan_item, plan_risk: the owner. plan_stakeholder: the person, when a participant is meant.',
  ),
  parent_page: nullableText(
    'wiki_page: the parent page as it was named; else null.',
  ),
  page_type: nullableText(
    `wiki_page: what kind of page, one of ${WIKI_PAGE_TYPES.join(', ')}; else null.`,
  ),
  publish: flag(
    'wiki_page: true only when the requester asked to publish the page; else false (a draft).',
  ),
  general_knowledge: flag(
    'wiki_page: true when the page is written from general knowledge rather than from the conversation, tasks or pages given; else false.',
  ),
  revises: flag(
    'wiki_page: true when this page is the open proposal given in the data, changed as the request asks; any item: true when it belongs to the open_plan given in the data and the request changes that plan; else false.',
  ),
  body: list(
    object({
      type: oneOf(WIKI_BLOCK_TYPES, 'Block type.'),
      level: {
        type: ['integer', 'null'],
        description: 'heading: 1, 2 or 3; else null.',
      },
      text: nullableText(
        'heading, paragraph, quote, code, callout, excerpt, toggle, status: the text; chart: the title; task_table: search words or null; else null. Inline only **bold**, _italic_, `code`, [m7] to cite a message, @P2 for a person and [d:2026-11-28] for a date.',
      ),
      title: nullableText('callout, toggle, chart: the title; else null.'),
      items: list(
        text('One entry.'),
        'bullets, numbered, checklist ("[x] " when done), decisions, callout, toggle, columns (2-3), status (lozenge texts): the entries; task_table: status names to show; else empty.',
      ),
      rows: list(
        list(text('Cell.'), 'One row.'),
        'table and chart: rows, the first is the header (chart: label, then one column per series; numbers exactly as stated); properties: [key, value] pairs; else empty.',
      ),
      variant: nullableText(
        'callout: info, note, tip, warning, success or danger; status: grey, green, blue, red, yellow or purple; chart: bar, pie, line or area; else null.',
      ),
      language: nullableText('code: the language ("bash"); else null.'),
      refs: list(
        text('Handle or key.'),
        'task_cards: task handles ("T1"), keys as written ("ABC-T12") or items of this answer ("i2"); include_page: page handles ("W1"); task_table: people handles ("P2") whose tasks to show; else empty.',
      ),
      labels: list(
        text('Label as it was named.'),
        'task_cards: show the tasks with these labels; pages_by_label, decision_report, properties_report: the page labels; else empty.',
      ),
    }),
    'wiki_page: the page content as blocks, never HTML or markdown; else empty.',
  ),
  plan: nullableText('plan_item, plan_link: the existing plan as it was named; else null.'),
  // 1.22.1: an existing task into a plan, and dependencies of a new plan item.
  task: object(
    {
      key: nullableText('plan_link: the key of the existing task exactly as written ("ABC-12"); else null.'),
      said: nullableText('plan_link: otherwise the words used for the task; else null.'),
    },
    'plan_link: the existing task to add to the plan. Both null otherwise.',
  ),
  depends: list(
    object({
      item: nullableText('ref of another plan_item of this answer ("i2") at the other end; else null.'),
      key: nullableText('key of an existing plan item at the other end ("ABC-12"); else null.'),
      said: nullableText('otherwise the name of the item at the other end; else null.'),
      type: oneOf(
        DEPENDENCY_TYPES,
        'finish_to_start: "after X ends", "once X is done", "nach X", "sobald X fertig ist". start_to_start: "starts with X", "beginnt mit X". finish_to_finish: "finishes with X", "endet mit X". start_to_finish: "can\'t finish until X starts", "kann erst enden, wenn X beginnt". unclear: anything else.',
      ),
      this_is: oneOf(
        ['successor', 'predecessor'] as const,
        'successor when this item waits for the other ("this starts after X"); predecessor when the other waits for this ("X starts after this").',
      ),
      words: text('the words that set this dependency, as written.'),
    }),
    'plan_item: dependencies on another item; empty when none were asked for. Never for a plan_link.',
  ),
  // 1.23: suggestions for an existing plan.
  reason: nullableText(
    'plan_dependency, plan_risk, plan_stakeholder: one short line saying why, naming the words, file ([F1]) or item it comes from; else null.',
  ),
  predecessor: object(
    {
      key: nullableText('key of the existing plan item exactly as given ("ABC-12"); else null.'),
      said: nullableText('otherwise its name; else null.'),
    },
    'plan_dependency: the item that comes first. Both null otherwise.',
  ),
  successor: object(
    {
      key: nullableText('key of the existing plan item exactly as given ("ABC-12"); else null.'),
      said: nullableText('otherwise its name; else null.'),
    },
    'plan_dependency: the item that waits for the predecessor. Both null otherwise.',
  ),
  dependency_type: oneOf(
    DEPENDENCY_TYPES,
    'plan_dependency: how the successor waits; finish_to_start when it starts after the predecessor ends. Else unclear.',
  ),
  dates_for: list(
    text('key of a plan item exactly as given.'),
    'plan_dates: the items the request names; empty for every item of the plan without dates. Else empty.',
  ),
  risk: object(
    {
      risk_type: oneOf(['risk', 'opportunity'] as const, 'plan_risk: risk, or opportunity for a chance; else risk.'),
      category: nullableText('plan_risk: Technical, Schedule, Budget, Resource, Legal, Compliance or another short word; else null.'),
      probability: { type: ['integer', 'null'], description: 'plan_risk: 1 (very low) to 5 (very high); else null.' },
      impact: { type: ['integer', 'null'], description: 'plan_risk: 1 (very low) to 5 (very high); else null.' },
      mitigation: nullableText('plan_risk: how to make it less likely or less bad; else null.'),
      contingency: nullableText('plan_risk: what to do when it happens; else null.'),
    },
    'plan_risk: the risk; its name is the title and its description the description.',
  ),
  stakeholder: object(
    {
      role: nullableText('plan_stakeholder: their role ("Approver"); else null.'),
      organization: nullableText('plan_stakeholder: their organization or department; else null.'),
      email: nullableText('plan_stakeholder: an email address only when written in the data; else null.'),
      power: { type: ['integer', 'null'], description: 'plan_stakeholder: power over the plan, 1 to 10; else null.' },
      interest: { type: ['integer', 'null'], description: 'plan_stakeholder: interest in the plan, 1 to 10; else null.' },
      attitude: nullableText('plan_stakeholder: supportive, neutral or resistant; else null.'),
      engagement: nullableText('plan_stakeholder: how to keep them involved; else null.'),
    },
    'plan_stakeholder: the stakeholder; their name or role is the title.',
  ),
  milestone: flag('plan_item: true for a milestone; else false.'),
  start: dateOf('plan, plan_item: the start date; a milestone: its date.'),
  end: dateOf('plan, plan_item: the end date; empty for a milestone.'),
  plan_type: nullableText(
    'plan: waterfall, agile, hybrid or ipma as the request names it; null when none was named.',
  ),
  item_type: nullableText(
    'plan_item: phase, work_package, task or milestone; else null.',
  ),
  plan_ref: nullableText(
    'plan_item: ref of the plan item of this answer ("i1") it goes in; null when it goes in an existing plan.',
  ),
  estimated_hours: {
    type: ['number', 'null'],
    description: 'plan_item: estimated hours as stated; else null.',
  },
  estimated_cost: {
    type: ['number', 'null'],
    description: 'plan_item: estimated cost as stated, a number only; else null.',
  },
  progress: {
    type: ['integer', 'null'],
    description: 'plan_item: percent done (0 to 100) as stated; else null.',
  },
  space_ref: nullableText(
    'ref of a space item of this answer ("i1") this item belongs in; null when it goes in an existing space.',
  ),
  process_ref: nullableText(
    'task, wiki_page: ref of a process item of this answer ("i2") this belongs to; else null.',
  ),
  space_key: nullableText(
    'space: the key as it was named ("ABC"); null when none was named.',
  ),
  member: personOf(
    'space_member_*: the person whose membership or permissions change. All null and false for other kinds.',
  ),
  member_role: nullableText(
    'space_member_add, space_member_role: owner, admin, member or viewer, only when the request says which; else null.',
  ),
  grant_permissions: list(
    text('A space permission key such as create_tasks.'),
    'space_member_permissions, space_member_add: permissions the request gives; else empty.',
  ),
  revoke_permissions: list(
    text('A space permission key such as create_tasks.'),
    'space_member_permissions: permissions the request takes away; else empty.',
  ),
  request_type: nullableText(
    'process: what kind of process record, one of Risiko, Geschäftsprozessbewertung, Prozessbewertung, Servicebewertung, Assetbewertung, Schwachstelle, Maßnahme, Assetgroup; null when unclear.',
  ),
  process_scores: list(
    object({
      key: text(
        'vuln_c_p, vuln_c_i, vuln_i_p, vuln_i_i, vuln_a_p, vuln_a_i, action_c_p, action_c_i, action_i_p, action_i_i, action_a_p or action_a_i.',
      ),
      value: { type: 'integer', description: 'The score, 0 to 4.' },
    }),
    'process: scores the request or the data state, or that the request tells you to decide: action_* for Maßnahme, vuln_* for every other type; else empty.',
  ),
});

/** Sent to the provider for the plan call. Strict-mode compatible (OpenAI). */
export const AGENT_PLAN_JSON_SCHEMA: JsonSchema = object({
  reply: text(
    'A short plain-text answer to the requester in their language. No HTML, markdown, URLs or ids.',
  ),
  reply_language: oneOf(LANGUAGES, 'Language of the request.'),
  object_language: oneOf(
    LANGUAGES,
    'Language the titles and texts of the items are written in.',
  ),
  context: object(
    {
      action: oneOf(
        CONTEXT_ACTIONS,
        '"ok" when the given messages are the ones the requester means; otherwise which messages to read instead.',
      ),
      n: {
        type: ['integer', 'null'],
        description: 'last_n: how many messages; else null.',
      },
      since: nullableText(
        'since: where to start, a message handle ("m7") or the words used ("Monday"); else null.',
      ),
    },
    'Whether the requester asked for other messages than the ones given.',
  ),
  intents: list(
    INTENT,
    `One entry per object to create, at most ${MAX_PLAN_INTENTS}. Empty when nothing is to be created.`,
  ),
  more_items: flag(
    `True when the request holds more than ${MAX_PLAN_INTENTS} items.`,
  ),
  unsupported: oneOf(
    UNSUPPORTED,
    'What was asked for besides creating objects; "none" when nothing.',
  ),
});

/** Sent to the provider for an asset fill call: values for the attributes of one asset type. */
export const AGENT_ASSET_FILL_JSON_SCHEMA: JsonSchema = object({
  assets: list(
    object({
      ref: text('Handle of the item as given ("i3").'),
      values: list(
        object({
          attr: text('Handle of the attribute as given ("A4").'),
          value: nullableText(
            'The value as text; null when the messages do not give it.',
          ),
          person: personOf(
            'For an attribute that holds a person; else all null and false.',
          ),
          unsure: flag('True when the value may be wrong or incomplete.'),
        }),
        'One entry per attribute that has a value.',
      ),
    }),
    'One entry per asset.',
  ),
});

/** Spread into TenantAiService.generateJson: the schema with the name and description providers see. */
export const AGENT_PLAN_CALL = {
  schema: AGENT_PLAN_JSON_SCHEMA,
  schemaName: 'robert_plan',
  schemaDescription: "Record Robert's reply and the objects to propose",
};

export const AGENT_ASSET_FILL_CALL = {
  schema: AGENT_ASSET_FILL_JSON_SCHEMA,
  schemaName: 'robert_asset_values',
  schemaDescription: 'Record the attribute values found for each asset',
};

const person = z.object({
  said: z.string().nullable(),
  participant: z.string().nullable(),
  is_requester: z.boolean(),
});

const date = z.object({
  said: z.string().nullable(),
  iso: z.string().nullable(),
});

// Audit 2026-11-10: one invented enum value must not lose the whole answer. The provider is still
// sent the real lists; what comes back outside them falls back here.
const intent = z.object({
  ref: z.string(),
  // An invented kind is one Robert cannot create: counted in flags.unsupportedKinds, never proposed.
  kind: z.enum([...AGENT_INTENT_KINDS, 'other']).catch('other'),
  title: z.string(),
  description: z.string().nullable(),
  sources: z.array(z.string()),
  space: z.string().nullable(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  priority: z.object({
    said: z.string().nullable(),
    level: z.enum(PRIORITY_LEVELS).catch('none'),
  }),
  assignee: person,
  due: date,
  labels: z.array(z.string()),
  parent: z.object({
    item: z.string().nullable(),
    key: z.string().nullable(),
    said: z.string().nullable(),
  }),
  asset_type: z.array(z.string()),
  facts: z.array(
    z.object({ label: z.string(), value: z.string(), unsure: z.boolean() }),
  ),
  owner: person,
  parent_page: z.string().nullable(),
  page_type: z.string().nullable().catch(null),
  publish: z.boolean().catch(false),
  general_knowledge: z.boolean().catch(false),
  revises: z.boolean().catch(false),
  body: z.array(
    z.object({
      type: z.enum(WIKI_BLOCK_TYPES).catch('paragraph'),
      level: z.number().int().nullable().catch(null),
      text: z.string().nullable(),
      title: z.string().nullable().catch(null),
      items: z.array(z.string()),
      rows: z.array(z.array(z.string())).catch([]),
      variant: z.string().nullable().catch(null),
      language: z.string().nullable().catch(null),
      refs: z.array(z.string()).catch([]),
      labels: z.array(z.string()).catch([]),
    }),
  ),
  plan: z.string().nullable(),
  milestone: z.boolean(),
  start: date,
  end: date,
  // 1.22. Optional so a plan or a stored intent from before them still parses.
  plan_type: z.string().nullable().optional().catch(null),
  item_type: z.string().nullable().optional().catch(null),
  plan_ref: z.string().nullable().optional().catch(null),
  // 1.22.1. Optional so answers and stored intents from before still parse.
  task: z
    .object({ key: z.string().nullable(), said: z.string().nullable() })
    .optional()
    .catch(undefined),
  depends: z
    .array(
      z.object({
        item: z.string().nullable().catch(null),
        key: z.string().nullable().catch(null),
        said: z.string().nullable().catch(null),
        type: z.enum(DEPENDENCY_TYPES).catch('unclear'),
        this_is: z.enum(['successor', 'predecessor']).catch('successor'),
        words: z.string().catch(''),
        // Set by the worker: the ordinal of the card `item` names.
        ordinal: z.number().int().nullable().optional().catch(null),
      }),
    )
    .max(10)
    .optional()
    .catch([]),
  // 1.23. Optional so answers and stored intents from before still parse.
  reason: z.string().nullable().optional().catch(null),
  predecessor: z.object({ key: z.string().nullable().catch(null), said: z.string().nullable().catch(null) }).optional().catch(undefined),
  successor: z.object({ key: z.string().nullable().catch(null), said: z.string().nullable().catch(null) }).optional().catch(undefined),
  dependency_type: z.enum(DEPENDENCY_TYPES).optional().catch('unclear'),
  dates_for: z.array(z.string()).max(50).optional().catch([]),
  risk: z
    .object({
      risk_type: z.enum(['risk', 'opportunity']).catch('risk'),
      category: z.string().nullable().catch(null),
      // Outside the scale is kept as said: the card asks (never clamped silently).
      probability: z.number().int().nullable().catch(null),
      impact: z.number().int().nullable().catch(null),
      mitigation: z.string().nullable().catch(null),
      contingency: z.string().nullable().catch(null),
    })
    .optional()
    .catch(undefined),
  stakeholder: z
    .object({
      role: z.string().nullable().catch(null),
      organization: z.string().nullable().catch(null),
      email: z.string().nullable().catch(null),
      power: z.number().int().nullable().catch(null),
      interest: z.number().int().nullable().catch(null),
      attitude: z.string().nullable().catch(null),
      engagement: z.string().nullable().catch(null),
    })
    .optional()
    .catch(undefined),
  estimated_hours: z.number().nullable().optional().catch(null),
  estimated_cost: z.number().nullable().optional().catch(null),
  progress: z.number().int().nullable().optional().catch(null),
  // 1.20. Optional here so a plan or a stored intent from before them still parses.
  space_ref: z.string().nullable().optional().catch(null),
  process_ref: z.string().nullable().optional().catch(null),
  space_key: z.string().nullable().optional().catch(null),
  member: person.optional().catch(undefined),
  member_role: z.string().nullable().optional().catch(null),
  grant_permissions: z.array(z.string()).optional().catch([]),
  revoke_permissions: z.array(z.string()).optional().catch([]),
  request_type: z.string().nullable().optional().catch(null),
  process_scores: z
    .array(z.object({ key: z.string(), value: z.number().int() }))
    .optional()
    .catch([]),
});

/** Parses every plan answer. Unknown keys are dropped; more than MAX_PLAN_INTENTS intents are cut, never refused. */
export const agentPlanSchema = z
  .object({
    reply: z.string(),
    reply_language: z.enum(LANGUAGES).catch('other'),
    object_language: z.enum(LANGUAGES).catch('other'),
    context: z.object({
      action: z.enum(CONTEXT_ACTIONS).catch('ok'),
      n: z.number().int().nullable(),
      since: z.string().nullable(),
    }),
    intents: z.array(intent),
    more_items: z.boolean(),
    unsupported: z.enum(UNSUPPORTED).catch('other'),
  })
  .transform((plan) =>
    plan.intents.length > MAX_PLAN_INTENTS
      ? {
          ...plan,
          intents: plan.intents.slice(0, MAX_PLAN_INTENTS),
          more_items: true,
        }
      : plan,
  );

/** Parses every asset fill answer. */
export const agentAssetFillSchema = z.object({
  assets: z.array(
    z.object({
      ref: z.string(),
      values: z.array(
        z.object({
          attr: z.string(),
          value: z.string().nullable(),
          person,
          unsure: z.boolean(),
        }),
      ),
    }),
  ),
});

export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type AgentIntent = AgentPlan['intents'][number];
export type AgentAssetFill = z.infer<typeof agentAssetFillSchema>;
