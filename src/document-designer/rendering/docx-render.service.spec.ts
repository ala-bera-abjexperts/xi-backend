// jsdom's ESM dependency chain is not transformable under jest — mock the
// sanitizer with a faithful double (repo precedent: sanitize-rich-text mocks).
jest.mock('./html-sanitizer', () => ({
  sanitizeHtml: (html: string) => html,
  stripHtmlToText: (html: string) => html.replace(/<[^>]*>/g, '').trim(),
}));

// Wrap docx's Table and Paragraph so specs can inspect what the renderer
// emits (rows, frame positions, page breaks, spacers) without unzipping the
// produced .docx; every other docx export stays real.
jest.mock('docx', () => {
  const actual = jest.requireActual<typeof import('docx')>('docx');

  return {
    ...actual,
    Table: jest.fn(
      (options: ConstructorParameters<typeof actual.Table>[0]) =>
        new actual.Table(options),
    ),
    Paragraph: jest.fn(
      (options: ConstructorParameters<typeof actual.Paragraph>[0]) =>
        new actual.Paragraph(options),
    ),
  };
});

import { PageBreak, Paragraph, Table } from 'docx';
import {
  DocxRenderService,
  htmlToTextLines,
  pxToHalfPoints,
  pxToTwip,
} from './docx-render.service';
import type {
  IDocumentContextItem,
  IDocumentDataContext,
} from './document-data-resolver.service';
import type { IDocumentTemplateDefinition } from '../template-definition/template-definition.types';

type AnyRecord = Record<string, unknown>;

const TableMock = Table as unknown as jest.Mock;
const ParagraphMock = Paragraph as unknown as jest.Mock;

interface ParagraphOptions {
  children?: unknown[];
  frame?: { position?: { x: number; y: number } };
  spacing?: { line?: number; lineRule?: string };
}

function paragraphOptions(): ParagraphOptions[] {
  return (ParagraphMock.mock.calls as Array<[ParagraphOptions]>).map(
    (call) => call[0] ?? {},
  );
}

const page = {
  size: 'A4' as const,
  orientation: 'portrait' as const,
  margins: { top: 48, right: 48, bottom: 48, left: 48 },
  pageBreakMargin: 24,
};

function element(overrides: AnyRecord): AnyRecord {
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

function definition(
  mode: 'repeat_per_item' | 'fixed_document',
  elements: AnyRecord[],
): IDocumentTemplateDefinition {
  return {
    schemaVersion: 1,
    mode,
    sourceEntity: 'tasks',
    page,
    elements,
  } as unknown as IDocumentTemplateDefinition;
}

function taskItem(id: string, raw: AnyRecord): IDocumentContextItem {
  return { id, entityType: 'task', raw: { id, ...raw } };
}

function dataCtx(items: IDocumentContextItem[]): IDocumentDataContext {
  return {
    items,
    subtasksByItemId: {},
    linkedByItemId: {},
    dynamicQueryByRegionId: {},
    lookups: {
      usersById: {},
      statusesById: {},
      prioritiesById: {},
      spacesById: {},
      assetsById: {},
      tasksById: {},
      wikiPagesById: {},
      organizationName: 'Acme GmbH',
    },
    fieldDefsBySpace: {},
    orgFieldDefs: {},
    warnings: [],
  };
}

describe('DocxRenderService', () => {
  const service = new DocxRenderService();

  beforeEach(() => {
    TableMock.mockClear();
    ParagraphMock.mockClear();
  });

  it('produces a non-empty .docx buffer', async () => {
    const def = definition('repeat_per_item', [
      element({ id: 'text-1', type: 'text', html: '<p>Hello {{summary}}</p>' }),
      element({
        id: 'field-1',
        type: 'field',
        y: 60,
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { summary: 'World' })]);

    const { buffer, warnings } = await service.renderDocx(def, ctx);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // .docx files are ZIP containers — PK signature.
    expect(buffer.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(warnings).toEqual([]);
  });

  it('warns for ellipse (rendered as rectangle) and rotation', async () => {
    const def = definition('repeat_per_item', [
      element({ id: 'ellipse-1', type: 'ellipse' }),
      element({ id: 'rect-1', type: 'rectangle', y: 60, rotation: 45 }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);

    const { warnings } = await service.renderDocx(def, ctx);

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ellipse rendered as rectangle in Word'),
        expect.stringContaining('rotation is not supported in Word'),
      ]),
    );
  });

  it('converts px to twips at exactly ×15 (A4 width 794px → 11910)', () => {
    expect(pxToTwip(794)).toBe(11910);
    expect(pxToTwip(1123)).toBe(16845);
    expect(pxToTwip(48)).toBe(720);
  });

  it('converts px font sizes to half-points (16px → 12pt → 24)', () => {
    expect(pxToHalfPoints(16)).toBe(24);
    expect(pxToHalfPoints(12)).toBe(18);
  });

  it('emits one table row per loop item (subtasks region)', async () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'region-1',
        type: 'loop_region',
        y: 0,
        height: 120,
        dataSource: 'subtasks',
        itemHeight: 40,
        itemSpacing: 8,
      }),
      element({
        id: 'child-field',
        type: 'field',
        parentId: 'region-1',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);
    ctx.subtasksByItemId['task-1'] = [
      { id: 'sub-1', summary: 'Subtask one' },
      { id: 'sub-2', summary: 'Subtask two' },
      { id: 'sub-3', summary: 'Subtask three' },
    ];

    await service.renderDocx(def, ctx);

    expect(TableMock).toHaveBeenCalledTimes(1);
    const tableCalls = TableMock.mock.calls as Array<[{ rows: unknown[] }]>;
    expect(tableCalls[0][0].rows).toHaveLength(3);
  });

  it('renders the empty state without touching item elements', async () => {
    const def = definition('repeat_per_item', [
      element({ id: 'text-1', type: 'text', html: '<p>never</p>' }),
    ]);

    const { buffer } = await service.renderDocx(def, dataCtx([]));

    expect(buffer.length).toBeGreaterThan(0);
    expect(TableMock).not.toHaveBeenCalled();
  });

  it('skips url/storage images with a warning (no network fetch in Word)', async () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'img-1',
        type: 'image',
        src: { kind: 'url', url: 'https://example.com/x.png' },
        objectFit: 'contain',
      }),
      element({
        id: 'img-2',
        type: 'image',
        y: 60,
        src: { kind: 'storage', bucket: 'b', path: 'p.png' },
        objectFit: 'contain',
      }),
    ]);

    const { warnings } = await service.renderDocx(
      def,
      dataCtx([taskItem('task-1', {})]),
    );

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('img-1'),
        expect.stringContaining('img-2'),
      ]),
    );
  });

  it('gives an actionable warning for an AVIF data-URI image (docx has no AVIF support)', async () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'img-avif',
        type: 'image',
        src: { kind: 'data', dataUri: 'data:image/avif;base64,AAAA' },
        objectFit: 'contain',
      }),
    ]);

    const { warnings } = await service.renderDocx(
      def,
      dataCtx([taskItem('task-1', {})]),
    );

    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('WEBP/SVG/AVIF')]),
    );
  });

  it('flattens block HTML to text lines and keeps entities decoded', () => {
    expect(
      htmlToTextLines(
        '<p>First</p><p>Second &amp; third</p><ul><li>Item</li></ul>',
      ),
    ).toEqual(['First', 'Second & third', '• Item']);
    expect(htmlToTextLines('')).toEqual(['']);
  });

  it('positions page rows at PAGE-ORIGIN coordinates via table indent — margins never shift output', async () => {
    // Element flush with the 48px margin guide on the canvas. A solo
    // top-level rectangle becomes a 1-row, 1-cell table (see buildPageRow),
    // not a frame — frame positioning is what broke in non-Word viewers.
    const def = definition('repeat_per_item', [
      element({ id: 'rect-1', x: 48, y: 48 }),
    ]);

    await service.renderDocx(def, dataCtx([taskItem('task-1', {})]));

    // 48px × 15 = 720 twips from the page corner (no margin added on top).
    expect(TableMock).toHaveBeenCalledTimes(1);
    const tableOptions = (
      TableMock.mock.calls as Array<
        [{ indent?: { size: number; type: string } }]
      >
    )[0][0];
    expect(tableOptions.indent).toEqual({ size: pxToTwip(48), type: 'dxa' });
  });

  it('always page-breaks between repeat_per_item items and inserts a pageBreakMargin spacer before items 2..n', async () => {
    const def = definition('repeat_per_item', [
      element({ id: 'rect-1', x: 0, y: 100, height: 40 }),
    ]);
    const ctx = dataCtx([
      taskItem('task-1', { summary: 'One' }),
      taskItem('task-2', { summary: 'Two' }),
    ]);

    const { warnings } = await service.renderDocx(def, ctx);

    // No shared-page fallback anymore — pagination matches HTML/PDF.
    expect(warnings).toEqual([]);
    const breaks = paragraphOptions().filter((opts) =>
      (opts.children ?? []).some((child) => child instanceof PageBreak),
    );
    expect(breaks).toHaveLength(1);

    // One table per item (no shared rows/positions between them); exact-height
    // spacers keep the designed y: 100px before item 1's row, then the 24px
    // pageBreakMargin + 100px before item 2's.
    expect(TableMock).toHaveBeenCalledTimes(2);
    const spacers = paragraphOptions().filter(
      (opts) => opts.spacing?.lineRule === 'exact',
    );
    expect(spacers.map((opts) => opts.spacing!.line)).toEqual([
      pxToTwip(100),
      pxToTwip(24),
      pxToTwip(100),
    ]);
  });

  it('indents the fixed_document items region table by the region x and lands it at its designed y', async () => {
    const def = definition('fixed_document', [
      element({
        id: 'items-1',
        type: 'loop_region',
        dataSource: 'items',
        x: 250,
        y: 100,
        width: 300,
        height: 200,
        itemHeight: 40,
        itemSpacing: 8,
      }),
      element({
        id: 'row-field',
        type: 'field',
        parentId: 'items-1',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { summary: 'Item One' })]);

    await service.renderDocx(def, ctx);

    // Table indented by region.x (250px → 3750 twips) at region.width.
    expect(TableMock).toHaveBeenCalledTimes(1);
    const tableOptions = (
      TableMock.mock.calls as Array<
        [{ indent?: { size: number; type: string } }]
      >
    )[0][0];
    expect(tableOptions.indent).toEqual({ size: pxToTwip(250), type: 'dxa' });

    // The gap band above the region (0..100px) becomes an exact-height spacer
    // so the table starts at the designed y — the flow twin of the HTML bands.
    const spacers = paragraphOptions().filter(
      (opts) => opts.spacing?.lineRule === 'exact',
    );
    expect(spacers.length).toBeGreaterThanOrEqual(1);
    expect(
      spacers.reduce((sum, opts) => sum + (opts.spacing?.line ?? 0), 0),
    ).toBe(pxToTwip(100));
  });

  it('renders fixed_document statics as page-row tables at their raw page coordinates', async () => {
    const def = definition('fixed_document', [
      element({ id: 'header', type: 'text', x: 48, y: 48, html: '<p>H</p>' }),
      element({
        id: 'items-1',
        type: 'loop_region',
        dataSource: 'items',
        y: 200,
        height: 100,
        itemHeight: 40,
        itemSpacing: 8,
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);

    await service.renderDocx(def, ctx);

    // The static "header" text becomes its own 1-row table, indented by its
    // raw page-origin x (48px → 720 twips) — previously a frame position.
    const tableCalls = TableMock.mock.calls as Array<
      [{ indent?: { size: number; type: string } }]
    >;
    const staticTable = tableCalls.find((c) => c[0].indent?.size === 720);
    expect(staticTable).toBeDefined();
  });

  it('recurses into nested loop regions beyond the old depth-2 cap', async () => {
    const def = definition('fixed_document', [
      element({
        id: 'items-1',
        type: 'loop_region',
        dataSource: 'items',
        y: 0,
        height: 300,
        itemHeight: 20,
        itemSpacing: 0,
      }),
      element({
        id: 'level-2',
        type: 'loop_region',
        dataSource: 'subtasks',
        parentId: 'items-1',
        y: 20,
        height: 100,
        itemHeight: 20,
        itemSpacing: 0,
      }),
      element({
        id: 'level-3',
        type: 'loop_region',
        dataSource: 'subtasks',
        parentId: 'level-2',
        y: 20,
        height: 100,
        itemHeight: 20,
        itemSpacing: 0,
      }),
      element({
        id: 'level-3-field',
        type: 'field',
        parentId: 'level-3',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);
    const ctx = dataCtx([taskItem('epic-1', { summary: 'Epic' })]);
    ctx.subtasksByItemId['epic-1'] = [
      { id: 'story-1', parent_task_id: 'epic-1', summary: 'Story' },
    ];
    ctx.subtasksByItemId['story-1'] = [
      { id: 'task-1', parent_task_id: 'story-1', summary: 'Grandchild task' },
    ];

    const { warnings } = await service.renderDocx(def, ctx);

    // Old behavior warned and skipped past depth 2; the new recursive
    // regionChildrenBlocks/regionToTable emits a real nested Table for
    // BOTH the level-2 and level-3 regions instead.
    expect(warnings.some((w) => w.includes('nested below a subtasks'))).toBe(
      false,
    );
    expect(TableMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
