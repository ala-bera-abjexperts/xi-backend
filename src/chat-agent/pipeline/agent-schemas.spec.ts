import { z } from 'zod';

import { toGeminiSchema } from '../../ai-automation/tenant-ai.service';
import {
  AGENT_ASSET_FILL_CALL,
  AGENT_ASSET_FILL_JSON_SCHEMA,
  AGENT_INTENT_KINDS,
  AGENT_PLAN_CALL,
  AGENT_PLAN_JSON_SCHEMA,
  agentAssetFillSchema,
  agentPlanSchema,
  MAX_PLAN_INTENTS,
} from './agent-schemas';

/** A JSON schema node, as far as these schemas use the vocabulary. */
interface Node {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Node>;
  required?: string[];
  additionalProperties?: unknown;
  items?: Node;
  anyOf?: Node[];
}

const SCHEMAS: [string, Node, z.ZodType][] = [
  ['plan', AGENT_PLAN_JSON_SCHEMA, agentPlanSchema],
  ['asset fill', AGENT_ASSET_FILL_JSON_SCHEMA, agentAssetFillSchema],
];

const SCALARS = ['string', 'number', 'integer', 'boolean'];

/** Every schema node with its path, the root included. */
function nodes(schema: Node, path = '$'): [string, Node][] {
  return [
    [path, schema],
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
      nodes(child, `${path}.${key}`),
    ),
    ...(schema.items ? nodes(schema.items, `${path}[]`) : []),
  ];
}

/** Why a node breaks the flat shape; empty when it is fine. */
function flatShapeProblems(path: string, node: Node): string[] {
  const problems: string[] = [];
  const { type } = node;
  const base = Array.isArray(type) ? type[0] : type;

  for (const banned of ['anyOf', 'oneOf', 'allOf', '$ref', '$defs', 'nullable'])
    if (banned in node) problems.push(`${path}: uses ${banned}`);

  if (Array.isArray(type) && (type.length !== 2 || type[1] !== 'null'))
    problems.push(`${path}: a nullable type must be [T, "null"]`);

  if (base === 'object') {
    const keys = Object.keys(node.properties ?? {});

    if (Array.isArray(type)) problems.push(`${path}: nullable object`);
    if (node.additionalProperties !== false)
      problems.push(`${path}: additionalProperties is not false`);
    if (keys.length === 0) problems.push(`${path}: no properties`);
    if (JSON.stringify(node.required) !== JSON.stringify(keys))
      problems.push(`${path}: required does not list every key`);
  } else if (base === 'array') {
    if (!node.items) problems.push(`${path}: array without items`);
  } else if (!SCALARS.includes(String(base))) {
    problems.push(`${path}: unknown type ${JSON.stringify(type)}`);
  }

  if (
    node.enum &&
    (type !== 'string' || node.enum.some((value) => typeof value !== 'string'))
  )
    problems.push(`${path}: enum must be a non-nullable list of strings`);

  return problems;
}

/** What both schema kinds must agree on: keys, types, nullability, enum values, nesting. */
function shape(node: Node): unknown {
  const variants = node.anyOf ?? [node];
  const main = variants.find((variant) => variant.type !== 'null') ?? {};

  return {
    types: variants.flatMap((variant) => variant.type ?? []).sort(),
    ...(main.enum ? { enum: main.enum } : {}),
    ...(main.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(main.properties).map(([key, child]) => [
              key,
              shape(child),
            ]),
          ),
        }
      : {}),
    ...(main.items ? { items: shape(main.items) } : {}),
  };
}

const person = { said: null, participant: null, is_requester: false };
const date = { said: null, iso: null };

const intentAnswer = (ref: string) => ({
  ref,
  kind: 'task',
  title: 'Rechnung prüfen',
  description: null,
  sources: ['m7'],
  space: null,
  type: 'Bug',
  status: null,
  priority: { said: 'dringend', level: 'high' },
  assignee: { said: 'Anna', participant: 'P2', is_requester: false },
  due: { said: 'bis Freitag', iso: '2026-10-16' },
  labels: [],
  parent: { item: null, key: null, said: null },
  asset_type: [],
  facts: [],
  owner: person,
  parent_page: null,
  page_type: null,
  publish: false,
  general_knowledge: false,
  revises: false,
  body: [
    {
      type: 'bullets',
      level: null,
      text: null,
      title: null,
      items: ['a', 'b'],
      rows: [],
      variant: null,
      language: null,
      refs: [],
      labels: [],
    },
  ],
  plan: null,
  milestone: false,
  start: date,
  end: date,
});

const planAnswer = (intents: unknown[] = [intentAnswer('i1')]) => ({
  reply: 'Ich lege eine Aufgabe an.',
  reply_language: 'de',
  object_language: 'de',
  context: { action: 'ok', n: null, since: null },
  intents,
  more_items: false,
  unsupported: 'none',
});

describe('Robert provider schemas', () => {
  describe.each(SCHEMAS)('%s', (_name, jsonSchema, zodSchema) => {
    it('is flat: every key required, no extra keys, [T, "null"] only, no unions or references', () => {
      const all = nodes(jsonSchema);

      expect(all.length).toBeGreaterThan(5);
      expect(
        all.flatMap(([path, node]) => flatShapeProblems(path, node)),
      ).toEqual([]);
      expect(JSON.stringify(jsonSchema)).not.toMatch(/anyOf|oneOf|\$ref/);
    });

    it('agrees key by key with its zod schema', () => {
      const parsed = z.toJSONSchema(zodSchema, { io: 'input' }) as Node;
      // The parse falls back to "other" for an invented kind; the model is never offered it.
      const kind = parsed.properties?.intents?.items?.properties?.kind;
      if (kind?.enum) kind.enum = kind.enum.filter((v) => v !== 'other');
      // The worker sets a dependency's ordinal; the model never sees it (1.22.1).
      const dep = parsed.properties?.intents?.items?.properties?.depends?.items;
      if (dep?.properties) delete dep.properties.ordinal;
      if (dep?.required) dep.required = dep.required.filter((k) => k !== 'ordinal');
      expect(shape(parsed)).toEqual(shape(jsonSchema));
    });

    it('converts to a Gemini schema without an unknown or undefined type', () => {
      const converted = nodes(
        toGeminiSchema(jsonSchema as Record<string, unknown>),
      );

      expect(converted).toHaveLength(nodes(jsonSchema).length);

      for (const [path, node] of converted) {
        expect([path, node.type]).toEqual([
          path,
          expect.stringMatching(
            /^(STRING|NUMBER|INTEGER|BOOLEAN|ARRAY|OBJECT)$/,
          ),
        ]);
        if (node.type === 'ARRAY') expect(node.items).toBeDefined();
        if (node.type === 'OBJECT')
          expect(node.required).toEqual(Object.keys(node.properties ?? {}));
      }
    });

    it('never asks the model for an id', () => {
      const keys = nodes(jsonSchema).flatMap(([, node]) =>
        Object.keys(node.properties ?? {}),
      );

      expect(keys.filter((key) => /(^|_)(id|ids|uuid)$/i.test(key))).toEqual(
        [],
      );
    });
  });

  it('names the intent fields as the contract does', () => {
    const intent =
      (AGENT_PLAN_JSON_SCHEMA as Node).properties?.intents.items?.properties ??
      {};

    expect(intent.kind.enum).toEqual([
      'task',
      'subtask',
      'asset_object',
      'wiki_page',
      'plan_item',
      'plan',
      'plan_link',
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
    ]);
    expect(AGENT_INTENT_KINDS).toEqual(intent.kind.enum);
    expect(Object.keys(intent)).toEqual(
      expect.arrayContaining([
        ...['title', 'description', 'space', 'type', 'status', 'priority'],
        ...['assignee', 'due', 'labels', 'parent', 'asset_type', 'owner'],
        ...['parent_page', 'body', 'plan', 'task', 'depends', 'milestone', 'start', 'end'],
        ...['plan_type', 'item_type', 'plan_ref', 'estimated_hours', 'estimated_cost', 'progress'],
      ]),
    );
    expect(Object.keys(intent.body.items?.properties ?? {})).toEqual([
      'type',
      'level',
      'text',
      'title',
      'items',
      'rows',
      'variant',
      'language',
      'refs',
      'labels',
    ]);
  });

  it('parses a full plan answer and drops keys the schema does not know', () => {
    const parsed = agentPlanSchema.parse({
      ...planAnswer(),
      entity_id: '0b3e7000-0000-4000-8000-000000000001',
    });

    expect(parsed).toEqual(planAnswer());
  });

  it('refuses an answer that leaves a key out', () => {
    const withoutReply: Record<string, unknown> = planAnswer();

    delete withoutReply.reply;

    expect(agentPlanSchema.safeParse(withoutReply).success).toBe(false);
  });

  it('one invented enum value does not lose the whole answer (audit 2026-11-10)', () => {
    const odd = { ...intentAnswer('i2'), kind: 'risk', priority: { said: 'asap', level: 'urgent' } };
    const page = {
      ...intentAnswer('i3'),
      body: [{ ...(intentAnswer('i3').body as object[])[0], type: 'mermaid' }],
    };
    const parsed = agentPlanSchema.parse({
      ...planAnswer([intentAnswer('i1'), odd, page]),
      unsupported: 'archive',
    });
    // The good one is kept as it was; the invented kind is counted as one Robert can't create.
    expect(parsed.intents[0]).toEqual(planAnswer().intents[0]);
    expect(parsed.intents[1]).toMatchObject({ kind: 'other', priority: { level: 'none' } });
    expect(parsed.unsupported).toBe('other');
  });

  it(`keeps at most ${MAX_PLAN_INTENTS} intents and says that there were more`, () => {
    const sixty = Array.from({ length: 60 }, (_, i) =>
      intentAnswer(`i${i + 1}`),
    );
    const parsed = agentPlanSchema.parse(planAnswer(sixty));

    expect(MAX_PLAN_INTENTS).toBe(50);
    expect(parsed.intents.map((intent) => intent.ref)).toEqual(
      sixty.slice(0, 50).map((intent) => intent.ref),
    );
    expect(parsed.more_items).toBe(true);
    expect(
      agentPlanSchema.parse(planAnswer(sixty.slice(0, 50))).more_items,
    ).toBe(false);
  });

  it('parses an asset fill answer', () => {
    const answer = {
      assets: [
        {
          ref: 'i3',
          values: [
            { attr: 'A1', value: 'SN-123', person, unsure: false },
            {
              attr: 'A4',
              value: null,
              person: { said: 'ich', participant: null, is_requester: true },
              unsure: true,
            },
          ],
        },
      ],
    };

    expect(agentAssetFillSchema.parse(answer)).toEqual(answer);
  });

  it('gives each call a provider-safe schema name', () => {
    for (const call of [AGENT_PLAN_CALL, AGENT_ASSET_FILL_CALL]) {
      expect(call.schemaName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(call.schemaDescription).not.toBe('');
    }

    expect(AGENT_PLAN_CALL.schema).toBe(AGENT_PLAN_JSON_SCHEMA);
    expect(AGENT_ASSET_FILL_CALL.schema).toBe(AGENT_ASSET_FILL_JSON_SCHEMA);
  });
});
