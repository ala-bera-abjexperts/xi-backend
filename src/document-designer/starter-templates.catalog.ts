import type {
  DocumentSourceEntity,
  DocumentTemplateMode,
  IDocumentTemplateDefinition,
} from './template-definition/template-definition.types';

export interface IDocumentStarterTemplate {
  /** Stable slug, part of a URL — never rename once shipped. */
  key: string;
  name: string;
  description: string;
  source_entity: DocumentSourceEntity;
  mode: DocumentTemplateMode;
  definition: IDocumentTemplateDefinition;
}

const ACCENT = '#4F46E5';
const INK = '#0F172A';
const MUTED = '#64748B';
const FOOTER_MUTED = '#94A3B8';
const CARD_BG = '#F8FAFC';
const CARD_BORDER = '#E2E8F0';
const TABLE_HEADER_BG = '#F1F5F9';

const PAGE = {
  size: 'A4' as const,
  orientation: 'portrait' as const,
  margins: { top: 48, right: 48, bottom: 48, left: 48 },
  pageBreakMargin: 0,
};

/** Header block shared by every starter: accent bar + title + accent divider. */
function headerElements(title: string) {
  return [
    {
      id: 'accent-bar',
      type: 'rectangle' as const,
      x: 48,
      y: 48,
      width: 4,
      height: 32,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 1,
      parentId: null,
      style: { backgroundColor: ACCENT, borderRadius: 2 },
    },
    {
      id: 'title',
      type: 'text' as const,
      x: 64,
      y: 48,
      width: 682,
      height: 32,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 2,
      parentId: null,
      style: { fontSize: 24, fontWeight: 700 as const, color: INK },
      html: `<p>${title}</p>`,
    },
    {
      id: 'divider-top',
      type: 'line' as const,
      x: 48,
      y: 96,
      width: 698,
      height: 2,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 1,
      parentId: null,
      style: { backgroundColor: ACCENT },
    },
  ];
}

/** Footer block shared by every starter: light divider + muted export-date meta. */
function footerElements(dividerY: number) {
  return [
    {
      id: 'divider-footer',
      type: 'line' as const,
      x: 48,
      y: dividerY,
      width: 698,
      height: 1,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 1,
      parentId: null,
      style: { backgroundColor: CARD_BORDER },
    },
    {
      id: 'field-footer-meta',
      type: 'field' as const,
      x: 48,
      y: dividerY + 12,
      width: 400,
      height: 18,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 2,
      parentId: null,
      style: { fontSize: 10, color: FOOTER_MUTED },
      binding: {
        source: 'meta' as const,
        fieldKey: 'exportDate',
        format: { dateFormat: 'dd.MM.yyyy HH:mm' },
      },
    },
  ];
}

/**
 * One label + bordered value-card "field group", the recurring visual unit
 * across every starter. `emphasis` bumps size/weight for primary fields
 * (a report's summary/title/name), `tall` grows the card for long text.
 */
function fieldGroup(opts: {
  idBase: string;
  label: string;
  x: number;
  y: number;
  width: number;
  fieldKey: string;
  source?: 'system' | 'custom_field' | 'meta';
  format?: Record<string, unknown>;
  emphasis?: boolean;
  tall?: number;
}) {
  const cardHeight = opts.tall ?? 34;
  const cardY = opts.y + 18;
  const fontSize = opts.emphasis ? 16 : 14;
  const fontWeight = opts.emphasis ? (700 as const) : (600 as const);
  // Multi-line long-text fields (description, tall > 60) get generous
  // padding for wrapped lines. Single-line fields (standard rows, and
  // "tall" emphasis rows like summary/title/name which are still one line,
  // just a bigger card) need a real line-height box, not a bare fontSize —
  // a box exactly equal to fontSize clips ascenders/descenders (this is
  // the bug: 'g'/'y' in "Budget" visibly clipped at fontSize 16 in a
  // height-16 box). Centered vertically in the card either way.
  const isMultiline = !!opts.tall && opts.tall > 60;
  const lineBoxHeight = Math.ceil(fontSize * 1.5);
  const fieldY = isMultiline
    ? cardY + 12
    : cardY + Math.round((cardHeight - lineBoxHeight) / 2);
  const fieldHeight = isMultiline ? cardHeight - 24 : lineBoxHeight;

  return [
    {
      id: `label-${opts.idBase}`,
      type: 'text' as const,
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: 14,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 2,
      parentId: null,
      style: {
        fontSize: 10,
        fontWeight: 600 as const,
        color: MUTED,
      },
      html: `<p>${opts.label}</p>`,
    },
    {
      id: `card-${opts.idBase}`,
      type: 'rectangle' as const,
      x: opts.x,
      // width shrunk 2px: a 1px border on each side adds to the box's
      // rendered width on top of the declared width (content-box model),
      // so a full-width bordered card at exactly the content width
      // overflowed by 2px and triggered a spurious horizontal scrollbar
      // in the preview frame.
      y: cardY,
      width: opts.width - 2,
      height: cardHeight,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 1,
      parentId: null,
      style: {
        backgroundColor: CARD_BG,
        borderColor: CARD_BORDER,
        borderWidth: 1,
        borderRadius: 8,
      },
    },
    {
      id: `field-${opts.idBase}`,
      type: 'field' as const,
      x: opts.x + 12,
      y: fieldY,
      width: opts.width - 24,
      height: fieldHeight,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 2,
      parentId: null,
      style: isMultiline
        ? { fontSize, fontWeight, lineHeight: 1.6, color: INK }
        : { fontSize, fontWeight, lineHeight: 1.4, color: INK },
      binding: {
        source: opts.source ?? 'system',
        fieldKey: opts.fieldKey,
        ...(opts.format ? { format: opts.format } : {}),
      },
    },
  ];
}

// Shared row grid used by every repeat_per_item starter, so the four starters
// read as one consistent set: 3-col row at y124, 2-col row at y196,
// full-width emphasized row at y268, tall full-width card at y346-y1014.
const COL3_WIDTH = 222;
const COL3 = [48, 286, 524];
const COL2_WIDTH = 341;
const COL2 = [48, 405];
const FULL_WIDTH = 698;

// Table archetype geometry, shared by every fixed_document starter.
const TABLE_X = 48;
const TABLE_WIDTH = 696;
const TABLE_ROW_HEIGHT = 32;

/** Column grid for a key-first table (KEY | NAME | ATTR | DATE). */
const KEY_FIRST_COLS = [
  { x: 12, width: 138 },
  { x: 172, width: 298 },
  { x: 442, width: 118 },
  { x: 582, width: 106 },
];

/** Column grid for a name-first table — wider first cell, no key column. */
const NAME_FIRST_COLS = [
  { x: 12, width: 298 },
  { x: 322, width: 138 },
  { x: 472, width: 118 },
  { x: 600, width: 84 },
];

interface ITableColumn {
  idBase: string;
  label: string;
  x: number;
  width: number;
  fieldKey: string;
  format?: Record<string, unknown>;
  /** Primary column (key/name) — ink instead of muted, semibold. */
  strong?: boolean;
}

/**
 * Header band + column labels + divider + an `items` loop region with one
 * flush row per record. Column `x`/`width` are REGION-RELATIVE (row fields are
 * children of the region); the matching header label is emitted at the
 * page-absolute x, which is the offset `board-export`'s comment warns about.
 *
 * board-export predates this helper and stays hand-written on purpose — its
 * rendered output must not shift.
 */
function tableElements(opts: {
  loopId: string;
  columns: ITableColumn[];
  sortBy: string;
  sortDir?: 'asc' | 'desc';
  maxItems?: number;
}) {
  return [
    // Unbordered band: a bordered box at the full content width overflows by
    // 2px in a content-box model — the divider below separates instead.
    {
      id: 'table-header-band',
      type: 'rectangle' as const,
      x: TABLE_X,
      y: 124,
      width: TABLE_WIDTH,
      height: 28,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 1,
      parentId: null,
      style: { backgroundColor: TABLE_HEADER_BG, borderRadius: 0 },
    },
    ...opts.columns.map((col) => ({
      id: `label-${col.idBase}`,
      type: 'text' as const,
      x: TABLE_X + col.x,
      y: 132,
      width: col.width,
      height: 14,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 2,
      parentId: null,
      style: { fontSize: 10, fontWeight: 700 as const, color: MUTED },
      html: `<p>${col.label}</p>`,
    })),
    {
      id: 'header-divider',
      type: 'line' as const,
      x: TABLE_X,
      y: 152,
      width: TABLE_WIDTH,
      height: 2,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 1,
      parentId: null,
      style: { backgroundColor: '#CBD5E1' },
    },
    {
      id: opts.loopId,
      type: 'loop_region' as const,
      x: TABLE_X,
      y: 154,
      width: TABLE_WIDTH,
      height: TABLE_ROW_HEIGHT,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 1,
      parentId: null,
      style: {},
      dataSource: 'items' as const,
      sortBy: opts.sortBy,
      sortDir: opts.sortDir ?? ('desc' as const),
      maxItems: opts.maxItems ?? 100,
      itemSpacing: 0,
      itemHeight: TABLE_ROW_HEIGHT,
    },
    {
      id: 'row-divider',
      type: 'line' as const,
      x: 0,
      y: TABLE_ROW_HEIGHT - 1,
      width: TABLE_WIDTH,
      height: 1,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 1,
      parentId: opts.loopId,
      style: { backgroundColor: CARD_BORDER },
    },
    ...opts.columns.map((col) => ({
      id: `field-${col.idBase}`,
      type: 'field' as const,
      x: col.x,
      y: 8,
      width: col.width,
      height: 16,
      rotation: 0,
      positionMode: 'absolute' as const,
      zIndex: 2,
      parentId: opts.loopId,
      style: col.strong
        ? { fontSize: 12, fontWeight: 600 as const, color: INK }
        : { fontSize: 12, color: MUTED },
      binding: {
        source: 'system' as const,
        fieldKey: col.fieldKey,
        ...(col.format ? { format: col.format } : {}),
      },
    })),
  ];
}

export const DOCUMENT_STARTER_TEMPLATES: IDocumentStarterTemplate[] = [
  // task-report
  {
    key: 'task-report',
    name: 'Task Report',
    description:
      'One page per task with key details, description and assignment.',
    source_entity: 'tasks',
    mode: 'repeat_per_item',
    definition: {
      schemaVersion: 1,
      mode: 'repeat_per_item',
      sourceEntity: 'tasks',
      page: PAGE,
      elements: [
        ...headerElements('Task Report'),
        ...fieldGroup({
          idBase: 'key',
          label: 'KEY',
          x: COL3[0],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'key',
        }),
        ...fieldGroup({
          idBase: 'status',
          label: 'STATUS',
          x: COL3[1],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'status',
        }),
        ...fieldGroup({
          idBase: 'priority',
          label: 'PRIORITY',
          x: COL3[2],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'priority',
        }),
        ...fieldGroup({
          idBase: 'assigned',
          label: 'ASSIGNED TO',
          x: COL2[0],
          y: 196,
          width: COL2_WIDTH,
          fieldKey: 'assigned_to',
          format: { userDisplay: 'name' },
        }),
        ...fieldGroup({
          idBase: 'due',
          label: 'DUE DATE',
          x: COL2[1],
          y: 196,
          width: COL2_WIDTH,
          fieldKey: 'due_date',
          format: { dateFormat: 'dd.MM.yyyy' },
        }),
        ...fieldGroup({
          idBase: 'summary',
          label: 'SUMMARY',
          x: 48,
          y: 268,
          width: FULL_WIDTH,
          fieldKey: 'summary',
          emphasis: true,
          tall: 40,
        }),
        ...fieldGroup({
          idBase: 'description',
          label: 'DESCRIPTION',
          x: 48,
          y: 346,
          width: FULL_WIDTH,
          fieldKey: 'description',
          format: { renderHtml: true },
          tall: 668,
        }),
        ...footerElements(1030),
      ],
    },
  },

  // process-summary
  {
    key: 'process-summary',
    name: 'Process Summary',
    description:
      'One page per process with key details, request type and assignment.',
    source_entity: 'processes',
    mode: 'repeat_per_item',
    definition: {
      schemaVersion: 1,
      mode: 'repeat_per_item',
      sourceEntity: 'processes',
      page: PAGE,
      elements: [
        ...headerElements('Process Summary'),
        ...fieldGroup({
          idBase: 'key',
          label: 'KEY',
          x: COL3[0],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'key',
        }),
        ...fieldGroup({
          idBase: 'status',
          label: 'STATUS',
          x: COL3[1],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'status',
        }),
        ...fieldGroup({
          idBase: 'request-type',
          label: 'REQUEST TYPE',
          x: COL3[2],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'request_type',
        }),
        ...fieldGroup({
          idBase: 'assigned',
          label: 'ASSIGNED TO',
          x: 48,
          y: 196,
          width: FULL_WIDTH,
          fieldKey: 'assigned_to',
          format: { userDisplay: 'name' },
        }),
        ...fieldGroup({
          idBase: 'title',
          label: 'TITLE',
          x: 48,
          y: 268,
          width: FULL_WIDTH,
          fieldKey: 'title',
          emphasis: true,
          tall: 40,
        }),
        ...fieldGroup({
          idBase: 'description',
          label: 'DESCRIPTION',
          x: 48,
          y: 346,
          width: FULL_WIDTH,
          fieldKey: 'description',
          format: { renderHtml: true },
          tall: 668,
        }),
        ...footerElements(1030),
      ],
    },
  },

  // board-export
  // fixed_document mode; demonstrates a loop_region. Children carry the
  // region's own id as parentId and REGION-RELATIVE x/y (offset from the
  // region's own top-left, not the page) — verified against
  // LoopRegionElement.tsx before writing these; the previous draft had
  // 'type'/'updated' columns 48px off because it reused page-absolute x.
  {
    key: 'board-export',
    name: 'Board Export',
    description: 'A single document listing every board, one row per board.',
    source_entity: 'boards',
    mode: 'fixed_document',
    definition: {
      schemaVersion: 1,
      mode: 'fixed_document',
      sourceEntity: 'boards',
      page: PAGE,
      pages: [{ id: 'page-1' }],
      elements: [
        ...headerElements('Board Export'),
        {
          // No border on this band (a bordered box at the full content
          // width overflows by 2px in a content-box model and triggers a
          // spurious horizontal scrollbar) — the header-divider line below
          // provides the separation instead. Sharp corners, no radius.
          id: 'table-header-band',
          type: 'rectangle',
          x: 48,
          y: 124,
          width: 696,
          height: 28,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 1,
          parentId: null,
          style: { backgroundColor: TABLE_HEADER_BG, borderRadius: 0 },
        },
        {
          id: 'label-key',
          type: 'text',
          x: 60,
          y: 132,
          width: 138,
          height: 14,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: null,
          style: { fontSize: 10, fontWeight: 700, color: MUTED },
          html: '<p>KEY</p>',
        },
        {
          id: 'label-name',
          type: 'text',
          x: 220,
          y: 132,
          width: 198,
          height: 14,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: null,
          style: { fontSize: 10, fontWeight: 700, color: MUTED },
          html: '<p>NAME</p>',
        },
        {
          id: 'label-type',
          type: 'text',
          x: 490,
          y: 132,
          width: 118,
          height: 14,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: null,
          style: { fontSize: 10, fontWeight: 700, color: MUTED },
          html: '<p>TYPE</p>',
        },
        {
          id: 'label-updated',
          type: 'text',
          x: 630,
          y: 132,
          width: 106,
          height: 14,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: null,
          style: { fontSize: 10, fontWeight: 700, color: MUTED },
          html: '<p>UPDATED</p>',
        },
        {
          id: 'header-divider',
          type: 'line',
          x: 48,
          y: 152,
          width: 696,
          height: 2,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 1,
          parentId: null,
          style: { backgroundColor: '#CBD5E1' },
        },
        {
          // Rows sit flush (itemSpacing 0) and are separated by their own
          // hairline bottom divider instead of a bordered/rounded card —
          // a real table, not a stack of floating boxes.
          id: 'boards-loop',
          type: 'loop_region',
          x: 48,
          y: 154,
          width: 696,
          height: 32,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 1,
          parentId: null,
          style: {},
          dataSource: 'items',
          sortBy: 'updated_at',
          sortDir: 'desc',
          maxItems: 100,
          itemSpacing: 0,
          itemHeight: 32,
        },
        {
          id: 'row-divider',
          type: 'line',
          x: 0,
          y: 31,
          width: 696,
          height: 1,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 1,
          parentId: 'boards-loop',
          style: { backgroundColor: CARD_BORDER },
        },
        {
          id: 'field-board-key',
          type: 'field',
          x: 12,
          y: 8,
          width: 138,
          height: 16,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: 'boards-loop',
          style: { fontSize: 12, fontWeight: 600, color: INK },
          binding: { source: 'system', fieldKey: 'board_key' },
        },
        {
          id: 'field-board-name',
          type: 'field',
          x: 172,
          y: 8,
          width: 298,
          height: 16,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: 'boards-loop',
          style: { fontSize: 12, color: INK },
          binding: { source: 'system', fieldKey: 'name' },
        },
        {
          id: 'field-board-type',
          type: 'field',
          x: 442,
          y: 8,
          width: 118,
          height: 16,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: 'boards-loop',
          style: { fontSize: 12, color: MUTED },
          binding: { source: 'system', fieldKey: 'board_type' },
        },
        {
          id: 'field-board-updated',
          type: 'field',
          x: 582,
          y: 8,
          width: 106,
          height: 16,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: 'boards-loop',
          style: { fontSize: 12, color: MUTED },
          binding: {
            source: 'system',
            fieldKey: 'updated_at',
            format: { dateFormat: 'dd.MM.yyyy' },
          },
        },
        ...footerElements(1030),
      ],
    },
  },

  // form-submission-summary
  // source_entity 'form_builder' is the form definitions module (there is no
  // separate submissions entity in DOCUMENT_SOURCE_ENTITIES) — one page per
  // form. Same row grid as task-report/process-summary for visual
  // consistency across the whole starter set.
  {
    key: 'form-submission-summary',
    name: 'Form Summary',
    description: 'One page per form with key details for a quick read.',
    source_entity: 'form_builder',
    mode: 'repeat_per_item',
    definition: {
      schemaVersion: 1,
      mode: 'repeat_per_item',
      sourceEntity: 'form_builder',
      page: PAGE,
      elements: [
        ...headerElements('Form Summary'),
        // KEY removed: form_key is unpopulated in this system's data — no
        // point binding a field that always renders empty. Reflowed STATUS
        // and VERSION onto the 2-column grid (same COL2/COL2_WIDTH the
        // PUBLIC/UPDATED AT row already uses) instead of leaving a 3-column
        // row with an empty first cell.
        ...fieldGroup({
          idBase: 'status',
          label: 'STATUS',
          x: COL2[0],
          y: 124,
          width: COL2_WIDTH,
          fieldKey: 'status',
        }),
        ...fieldGroup({
          idBase: 'version',
          label: 'VERSION',
          x: COL2[1],
          y: 124,
          width: COL2_WIDTH,
          fieldKey: 'version',
        }),
        ...fieldGroup({
          idBase: 'public',
          label: 'PUBLIC',
          x: COL2[0],
          y: 196,
          width: COL2_WIDTH,
          fieldKey: 'is_public',
        }),
        ...fieldGroup({
          idBase: 'updated',
          label: 'UPDATED AT',
          x: COL2[1],
          y: 196,
          width: COL2_WIDTH,
          fieldKey: 'updated_at',
          format: { dateFormat: 'dd.MM.yyyy' },
        }),
        ...fieldGroup({
          idBase: 'name',
          label: 'NAME',
          x: 48,
          y: 268,
          width: FULL_WIDTH,
          fieldKey: 'name',
          emphasis: true,
          tall: 40,
        }),
        ...fieldGroup({
          idBase: 'description',
          label: 'DESCRIPTION',
          x: 48,
          y: 346,
          width: FULL_WIDTH,
          fieldKey: 'description',
          tall: 668,
        }),
        ...footerElements(1030),
      ],
    },
  },

  // wiki-page
  // The one module whose body is genuinely long-form: `content` is html, so
  // it gets the tall renderHtml card the same way task-report's description
  // does. Key column is `slug` (wiki has no generated key).
  {
    key: 'wiki-page',
    name: 'Wiki Page',
    description:
      'One page per wiki page with status, publishing details and the full content.',
    source_entity: 'wiki',
    mode: 'repeat_per_item',
    definition: {
      schemaVersion: 1,
      mode: 'repeat_per_item',
      sourceEntity: 'wiki',
      page: PAGE,
      elements: [
        ...headerElements('Wiki Page'),
        ...fieldGroup({
          idBase: 'slug',
          label: 'SLUG',
          x: COL3[0],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'slug',
        }),
        ...fieldGroup({
          idBase: 'status',
          label: 'STATUS',
          x: COL3[1],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'workflow_status',
        }),
        ...fieldGroup({
          idBase: 'published',
          label: 'PUBLISHED',
          x: COL3[2],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'is_published',
        }),
        ...fieldGroup({
          idBase: 'created-by',
          label: 'CREATED BY',
          x: COL2[0],
          y: 196,
          width: COL2_WIDTH,
          fieldKey: 'created_by',
          format: { userDisplay: 'name' },
        }),
        ...fieldGroup({
          idBase: 'published-at',
          label: 'PUBLISHED AT',
          x: COL2[1],
          y: 196,
          width: COL2_WIDTH,
          fieldKey: 'published_at',
          format: { dateFormat: 'dd.MM.yyyy' },
        }),
        ...fieldGroup({
          idBase: 'title',
          label: 'TITLE',
          x: 48,
          y: 268,
          width: FULL_WIDTH,
          fieldKey: 'title',
          emphasis: true,
          tall: 40,
        }),
        ...fieldGroup({
          idBase: 'content',
          label: 'CONTENT',
          x: 48,
          y: 346,
          width: FULL_WIDTH,
          fieldKey: 'content',
          format: { renderHtml: true },
          tall: 668,
        }),
        ...footerElements(1030),
      ],
    },
  },

  // plan-overview
  // Plans carry the richest field set of the remaining modules (RAG, budget,
  // progress, dates), so this uses a THIRD 3-column row at y268 and shifts
  // name/description down accordingly — same grid columns and same helpers,
  // just one row taller than the other repeat_per_item starters.
  // budget/progress are left unformatted: `currency` is a sibling column the
  // formatter cannot read, and progress has no documented 0-1 vs 0-100 scale.
  {
    key: 'plan-overview',
    name: 'Plan Overview',
    description:
      'One page per plan with key details, dates, budget and progress.',
    source_entity: 'plans',
    mode: 'repeat_per_item',
    definition: {
      schemaVersion: 1,
      mode: 'repeat_per_item',
      sourceEntity: 'plans',
      page: PAGE,
      elements: [
        ...headerElements('Plan Overview'),
        ...fieldGroup({
          idBase: 'key',
          label: 'KEY',
          x: COL3[0],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'plan_key',
        }),
        ...fieldGroup({
          idBase: 'status',
          label: 'STATUS',
          x: COL3[1],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'status',
        }),
        ...fieldGroup({
          idBase: 'rag',
          label: 'RAG STATUS',
          x: COL3[2],
          y: 124,
          width: COL3_WIDTH,
          fieldKey: 'rag_status',
        }),
        ...fieldGroup({
          idBase: 'owner',
          label: 'OWNER',
          x: COL3[0],
          y: 196,
          width: COL3_WIDTH,
          fieldKey: 'owner_id',
          format: { userDisplay: 'name' },
        }),
        ...fieldGroup({
          idBase: 'start',
          label: 'START DATE',
          x: COL3[1],
          y: 196,
          width: COL3_WIDTH,
          fieldKey: 'start_date',
          format: { dateFormat: 'dd.MM.yyyy' },
        }),
        ...fieldGroup({
          idBase: 'end',
          label: 'END DATE',
          x: COL3[2],
          y: 196,
          width: COL3_WIDTH,
          fieldKey: 'end_date',
          format: { dateFormat: 'dd.MM.yyyy' },
        }),
        ...fieldGroup({
          idBase: 'type',
          label: 'PLAN TYPE',
          x: COL3[0],
          y: 268,
          width: COL3_WIDTH,
          fieldKey: 'plan_type',
        }),
        ...fieldGroup({
          idBase: 'budget',
          label: 'BUDGET',
          x: COL3[1],
          y: 268,
          width: COL3_WIDTH,
          fieldKey: 'budget',
        }),
        ...fieldGroup({
          idBase: 'progress',
          label: 'PROGRESS',
          x: COL3[2],
          y: 268,
          width: COL3_WIDTH,
          fieldKey: 'progress',
        }),
        ...fieldGroup({
          idBase: 'name',
          label: 'NAME',
          x: 48,
          y: 340,
          width: FULL_WIDTH,
          fieldKey: 'name',
          emphasis: true,
          tall: 40,
        }),
        ...fieldGroup({
          idBase: 'description',
          label: 'DESCRIPTION',
          x: 48,
          y: 418,
          width: FULL_WIDTH,
          fieldKey: 'description',
          format: { renderHtml: true },
          tall: 596,
        }),
        ...footerElements(1030),
      ],
    },
  },

  // list-export
  // `lists` is backed by asset_items and has no key column, so this and the
  // three name-first tables below lead with the title instead.
  {
    key: 'list-export',
    name: 'List Export',
    description: 'A single document listing every list, one row per list.',
    source_entity: 'lists',
    mode: 'fixed_document',
    definition: {
      schemaVersion: 1,
      mode: 'fixed_document',
      sourceEntity: 'lists',
      page: PAGE,
      pages: [{ id: 'page-1' }],
      elements: [
        ...headerElements('List Export'),
        ...tableElements({
          loopId: 'lists-loop',
          sortBy: 'updated_at',
          columns: [
            {
              idBase: 'title',
              label: 'TITLE',
              ...NAME_FIRST_COLS[0],
              fieldKey: 'title',
              strong: true,
            },
            {
              idBase: 'created-by',
              label: 'CREATED BY',
              ...NAME_FIRST_COLS[1],
              fieldKey: 'created_by',
              format: { userDisplay: 'name' },
            },
            {
              idBase: 'created',
              label: 'CREATED',
              ...NAME_FIRST_COLS[2],
              fieldKey: 'created_at',
              format: { dateFormat: 'dd.MM.yyyy' },
            },
            {
              idBase: 'updated',
              label: 'UPDATED',
              ...NAME_FIRST_COLS[3],
              fieldKey: 'updated_at',
              format: { dateFormat: 'dd.MM.yyyy' },
            },
          ],
        }),
        ...footerElements(1030),
      ],
    },
  },

  // asset-register
  {
    key: 'asset-register',
    name: 'Asset Register',
    description: 'A single document listing every asset, one row per asset.',
    source_entity: 'assets',
    mode: 'fixed_document',
    definition: {
      schemaVersion: 1,
      mode: 'fixed_document',
      sourceEntity: 'assets',
      page: PAGE,
      pages: [{ id: 'page-1' }],
      elements: [
        ...headerElements('Asset Register'),
        ...tableElements({
          loopId: 'assets-loop',
          sortBy: 'updated_at',
          columns: [
            {
              idBase: 'key',
              label: 'KEY',
              ...KEY_FIRST_COLS[0],
              fieldKey: 'object_key',
              strong: true,
            },
            {
              idBase: 'name',
              label: 'NAME',
              ...KEY_FIRST_COLS[1],
              fieldKey: 'name',
            },
            {
              idBase: 'status',
              label: 'STATUS',
              ...KEY_FIRST_COLS[2],
              fieldKey: 'status',
            },
            {
              idBase: 'updated',
              label: 'UPDATED',
              ...KEY_FIRST_COLS[3],
              fieldKey: 'updated_at',
              format: { dateFormat: 'dd.MM.yyyy' },
            },
          ],
        }),
        ...footerElements(1030),
      ],
    },
  },

  // automation-inventory
  // Last/next run are the columns an operator actually scans for, which is
  // why this one is a table rather than a page per automation.
  {
    key: 'automation-inventory',
    name: 'Automation Inventory',
    description:
      'A single document listing every automation with its last and next run.',
    source_entity: 'automations',
    mode: 'fixed_document',
    definition: {
      schemaVersion: 1,
      mode: 'fixed_document',
      sourceEntity: 'automations',
      page: PAGE,
      pages: [{ id: 'page-1' }],
      elements: [
        ...headerElements('Automation Inventory'),
        ...tableElements({
          loopId: 'automations-loop',
          sortBy: 'updated_at',
          columns: [
            {
              idBase: 'name',
              label: 'NAME',
              ...NAME_FIRST_COLS[0],
              fieldKey: 'name',
              strong: true,
            },
            {
              idBase: 'status',
              label: 'STATUS',
              ...NAME_FIRST_COLS[1],
              fieldKey: 'status',
            },
            {
              idBase: 'last-run',
              label: 'LAST RUN',
              ...NAME_FIRST_COLS[2],
              fieldKey: 'last_run_at',
              format: { dateFormat: 'dd.MM.yyyy' },
            },
            {
              idBase: 'next-run',
              label: 'NEXT RUN',
              ...NAME_FIRST_COLS[3],
              fieldKey: 'next_run_at',
              format: { dateFormat: 'dd.MM.yyyy' },
            },
          ],
        }),
        ...footerElements(1030),
      ],
    },
  },

  // dashboard-index
  // A dashboard's content is a widget grid, not printable fields — so the
  // starter is an index of what exists, not an attempt to render one.
  {
    key: 'dashboard-index',
    name: 'Dashboard Index',
    description:
      'A single document listing every dashboard, one row per dashboard.',
    source_entity: 'dashboards',
    mode: 'fixed_document',
    definition: {
      schemaVersion: 1,
      mode: 'fixed_document',
      sourceEntity: 'dashboards',
      page: PAGE,
      pages: [{ id: 'page-1' }],
      elements: [
        ...headerElements('Dashboard Index'),
        ...tableElements({
          loopId: 'dashboards-loop',
          sortBy: 'updated_at',
          columns: [
            {
              idBase: 'name',
              label: 'NAME',
              ...NAME_FIRST_COLS[0],
              fieldKey: 'name',
              strong: true,
            },
            {
              idBase: 'visibility',
              label: 'VISIBILITY',
              ...NAME_FIRST_COLS[1],
              fieldKey: 'visibility',
            },
            {
              idBase: 'status',
              label: 'STATUS',
              ...NAME_FIRST_COLS[2],
              fieldKey: 'status',
            },
            {
              idBase: 'updated',
              label: 'UPDATED',
              ...NAME_FIRST_COLS[3],
              fieldKey: 'updated_at',
              format: { dateFormat: 'dd.MM.yyyy' },
            },
          ],
        }),
        ...footerElements(1030),
      ],
    },
  },

  // file-index
  // The resolver's extraFilter already limits this module to real files
  // (node_type 'file', not deleted), so no per-region filter is needed.
  // SIZE is labelled in bytes because file_size is a raw number column and
  // the formatter has no byte-size unit.
  {
    key: 'file-index',
    name: 'File Index',
    description: 'A single document listing every file with type and size.',
    source_entity: 'file_explorer',
    mode: 'fixed_document',
    definition: {
      schemaVersion: 1,
      mode: 'fixed_document',
      sourceEntity: 'file_explorer',
      page: PAGE,
      pages: [{ id: 'page-1' }],
      elements: [
        ...headerElements('File Index'),
        ...tableElements({
          loopId: 'files-loop',
          sortBy: 'updated_at',
          columns: [
            {
              idBase: 'name',
              label: 'FILE NAME',
              ...NAME_FIRST_COLS[0],
              fieldKey: 'name',
              strong: true,
            },
            {
              idBase: 'type',
              label: 'TYPE',
              ...NAME_FIRST_COLS[1],
              fieldKey: 'mime_type',
            },
            {
              idBase: 'size',
              label: 'SIZE (BYTES)',
              ...NAME_FIRST_COLS[2],
              fieldKey: 'file_size',
            },
            {
              idBase: 'updated',
              label: 'UPDATED',
              ...NAME_FIRST_COLS[3],
              fieldKey: 'updated_at',
              format: { dateFormat: 'dd.MM.yyyy' },
            },
          ],
        }),
        ...footerElements(1030),
      ],
    },
  },

  // task-digest
  // The worked example of the three dynamic features, in one document:
  //   LOOP      — `tasks-loop` renders one row per task in the export scope.
  //   CONDITION — the DUE cell and the "No due date" placeholder carry
  //               opposite rules on the same cell, so a row shows exactly one
  //               of them and the column never has an empty gap.
  //   VARIABLE  — two counters increment per row (one unconditionally, one
  //               only when the row has a due date) and are printed ABOVE the
  //               table. That reads correctly because variables are resolved
  //               in a whole-document pre-pass (computeFinalVariables), so a
  //               token always shows the FINAL total regardless of where it
  //               sits — a running mid-loop total is explicitly not supported.
  {
    key: 'task-digest',
    name: 'Task Digest',
    description:
      'A single document listing tasks, with a conditional notes cell and counters in the summary line.',
    source_entity: 'tasks',
    mode: 'fixed_document',
    definition: {
      schemaVersion: 1,
      mode: 'fixed_document',
      sourceEntity: 'tasks',
      page: PAGE,
      pages: [{ id: 'page-1' }],
      elements: [
        ...headerElements('Task Digest'),
        {
          // Sits between the header divider (y96) and the table band (y124).
          id: 'summary-line',
          type: 'text',
          x: 48,
          y: 102,
          width: FULL_WIDTH,
          height: 16,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: null,
          style: { fontSize: 11, fontWeight: 600, color: ACCENT },
          html: '<p>{{var.documented}} of {{var.total}} tasks have a description.</p>',
        },
        {
          // Seeds. A counter that never increments (its condition matched no
          // row) is UNSET, and an unset variable interpolates to '' — the
          // summary line would read "of 12 tasks" with a hole in it. Seeding
          // to 0 at page level, below the loop's zIndex so the pre-pass walk
          // reaches it first, makes the sentence read correctly at zero.
          id: 'var-seed-total',
          type: 'variable_set',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 0,
          parentId: null,
          style: {},
          op: 'assign',
          varName: 'total',
          value: '0',
        },
        {
          id: 'var-seed-documented',
          type: 'variable_set',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 0,
          parentId: null,
          style: {},
          op: 'assign',
          varName: 'documented',
          value: '0',
        },
        ...tableElements({
          loopId: 'tasks-loop',
          sortBy: 'key',
          sortDir: 'asc',
          columns: [
            {
              idBase: 'key',
              label: 'KEY',
              ...KEY_FIRST_COLS[0],
              fieldKey: 'key',
              strong: true,
            },
            {
              idBase: 'summary',
              label: 'TITLE',
              ...KEY_FIRST_COLS[1],
              fieldKey: 'summary',
            },
            {
              idBase: 'status',
              label: 'STATUS',
              ...KEY_FIRST_COLS[2],
              fieldKey: 'status',
            },
          ],
        }),
        {
          // Header for the flag column below (the helper only labels its own
          // columns), aligned to the same page-absolute x as the row cells.
          id: 'label-notes',
          type: 'text',
          x: TABLE_X + KEY_FIRST_COLS[3].x,
          y: 132,
          width: KEY_FIRST_COLS[3].width,
          height: 14,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: null,
          style: { fontSize: 10, fontWeight: 700, color: MUTED },
          html: '<p>NOTES</p>',
        },
        {
          // Two elements, one cell, opposite rules: exactly one renders per
          // row, so the column is never blank. This is the condition demo.
          id: 'flag-documented',
          type: 'text',
          x: KEY_FIRST_COLS[3].x,
          y: 8,
          width: KEY_FIRST_COLS[3].width,
          height: 16,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: 'tasks-loop',
          style: { fontSize: 11, fontWeight: 600, color: ACCENT },
          condition: {
            combinator: 'and',
            rules: [{ field: 'description', operator: 'notNull', value: null }],
          },
          html: '<p>Documented</p>',
        },
        {
          id: 'flag-undocumented',
          type: 'text',
          x: KEY_FIRST_COLS[3].x,
          y: 8,
          width: KEY_FIRST_COLS[3].width,
          height: 16,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 2,
          parentId: 'tasks-loop',
          style: { fontSize: 11, color: FOOTER_MUTED },
          condition: {
            combinator: 'and',
            rules: [{ field: 'description', operator: 'null', value: null }],
          },
          html: '<p>No description</p>',
        },
        {
          // Non-visual counters. Geometry is required by the element contract
          // but never drawn — the renderer skips variable_set when painting.
          id: 'var-total',
          type: 'variable_set',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 0,
          parentId: 'tasks-loop',
          style: {},
          op: 'increment',
          varName: 'total',
          value: '1',
        },
        {
          id: 'var-documented',
          type: 'variable_set',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          rotation: 0,
          positionMode: 'absolute',
          zIndex: 0,
          parentId: 'tasks-loop',
          style: {},
          condition: {
            combinator: 'and',
            rules: [{ field: 'description', operator: 'notNull', value: null }],
          },
          op: 'increment',
          varName: 'documented',
          value: '1',
        },
        ...footerElements(1030),
      ],
    },
  },
];

export function findStarterTemplate(
  key: string,
): IDocumentStarterTemplate | undefined {
  return DOCUMENT_STARTER_TEMPLATES.find((t) => t.key === key);
}
