/**
 * @fileoverview Word (.docx) rendering for document exports. MIRRORS the HTML
 * renderer's data flow — the same condition evaluator, the same field
 * formatter, and the SHARED helpers exported by document-render.service
 * (band decomposition, region loop rows, token interpolation) — so both
 * formats always agree on WHICH content appears; only the layout fidelity
 * differs.
 *
 * COORDINATE MODEL — identical to the HTML renderer (and the designer canvas):
 * (0,0) is the TOP-LEFT CORNER OF THE PHYSICAL PAGE. Word section margins are
 * 0 (mirroring `@page { margin: 0 }`), frames anchor to the page at the raw
 * stored coordinates (px×15 twips), and template page margins are designer
 * guides only — they never shift output. `pageBreakMargin` applies to
 * repeat_per_item only: every item starts a fresh page and items 2..n are
 * pushed down by pageBreakMargin px, matching the HTML/PDF renderer.
 *
 * Layout mapping (v1, documented limitations surfaced as warnings):
 *  - Page-level elements NO LONGER use Word's legacy absolute-frame feature
 *    (`framePr`) — that has notoriously weak/inconsistent support outside
 *    real Word (confirmed: Google Docs drops overlapping frame content
 *    entirely). Instead: clusterRows() groups elements into visual rows by
 *    y-range overlap (a sweep-line pass — NOT the same as
 *    decomposeFixedDocumentBands, which only separates loop-region bands
 *    from everything else); within a row, detectContainers() finds
 *    rectangle/ellipse shapes that geometrically contain — and sit at a
 *    LOWER z-index than — other row elements, treating them as that cell's
 *    background (shading, not a separate overlapping shape); buildPageRow()
 *    turns each row into its own small table, one column per x-group,
 *    exactly generalizing the loop-region column technique (groupByX) to
 *    the whole page. `elementToFrame()`/frames remain ONLY as an internal
 *    building block no longer reachable from page-level rendering — kept
 *    for reference, not a live fallback path.
 *  - Loop regions → borderless tables (one cantSplit row per loop item),
 *    indented by the region's x, with one column per distinct x among the
 *    region's child elements (matching the canvas's side-by-side field
 *    layout) — column widths derived from each column's element width, last
 *    column absorbing any twip-rounding remainder. Nested regions nest
 *    tables inside whichever column their own x falls into (depth ≤ 2 by
 *    schema). In fixed_document mode, gap bands become exact-height spacer
 *    paragraphs so region tables land at their designed y.
 *  - Ellipses render as rectangles; rotation is dropped; url/storage images
 *    are skipped (no network fetch here); rich text is flattened to plain
 *    runs (block tags → line breaks). Shapes placed INSIDE a loop region or
 *    a container's contained content are still not rendered (a pre-existing,
 *    documented gap — no real template currently uses this).
 * @module src/document-designer/rendering/docx-render.service
 */

import { Injectable } from '@nestjs/common';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  FrameAnchorType,
  FrameWrap,
  Header,
  HeightRule,
  ImageRun,
  LineRuleType,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  Footer,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { IFrameOptions, ParagraphChild } from 'docx';
import type {
  IDocElement,
  IDocElementStyle,
  IDocFieldElement,
  IDocImageElement,
  IDocLinkElement,
  IDocLoopRegionElement,
  IDocTextElement,
  IDocumentTemplateDefinition,
} from '../template-definition/template-definition.types';
import { DEFAULT_ELEMENT_STYLE, getPageDimensionsPx } from './render-constants';
import type {
  IDocumentContextItem,
  IDocumentDataContext,
} from './document-data-resolver.service';
import { getSourceEntityConfig } from '../source-entities';
import { MAX_LOOP_REGION_DEPTH } from '../template-definition/template-definition.schema';
import { ElementConditionEvaluator } from './element-condition-evaluator';
import { formatFieldValue, type IDocumentMetaContext } from './field-formatter';
import {
  applyRegionListOps,
  scopedItemsRegion,
  computeFinalVariables,
  decomposeFixedDocumentBands,
  groupChildren,
  interpolateTokensToText,
  resolvePassFailStatus,
  resolveRegionLoopRows,
  splitBandsAtAuthoredBoundaries,
  substituteLiveTokens,
  TEST_STATUS_ROW_COLORS,
  topLevelElements,
} from './document-render.service';
import {
  isTaskListSource,
  listColumnLabel,
  listTableColumns,
} from './task-list-sources';
import { sanitizeHtml } from './html-sanitizer';
import {
  blendOverWhite,
  cssColorToHex,
  DocxNumbering,
  firstFontFamily,
  parseHtml,
  readImageSize,
  renderHtmlBlocks,
  renderHtmlNodes,
  separatorParagraph,
  xmlSafe,
  type HtmlNode,
  type IDocxHtmlOptions,
} from './docx-html';
import {
  atLeast,
  boxCellOptions,
  boxColor,
  cellChildren,
  clusterRowsV2,
  fitInto,
  flowTable,
  gapParagraph,
  groupColumns,
  hasBoxStyle,
  keepRowTogether,
  layoutColumns,
  NO_CELL_BORDERS,
  opacityOf,
  resolveDocxLayout,
  separateTables,
  SNAP_PX,
  twip,
  xmlSafeDeep,
  escapeHtmlText,
  TOKEN_PATTERN,
  type ILayoutCell,
} from './docx-layout';

/** Never part of a visual row/column — its mutation already ran in computeFinalVariables. */
function excludeVariableSets(elements: IDocElement[]): IDocElement[] {
  return elements.filter((el) => el.type !== 'variable_set');
}

export interface IDocxRenderOptions {
  /** See IDocumentRenderOptions.ignoreItemsRegionFilter — same contract. */
  ignoreItemsRegionFilter?: boolean;
  /** public.users.id used for the `exportedBy` meta field. */
  exportedByUserId?: string | null;
  /** Timestamp for the `exportDate` meta field (defaults to now). */
  exportDate?: Date;
  /** Template identity for the `templateName` / `templateDescription` /
   *  `templateUpdatedAt` meta fields — kept in step with
   *  IDocumentRenderOptions so DOCX and HTML/PDF never diverge. */
  templateName?: string | null;
  templateDescription?: string | null;
  templateUpdatedAt?: Date | null;
  /** 'legacy' = the original table flow; default = v2 layout (see docx-layout.ts). */
  layout?: 'v2' | 'legacy';
  /** Pre-downloaded storage images keyed `${bucket}/${path}` (v2 layout only). */
  imageData?: Map<string, IDocxImageData>;
}

/** An embeddable image payload (the formats Word's ImageRun accepts). */
export interface IDocxImageData {
  type: 'png' | 'jpg' | 'gif' | 'bmp';
  data: Buffer;
}

export interface IDocxRenderResult {
  buffer: Buffer;
  warnings: string[];
}

/** CSS px at 96 dpi → twips (1in = 96px = 1440twip ⇒ ×15 exact). */
const PX_TO_TWIP = 15;

/** DOCX cell shading has no alpha channel — flat ~8%-over-white equivalent of the HTML tint. */
const TEST_STATUS_DOCX_TINT = { pass: '#ECF9F5', fail: '#FEF0F0' } as const;

/** Word footer font size, matching the HTML renderer's stamped footer. */
const PAGE_FOOTER_FONT_SIZE_PX = 10;

type DocxBlock = Paragraph | Table;

interface DocxEnv {
  definition: IDocumentTemplateDefinition;
  dataCtx: IDocumentDataContext;
  options: IDocxRenderOptions;
  warnings: string[];
  warnedKeys: Set<string>;
  evaluator: ElementConditionEvaluator;
  childrenByParent: Map<string, IDocElement[]>;
  pageWidth: number;
  pageHeight: number;
  /** Fully computed by computeFinalVariables before rendering starts — see document-render.service's doc. */
  variables: Map<string, unknown>;
  /** `{{live.X}}` support — see RenderEnv's doc in document-render.service.ts. */
  liveTokenCache: Map<string, Map<string, unknown[]>>;
  liveTokenVisitIndex: Map<string, number>;
  /** v2 layout: Word list numbering collected while rendering rich text. */
  numbering: DocxNumbering;
  /** v2 layout: sanitized + parsed static text-element HTML, by element id. */
  htmlCache: Map<string, HtmlNode[]>;
  /** v2 task-list documents: body split into Word sections (see listSectionV2). */
  sectionGroups?: DocxBlock[][];
}

@Injectable()
export class DocxRenderService {
  async renderDocx(
    definition: IDocumentTemplateDefinition,
    dataCtx: IDocumentDataContext,
    options: IDocxRenderOptions = {},
  ): Promise<IDocxRenderResult> {
    const warnings: string[] = [];
    const { width, height } = getPageDimensionsPx(
      definition.page.size,
      definition.page.orientation,
    );

    const env: DocxEnv = {
      definition,
      dataCtx,
      options,
      warnings,
      warnedKeys: new Set<string>(),
      evaluator: new ElementConditionEvaluator(
        getSourceEntityConfig(definition.sourceEntity).itemEntityType,
      ),
      childrenByParent: groupChildren(definition.elements),
      pageWidth: width,
      pageHeight: height,
      variables: new Map(),
      liveTokenCache: new Map(),
      liveTokenVisitIndex: new Map(),
      numbering: new DocxNumbering(),
      htmlCache: new Map(),
    };

    computeFinalVariables(env, (itemIndex, itemCount) =>
      this.buildMeta(env, itemIndex, itemCount),
    );

    const useV2 = resolveDocxLayout(options.layout) === 'v2';
    // v2: every data string reaching Word is XML-safe (lookups/list rows feed the reused legacy cells too).
    if (useV2) env.dataCtx = xmlSafeDeep(env.dataCtx);

    let children: DocxBlock[];
    if (dataCtx.items.length === 0) {
      children = [
        new Paragraph({
          children: [new TextRun('No items matched this export.')],
        }),
      ];
    } else if (useV2 && definition.mode === 'repeat_per_item') {
      children = this.renderRepeatPerItemV2(env);
    } else if (useV2) {
      children = this.renderFixedDocumentV2(env);
    } else if (definition.mode === 'repeat_per_item') {
      children = this.renderRepeatPerItem(env);
    } else {
      children = this.renderFixedDocument(env);
    }

    // getPageDimensionsPx already swapped width/height for landscape, so the
    // orientation flag is intentionally omitted (docx would swap them again).
    // Section margins are 0 — the coordinate model is page-origin (template
    // margins are designer guides only), mirroring the HTML renderer's
    // `@page { margin: 0 }` + unpadded `.doc-root`.
    //
    // Page numbers use a real Word FOOTER with page-number FIELDS (not stamped
    // text) — Word reflows content, so fields stay correct on every page.
    const showPageNumberFooter =
      definition.mode === 'fixed_document' &&
      definition.showPageNumbers === true &&
      !!definition.pages &&
      definition.pages.length > 1;

    // Only lists rendered by the v2 rich-text mapper register numbering.
    const numberingConfig = env.numbering.config();

    // v2 task-list documents: sections with continuation-page margins (the single section below stays for everything else).
    if (env.sectionGroups && env.sectionGroups.length > 0) {
      const listDoc = new Document({
        ...(numberingConfig.length > 0
          ? { numbering: { config: numberingConfig } }
          : {}),
        sections: env.sectionGroups.map((group) =>
          this.listSectionV2(env, group),
        ),
      });

      return {
        buffer: Buffer.from(await Packer.toBuffer(listDoc)),
        warnings,
      };
    }

    const doc = new Document({
      ...(numberingConfig.length > 0
        ? { numbering: { config: numberingConfig } }
        : {}),
      sections: [
        {
          ...(showPageNumberFooter
            ? {
                footers: {
                  default: new Footer({
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [
                          new TextRun({
                            children: [
                              'Page ',
                              PageNumber.CURRENT,
                              ' of ',
                              PageNumber.TOTAL_PAGES,
                            ],
                            size: pxToHalfPoints(PAGE_FOOTER_FONT_SIZE_PX),
                            color: '9CA3AF',
                          }),
                        ],
                      }),
                    ],
                  }),
                },
              }
            : {}),
          properties: {
            page: {
              size: {
                width: pxToTwip(env.pageWidth),
                height: pxToTwip(env.pageHeight),
              },
              margin: { top: 0, right: 0, bottom: 0, left: 0 },
            },
          },
          children,
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);

    return { buffer: Buffer.from(buffer), warnings };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // repeat_per_item
  // ───────────────────────────────────────────────────────────────────────────

  private renderRepeatPerItem(env: DocxEnv): DocxBlock[] {
    const { definition, dataCtx } = env;
    const blocks: DocxBlock[] = [];
    const itemCount = dataCtx.items.length;
    const pageEls = topLevelElements(definition.elements);
    const loopRegions = pageEls.filter(
      (el): el is IDocLoopRegionElement => el.type === 'loop_region',
    );
    const rows = this.clusterRows(
      excludeVariableSets(pageEls.filter((el) => el.type !== 'loop_region')),
    );

    // Unified top-to-bottom render order: loop-region tables interleave with
    // page rows by y-position (not z-index — z-index only orders overlapping
    // content WITHIN a row, handled separately by detectContainers/buildPageRow).
    const ordered: Array<
      | { y: number; region: IDocLoopRegionElement; row?: undefined }
      | { y: number; region?: undefined; row: IDocElement[] }
    > = [
      ...loopRegions.map((region) => ({ y: region.y, region })),
      ...rows.map((row) => ({ y: Math.min(...row.map((el) => el.y)), row })),
    ].sort((a, b) => a.y - b.y);

    dataCtx.items.forEach((item, index) => {
      const meta = this.buildMeta(env, index + 1, itemCount);

      // Every item starts a fresh page (matches HTML/PDF — no shared pages).
      // pageBreakMargin used to be baked into every element's absolute y for
      // items 2+; a single leading spacer gives the same designed clearance
      // without threading an offset through what's now relative/flowing
      // content (exactSpacers(0) is a safe no-op when the margin is 0).
      if (index > 0) {
        blocks.push(new Paragraph({ children: [new PageBreak()] }));
        blocks.push(...this.exactSpacers(definition.page.pageBreakMargin));
      }

      for (const entry of ordered) {
        if (entry.region) {
          const condition = env.evaluator.evaluate(
            entry.region.condition,
            item.raw,
            undefined,
            env.variables,
          );
          if (condition.warning) env.warnings.push(condition.warning);
          if (!condition.show) continue;
          const table = this.regionToTable(entry.region, item, meta, env, 1);
          if (table) blocks.push(table);
        } else {
          const block = this.buildPageRow(entry.row, item, meta, env, item.raw);
          if (block) blocks.push(block);
        }
      }
    });

    return blocks;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // fixed_document — reuses the SHARED band decomposition (no duplication)
  // ───────────────────────────────────────────────────────────────────────────

  private renderFixedDocument(env: DocxEnv): DocxBlock[] {
    const { definition, dataCtx } = env;
    const itemCount = dataCtx.items.length;
    const docMeta = this.buildMeta(env, undefined, itemCount);
    const blocks: DocxBlock[] = [];

    // Bands are decomposed in FULL-PAGE space (page-origin), same as HTML.
    // Authored multi-page support (fixed_document only): split bands at every
    // authored boundary so a PageBreak paragraph can be inserted at each one;
    // legacy defs (no pages) keep today's flow untouched.
    const authoredPages =
      definition.mode === 'fixed_document' ? definition.pages : undefined;
    const useAuthoredPages = !!authoredPages && authoredPages.length > 1;

    const { anchored, bands: rawBands } = decomposeFixedDocumentBands(
      definition.elements,
      env.pageHeight,
      env.warnings,
    );
    let bands = rawBands;

    if (useAuthoredPages) {
      // Extend the tail BEFORE splitting so the splitter cuts it at every
      // authored boundary — same ordering as the HTML renderer.
      const fullHeight = authoredPages.length * env.pageHeight;
      const last = rawBands[rawBands.length - 1];
      if (last && last.end < fullHeight) last.end = fullHeight;

      bands = splitBandsAtAuthoredBoundaries(
        bands,
        env.pageHeight,
        authoredPages.length,
      );
    }

    // Anchored elements repeat on every printed page in HTML/PDF; Word can't
    // do that outside headers/footers — render once at raw page coords, in
    // the same row/table layout as everything else (not frames — that's the
    // whole point of this rewrite).
    const anchoredNonRegion = anchored.filter((el) => {
      if (el.type === 'variable_set') return false;
      if (el.type !== 'loop_region') return true;
      this.warnOnce(
        env,
        `anchored:${el.id}`,
        `Anchored loop region ${el.id} is not supported in Word (skipped)`,
      );

      return false;
    });
    for (const row of this.clusterRows(anchoredNonRegion)) {
      for (const el of row) {
        this.warnOnce(
          env,
          `anchored:${el.id}`,
          `Anchored element ${el.id} renders once (first page only) in Word`,
        );
      }
      const block = this.buildPageRow(row, null, docMeta, env, null);
      if (block) blocks.push(block);
    }

    // Region show/hide conditions run against the meta-only context (same
    // policy as the HTML renderer); a hidden region keeps its designed height
    // as a spacer so later tables stay at their canvas positions.
    const regionVisible = new Map<string, boolean>();
    for (const band of bands) {
      if (!band.region) continue;
      const condition = env.evaluator.evaluate(
        band.region.condition,
        null,
        docMeta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);
      regionVisible.set(band.region.id, condition.show);
    }
    const lastVisibleRegionIdx = bands.reduce(
      (acc, band, idx) =>
        band.region && regionVisible.get(band.region.id) ? idx : acc,
      -1,
    );

    bands.forEach((band, idx) => {
      // Authored pages: a band starting exactly on a boundary k*pageHeight is
      // the FIRST band of authored page k+1 — insert the explicit break there
      // (same technique as the repeat_per_item per-item breaks).
      if (
        useAuthoredPages &&
        idx > 0 &&
        band.start > 0 &&
        band.start % env.pageHeight === 0
      ) {
        blocks.push(new Paragraph({ children: [new PageBreak()] }));
      }

      // Statics anchor to the page at their raw page-origin coordinates, via
      // the same row/table layout as everything else.
      for (const row of this.clusterRows(excludeVariableSets(band.statics))) {
        const block = this.buildPageRow(row, null, docMeta, env, null);
        if (block) blocks.push(block);
      }

      if (band.region && regionVisible.get(band.region.id)) {
        const table = this.itemsRegionToTable(band.region, env);
        if (table) {
          blocks.push(table);
          return;
        }
      }

      // Gap band / hidden or empty region: emit an exact-height spacer so a
      // FOLLOWING region table lands at its designed y. Trailing bands emit
      // nothing (a spacer there would only add blank pages).
      if (idx < lastVisibleRegionIdx) {
        blocks.push(...this.exactSpacers(band.end - band.start));
      }
    });

    if (blocks.length === 0) blocks.push(new Paragraph({ children: [] }));

    return blocks;
  }

  /**
   * Empty paragraphs with EXACT line height totalling `heightPx` — the flow
   * twin of the HTML renderer's fixed-height gap bands. Chunked because a
   * single Word line height caps at 31680 twips.
   */
  private exactSpacers(heightPx: number): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    let remaining = Math.max(0, Math.round(heightPx));
    const CHUNK_PX = 1000;

    while (remaining > 0) {
      const slice = Math.min(remaining, CHUNK_PX);
      remaining -= slice;
      paragraphs.push(
        new Paragraph({
          children: [],
          spacing: {
            before: 0,
            after: 0,
            line: pxToTwip(slice),
            lineRule: LineRuleType.EXACT,
          },
        }),
      );
    }
    return paragraphs;
  }

  /** Top-level `items` region: one table row per scoped item. */
  private itemsRegionToTable(
    region: IDocLoopRegionElement,
    env: DocxEnv,
  ): Table | null {
    const itemCount = env.dataCtx.items.length;
    const entries = applyRegionListOps(
      scopedItemsRegion(region, env.options.ignoreItemsRegionFilter),
      env.dataCtx.items.map((item) => ({ row: item.raw, item })),
      env.evaluator,
      env.warnings,
      env.variables,
    );

    const columns = this.regionColumns(region, env);
    // A row holding a task list may grow past a page, so let Word split it.
    const holdsList = columns.some((column) =>
      column.elements.some(
        (el) => el.type === 'loop_region' && isTaskListSource(el.dataSource),
      ),
    );
    const rows: TableRow[] = [];
    for (const entry of entries) {
      if (!entry.item) continue;
      const index = env.dataCtx.items.indexOf(entry.item);
      const meta = this.buildMeta(env, index + 1, itemCount);
      const { columnBlocks, hasContent } = this.regionChildrenBlocks(
        columns,
        entry.item,
        entry.item.raw,
        meta,
        env,
        1,
      );
      if (!hasContent) continue;
      const badge = this.testStatusBadgeParagraph(
        region,
        entry.item.raw,
        meta,
        env,
      );
      if (badge && columnBlocks[0]) columnBlocks[0].unshift(badge);
      rows.push(
        this.borderlessRow(
          columnBlocks,
          this.testStatusRowStyle(region, entry.item.raw, meta, env),
          !holdsList,
        ),
      );
      // Titles and task lists stack full width under the task's own row.
      rows.push(
        ...this.listBandFlowRows(region, columns.length, entry.item, meta, env),
      );
    }

    if (rows.length === 0) return null;

    // Indent by the region's x so the table keeps the designed horizontal
    // offset (child coordinates are region-relative; the region's own x
    // would otherwise be lost — same fix as the HTML items-region wrapper).
    return this.borderlessTable(
      region.width,
      rows,
      region.x,
      columns.map((c) => c.widthPx),
    );
  }

  /** subtasks / linked_tasks region for one context item (depth ≤ 2). */
  private regionToTable(
    region: IDocLoopRegionElement,
    contextItem: IDocumentContextItem,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    depth: number,
  ): Table | null {
    const rows = resolveRegionLoopRows(
      region,
      contextItem,
      env.dataCtx,
      env.evaluator,
      env.warnings,
      env.variables,
    );
    if (rows.length === 0) return null;

    // Task lists render as a real table: header row + one row per record.
    if (isTaskListSource(region.dataSource)) {
      return this.listTable(region, rows, meta, env, depth);
    }

    const columns = this.regionColumns(region, env);
    const tableRows: TableRow[] = [];
    for (const row of rows) {
      const rowItem: IDocumentContextItem = {
        id: typeof row['id'] === 'string' ? row['id'] : '',
        entityType: 'task',
        raw: row,
      };
      const { columnBlocks, hasContent } = this.regionChildrenBlocks(
        columns,
        rowItem,
        row,
        meta,
        env,
        depth,
      );
      if (!hasContent) continue;
      const badge = this.testStatusBadgeParagraph(region, row, meta, env);
      if (badge && columnBlocks[0]) columnBlocks[0].unshift(badge);
      tableRows.push(
        this.borderlessRow(
          columnBlocks,
          this.testStatusRowStyle(region, row, meta, env),
        ),
      );
    }

    if (tableRows.length === 0) return null;

    // region.x is the offset within its flow container (page for top-level
    // regions in repeat mode, the parent cell for nested regions).
    return this.borderlessTable(
      region.width,
      tableRows,
      region.x,
      columns.map((c) => c.widthPx),
    );
  }

  /**
   * A task list as a bordered table with a header row that repeats on every
   * page — mirrors the HTML list table (same columns, labels and zebra rows).
   */
  private listTable(
    region: IDocLoopRegionElement,
    rows: Array<Record<string, unknown>>,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    depth: number,
  ): Table | null {
    if (!isTaskListSource(region.dataSource)) return null;

    const source = region.dataSource;
    const cells = listTableColumns(env.childrenByParent.get(region.id) ?? []);
    if (cells.length === 0) return null;

    const total = cells.reduce((sum, el) => sum + Math.max(1, el.width), 0);
    const columns = cells.map((el) => ({
      widthPx: (region.width * Math.max(1, el.width)) / total,
      elements: [el],
    }));
    const header = new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: cells.map(
        (el) =>
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: 'F1F5F9' },
            margins: LIST_CELL_MARGINS,
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: listColumnLabel(source, el).toUpperCase(),
                    bold: true,
                    color: '475569',
                    font: 'Arial',
                    size: pxToHalfPoints(10),
                  }),
                ],
              }),
            ],
          }),
      ),
    });

    const body: TableRow[] = [];
    for (const row of rows) {
      const rowItem: IDocumentContextItem = {
        id: typeof row['id'] === 'string' ? row['id'] : '',
        entityType: 'task',
        raw: row,
      };
      const { columnBlocks, hasContent } = this.regionChildrenBlocks(
        columns,
        rowItem,
        row,
        meta,
        env,
        depth,
      );
      if (!hasContent) continue;
      const badge = this.testStatusBadgeParagraph(region, row, meta, env);
      if (badge && columnBlocks[0]) columnBlocks[0].unshift(badge);
      const tint = shadingOf(this.testStatusRowStyle(region, row, meta, env));
      const shading =
        tint ??
        (body.length % 2 === 1
          ? { type: ShadingType.CLEAR, fill: 'F8FAFC' }
          : undefined);
      body.push(
        new TableRow({
          cantSplit: true,
          children: columnBlocks.map(
            (blocks) =>
              new TableCell({
                margins: LIST_CELL_MARGINS,
                ...(shading ? { shading } : {}),
                children: blocks,
              }),
          ),
        }),
      );
    }
    if (body.length === 0) return null;

    return new Table({
      width: { size: pxToTwip(region.width), type: WidthType.DXA },
      columnWidths: columns.map((column) => pxToTwip(column.widthPx)),
      ...(region.x > 0
        ? { indent: { size: pxToTwip(region.x), type: WidthType.DXA } }
        : {}),
      borders: {
        top: LIST_TABLE_LINE,
        bottom: LIST_TABLE_LINE,
        left: LIST_TABLE_LINE,
        right: LIST_TABLE_LINE,
        insideHorizontal: LIST_TABLE_LINE,
        insideVertical: NO_BORDER,
      },
      rows: [header, ...body],
    });
  }

  /**
   * Column layout for a loop region: child elements grouped by distinct x
   * (elements sharing an x are meant to stack within one cell — e.g. a
   * two-line cell; elements at different x sit side by side, matching the
   * canvas). Computed once per region and reused for every row, so column
   * count/order can never vary row to row even when a field's `condition`
   * hides it for some rows — that row just gets an empty cell, never a
   * missing/shifted column.
   *
   * ponytail: groups by exact x equality, not a tolerance range — every real
   * template today places columns at deliberately distinct x offsets. Add a
   * tolerance if a template ever needs near-but-not-equal x treated as one
   * column.
   */
  private regionColumns(
    region: IDocLoopRegionElement,
    env: DocxEnv,
  ): Array<{ widthPx: number; elements: IDocElement[] }> {
    const children = env.childrenByParent.get(region.id) ?? [];

    // Task lists and relative elements render under the row (listBandFlowRows), not as columns.
    const flow = this.listBandFlow(region, env);
    if (flow.length > 0) {
      return this.groupByX(
        excludeVariableSets(children).filter((el) => !flow.includes(el)),
        region.width,
      );
    }

    return this.groupByX(excludeVariableSets(children), region.width);
  }

  /**
   * Children of an items band holding task lists that flow under the task's
   * row: the lists and every relative element (their titles), top to bottom.
   * Empty when the band has no list or nothing else to form the row.
   */
  private listBandFlow(
    region: IDocLoopRegionElement,
    env: DocxEnv,
  ): IDocElement[] {
    const children = excludeVariableSets(
      env.childrenByParent.get(region.id) ?? [],
    );
    const isList = (el: IDocElement) =>
      el.type === 'loop_region' && isTaskListSource(el.dataSource);
    if (!children.some(isList)) return [];

    const flow = children
      .filter((el) => isList(el) || el.positionMode === 'relative')
      .sort((a, b) => a.y - b.y || a.x - b.x);

    return flow.length < children.length ? flow : [];
  }

  /** One full-width row per visible flow element (see listBandFlow); a hidden or empty list adds none. */
  private listBandFlowRows(
    region: IDocLoopRegionElement,
    columnCount: number,
    item: IDocumentContextItem,
    meta: IDocumentMetaContext,
    env: DocxEnv,
  ): TableRow[] {
    const rows: TableRow[] = [];

    for (const el of this.listBandFlow(region, env)) {
      const condition = env.evaluator.evaluate(
        el.condition,
        item.raw,
        undefined,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);
      if (!condition.show) continue;

      const block =
        el.type === 'loop_region'
          ? this.regionToTable(el, item, meta, env, 1)
          : this.elementToFlowBlock(el, item, meta, env);
      if (!block) continue;

      rows.push(
        new TableRow({
          cantSplit: false,
          children: [
            new TableCell({
              columnSpan: Math.max(1, columnCount),
              borders: {
                top: NO_BORDER,
                bottom: NO_BORDER,
                left: NO_BORDER,
                right: NO_BORDER,
              },
              // Word needs a paragraph after a table inside a cell.
              children:
                block instanceof Table
                  ? [block, new Paragraph({ children: [] })]
                  : [block],
            }),
          ],
        }),
      );
    }

    return rows;
  }

  /**
   * Group elements into x-ordered columns (elements sharing an x stack
   * vertically within one cell; elements at different x sit side by side).
   * Shared by loop-region columns (via regionColumns) AND page-level row
   * layout (see clusterRows/buildPageRow) — one grouping rule for both.
   *
   * ponytail: groups by exact x equality, not a tolerance range — every real
   * template today places columns at deliberately distinct x offsets. Add a
   * tolerance if a template ever needs near-but-not-equal x treated as one
   * column.
   */
  private groupByX(
    elements: IDocElement[],
    totalWidthPx: number,
  ): Array<{ widthPx: number; elements: IDocElement[] }> {
    const byX = new Map<number, IDocElement[]>();

    for (const el of elements) {
      const group = byX.get(el.x) ?? [];
      group.push(el);
      byX.set(el.x, group);
    }

    const columns = Array.from(byX.entries())
      .sort(([xa], [xb]) => xa - xb)
      .map(([, els]) => ({
        widthPx: Math.max(...els.map((el) => el.width)),
        elements: [...els].sort((a, b) => a.y - b.y),
      }));

    // Last column absorbs the remainder so columns always sum to the total
    // width — avoids a twip-rounding gap/overflow at the row's right edge.
    if (columns.length > 0) {
      const consumed = columns
        .slice(0, -1)
        .reduce((sum, c) => sum + c.widthPx, 0);
      const last = columns[columns.length - 1];
      last.widthPx = Math.max(last.widthPx, totalWidthPx - consumed);
    }

    return columns;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Page-level rows — table-based layout replacing per-element frames
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Cluster elements into visual rows by Y-RANGE OVERLAP (a sweep-line "line
   * box" pass) — NOT the same as decomposeFixedDocumentBands, which only
   * separates loop-region bands from everything else. That coarse split
   * still runs first (bands are computed by the caller); this is the finer
   * pass within one "everything else" band/pool. Verified against the real
   * "Task Report" template: the header rectangle+title+status+org/date all
   * mutually overlap and merge into one row; each Assignee/Reporter/etc.
   * label-value pair forms its own row (no y-overlap between consecutive
   * pairs); the decorative ellipse merges into the Assignee row (its y-range
   * overlaps), matching its actual designed position.
   */
  private clusterRows(elements: IDocElement[]): IDocElement[][] {
    const sorted = [...elements].sort((a, b) => a.y - b.y);
    const rows: IDocElement[][] = [];
    let current: IDocElement[] = [];
    // Deliberately the LAST-ADDED element's own end, not the accumulated max
    // across the whole group — using the accumulated max lets one unusually
    // tall element (found via real verification: a 40px decorative ellipse)
    // transitively bridge two rows that don't actually overlap each other
    // (e.g. it drags "Reporter" into "Assignee"'s row even though those two
    // don't overlap on their own). Comparing against only the most recent
    // element keeps the chain honest without losing legitimate multi-element
    // merges (verified against the header: el-1/el-2/el-4/el-3 still merge
    // correctly since each consecutive pair genuinely overlaps).
    let lastEnd = -Infinity;

    for (const el of sorted) {
      if (current.length > 0 && el.y < lastEnd) {
        current.push(el);
      } else {
        if (current.length > 0) rows.push(current);
        current = [el];
      }
      lastEnd = el.y + el.height;
    }
    if (current.length > 0) rows.push(current);

    return rows;
  }

  /**
   * Rectangle/ellipse elements in `row` that geometrically contain other row
   * elements AND sit at a LOWER z-index than everything they contain (i.e.
   * designed to render behind them, a background — not an overlay on top).
   * Verified against the real template: el-1 (header rect, zIndex 0) sits
   * below el-2/el-3/el-4 (zIndex 1-3).
   */
  private detectContainers(
    row: IDocElement[],
  ): Map<IDocElement, IDocElement[]> {
    const containers = new Map<IDocElement, IDocElement[]>();

    for (const shape of row) {
      if (shape.type !== 'rectangle' && shape.type !== 'ellipse') continue;
      const contained = row.filter((other) => {
        if (other === shape) return false;
        const within =
          other.x >= shape.x &&
          other.y >= shape.y &&
          other.x + other.width <= shape.x + shape.width &&
          other.y + other.height <= shape.y + shape.height;

        return within && other.zIndex > shape.zIndex;
      });
      if (contained.length > 0) containers.set(shape, contained);
    }

    return containers;
  }

  /**
   * Content for a container's cell: contained elements grouped into
   * sub-columns by x (nested table if >1 sub-column, since a table cell
   * can't otherwise place content side by side — the exact same nested-table
   * technique already proven for nested loop regions).
   */
  private containerCellBlocks(
    container: IDocElement,
    contained: IDocElement[],
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    conditionRow: Record<string, unknown> | null,
  ): DocxBlock[] {
    const visible = contained.filter((el) => {
      const condition = env.evaluator.evaluate(
        el.condition,
        conditionRow,
        meta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);

      return condition.show;
    });
    if (visible.length === 0) return [new Paragraph({ children: [] })];

    const flowBlocksFor = (els: IDocElement[]): DocxBlock[] => {
      const blocks: DocxBlock[] = [];
      for (const el of els) {
        const flow = this.elementToFlowBlock(el, item, meta, env);
        if (flow) blocks.push(flow);
      }

      return blocks.length > 0 ? blocks : [new Paragraph({ children: [] })];
    };

    const subColumns = this.groupByX(visible, container.width);
    if (subColumns.length <= 1) {
      return flowBlocksFor(visible);
    }

    const subRow = this.borderlessRow(
      subColumns.map((col) => flowBlocksFor(col.elements)),
    );

    return [
      this.borderlessTable(
        container.width,
        [subRow],
        0,
        subColumns.map((c) => c.widthPx),
      ),
    ];
  }

  /**
   * One page-level row → a single-cell bordered paragraph (a lone `line`
   * element — the common divider case) or a TableRow with one cell per
   * x-column, each cell shaded/bordered when its column holds a
   * rectangle/ellipse (see detectContainers) or plain/borderless otherwise.
   * Returns null if every element in the row is conditionally hidden for
   * this item.
   */
  private buildPageRow(
    row: IDocElement[],
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    conditionRow: Record<string, unknown> | null,
  ): DocxBlock | null {
    const visible = row.filter((el) => {
      const condition = env.evaluator.evaluate(
        el.condition,
        conditionRow,
        meta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);

      return condition.show;
    });
    if (visible.length === 0) return null;

    // Frame-based rendering used to check this once per element; centralize
    // it here so every path below (container cell, plain column, solo shape)
    // is covered uniformly instead of missing it in some branches.
    for (const el of visible) {
      if (el.rotation) {
        this.warnOnce(
          env,
          `rotation:${el.id}`,
          `Element ${el.id} rotation is not supported in Word (rendered unrotated)`,
        );
      }
    }

    if (visible.length === 1 && visible[0].type === 'line') {
      return this.lineParagraph(visible[0]);
    }

    const containers = this.detectContainers(visible);
    const containedIds = new Set(
      Array.from(containers.values())
        .flat()
        .map((el) => el.id),
    );
    const topLevel = visible.filter((el) => !containedIds.has(el.id));
    if (topLevel.length === 0) return null;

    const minX = Math.min(...topLevel.map((el) => el.x));
    const maxRight = Math.max(...topLevel.map((el) => el.x + el.width));
    const columns = this.groupByX(topLevel, maxRight - minX);

    const cells = columns.map((column) => {
      const shapeEl = column.elements.find(
        (el) => el.type === 'rectangle' || el.type === 'ellipse',
      );

      if (shapeEl) {
        if (shapeEl.type === 'ellipse') {
          this.warnOnce(
            env,
            `ellipse:${shapeEl.id}`,
            `Element ${shapeEl.id}: ellipse rendered as rectangle in Word`,
          );
        }
        const style = shapeEl.style ?? {};
        const contained = containers.get(shapeEl) ?? [];
        const insetPx =
          contained.length > 0
            ? Math.max(0, Math.min(...contained.map((c) => c.x)) - shapeEl.x)
            : 0;

        return {
          widthPx: shapeEl.width,
          blocks:
            contained.length > 0
              ? this.containerCellBlocks(
                  shapeEl,
                  contained,
                  item,
                  meta,
                  env,
                  conditionRow,
                )
              : [new Paragraph({ children: [] })],
          shading: shadingOf(style),
          border: borderOf(style),
          marginLeftPx: insetPx,
        };
      }

      const blocks: DocxBlock[] = [];
      for (const el of column.elements) {
        const flow = this.elementToFlowBlock(el, item, meta, env);
        if (flow) blocks.push(flow);
      }

      return {
        widthPx: column.widthPx,
        blocks: blocks.length > 0 ? blocks : [new Paragraph({ children: [] })],
        shading: undefined,
        border: undefined,
        marginLeftPx: 0,
      };
    });

    // Each page row becomes its own 1-row table (one column per x-group) —
    // rows don't share a table with each other, matching how loop-region and
    // page content already interleave as separate blocks.
    return this.borderlessTable(
      cells.reduce((sum, c) => sum + c.widthPx, 0),
      [this.buildTableRow(cells)],
      minX,
      cells.map((c) => c.widthPx),
    );
  }

  /** Thin bottom-border paragraph for a lone `line` row — no table needed. */
  private lineParagraph(el: IDocElement): Paragraph {
    const style = el.style ?? {};
    const stroke = Math.max(1, el.height);
    const color =
      style.backgroundColor && style.backgroundColor !== 'transparent'
        ? style.backgroundColor
        : (style.borderColor ?? DEFAULT_ELEMENT_STYLE.borderColor);

    return new Paragraph({
      children: [],
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: pxToBorderEighths(stroke),
          color: hexColor(color) ?? '000000',
        },
      },
    });
  }

  /** Page-level table row with per-cell shading/border/margin support. */
  private buildTableRow(
    cells: Array<{
      widthPx: number;
      blocks: DocxBlock[];
      shading?: ReturnType<typeof shadingOf>;
      border?: ReturnType<typeof borderOf>;
      marginLeftPx: number;
    }>,
  ): TableRow {
    return new TableRow({
      cantSplit: true,
      children: cells.map(
        (cell) =>
          new TableCell({
            borders: cell.border
              ? cell.border
              : {
                  top: NO_BORDER,
                  bottom: NO_BORDER,
                  left: NO_BORDER,
                  right: NO_BORDER,
                },
            shading: cell.shading,
            margins:
              cell.marginLeftPx > 0
                ? { left: pxToTwip(cell.marginLeftPx) }
                : undefined,
            children: cell.blocks,
          }),
      ),
    });
  }

  /**
   * Flow blocks for one region row, grouped by column (see regionColumns).
   * `hasContent` tells the caller whether ANY column produced real content —
   * a row where every column falls back to an empty placeholder paragraph
   * (all children condition-hidden, or a nested region resolved zero rows)
   * costs the same one-line minimum as the HTML/PDF renderer's equivalent
   * "nothing to show" case; callers use `hasContent` to skip such rows
   * entirely rather than emitting hundreds of near-empty table rows.
   */
  private regionChildrenBlocks(
    columns: Array<{ widthPx: number; elements: IDocElement[] }>,
    rowItem: IDocumentContextItem,
    conditionRow: Record<string, unknown>,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    depth: number,
  ): { columnBlocks: DocxBlock[][]; hasContent: boolean } {
    let hasContent = false;
    const columnBlocks = columns.map((column) => {
      const blocks: DocxBlock[] = [];

      for (const el of column.elements) {
        const condition = env.evaluator.evaluate(
          el.condition,
          conditionRow,
          undefined,
          env.variables,
        );
        if (condition.warning) env.warnings.push(condition.warning);
        if (!condition.show) continue;

        if (el.type === 'loop_region') {
          if (depth >= MAX_LOOP_REGION_DEPTH) {
            env.warnings.push(
              `Loop region ${el.id} exceeds the maximum nesting depth of ${MAX_LOOP_REGION_DEPTH} (rendered empty)`,
            );
            continue;
          }
          const nested = this.regionToTable(el, rowItem, meta, env, depth + 1);
          if (nested) blocks.push(nested);
          continue;
        }

        const flow = this.elementToFlowBlock(el, rowItem, meta, env);
        if (flow) blocks.push(flow);
      }

      if (blocks.length > 0) hasContent = true;
      if (blocks.length === 0) blocks.push(new Paragraph({ children: [] }));

      return blocks;
    });

    return { columnBlocks, hasContent };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Single elements — page-anchored frames
  // ───────────────────────────────────────────────────────────────────────────

  private elementToFrame(
    el: IDocElement,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    position: { left: number; top: number },
  ): Paragraph {
    if (el.rotation) {
      this.warnOnce(
        env,
        `rotation:${el.id}`,
        `Element ${el.id} rotation is not supported in Word (rendered unrotated)`,
      );
    }

    const frame: IFrameOptions = {
      type: 'absolute',
      position: { x: pxToTwip(position.left), y: pxToTwip(position.top) },
      width: pxToTwip(el.width),
      height: pxToTwip(el.height),
      rule: HeightRule.ATLEAST,
      anchor: {
        horizontal: FrameAnchorType.PAGE,
        vertical: FrameAnchorType.PAGE,
      },
      wrap: FrameWrap.NONE,
    };

    const style = el.style ?? {};
    const base = {
      frame,
      alignment: alignmentOf(style),
      shading: shadingOf(style),
    };

    switch (el.type) {
      case 'line': {
        const stroke = Math.max(1, el.height);
        const color =
          style.backgroundColor && style.backgroundColor !== 'transparent'
            ? style.backgroundColor
            : (style.borderColor ?? DEFAULT_ELEMENT_STYLE.borderColor);

        return new Paragraph({
          frame: {
            ...frame,
            height: pxToTwip(Math.max(1, el.height)),
          },
          children: [],
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: pxToBorderEighths(stroke),
              color: hexColor(color) ?? '000000',
            },
          },
        });
      }
      case 'ellipse':
        this.warnOnce(
          env,
          `ellipse:${el.id}`,
          `Element ${el.id}: ellipse rendered as rectangle in Word`,
        );

        return new Paragraph({
          ...base,
          children: [],
          border: borderOf(style),
        });
      case 'rectangle':
        return new Paragraph({
          ...base,
          children: [],
          border: borderOf(style),
        });
      case 'text':
        return new Paragraph({
          ...base,
          border: borderOf(style),
          children: this.textRuns(el, item, meta, env),
        });
      case 'link':
        return new Paragraph({
          ...base,
          border: borderOf(style),
          children: this.linkChildren(el, item, meta, env),
        });
      case 'field':
        return new Paragraph({
          ...base,
          border: borderOf(style),
          children: this.fieldRuns(el, item, meta, env),
        });
      case 'image':
        return new Paragraph({
          ...base,
          children: this.imageChildren(el, env),
        });
      default:
        return new Paragraph({ ...base, children: [] });
    }
  }

  /** Flow (non-frame) variant used inside loop-region table cells. */
  private elementToFlowBlock(
    el: IDocElement,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
  ): DocxBlock | null {
    const style = el.style ?? {};

    switch (el.type) {
      case 'text':
        return new Paragraph({
          alignment: alignmentOf(style),
          children: this.textRuns(el, item, meta, env),
        });
      case 'field':
        return new Paragraph({
          alignment: alignmentOf(style),
          children: this.fieldRuns(el, item, meta, env),
        });
      case 'link':
        return new Paragraph({
          alignment: alignmentOf(style),
          children: this.linkChildren(el, item, meta, env),
        });
      case 'image':
        return new Paragraph({ children: this.imageChildren(el, env) });
      case 'line':
      case 'rectangle':
      case 'ellipse':
        this.warnOnce(
          env,
          `region-shape:${el.id}`,
          `Shape element ${el.id} inside a loop region is not rendered in Word`,
        );

        return null;
      default:
        return null;
    }
  }

  // ── Element content builders ──────────────────────────────────────────────

  private textRuns(
    el: IDocTextElement,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
  ): ParagraphChild[] {
    const htmlWithLive = substituteLiveTokens(el.html, el.id, env);
    const lines = htmlToTextLines(htmlWithLive).map((line) =>
      interpolateTokensToText(
        line,
        item?.raw ?? null,
        env.dataCtx,
        meta,
        env.warnings,
        env.variables,
      ),
    );

    return this.linesToRuns(lines, el.style);
  }

  private fieldRuns(
    el: IDocFieldElement,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
  ): ParagraphChild[] {
    const html = formatFieldValue(
      el.binding,
      item?.raw ?? null,
      env.dataCtx,
      meta,
      env.warnings,
    );

    return this.linesToRuns(htmlToTextLines(html), el.style);
  }

  private linkChildren(
    el: IDocLinkElement,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
  ): ParagraphChild[] {
    const text = interpolateTokensToText(
      substituteLiveTokens(el.text, el.id, env),
      item?.raw ?? null,
      env.dataCtx,
      meta,
      env.warnings,
      env.variables,
    );
    const href = interpolateTokensToText(
      substituteLiveTokens(el.href, el.id, env),
      item?.raw ?? null,
      env.dataCtx,
      meta,
      env.warnings,
      env.variables,
    ).trim();

    if (!/^https?:\/\//i.test(href)) {
      env.warnings.push(
        `Link element ${el.id} resolved to a non-http(s) URL and was rendered as text`,
      );

      return [new TextRun({ text, ...runStyle(el.style) })];
    }

    return [
      new ExternalHyperlink({
        link: href,
        children: [
          new TextRun({ text, style: 'Hyperlink', ...runStyle(el.style) }),
        ],
      }),
    ];
  }

  private imageChildren(el: IDocImageElement, env: DocxEnv): ParagraphChild[] {
    const src = el.src;
    if (src.kind !== 'data') {
      this.warnOnce(
        env,
        `image:${el.id}`,
        `Image element ${el.id}: ${src.kind} images are not embedded in Word exports (skipped)`,
      );

      return [];
    }

    const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(
      src.dataUri,
    );
    if (!match) {
      // WEBP/SVG/AVIF pass the frontend's upload picker and the schema's own dataUri regex, but
      // the `docx` package's ImageRun only accepts jpg/png/gif/bmp — give a specific, actionable
      // message for that known gap instead of a generic "unsupported format".
      const isKnownUnsupportedFormat =
        /^data:image\/(webp|svg\+xml|avif);base64,/i.test(src.dataUri);
      this.warnOnce(
        env,
        `image:${el.id}`,
        isKnownUnsupportedFormat
          ? `Image element ${el.id}: WEBP/SVG/AVIF images are not supported in Word exports — use PNG, JPEG, GIF, or BMP for this element (skipped)`
          : `Image element ${el.id}: unsupported data URI image format (skipped)`,
      );

      return [];
    }

    const format = match[1].toLowerCase();
    const type = format === 'jpeg' || format === 'jpg' ? 'jpg' : format;

    try {
      return [
        new ImageRun({
          type: type as 'jpg' | 'png' | 'gif' | 'bmp',
          data: Buffer.from(match[2], 'base64'),
          transformation: {
            width: Math.max(1, Math.round(el.width)),
            height: Math.max(1, Math.round(el.height)),
          },
        }),
      ];
    } catch {
      this.warnOnce(
        env,
        `image:${el.id}`,
        `Image element ${el.id}: data image could not be decoded (skipped)`,
      );

      return [];
    }
  }

  private linesToRuns(
    lines: string[],
    style: IDocElementStyle | undefined,
  ): ParagraphChild[] {
    const options = runStyle(style);
    const nonEmpty = lines.length > 0 ? lines : [''];

    return nonEmpty.map(
      (line, index) =>
        new TextRun({
          text: line,
          ...options,
          ...(index > 0 ? { break: 1 } : {}),
        }),
    );
  }

  // ── Table plumbing ────────────────────────────────────────────────────────

  /**
   * One TableCell per column — was a single flattened cell, see regionColumns.
   * `rowStyle` (pass/fail row styling) applies shading across every cell and a
   * left border accent on the first (leftmost, per groupByX's ascending sort)
   * column only, reusing the existing shadingOf/borderOf primitives as-is.
   */
  private borderlessRow(
    columnBlocks: DocxBlock[][],
    rowStyle?: IDocElementStyle,
    cantSplit = true,
  ): TableRow {
    const shading = rowStyle ? shadingOf(rowStyle) : undefined;
    const leftAccent = rowStyle ? borderOf(rowStyle)?.left : undefined;

    return new TableRow({
      cantSplit,
      children: columnBlocks.map(
        (blocks, index) =>
          new TableCell({
            borders: {
              top: NO_BORDER,
              bottom: NO_BORDER,
              left: index === 0 && leftAccent ? leftAccent : NO_BORDER,
              right: NO_BORDER,
            },
            ...(shading ? { shading } : {}),
            children: blocks,
          }),
      ),
    });
  }

  /** Pass/fail styling for one loop row: background shading only, via the existing element-style shape so shadingOf can build it. */
  private testStatusRowStyle(
    region: IDocLoopRegionElement,
    row: Record<string, unknown>,
    meta: IDocumentMetaContext,
    env: DocxEnv,
  ): IDocElementStyle | undefined {
    const status = resolvePassFailStatus(region, row, meta, env);
    if (!status) return undefined;

    return {
      backgroundColor: TEST_STATUS_DOCX_TINT[status],
    };
  }

  /**
   * Small bold "Pass"/"Fail" text paragraph for one loop row, prepended
   * ahead of the row's own content in the leftmost cell — the tint alone can
   * be too subtle (grayscale printing, small color difference), so the
   * classification is also stated as text. Same resolvePassFailStatus() call
   * as testStatusRowStyle — one classification, two visual outputs.
   */
  private testStatusBadgeParagraph(
    region: IDocLoopRegionElement,
    row: Record<string, unknown>,
    meta: IDocumentMetaContext,
    env: DocxEnv,
  ): Paragraph | null {
    const status = resolvePassFailStatus(region, row, meta, env);
    if (!status) return null;

    const tokens = TEST_STATUS_ROW_COLORS[status];

    return new Paragraph({
      children: [
        new TextRun({
          text: tokens.label,
          bold: true,
          color: tokens.solid.replace('#', ''),
          size: pxToHalfPoints(10),
        }),
      ],
    });
  }

  private borderlessTable(
    widthPx: number,
    rows: TableRow[],
    indentPx = 0,
    columnWidthsPx?: number[],
  ): Table {
    return new Table({
      width: { size: pxToTwip(widthPx), type: WidthType.DXA },
      ...(columnWidthsPx
        ? { columnWidths: columnWidthsPx.map((w) => pxToTwip(w)) }
        : {}),
      ...(indentPx > 0
        ? { indent: { size: pxToTwip(indentPx), type: WidthType.DXA } }
        : {}),
      borders: {
        top: NO_BORDER,
        bottom: NO_BORDER,
        left: NO_BORDER,
        right: NO_BORDER,
        insideHorizontal: NO_BORDER,
        insideVertical: NO_BORDER,
      },
      rows,
    });
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  private buildMeta(
    env: DocxEnv,
    itemIndex: number | undefined,
    itemCount: number,
  ): IDocumentMetaContext {
    return {
      exportDate: env.options.exportDate ?? new Date(),
      exportedByUserId: env.options.exportedByUserId ?? null,
      templateName: env.options.templateName ?? null,
      templateDescription: env.options.templateDescription ?? null,
      templateUpdatedAt: env.options.templateUpdatedAt ?? null,
      itemIndex,
      itemCount,
      sourceEntity: env.definition.sourceEntity,
    };
  }

  private warnOnce(env: DocxEnv, key: string, message: string): void {
    if (env.warnedKeys.has(key)) return;
    env.warnedKeys.add(key);
    env.warnings.push(message);
  }

  // v2 layout — keeps designed positions and element styling (docx-layout.ts,
  // docx-html.ts). Everything above stays the legacy path (layout: 'legacy').

  private renderRepeatPerItemV2(env: DocxEnv): DocxBlock[] {
    const { definition, dataCtx } = env;
    const blocks: DocxBlock[] = [];
    const itemCount = dataCtx.items.length;
    const pageEls = topLevelElements(definition.elements);
    const regions = pageEls.filter(
      (el): el is IDocLoopRegionElement => el.type === 'loop_region',
    );
    const hasLists = regions.some((region) =>
      isTaskListSource(region.dataSource),
    );
    const rows = clusterRowsV2(
      excludeVariableSets(pageEls.filter((el) => el.type !== 'loop_region')),
    );
    const ordered: Array<
      | { y: number; region: IDocLoopRegionElement; row?: undefined }
      | { y: number; region?: undefined; row: IDocElement[] }
    > = [
      ...regions.map((region) => ({ y: region.y, region })),
      ...rows.map((row) => ({ y: Math.min(...row.map((el) => el.y)), row })),
    ].sort((a, b) => a.y - b.y);

    // With task lists every record is its own Word section (continuation-page margins, see listSectionV2).
    const groups: DocxBlock[][] = [];

    dataCtx.items.forEach((item, index) => {
      const meta = this.buildMeta(env, index + 1, itemCount);
      const start = blocks.length;

      // Same break + pageBreakMargin as the legacy path; the 1pt mark can't spill a blank page.
      if (index > 0) {
        if (!hasLists) {
          blocks.push(
            new Paragraph({ children: [new PageBreak()], run: { size: 2 } }),
          );
        }
        blocks.push(...this.exactSpacers(definition.page.pageBreakMargin));
      }

      let cursor = 0;
      for (const entry of ordered) {
        if (entry.region) {
          const region = entry.region;
          const bottom = region.y + region.height;
          const condition = env.evaluator.evaluate(
            region.condition,
            item.raw,
            undefined,
            env.variables,
          );
          if (condition.warning) env.warnings.push(condition.warning);
          const metrics = { designedHeight: region.height };
          const table = condition.show
            ? this.regionToTableV2(
                region,
                item,
                meta,
                env,
                1,
                region.x,
                metrics,
              )
            : null;
          if (!table) {
            // A hidden/empty task list collapses in the HTML flow; other regions keep their space.
            if (isTaskListSource(region.dataSource)) {
              cursor = Math.max(cursor, bottom);
            }
            continue;
          }
          blocks.push(...this.exactSpacers(region.y - cursor), table);
          // A region's designed height is a minimum (HTML max(region.height, rendered)); lists flow.
          if (!isTaskListSource(region.dataSource)) {
            blocks.push(
              ...this.exactSpacers(region.height - metrics.designedHeight),
            );
          }
          cursor = Math.max(cursor, bottom);
          continue;
        }

        const placed = this.buildPageRowV2(
          entry.row,
          item,
          meta,
          env,
          item.raw,
          hasLists,
        );
        if (!placed) continue;
        blocks.push(...this.exactSpacers(placed.top - cursor), placed.block);
        cursor = Math.max(cursor, placed.bottom);
      }

      groups.push([
        ...separateTables(blocks.slice(start)),
        separatorParagraph(),
      ]);
    });

    if (hasLists) env.sectionGroups = groups;

    return [...separateTables(blocks), separatorParagraph()];
  }

  /**
   * Task-list documents (HTML adds page margins there): the record's first page keeps its
   * designed layout (empty first-page header, top margin 0), continuation pages start below a
   * header as tall as max(pageBreakMargin, margins.top), and every page keeps the bottom margin —
   * so a table running onto the next page never touches the paper edge.
   */
  private listSectionV2(env: DocxEnv, children: DocxBlock[]) {
    const { page } = env.definition;
    const topPx = Math.max(page.pageBreakMargin, page.margins.top);

    return {
      headers: {
        first: new Header({ children: [separatorParagraph()] }),
        ...(topPx > 0
          ? {
              default: new Header({
                children: [
                  new Paragraph({
                    children: [],
                    spacing: {
                      before: 0,
                      after: 0,
                      line: twip(topPx),
                      lineRule: LineRuleType.EXACT,
                    },
                  }),
                ],
              }),
            }
          : {}),
      },
      properties: {
        titlePage: true,
        page: {
          size: {
            width: pxToTwip(env.pageWidth),
            height: pxToTwip(env.pageHeight),
          },
          margin: {
            top: 0,
            right: 0,
            bottom: twip(Math.max(0, page.margins.bottom)),
            left: 0,
            header: 0,
            footer: 0,
          },
        },
      },
      children,
    };
  }

  private renderFixedDocumentV2(env: DocxEnv): DocxBlock[] {
    const { definition, dataCtx } = env;
    const docMeta = this.buildMeta(env, undefined, dataCtx.items.length);
    const blocks: DocxBlock[] = [];
    const authoredPages =
      definition.mode === 'fixed_document' ? definition.pages : undefined;
    const useAuthoredPages = !!authoredPages && authoredPages.length > 1;

    const { anchored, bands: rawBands } = decomposeFixedDocumentBands(
      definition.elements,
      env.pageHeight,
      env.warnings,
    );
    let bands = rawBands;
    if (useAuthoredPages) {
      const fullHeight = authoredPages.length * env.pageHeight;
      const last = rawBands[rawBands.length - 1];
      if (last && last.end < fullHeight) last.end = fullHeight;
      bands = splitBandsAtAuthoredBoundaries(
        bands,
        env.pageHeight,
        authoredPages.length,
      );
    }

    // Anchored elements render once at their designed y (first page) — same warnings as the legacy path.
    const staticsByBand = bands.map((band) => [...band.statics]);
    for (const el of anchored) {
      if (el.type === 'variable_set') continue;
      if (el.type === 'loop_region') {
        this.warnOnce(
          env,
          `anchored:${el.id}`,
          `Anchored loop region ${el.id} is not supported in Word (skipped)`,
        );
        continue;
      }
      this.warnOnce(
        env,
        `anchored:${el.id}`,
        `Anchored element ${el.id} renders once (first page only) in Word`,
      );
      const index = bands.findIndex(
        (band) => el.y >= band.start && el.y < band.end,
      );
      staticsByBand[index >= 0 ? index : staticsByBand.length - 1]?.push(el);
    }

    const regionVisible = new Map<string, boolean>();
    for (const band of bands) {
      if (!band.region) continue;
      const condition = env.evaluator.evaluate(
        band.region.condition,
        null,
        docMeta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);
      regionVisible.set(band.region.id, condition.show);
    }
    // Gaps close up to the last band holding anything (statics or a visible region), so later statics keep their y.
    const lastContentIdx = bands.reduce(
      (acc, band, idx) =>
        excludeVariableSets(staticsByBand[idx]).length > 0 ||
        (band.region && regionVisible.get(band.region.id))
          ? idx
          : acc,
      -1,
    );
    const startsAuthoredPage = (band: { start: number }) =>
      useAuthoredPages && band.start > 0 && band.start % env.pageHeight === 0;

    bands.forEach((band, idx) => {
      if (idx > 0 && startsAuthoredPage(band)) {
        blocks.push(
          new Paragraph({ children: [new PageBreak()], run: { size: 2 } }),
        );
      }

      // Statics sit at their designed y inside the band (cursor from band.start).
      let cursor = band.start;
      for (const row of clusterRowsV2(
        excludeVariableSets(staticsByBand[idx]),
      )) {
        const placed = this.buildPageRowV2(
          row,
          null,
          docMeta,
          env,
          null,
          false,
        );
        if (!placed) continue;
        blocks.push(...this.exactSpacers(placed.top - cursor), placed.block);
        cursor = Math.max(cursor, placed.bottom);
      }

      if (band.region && regionVisible.get(band.region.id)) {
        const table = this.itemsRegionToTableV2(band.region, env);
        if (table) {
          blocks.push(...this.exactSpacers(band.start - cursor), table);
          return;
        }
      }

      // Close the gap to the next band, except right before an authored page break.
      const next = bands[idx + 1];
      if (idx < lastContentIdx && !(next && startsAuthoredPage(next))) {
        blocks.push(...this.exactSpacers(band.end - cursor));
      }
    });

    const result = [...separateTables(blocks), separatorParagraph()];
    // Same condition as the HTML list-page margins (task lists, at most one authored page).
    const hasLists = definition.elements.some(
      (el) => el.type === 'loop_region' && isTaskListSource(el.dataSource),
    );
    if (hasLists && (definition.pages?.length ?? 0) <= 1) {
      env.sectionGroups = [result];
    }

    return result;
  }

  /** One visual row → a fixed-layout table whose columns keep their designed x. */
  private buildPageRowV2(
    row: IDocElement[],
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    conditionRow: Record<string, unknown> | null,
    hasLists: boolean,
  ): { block: DocxBlock; top: number; bottom: number } | null {
    const visible = row.filter((el) => {
      const condition = env.evaluator.evaluate(
        el.condition,
        conditionRow,
        meta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);

      return condition.show;
    });
    if (visible.length === 0) return null;

    for (const el of visible) {
      if (el.rotation) {
        this.warnOnce(
          env,
          `rotation:${el.id}`,
          `Element ${el.id} rotation is not supported in Word (rendered unrotated)`,
        );
      }
    }

    const top = Math.min(...visible.map((el) => el.y));
    const bottom = Math.max(...visible.map((el) => el.y + el.height));

    if (visible.length === 1 && visible[0].type === 'line') {
      return {
        block: this.lineParagraphV2(visible[0], 0, env.pageWidth),
        top,
        bottom,
      };
    }

    const containers = this.detectContainers(visible);
    const containedIds = new Set(
      Array.from(containers.values())
        .flat()
        .map((el) => el.id),
    );
    const topLevel = visible.filter((el) => !containedIds.has(el.id));
    if (topLevel.length === 0) return null;

    const { indentPx, cells } = layoutColumns(
      groupColumns(topLevel),
      0,
      env.pageWidth,
      false,
    );
    const texts: string[] = [];
    const tableCells = cells.map((cell) =>
      this.pageCellV2(
        cell,
        containers,
        { top, bottom, hugRelative: hasLists },
        item,
        meta,
        env,
        conditionRow,
        texts,
      ),
    );
    // HTML list flow gives relative elements no minimum height — mirror it there.
    const minHeight = Math.max(
      0,
      ...visible
        .filter((el) => !(hasLists && el.positionMode === 'relative'))
        .map((el) => el.y + el.height - top),
    );
    const tableRow = new TableRow({
      cantSplit: keepRowTogether(texts),
      ...(minHeight > 0 ? { height: atLeast(minHeight) } : {}),
      children: tableCells,
    });

    return {
      block: flowTable(
        [tableRow],
        cells.map((cell) => cell.widthTwip),
        indentPx,
      ),
      top,
      bottom,
    };
  }

  private pageCellV2(
    cell: ILayoutCell,
    containers: Map<IDocElement, IDocElement[]>,
    rowBox: { top: number; bottom: number; hugRelative?: boolean },
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    conditionRow: Record<string, unknown> | null,
    texts: string[],
  ): TableCell {
    if (cell.kind === 'gap') {
      return new TableCell({
        borders: NO_CELL_BORDERS,
        children: [separatorParagraph()],
      });
    }

    const shape = cell.elements.find(
      (el) => el.type === 'rectangle' || el.type === 'ellipse',
    );
    // A shape sharing its x with other elements stacks with them (never swallows them).
    if (shape && cell.elements.length === 1) {
      if (shape.type === 'ellipse') {
        this.warnOnce(
          env,
          `ellipse:${shape.id}`,
          `Element ${shape.id}: ellipse rendered as rectangle in Word`,
        );
      }
      // A shape's padding has no effect in HTML (its content is positioned) — ignore it here too.
      const box = { ...boxCellOptions(shape.style), padding: 0 };
      const contained = containers.get(shape) ?? [];
      const inner =
        contained.length > 0
          ? this.containerBlocksV2(
              shape,
              contained,
              item,
              meta,
              env,
              conditionRow,
              box.fill,
              texts,
              containers,
            )
          : { blocks: [separatorParagraph()], top: 0, left: 0 };

      return this.boxedCellV2(cell, shape, box, inner.blocks, rowBox, {
        top: inner.top,
        left: inner.left + cell.padLeftPx,
      });
    }

    if (cell.elements.length === 1) {
      const el = cell.elements[0];
      if (el.type === 'line') return this.lineCellV2(el, cell, rowBox.top);
      const box = boxCellOptions(el.style);
      const content = this.elementBlocksV2(
        el,
        item,
        meta,
        env,
        cell.widthPx - cell.padLeftPx - 2 * box.padding,
        undefined,
        texts,
      );

      return this.boxedCellV2(cell, el, box, content, rowBox, {
        top: 0,
        left: cell.padLeftPx,
      });
    }

    return new TableCell({
      borders: NO_CELL_BORDERS,
      ...(cell.padLeftPx > 0
        ? { margins: { left: twip(cell.padLeftPx) } }
        : {}),
      children: cellChildren(
        this.stackBlocksV2(
          cell.elements,
          rowBox.top,
          cell,
          item,
          meta,
          env,
          undefined,
          texts,
          conditionRow,
          containers,
        ),
      ),
    });
  }

  /** Styles the cell itself when the box fills its row; otherwise nests a box table at its offset. */
  private boxedCellV2(
    cell: ILayoutCell,
    el: IDocElement,
    box: ReturnType<typeof boxCellOptions>,
    content: DocxBlock[],
    rowBox: { top: number; bottom: number; hugRelative?: boolean },
    inset: { top: number; left: number },
  ): TableCell {
    const offset = Math.max(0, el.y - rowBox.top);
    const styled = hasBoxStyle(el.style);
    // HTML list flow sizes relative boxes to their content, not their designed height.
    const hugsContent = !!rowBox.hugRelative && el.positionMode === 'relative';
    const fills =
      !hugsContent &&
      offset <= SNAP_PX &&
      Math.abs(el.y + el.height - rowBox.bottom) <= SNAP_PX;

    if (!styled || fills) {
      const pad = styled ? box.padding : 0;

      return new TableCell({
        borders: styled ? box.borders : NO_CELL_BORDERS,
        ...(styled && box.shading ? { shading: box.shading } : {}),
        margins: {
          top: twip(pad + (fills ? 0 : offset) + inset.top),
          bottom: twip(pad),
          left: twip(pad + inset.left),
          right: twip(pad),
        },
        children: cellChildren(content),
      });
    }

    return new TableCell({
      borders: NO_CELL_BORDERS,
      margins: { top: twip(offset), bottom: 0, left: 0, right: 0 },
      children: cellChildren([
        this.boxTableV2(
          el,
          box,
          content,
          Math.min(el.width, cell.widthPx),
          inset,
          hugsContent ? 0 : el.height,
        ),
      ]),
    });
  }

  /** A 1×1 table carrying one element's box (height is a minimum, grows with content). */
  private boxTableV2(
    el: IDocElement,
    box: ReturnType<typeof boxCellOptions>,
    content: DocxBlock[],
    widthPx: number,
    inset: { top: number; left: number },
    minHeightPx = el.height,
    indentPx = 0,
  ): Table {
    const pad = box.padding;

    return flowTable(
      [
        new TableRow({
          cantSplit: false,
          ...(minHeightPx > 0 ? { height: atLeast(minHeightPx) } : {}),
          children: [
            new TableCell({
              borders: box.borders,
              ...(box.shading ? { shading: box.shading } : {}),
              margins: {
                top: twip(pad + inset.top),
                bottom: twip(pad),
                left: twip(pad + inset.left),
                right: twip(pad),
              },
              children: cellChildren(content),
            }),
          ],
        }),
      ],
      [twip(Math.max(1, widthPx))],
      indentPx,
    );
  }

  /** Elements stacked in one column: designed gaps between them, heights kept except the last. */
  private stackBlocksV2(
    elements: IDocElement[],
    originY: number,
    column: { x: number; widthPx: number },
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    beneath: string | undefined,
    texts: string[],
    conditionRow: Record<string, unknown> | null = null,
    containers?: Map<IDocElement, IDocElement[]>,
  ): DocxBlock[] {
    const blocks: DocxBlock[] = [];
    const sorted = [...elements].sort((a, b) => a.y - b.y);
    let previousBottom = originY;

    sorted.forEach((el, index) => {
      const gap = Math.max(0, el.y - previousBottom);
      if (gap > 0 || index > 0) blocks.push(gapParagraph(gap));
      previousBottom = Math.max(previousBottom, el.y + el.height);
      // Stacked elements keep their own x inside the column.
      const offset = Math.min(
        Math.max(0, el.x - column.x),
        Math.max(0, column.widthPx - 1),
      );
      const widthPx = Math.max(1, Math.min(el.width, column.widthPx - offset));

      if (el.type === 'line') {
        blocks.push(
          this.lineParagraphV2(el, column.x, column.x + column.widthPx),
        );
        return;
      }
      const box = boxCellOptions(el.style, beneath);
      if (el.type === 'rectangle' || el.type === 'ellipse') {
        const shapeBox = { ...box, padding: 0 };
        const contained = containers?.get(el) ?? [];
        const inner =
          contained.length > 0
            ? this.containerBlocksV2(
                el,
                contained,
                item,
                meta,
                env,
                conditionRow,
                shapeBox.fill,
                texts,
                containers,
              )
            : { blocks: [separatorParagraph()], top: 0, left: 0 };
        blocks.push(
          this.boxTableV2(
            el,
            shapeBox,
            inner.blocks,
            widthPx,
            inner,
            el.height,
            offset,
          ),
        );
        return;
      }

      const content = this.elementBlocksV2(
        el,
        item,
        meta,
        env,
        widthPx - 2 * box.padding,
        beneath,
        texts,
      );
      const keepHeight = index < sorted.length - 1 || hasBoxStyle(el.style);
      if (keepHeight || offset > 0) {
        blocks.push(
          this.boxTableV2(
            el,
            box,
            content,
            widthPx,
            { top: 0, left: 0 },
            keepHeight ? el.height : 0,
            offset,
          ),
        );
      } else {
        blocks.push(...content);
      }
    });

    return blocks;
  }

  /** Content inside a background shape: its own sub-columns, offset by the content's inset. */
  private containerBlocksV2(
    shape: IDocElement,
    contained: IDocElement[],
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    conditionRow: Record<string, unknown> | null,
    beneath: string | undefined,
    texts: string[],
    containers?: Map<IDocElement, IDocElement[]>,
  ): { blocks: DocxBlock[]; top: number; left: number } {
    // Content of an inner shape renders inside that shape, not beside it.
    const ownedByInner = new Set(
      contained.flatMap((el) =>
        el !== shape ? (containers?.get(el) ?? []).map((c) => c.id) : [],
      ),
    );
    const visible = contained.filter((el) => {
      if (ownedByInner.has(el.id)) return false;
      const condition = env.evaluator.evaluate(
        el.condition,
        conditionRow,
        meta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);

      return condition.show;
    });
    if (visible.length === 0) {
      return { blocks: [separatorParagraph()], top: 0, left: 0 };
    }

    const minX = Math.min(...visible.map((el) => el.x));
    const minY = Math.min(...visible.map((el) => el.y));
    const right = shape.x + shape.width;
    const inset = {
      top: Math.max(0, minY - shape.y),
      left: Math.max(0, minX - shape.x),
    };
    const columns = groupColumns(visible);

    if (columns.length <= 1) {
      return {
        blocks: this.stackBlocksV2(
          visible,
          minY,
          { x: minX, widthPx: Math.max(1, right - minX) },
          item,
          meta,
          env,
          beneath,
          texts,
          conditionRow,
          containers,
        ),
        ...inset,
      };
    }

    const { cells } = layoutColumns(columns, minX, right, false);
    const row = new TableRow({
      cantSplit: false,
      children: cells.map(
        (cell) =>
          new TableCell({
            borders: NO_CELL_BORDERS,
            children: cellChildren(
              cell.kind === 'gap'
                ? []
                : this.stackBlocksV2(
                    cell.elements,
                    minY,
                    cell,
                    item,
                    meta,
                    env,
                    beneath,
                    texts,
                    conditionRow,
                    containers,
                  ),
            ),
          }),
      ),
    });

    return {
      blocks: [
        flowTable(
          [row],
          cells.map((cell) => cell.widthTwip),
        ),
      ],
      ...inset,
    };
  }

  /** Line within its designed horizontal span; stroke follows the PDF rule (borderWidth, default 1px). */
  private lineParagraphV2(
    el: IDocElement,
    originX: number,
    rightX: number,
  ): Paragraph {
    const style = el.style ?? {};
    const stroke = Math.max(1, style.borderWidth ?? 1);
    const source =
      style.backgroundColor && style.backgroundColor !== 'transparent'
        ? style.backgroundColor
        : (style.borderColor ?? DEFAULT_ELEMENT_STYLE.borderColor);
    const color = boxColor(source, opacityOf(style)) ?? '000000';

    return new Paragraph({
      children: [],
      indent: {
        left: twip(Math.max(0, el.x - originX)),
        right: twip(Math.max(0, rightX - (el.x + el.width))),
      },
      spacing: {
        before: 0,
        after: 0,
        line: Math.max(1, twip(Math.max(1, el.height - stroke))),
        lineRule: LineRuleType.EXACT,
      },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: Math.max(1, Math.round(stroke * 6)),
          color,
        },
      },
    });
  }

  /** A line sharing a row: horizontal → bottom rule in its cell, vertical → the cell's left border. */
  private lineCellV2(
    el: IDocElement,
    cell: ILayoutCell,
    rowTop: number,
  ): TableCell {
    const offset = Math.max(0, el.y - rowTop);
    if (el.width >= el.height) {
      return new TableCell({
        borders: NO_CELL_BORDERS,
        margins: { top: twip(offset), bottom: 0, left: 0, right: 0 },
        children: [this.lineParagraphV2(el, cell.x, cell.x + cell.widthPx)],
      });
    }

    const style = el.style ?? {};
    const stroke = Math.max(1, style.borderWidth ?? 1, el.width);
    const source =
      style.backgroundColor && style.backgroundColor !== 'transparent'
        ? style.backgroundColor
        : (style.borderColor ?? DEFAULT_ELEMENT_STYLE.borderColor);

    return new TableCell({
      borders: {
        ...NO_CELL_BORDERS,
        left: {
          style: BorderStyle.SINGLE,
          size: Math.max(1, Math.round(stroke * 6)),
          color: boxColor(source, opacityOf(style)) ?? '000000',
        },
      },
      children: [separatorParagraph()],
    });
  }

  /** Text/field/link/image content as rich Word blocks (runs once per visit — live tokens). */
  private elementBlocksV2(
    el: IDocElement,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    maxWidthPx: number,
    beneath: string | undefined,
    texts: string[],
  ): DocxBlock[] {
    const style = el.style ?? {};
    const opacity = opacityOf(style);
    const textColor = cssColorToHex(style.color) ?? '000000';
    const options: IDocxHtmlOptions = {
      base: {
        font:
          firstFontFamily(style.fontFamily) ?? DEFAULT_ELEMENT_STYLE.fontFamily,
        sizePx: style.fontSize ?? DEFAULT_ELEMENT_STYLE.fontSize,
        bold: (style.fontWeight ?? DEFAULT_ELEMENT_STYLE.fontWeight) >= 600,
        // docx-html expects the base colour already blended.
        color:
          opacity < 1 ? blendOverWhite(textColor, opacity, beneath) : textColor,
      },
      align: alignmentOf(style),
      lineHeight: style.lineHeight,
      keepNewlines: true,
      numbering: env.numbering,
      warn: (key, message) => this.warnOnce(env, key, message),
      maxWidthPx: Math.max(1, maxWidthPx),
      ...(opacity < 1
        ? {
            colorTransform: (hex: string) =>
              blendOverWhite(hex, opacity, beneath),
          }
        : {}),
    };

    switch (el.type) {
      case 'text': {
        const html = substituteLiveTokens(el.html, el.id, env);
        texts.push(html);

        // Tokens (incl. live ones): HTML-path order — escaped values, then sanitize — so token hrefs survive.
        if (el.html.includes('{{')) {
          const interpolated = html.replace(TOKEN_PATTERN, (token) =>
            escapeHtmlText(
              interpolateTokensToText(
                token,
                item?.raw ?? null,
                env.dataCtx,
                meta,
                env.warnings,
                env.variables,
              ),
            ).replace(/\r?\n/g, '<br>'),
          );

          return renderHtmlNodes(
            parseHtml(sanitizeHtml(interpolated)),
            options,
          );
        }

        return renderHtmlNodes(this.htmlNodesV2(env, el.id, html), options);
      }
      case 'field': {
        const value = formatFieldValue(
          el.binding,
          item?.raw ?? null,
          env.dataCtx,
          meta,
          env.warnings,
        );
        texts.push(value);

        return renderHtmlBlocks(value, options);
      }
      case 'link':
        return [this.linkParagraphV2(el, item, meta, env, options, texts)];
      case 'image':
        return this.imageBlocksV2(el, env);
      default:
        return [];
    }
  }

  /** Static template HTML is sanitized + parsed once per element; `{{live.}}` HTML changes per visit. */
  private htmlNodesV2(env: DocxEnv, id: string, html: string): HtmlNode[] {
    if (html.includes('{{live.')) return parseHtml(sanitizeHtml(html));
    const cached = env.htmlCache.get(id);
    if (cached) return cached;
    const nodes = parseHtml(sanitizeHtml(html));
    env.htmlCache.set(id, nodes);

    return nodes;
  }

  private linkParagraphV2(
    el: IDocLinkElement,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    options: IDocxHtmlOptions,
    texts: string[],
  ): Paragraph {
    const text = interpolateTokensToText(
      substituteLiveTokens(el.text, el.id, env),
      item?.raw ?? null,
      env.dataCtx,
      meta,
      env.warnings,
      env.variables,
    );
    const href = interpolateTokensToText(
      substituteLiveTokens(el.href, el.id, env),
      item?.raw ?? null,
      env.dataCtx,
      meta,
      env.warnings,
      env.variables,
    ).trim();
    texts.push(text);
    const run = {
      text: xmlSafe(text),
      font: options.base.font,
      size: pxToHalfPoints(options.base.sizePx),
      bold: options.base.bold,
      color: options.base.color ?? '000000',
    };

    if (!/^https?:\/\//i.test(href)) {
      env.warnings.push(
        `Link element ${el.id} resolved to a non-http(s) URL and was rendered as text`,
      );

      return new Paragraph({
        alignment: options.align,
        children: [new TextRun(run)],
      });
    }

    return new Paragraph({
      alignment: options.align,
      children: [
        new ExternalHyperlink({
          link: xmlSafe(href),
          children: [new TextRun({ ...run, underline: {} })],
        }),
      ],
    });
  }

  /** Data and pre-downloaded storage images; fill stretches, contain/cover fit (Word can't crop). */
  private imageBlocksV2(el: IDocImageElement, env: DocxEnv): DocxBlock[] {
    const src = el.src;
    let payload: IDocxImageData | undefined;

    if (src.kind === 'data') {
      // [\s\S]: base64 may be line-wrapped.
      const match = /^data:image\/(png|jpe?g|gif|bmp);base64,([\s\S]+)$/i.exec(
        src.dataUri,
      );
      if (!match) {
        const isKnownUnsupportedFormat =
          /^data:image\/(webp|svg\+xml|avif);base64,/i.test(src.dataUri);
        this.warnOnce(
          env,
          `image:${el.id}`,
          isKnownUnsupportedFormat
            ? `Image element ${el.id}: WEBP/SVG/AVIF images are not supported in Word exports — use PNG, JPEG, GIF, or BMP for this element (skipped)`
            : `Image element ${el.id}: unsupported data URI image format (skipped)`,
        );

        return [];
      }
      const format = match[1].toLowerCase();
      payload = {
        type:
          format === 'jpeg' || format === 'jpg'
            ? 'jpg'
            : (format as 'png' | 'gif' | 'bmp'),
        data: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
      };
    } else if (src.kind === 'storage') {
      payload = env.options.imageData?.get(`${src.bucket}/${src.path}`);
    }

    if (!payload) {
      this.warnOnce(
        env,
        `image:${el.id}`,
        src.kind === 'storage'
          ? `Image element ${el.id}: storage image could not be loaded for Word (skipped)`
          : `Image element ${el.id}: ${src.kind} images are not embedded in Word exports (skipped)`,
      );

      return [];
    }

    const size =
      el.objectFit === 'fill'
        ? {
            width: Math.max(1, Math.round(el.width)),
            height: Math.max(1, Math.round(el.height)),
          }
        : fitInto(readImageSize(payload.data), el);

    try {
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: {
            before: twip(Math.max(0, (el.height - size.height) / 2)),
            after: 0,
          },
          children: [
            new ImageRun({
              type: payload.type,
              data: payload.data,
              transformation: size,
            }),
          ],
        }),
      ];
    } catch {
      this.warnOnce(
        env,
        `image:${el.id}`,
        `Image element ${el.id}: data image could not be decoded (skipped)`,
      );

      return [];
    }
  }

  /** Loop regions: columns keep their x, rows keep itemHeight/itemSpacing; task lists stay the XE-T633 table. */
  private regionToTableV2(
    region: IDocLoopRegionElement,
    contextItem: IDocumentContextItem,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    depth: number,
    indentPx = region.x,
    // filled with the rows' designed height (HTML regionRenderedHeight, flat case)
    metrics?: { designedHeight: number },
  ): Table | null {
    const rows = resolveRegionLoopRows(
      region,
      contextItem,
      env.dataCtx,
      env.evaluator,
      env.warnings,
      env.variables,
    );
    if (rows.length === 0) return null;

    // XE-T633 list table as-is; rows cleaned of XML-illegal characters, and a
    // nested list sits at its cell's origin (its x is already the column's x).
    if (isTaskListSource(region.dataSource)) {
      return this.listTable(
        indentPx === region.x ? region : { ...region, x: indentPx },
        xmlSafeDeep(rows),
        meta,
        env,
        depth,
      );
    }

    const layout = this.regionLayoutV2(region, env);
    if (layout.cells.length === 0) return null;
    const tableRows: TableRow[] = [];
    for (const row of rows) {
      const rowItem: IDocumentContextItem = {
        id: typeof row['id'] === 'string' ? row['id'] : '',
        entityType: 'task',
        raw: row,
      };
      const tableRow = this.regionRowV2(
        region,
        layout.cells,
        rowItem,
        row,
        meta,
        env,
        depth,
        true,
      );
      if (tableRow) tableRows.push(tableRow);
    }
    if (tableRows.length === 0) return null;

    if (metrics) {
      const childBottom = Math.max(
        0,
        ...(env.childrenByParent.get(region.id) ?? [])
          .filter((el) => el.type !== 'loop_region')
          .map((el) => el.y + el.height),
      );
      metrics.designedHeight =
        tableRows.length *
        (Math.max(region.itemHeight, childBottom) +
          Math.max(0, region.itemSpacing));
    }

    return flowTable(
      tableRows,
      layout.cells.map((cell) => cell.widthTwip),
      indentPx,
    );
  }

  /** fixed_document top-level `items` region (the XE-T633 list band rows are reused as-is). */
  private itemsRegionToTableV2(
    region: IDocLoopRegionElement,
    env: DocxEnv,
  ): Table | null {
    const itemCount = env.dataCtx.items.length;
    const entries = applyRegionListOps(
      scopedItemsRegion(region, env.options.ignoreItemsRegionFilter),
      env.dataCtx.items.map((item) => ({ row: item.raw, item })),
      env.evaluator,
      env.warnings,
      env.variables,
    );

    const layout = this.regionLayoutV2(region, env);
    if (layout.cells.length === 0) return null;
    const holdsList = layout.cells.some((cell) =>
      cell.elements.some(
        (el) => el.type === 'loop_region' && isTaskListSource(el.dataSource),
      ),
    );

    // A band with flowing lists: itemHeight/itemSpacing apply to the whole band (HTML renderFlowBand).
    const hasFlow = this.listBandFlow(region, env).length > 0;
    const rowBottom = Math.max(
      0,
      ...layout.cells.flatMap((cell) =>
        cell.elements.map((el) => el.y + el.height),
      ),
    );

    const rows: TableRow[] = [];
    for (const entry of entries) {
      if (!entry.item) continue;
      const index = env.dataCtx.items.indexOf(entry.item);
      const meta = this.buildMeta(env, index + 1, itemCount);
      const tableRow = this.regionRowV2(
        region,
        layout.cells,
        entry.item,
        entry.item.raw,
        meta,
        env,
        1,
        !holdsList,
        !hasFlow,
      );
      if (tableRow) rows.push(tableRow);
      // Lists still show when the task's own row has nothing visible (HTML does the same).
      if (hasFlow) {
        rows.push(
          ...this.listBandFlowRowsV2(
            region,
            layout.cells.length,
            entry.item,
            meta,
            env,
            tableRow ? rowBottom : null,
          ),
        );
      }
    }
    if (rows.length === 0) return null;

    return flowTable(
      rows,
      layout.cells.map((cell) => cell.widthTwip),
      region.x,
    );
  }

  /** listBandFlowRows twin for the v2 path: lists via regionToTableV2 (clean rows), titles as rich text at their x. */
  private listBandFlowRowsV2(
    region: IDocLoopRegionElement,
    columnCount: number,
    item: IDocumentContextItem,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    // Designed bottom of the task's own row; null when that row rendered nothing.
    startY: number | null,
  ): TableRow[] {
    const placed: Array<{ blocks: DocxBlock[]; left: number; top: number }> =
      [];
    // Designed gaps between flow lines, measured from the task row's bottom (HTML renderFlowLines).
    let previousBottom = startY ?? 0;

    for (const el of this.listBandFlow(region, env)) {
      const isRegion = el.type === 'loop_region';
      const condition = env.evaluator.evaluate(
        el.condition,
        item.raw,
        undefined,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);
      const table =
        condition.show && isRegion
          ? this.regionToTableV2(el, item, meta, env, 1)
          : null;
      const blocks: DocxBlock[] = !condition.show
        ? []
        : isRegion
          ? table
            ? [table]
            : []
          : this.elementBlocksV2(
              el,
              item,
              meta,
              env,
              Math.max(1, region.width - el.x),
              undefined,
              [],
            );
      if (blocks.length === 0) {
        // A hidden or empty list still ends its flow line; other elements leave no trace.
        if (isRegion)
          previousBottom = Math.max(previousBottom, el.y + el.height);
        continue;
      }

      placed.push({
        blocks,
        left: isRegion ? 0 : Math.max(0, el.x),
        top: Math.max(0, el.y - previousBottom),
      });
      previousBottom = Math.max(previousBottom, el.y + el.height);
    }

    // The band pads to itemHeight, then keeps itemSpacing below it.
    const bottomPad =
      Math.max(0, region.itemHeight - previousBottom) +
      Math.max(0, region.itemSpacing);
    if (placed.length === 0) {
      // Nothing visible in the whole band → nothing at all (HTML returns '').
      if (startY === null) return [];
      placed.push({ blocks: [separatorParagraph()], left: 0, top: 0 });
    }

    return placed.map(
      (entry, index) =>
        new TableRow({
          cantSplit: false,
          children: [
            new TableCell({
              columnSpan: Math.max(1, columnCount),
              borders: NO_CELL_BORDERS,
              margins: {
                top: twip(entry.top),
                bottom: index === placed.length - 1 ? twip(bottomPad) : 0,
                left: twip(entry.left),
                right: 0,
              },
              children: cellChildren(entry.blocks),
            }),
          ],
        }),
    );
  }

  private regionLayoutV2(
    region: IDocLoopRegionElement,
    env: DocxEnv,
  ): { cells: ILayoutCell[] } {
    const columns = this.regionColumns(region, env)
      .filter((column) => column.elements.length > 0)
      .map((column) => ({
        x: column.elements[0].x,
        widthPx: Math.max(...column.elements.map((el) => el.width)),
        elements: column.elements,
      }));

    return layoutColumns(columns, 0, Math.max(1, region.width), true);
  }

  /** One loop row: child y offsets as top margins, itemSpacing as the bottom margin, pass/fail kept. */
  private regionRowV2(
    region: IDocLoopRegionElement,
    cells: ILayoutCell[],
    rowItem: IDocumentContextItem,
    conditionRow: Record<string, unknown>,
    meta: IDocumentMetaContext,
    env: DocxEnv,
    depth: number,
    allowKeepTogether: boolean,
    // false inside a task-list band: itemHeight/itemSpacing belong to the whole band there
    applyItemBox = true,
  ): TableRow | null {
    const texts: string[] = [];
    let contentBottom = 0;

    const columnBlocks = cells.map((cell) => {
      const blocks: DocxBlock[] = [];
      if (cell.kind === 'gap') return { cell, blocks, top: 0 };
      let top = 0;
      let previousBottom: number | null = null;

      for (const el of cell.elements) {
        const condition = env.evaluator.evaluate(
          el.condition,
          conditionRow,
          undefined,
          env.variables,
        );
        if (condition.warning) env.warnings.push(condition.warning);
        if (!condition.show) continue;

        let placed: DocxBlock[] = [];
        if (el.type === 'loop_region') {
          if (depth >= MAX_LOOP_REGION_DEPTH) {
            env.warnings.push(
              `Loop region ${el.id} exceeds the maximum nesting depth of ${MAX_LOOP_REGION_DEPTH} (rendered empty)`,
            );
            continue;
          }
          const nested = this.regionToTableV2(
            el,
            rowItem,
            meta,
            env,
            depth + 1,
            0,
          );
          if (nested) placed = [nested];
        } else if (el.type === 'line') {
          placed = [this.lineParagraphV2(el, cell.x, cell.x + cell.widthPx)];
        } else if (el.type === 'rectangle' || el.type === 'ellipse') {
          this.warnOnce(
            env,
            `region-shape:${el.id}`,
            `Shape element ${el.id} inside a loop region is not rendered in Word`,
          );
          continue;
        } else {
          placed = this.elementBlocksV2(
            el,
            rowItem,
            meta,
            env,
            cell.widthPx,
            undefined,
            texts,
          );
        }
        if (placed.length === 0) continue;

        if (previousBottom === null) {
          top = Math.max(0, el.y);
        } else {
          blocks.push(gapParagraph(el.y - previousBottom));
        }
        blocks.push(...placed);
        previousBottom = el.y + el.height;
        contentBottom = Math.max(contentBottom, el.y + el.height);
      }

      return { cell, blocks, top };
    });

    if (!columnBlocks.some((column) => column.blocks.length > 0)) return null;

    const rowStyle = this.testStatusRowStyle(region, conditionRow, meta, env);
    const badge = this.testStatusBadgeParagraph(
      region,
      conditionRow,
      meta,
      env,
    );
    const firstContent = columnBlocks.find(
      (column) => column.cell.kind === 'content',
    );
    if (badge && firstContent) firstContent.blocks.unshift(badge);
    const shading = rowStyle ? shadingOf(rowStyle) : undefined;
    const leftAccent = rowStyle ? borderOf(rowStyle)?.left : undefined;

    return new TableRow({
      cantSplit: allowKeepTogether && keepRowTogether(texts),
      // Row pitch = max(itemHeight, content) + itemSpacing, like the HTML item band + margin.
      height: atLeast(
        applyItemBox
          ? Math.max(region.itemHeight, contentBottom) +
              Math.max(0, region.itemSpacing)
          : contentBottom,
      ),
      children: columnBlocks.map(
        (column, index) =>
          new TableCell({
            borders: {
              ...NO_CELL_BORDERS,
              ...(index === 0 && leftAccent ? { left: leftAccent } : {}),
            },
            ...(shading ? { shading } : {}),
            margins: {
              top: twip(column.top),
              bottom: applyItemBox ? twip(Math.max(0, region.itemSpacing)) : 0,
              left: twip(column.cell.padLeftPx),
              right: 0,
            },
            children: cellChildren(column.blocks),
          }),
      ),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit / style conversion helpers
// ─────────────────────────────────────────────────────────────────────────────

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' } as const;

/** Task list tables: light row rules, roomy cells (twips). */
const LIST_TABLE_LINE = {
  style: BorderStyle.SINGLE,
  size: 4,
  color: 'E2E8F0',
} as const;
const LIST_CELL_MARGINS = { top: 80, bottom: 80, left: 120, right: 120 };

export function pxToTwip(px: number): number {
  return Math.round(px * PX_TO_TWIP);
}

/** docx font size unit is half-points: px → pt (×0.75) → half-points (×2). */
export function pxToHalfPoints(px: number): number {
  return Math.max(2, Math.round(px * 1.5));
}

/** docx border size unit is eighths of a point: px → pt (×0.75) → ×8 = ×6. */
function pxToBorderEighths(px: number): number {
  return Math.max(1, Math.round(px * 6));
}

/** Word colors are RRGGBB without '#'; 'transparent' → undefined. */
function hexColor(value: string | undefined): string | undefined {
  if (!value || value === 'transparent') return undefined;
  const raw = value.startsWith('#') ? value.slice(1) : value;
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(raw)) return undefined;
  if (raw.length === 3) {
    return raw
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase();
  }

  return raw.toUpperCase();
}

function runStyle(style: IDocElementStyle | undefined): {
  font: string;
  size: number;
  bold: boolean;
  color?: string;
} {
  const merged = { ...DEFAULT_ELEMENT_STYLE, ...(style ?? {}) };

  return {
    font: merged.fontFamily,
    size: pxToHalfPoints(merged.fontSize),
    bold: merged.fontWeight >= 600,
    color: hexColor(merged.color),
  };
}

function alignmentOf(
  style: IDocElementStyle | undefined,
): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  switch (style?.textAlign) {
    case 'center':
      return AlignmentType.CENTER;
    case 'right':
      return AlignmentType.RIGHT;
    case 'justify':
      return AlignmentType.JUSTIFIED;
    case 'left':
      return AlignmentType.LEFT;
    default:
      return undefined;
  }
}

function shadingOf(style: IDocElementStyle | undefined):
  | {
      type: (typeof ShadingType)[keyof typeof ShadingType];
      fill: string;
    }
  | undefined {
  const fill = hexColor(style?.backgroundColor);
  if (!fill) return undefined;

  return { type: ShadingType.CLEAR, fill };
}

function borderOf(style: IDocElementStyle | undefined):
  | {
      top: typeof NO_BORDER | BorderEdge;
      bottom: typeof NO_BORDER | BorderEdge;
      left: typeof NO_BORDER | BorderEdge;
      right: typeof NO_BORDER | BorderEdge;
    }
  | undefined {
  const width = style?.borderWidth ?? DEFAULT_ELEMENT_STYLE.borderWidth;
  if (!width || width <= 0) return undefined;

  const edge: BorderEdge = {
    style: BorderStyle.SINGLE,
    size: pxToBorderEighths(width),
    color:
      hexColor(style?.borderColor ?? DEFAULT_ELEMENT_STYLE.borderColor) ??
      '000000',
  };

  return { top: edge, bottom: edge, left: edge, right: edge };
}

interface BorderEdge {
  style: (typeof BorderStyle)[keyof typeof BorderStyle];
  size: number;
  color: string;
}

/**
 * Flatten sanitizable HTML to plain-text lines: block-tag boundaries become
 * line breaks, list items get a bullet, remaining tags are stripped, and the
 * basic entities the field formatter emits are decoded. Inline bold/italic is
 * intentionally dropped (v1 limitation — documented in the module header).
 */
export function htmlToTextLines(html: string): string[] {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|ul|ol)>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  const decoded = stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const lines = decoded
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim());

  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.length > 0 ? lines : [''];
}
