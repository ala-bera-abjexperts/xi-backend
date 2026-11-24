// jsdom's ESM dependency chain is not transformable under jest — mock the
// sanitizer with a faithful double (repo precedent: sanitize-rich-text mocks).
jest.mock('./html-sanitizer', () => ({
  sanitizeHtml: (html: string) =>
    html
      .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(script|style|iframe|object|embed|form)\b[^>]*\/?>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''),
  stripHtmlToText: (html: string) => html.replace(/<[^>]*>/g, '').trim(),
}));

import { DocumentRenderService } from './document-render.service';
import type {
  IDocumentContextItem,
  IDocumentDataContext,
} from './document-data-resolver.service';
import type { IDocumentTemplateDefinition } from '../template-definition/template-definition.types';

type AnyRecord = Record<string, unknown>;

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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('DocumentRenderService', () => {
  const service = new DocumentRenderService();

  it('emits one full-page section per item with a forced break before items 2..n', () => {
    const def = definition('repeat_per_item', [
      element({ id: 'text-1', type: 'text', html: '<p>Block</p>' }),
    ]);
    const ctx = dataCtx([
      taskItem('task-1', { summary: 'One' }),
      taskItem('task-2', { summary: 'Two' }),
    ]);

    const { html } = service.render(def, ctx);

    expect(countOccurrences(html, '<section')).toBe(2);
    // Exactly one forced break — before the second item only.
    expect(countOccurrences(html, 'break-before:page;')).toBe(1);
    // Sections are FULL-PAGE (A4 portrait 794×1123) in the page-origin model.
    expect(countOccurrences(html, 'width:794px; min-height:1123px;')).toBe(2);
  });

  it('pushes items 2..n down by pageBreakMargin (the designed gap after each break)', () => {
    const def = definition('repeat_per_item', [
      element({ id: 'rect-1', y: 100 }),
    ]);
    const ctx = dataCtx([
      taskItem('task-1', { summary: 'One' }),
      taskItem('task-2', { summary: 'Two' }),
    ]);

    const { html } = service.render(def, ctx);

    // Item 1 at the stored y; item 2 shifted by pageBreakMargin (24px).
    expect(countOccurrences(html, 'top:100px;')).toBe(1);
    expect(countOccurrences(html, 'top:124px;')).toBe(1);
  });

  it('places elements at PAGE-ORIGIN coordinates — margins never shift output', () => {
    // Element flush with the 48px margin guide on the canvas.
    const def = definition('repeat_per_item', [
      element({ id: 'rect-1', x: 48, y: 48 }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);

    const { html } = service.render(def, ctx);

    // Rendered at the exact canvas position, measured from the page corner…
    expect(html).toContain('left:48px; top:48px;');
    // …with @page margin 0 and an unpadded .doc-root (no content-area shift).
    expect(html).toContain('@page { size: 794px 1123px; margin: 0; }');
    expect(html).not.toContain('padding: 48px');
  });

  it('hides elements whose condition does not match the item', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'text-1',
        type: 'text',
        html: '<p>ONLY-OPEN</p>',
        condition: {
          combinator: 'and',
          rules: [{ field: 'status', operator: 'eq', value: 'open' }],
        },
      }),
    ]);
    const ctx = dataCtx([
      taskItem('task-1', { status: 'open' }),
      taskItem('task-2', { status: 'closed' }),
    ]);

    const { html } = service.render(def, ctx);
    expect(countOccurrences(html, 'ONLY-OPEN')).toBe(1);
  });

  it('interpolates tokens and escapes their values', () => {
    const def = definition('repeat_per_item', [
      element({ id: 'text-1', type: 'text', html: '<p>{{summary}}</p>' }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { summary: '<b>evil</b>' })]);

    const { html } = service.render(def, ctx);
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(html).not.toContain('<b>evil</b>');
  });

  it('strips script tags from text element HTML', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'text-1',
        type: 'text',
        html: '<p>safe</p><script>alert(1)</script>',
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);

    const { html } = service.render(def, ctx);
    expect(html).toContain('<p>safe</p>');
    expect(html).not.toContain('<script>');
  });

  it('emits a rotation transform', () => {
    const def = definition('repeat_per_item', [
      element({ id: 'rect-1', rotation: 45 }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);

    const { html } = service.render(def, ctx);
    expect(html).toContain('rotate(45deg)');
  });

  it('renders the empty state when no items matched', () => {
    const def = definition('repeat_per_item', [
      element({ id: 'text-1', type: 'text', html: '<p>Block</p>' }),
    ]);

    const { html } = service.render(def, dataCtx([]));
    expect(html).toContain('No items matched this export.');
  });

  it('renders fields through the formatter', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'field-1',
        type: 'field',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { summary: 'Quarterly audit' })]);

    const { html } = service.render(def, ctx);
    expect(html).toContain('Quarterly audit');
  });

  it('keeps fixed_document band order while the items region grows', () => {
    const def = definition('fixed_document', [
      element({ id: 'header', type: 'text', y: 10, html: '<p>DOC-HEADER</p>' }),
      element({
        id: 'items-1',
        type: 'loop_region',
        dataSource: 'items',
        y: 100,
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
      element({
        id: 'footer',
        type: 'text',
        y: 400,
        html: '<p>DOC-FOOTER</p>',
      }),
    ]);
    const ctx = dataCtx([
      taskItem('task-1', { summary: 'Item One' }),
      taskItem('task-2', { summary: 'Item Two' }),
    ]);

    const { html } = service.render(def, ctx);

    const headerIndex = html.indexOf('DOC-HEADER');
    const firstItemIndex = html.indexOf('Item One');
    const secondItemIndex = html.indexOf('Item Two');
    const footerIndex = html.indexOf('DOC-FOOTER');

    expect(headerIndex).toBeGreaterThan(-1);
    expect(firstItemIndex).toBeGreaterThan(headerIndex);
    expect(secondItemIndex).toBeGreaterThan(firstItemIndex);
    expect(footerIndex).toBeGreaterThan(secondItemIndex);
    expect(countOccurrences(html, 'doc-region-item')).toBeGreaterThanOrEqual(2);
  });

  it('emits anchored elements once with position:fixed', () => {
    const def = definition('fixed_document', [
      element({
        id: 'anchored-1',
        type: 'text',
        positionMode: 'anchored',
        html: '<p>PAGE-HEADER</p>',
      }),
      element({
        id: 'items-1',
        type: 'loop_region',
        dataSource: 'items',
        y: 100,
        height: 200,
        itemHeight: 40,
        itemSpacing: 8,
      }),
    ]);
    const ctx = dataCtx([
      taskItem('task-1', { summary: 'One' }),
      taskItem('task-2', { summary: 'Two' }),
    ]);

    const { html } = service.render(def, ctx);
    expect(html).toContain('position:fixed;');
    expect(countOccurrences(html, 'PAGE-HEADER')).toBe(1);
  });

  it('renders subtasks regions per item in repeat mode', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'region-1',
        type: 'loop_region',
        dataSource: 'subtasks',
        y: 20,
        height: 60,
        itemHeight: 30,
        itemSpacing: 4,
      }),
      element({
        id: 'sub-field',
        type: 'field',
        parentId: 'region-1',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { summary: 'Parent' })]);
    ctx.subtasksByItemId['task-1'] = [
      { id: 'sub-1', summary: 'Subtask Alpha' },
      { id: 'sub-2', summary: 'Subtask Beta' },
    ];

    const { html } = service.render(def, ctx);
    expect(html).toContain('Subtask Alpha');
    expect(html).toContain('Subtask Beta');
  });

  it('drops non-http(s) link targets and warns', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'link-1',
        type: 'link',
        text: 'Click',

        href: 'javascript:alert(1)',
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);

    const { html, warnings } = service.render(def, ctx);
    expect(html).not.toContain('javascript:alert');
    expect(warnings.some((w) => w.includes('non-http(s)'))).toBe(true);
  });

  it('preserves the items region x offset and width in fixed_document mode', () => {
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

    const { html } = service.render(def, ctx);

    // Item bands sit in a wrapper carrying the region's designed geometry.
    expect(html).toContain('margin-left:250px; width:300px;');
  });

  it('evaluates statics/anchored conditions against the meta-only context in fixed_document', () => {
    const def = definition('fixed_document', [
      element({
        id: 'few-items-banner',
        type: 'text',
        y: 10,
        html: '<p>FEW-ITEMS</p>',
        condition: {
          combinator: 'and',
          rules: [{ field: 'itemCount', operator: 'lte', value: 5 }],
        },
      }),
      element({
        id: 'many-items-banner',
        type: 'text',
        y: 60,
        html: '<p>MANY-ITEMS</p>',
        condition: {
          combinator: 'and',
          rules: [{ field: 'itemCount', operator: 'gt', value: 5 }],
        },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {}), taskItem('task-2', {})]);

    const { html, warnings } = service.render(def, ctx);

    // Meta rules are meaningful: 2 items → lte 5 shows, gt 5 hides.
    expect(html).toContain('FEW-ITEMS');
    expect(html).not.toContain('MANY-ITEMS');
    expect(warnings).toEqual([]);
  });

  it('warns when a fixed_document static condition references item fields (non-matching)', () => {
    const def = definition('fixed_document', [
      element({
        id: 'status-banner',
        type: 'text',
        y: 10,
        html: '<p>DONE-BANNER</p>',
        condition: {
          combinator: 'and',
          rules: [{ field: 'status', operator: 'eq', value: 'done' }],
        },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { status: 'done' })]);

    const { html, warnings } = service.render(def, ctx);

    // Item-field rules never match without an item context (documented).
    expect(html).not.toContain('DONE-BANNER');
    expect(
      warnings.some(
        (w) => w.includes('status') && w.includes('no item context'),
      ),
    ).toBe(true);
  });

  it('honors the items region condition in fixed_document, keeping the designed gap', () => {
    const def = definition('fixed_document', [
      element({
        id: 'items-1',
        type: 'loop_region',
        dataSource: 'items',
        y: 100,
        height: 200,
        itemHeight: 40,
        itemSpacing: 8,
        condition: {
          combinator: 'and',
          rules: [{ field: 'itemCount', operator: 'gt', value: 5 }],
        },
      }),
      element({
        id: 'row-field',
        type: 'field',
        parentId: 'items-1',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
      element({ id: 'footer', type: 'text', y: 400, html: '<p>FOOTER</p>' }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { summary: 'HIDDEN-ITEM' })]);

    const { html } = service.render(def, ctx);

    // 1 item, condition needs > 5 → region hidden, but its designed height is
    // kept as a gap band so the footer stays at its canvas position.
    expect(html).not.toContain('HIDDEN-ITEM');
    expect(html).toContain('height:200px;');
    expect(html).toContain('FOOTER');
  });

  it('resolves loop-region filter and sortBy on BARE custom field keys', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'region-1',
        type: 'loop_region',
        dataSource: 'subtasks',
        y: 20,
        height: 60,
        itemHeight: 30,
        itemSpacing: 4,
        filter: {
          combinator: 'and',
          rules: [{ field: 'severity', operator: 'neq', value: 'low' }],
        },
        sortBy: 'severity',
        sortDir: 'asc',
      }),
      element({
        id: 'sub-field',
        type: 'field',
        parentId: 'region-1',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { summary: 'Parent' })]);
    ctx.subtasksByItemId['task-1'] = [
      {
        id: 'sub-1',
        summary: 'Sub Medium',
        custom_field_values: { severity: 'medium' },
      },
      {
        id: 'sub-2',
        summary: 'Sub Low',
        custom_field_values: { severity: 'low' },
      },
      {
        id: 'sub-3',
        summary: 'Sub High',
        custom_field_values: { severity: 'high' },
      },
    ];

    const { html } = service.render(def, ctx);

    // Filter drops the 'low' row; sortBy orders high < medium (asc, text).
    expect(html).not.toContain('Sub Low');
    expect(html.indexOf('Sub High')).toBeGreaterThan(-1);
    expect(html.indexOf('Sub High')).toBeLessThan(html.indexOf('Sub Medium'));
  });

  it('sorts loop regions by cf_-prefixed custom field keys too', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'region-1',
        type: 'loop_region',
        dataSource: 'subtasks',
        y: 20,
        height: 60,
        itemHeight: 30,
        itemSpacing: 4,
        sortBy: 'cf_rank',
        sortDir: 'desc',
      }),
      element({
        id: 'sub-field',
        type: 'field',
        parentId: 'region-1',
        binding: { source: 'system', fieldKey: 'summary' },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', { summary: 'Parent' })]);
    ctx.subtasksByItemId['task-1'] = [
      { id: 'sub-1', summary: 'Rank One', custom_field_values: { rank: 1 } },
      { id: 'sub-2', summary: 'Rank Nine', custom_field_values: { rank: 9 } },
    ];

    const { html } = service.render(def, ctx);

    expect(html.indexOf('Rank Nine')).toBeLessThan(html.indexOf('Rank One'));
  });

  it('neutralizes CSS injection in style values (escapeHtml is not CSS-safe)', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'text-1',
        type: 'text',
        html: '<p>styled</p>',
        style: {
          fontFamily: 'x;background:url(https://attacker.example/beacon?t=1)',
          color: 'red;background:url(https://attacker.example/c)',
          backgroundColor: 'url(https://attacker.example/b)',
        },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);

    const { html } = service.render(def, ctx);

    expect(html).not.toContain('attacker.example');
    expect(html).not.toContain('url(');
    // The rejected color falls back to the default; the injected font-family
    // declaration is dropped entirely.
    expect(html).not.toContain('font-family:x');
  });

  it('keeps legitimate style values through the CSS sanitizers', () => {
    const def = definition('repeat_per_item', [
      element({
        id: 'text-1',
        type: 'text',
        html: '<p>styled</p>',
        style: {
          fontFamily: 'Times New Roman',
          color: 'rgba(10, 20, 30, 0.5)',
          backgroundColor: '#ff0000',
        },
      }),
    ]);
    const ctx = dataCtx([taskItem('task-1', {})]);

    const { html } = service.render(def, ctx);

    expect(html).toContain('font-family:Times New Roman;');
    expect(html).toContain('color:rgba(10, 20, 30, 0.5);');
    expect(html).toContain('background-color:#ff0000;');
  });

  describe('authored pages (fixed_document)', () => {
    function authoredDefinition(
      elements: AnyRecord[],
      opts: { pageCount: number; showPageNumbers?: boolean },
    ): IDocumentTemplateDefinition {
      return {
        ...definition('fixed_document', elements),
        showPageNumbers: opts.showPageNumbers,
        pages: Array.from({ length: opts.pageCount }, (_, i) => ({
          id: `page-${i + 1}`,
        })),
      } as unknown as IDocumentTemplateDefinition;
    }

    it('stamps "Page k of M" on every authored page, including empty trailing ones', () => {
      // Content ends mid-page-1; pages 2 and 3 were added afterwards.
      const def = authoredDefinition([element({ id: 'rect-1', y: 100 })], {
        pageCount: 3,
        showPageNumbers: true,
      });
      const ctx = dataCtx([taskItem('task-1', {})]);

      const { html } = service.render(def, ctx);

      expect(countOccurrences(html, 'Page 1 of 3')).toBe(1);
      expect(countOccurrences(html, 'Page 2 of 3')).toBe(1);
      expect(countOccurrences(html, 'Page 3 of 3')).toBe(1);
      // Forced breaks before pages 2 and 3 only.
      expect(countOccurrences(html, 'break-before:page;')).toBe(2);
    });

    it('omits footers when showPageNumbers is not set (unchanged behavior)', () => {
      const def = authoredDefinition([element({ id: 'rect-1', y: 100 })], {
        pageCount: 3,
      });
      const ctx = dataCtx([taskItem('task-1', {})]);

      const { html } = service.render(def, ctx);

      expect(html).not.toContain('Page 1 of 3');
      expect(html).not.toContain('Page 2 of 3');
      expect(html).not.toContain('Page 3 of 3');
    });

    it('keeps the flow exactly M pages tall when content ends mid-page-1', () => {
      const def = authoredDefinition([element({ id: 'rect-1', y: 100 })], {
        pageCount: 3,
        showPageNumbers: true,
      });
      const ctx = dataCtx([taskItem('task-1', {})]);

      const { html } = service.render(def, ctx);

      // The flow must span exactly M full-page bands (3 × 1123px).
      expect(countOccurrences(html, 'height:1123px;')).toBe(3);
    });
  });

  describe('runtime variables + unlimited loop nesting', () => {
    it('renders 3 levels of nested loop regions (beyond the old depth-2 cap)', () => {
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

      const { html, warnings } = service.render(def, ctx);

      expect(html).toContain('Grandchild task');
      expect(warnings).toEqual([]);
    });

    it('increments a variable once per matching row and displays it after the loop', () => {
      const def = definition('fixed_document', [
        element({
          id: 'items-1',
          type: 'loop_region',
          dataSource: 'items',
          y: 0,
          height: 200,
          itemHeight: 20,
          itemSpacing: 0,
        }),
        element({
          id: 'sub-1',
          type: 'loop_region',
          dataSource: 'subtasks',
          parentId: 'items-1',
          y: 20,
          height: 100,
          itemHeight: 20,
          itemSpacing: 0,
        }),
        element({
          id: 'counter',
          type: 'variable_set',
          parentId: 'sub-1',
          op: 'increment',
          varName: 'failedCount',
          value: '1',
          condition: {
            combinator: 'and',
            rules: [{ field: 'status', operator: 'eq', value: 'failed' }],
          },
        }),
        element({
          id: 'summary-text',
          type: 'text',
          y: 250,
          html: '<p>Failed: {{var.failedCount}}</p>',
        }),
      ]);
      const ctx = dataCtx([taskItem('task-1', {})]);
      ctx.subtasksByItemId['task-1'] = [
        { id: 'sub-a', parent_task_id: 'task-1', status: 'failed' },
        { id: 'sub-b', parent_task_id: 'task-1', status: 'passed' },
        { id: 'sub-c', parent_task_id: 'task-1', status: 'failed' },
      ];

      const { html } = service.render(def, ctx);

      // Gated by row-field condition — only the 2 'failed' rows increment.
      expect(html).toContain('Failed: 2');
    });

    it('displays a variable with no matching mutation as an empty string, never the raw token', () => {
      const def = definition('fixed_document', [
        element({
          id: 'items-1',
          type: 'loop_region',
          dataSource: 'items',
          y: 0,
          height: 100,
          itemHeight: 20,
          itemSpacing: 0,
        }),
        element({
          id: 'summary-text',
          type: 'text',
          y: 150,
          html: '<p>[{{var.neverSet}}]</p>',
        }),
      ]);
      const ctx = dataCtx([taskItem('task-1', {})]);

      const { html } = service.render(def, ctx);

      expect(html).toContain('[]');
      expect(html).not.toContain('var.neverSet');
    });
  });
});
