import {
  documentTemplateDefinitionSchema,
  MAX_LOOP_REGION_DEPTH,
  parseDocumentTemplateDefinition,
} from './template-definition.schema';

/** Builds a chain of `count` nested loop_region elements: items-1 -> level-2 -> level-3 -> ... */
function nestedRegionChain(count: number): AnyRecord[] {
  const chain: AnyRecord[] = [region({ id: 'items-1', dataSource: 'items' })];

  for (let i = 2; i <= count; i++) {
    chain.push(
      region({
        id: `level-${i}`,
        dataSource: 'subtasks',
        parentId: chain[chain.length - 1].id,
      }),
    );
  }

  return chain;
}

type AnyRecord = Record<string, unknown>;

const page = {
  size: 'A4',
  orientation: 'portrait',
  margins: { top: 48, right: 48, bottom: 48, left: 48 },
  pageBreakMargin: 24,
};

function element(overrides: AnyRecord = {}): AnyRecord {
  return {
    id: 'el-1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    positionMode: 'absolute',
    zIndex: 0,
    style: {},
    ...overrides,
  };
}

function region(overrides: AnyRecord = {}): AnyRecord {
  return element({
    id: 'region-1',
    type: 'loop_region',
    dataSource: 'subtasks',
    itemSpacing: 8,
    itemHeight: 40,
    height: 200,
    ...overrides,
  });
}

function repeatDef(elements: AnyRecord[]): AnyRecord {
  return {
    schemaVersion: 1,
    mode: 'repeat_per_item',
    sourceEntity: 'tasks',
    page,
    elements,
  };
}

function fixedDef(elements: AnyRecord[]): AnyRecord {
  return {
    schemaVersion: 1,
    mode: 'fixed_document',
    sourceEntity: 'tasks',
    page,
    elements,
  };
}

function expectInvalid(def: AnyRecord, messagePart: string): void {
  const result = documentTemplateDefinitionSchema.safeParse(def);
  expect(result.success).toBe(false);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => issue.message)
      .join(' | ');
    expect(messages).toContain(messagePart);
  }
}

describe('documentTemplateDefinitionSchema', () => {
  it('accepts a valid repeat_per_item definition', () => {
    const def = repeatDef([
      element({ id: 'text-1', type: 'text', html: '<p>{{summary}}</p>' }),
      element({
        id: 'field-1',
        type: 'field',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
      region({ id: 'region-1', dataSource: 'subtasks' }),
      element({
        id: 'child-1',
        type: 'field',
        parentId: 'region-1',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);

    const result = documentTemplateDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it('accepts a valid fixed_document definition with anchored meta fields', () => {
    const def = fixedDef([
      region({ id: 'items-1', dataSource: 'items' }),
      element({
        id: 'row-field',
        type: 'field',
        parentId: 'items-1',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
      region({
        id: 'nested-1',
        dataSource: 'subtasks',
        parentId: 'items-1',
      }),
      element({
        id: 'anchored-1',
        type: 'field',
        positionMode: 'anchored',
        binding: { source: 'meta', fieldKey: 'organizationName' },
      }),
      element({
        id: 'page-meta',
        type: 'field',
        binding: { source: 'meta', fieldKey: 'exportDate' },
      }),
    ]);

    const result = documentTemplateDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it('rejects duplicate element ids', () => {
    expectInvalid(
      repeatDef([element({ id: 'dup' }), element({ id: 'dup' })]),
      'Duplicate element id',
    );
  });

  it('rejects a missing parent reference', () => {
    expectInvalid(
      repeatDef([element({ id: 'child', parentId: 'ghost' })]),
      'missing parent',
    );
  });

  it('rejects a parent that is not a loop_region', () => {
    expectInvalid(
      repeatDef([
        element({ id: 'not-a-region' }),
        element({ id: 'child', parentId: 'not-a-region' }),
      ]),
      'is not a loop_region',
    );
  });

  it("rejects dataSource 'items' in repeat_per_item mode", () => {
    expectInvalid(
      repeatDef([region({ id: 'r1', dataSource: 'items' })]),
      "dataSource 'items' is not allowed in repeat_per_item mode",
    );
  });

  it('rejects nested loop regions in repeat_per_item mode', () => {
    expectInvalid(
      repeatDef([
        region({ id: 'outer', dataSource: 'subtasks' }),
        region({ id: 'inner', dataSource: 'linked_tasks', parentId: 'outer' }),
      ]),
      'nested loop regions are not allowed in repeat_per_item mode',
    );
  });

  it('rejects top-level non-items regions in fixed_document mode', () => {
    expectInvalid(
      fixedDef([region({ id: 'r1', dataSource: 'subtasks' })]),
      "top-level regions in fixed_document mode must use dataSource 'items'",
    );
  });

  it('accepts loop nesting deeper than 2 levels, up to MAX_LOOP_REGION_DEPTH', () => {
    const result = documentTemplateDefinitionSchema.safeParse(
      fixedDef(nestedRegionChain(MAX_LOOP_REGION_DEPTH)),
    );

    expect(result.success).toBe(true);
  });

  it(`rejects loop nesting deeper than ${MAX_LOOP_REGION_DEPTH} levels`, () => {
    expectInvalid(
      fixedDef(nestedRegionChain(MAX_LOOP_REGION_DEPTH + 1)),
      `deeper than ${MAX_LOOP_REGION_DEPTH} levels`,
    );
  });

  it('rejects anchored elements in repeat_per_item mode', () => {
    expectInvalid(
      repeatDef([element({ id: 'a1', positionMode: 'anchored' })]),
      'anchored position requires fixed_document mode',
    );
  });

  it('rejects page-level non-meta fields in fixed_document mode', () => {
    expectInvalid(
      fixedDef([
        region({ id: 'items-1', dataSource: 'items' }),
        element({
          id: 'field-1',
          type: 'field',
          binding: { source: 'system', fieldKey: 'summary' },
        }),
      ]),
      'must bind meta fields',
    );
  });

  it('rejects more than 500 elements', () => {
    const elements = Array.from({ length: 501 }, (_, index) =>
      element({ id: `el-${index}` }),
    );
    const result = documentTemplateDefinitionSchema.safeParse(
      repeatDef(elements),
    );
    expect(result.success).toBe(false);
  });
});

describe('parseDocumentTemplateDefinition', () => {
  it('parses a valid definition', () => {
    const def = repeatDef([element({ id: 'el-1' })]);
    const parsed = parseDocumentTemplateDefinition(def);
    expect(parsed.mode).toBe('repeat_per_item');
    expect(parsed.elements).toHaveLength(1);
  });

  it('throws on an oversized definition before schema validation', () => {
    const elements = Array.from({ length: 11 }, (_, index) =>
      element({
        id: `text-${index}`,
        type: 'text',
        html: 'a'.repeat(100000),
      }),
    );

    expect(() => parseDocumentTemplateDefinition(repeatDef(elements))).toThrow(
      /1 MiB/,
    );
  });

  it('throws a ZodError on an invalid definition', () => {
    expect(() =>
      parseDocumentTemplateDefinition({ schemaVersion: 2 }),
    ).toThrow();
  });
});
