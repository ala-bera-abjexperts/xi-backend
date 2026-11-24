/**
 * @fileoverview THE renderer: turns a validated template definition plus a
 * resolved {@link IDocumentDataContext} into a self-contained HTML document
 * sized for print (headless-Chromium PDF in Wave 2, iframe preview today).
 * PURE — no I/O, no injected clients; everything it needs arrives as input.
 *
 * COORDINATE MODEL (documented decision — MUST match the designer canvas):
 *  - (0,0) is the TOP-LEFT CORNER OF THE PHYSICAL PAGE. ALL top-level element
 *    coordinates (`absolute`, `relative` and `anchored`) are page-origin,
 *    exactly like the designer canvas (CanvasPage renders `left:el.x` /
 *    `top:el.y` on the full-page Paper and draws page margins as dashed
 *    GUIDES only — margins never offset elements).
 *  - `@page` margin is 0 and `.doc-root` carries NO padding: page containers
 *    are full-page, so an element stored at (x, y) prints at physical page
 *    position (x, y). Template page margins are design guides only — they
 *    never shift render output.
 *  - `anchored` elements emit ONCE in a `position:fixed` wrapper (Chromium
 *    repeats `position:fixed` boxes on every printed page — the standard
 *    header/footer trick).
 *  - Loop-region children are positioned relative to the region's content
 *    origin (their stored coordinates already are).
 *  - fixed_document pagination happens in full-page space: the band flow
 *    starts at the physical page top, so the canvas PageBreakGuides (raw
 *    pageHeight multiples) line up with printed page breaks.
 *  - `page.pageBreakMargin` applies to repeat_per_item mode only: every item
 *    starts a fresh page, and items 2..n are pushed down by pageBreakMargin
 *    px (the designed clearance after each forced break).
 *
 * KNOWN LIMITS (surfaced as render warnings where detectable):
 *  - In fixed_document mode a static element whose box crosses a loop
 *    region's vertical range cannot reflow with the region (band model).
 * @module src/document-designer/rendering/document-render.service
 */

import { Injectable } from '@nestjs/common';
import type {
  DocImageSrc,
  DocumentSourceEntity,
  IDocElement,
  IDocElementStyle,
  IDocFieldBinding,
  IDocLoopRegionElement,
  IDocumentTemplateDefinition,
  IDocVariableSetElement,
} from '../template-definition/template-definition.types';
import { DEFAULT_ELEMENT_STYLE, getPageDimensionsPx } from './render-constants';
import type {
  IDocumentContextItem,
  IDocumentDataContext,
  IDocumentLinkedEntry,
} from './document-data-resolver.service';
import { getSourceEntityConfig } from '../source-entities';
import { SYSTEM_FIELDS_BY_ENTITY } from '../bindable-fields.service';
import { MAX_LOOP_REGION_DEPTH } from '../template-definition/template-definition.schema';
import { ElementConditionEvaluator } from './element-condition-evaluator';
import {
  escapeHtml,
  formatFieldValue,
  resolveTokenText,
  type IDocumentMetaContext,
} from './field-formatter';
import { sanitizeHtml, stripHtmlToText } from './html-sanitizer';
import {
  isTaskListSource,
  listColumnLabel,
  listTableColumns,
  taskListRowSource,
} from './task-list-sources';

const TOKEN_REGEX = /\{\{\s*([\w.]+)\s*\}\}/g;

const BREAK_BEFORE_STYLE = ' break-before:page; page-break-before:always;';

/** Authored-page footer geometry (see pageFooterHtml). */
const PAGE_FOOTER_FONT_SIZE_PX = 10;
const PAGE_FOOTER_BOTTOM_OFFSET_PX = 24;
const PAGE_FOOTER_LINE_HEIGHT_PX = 12;

/** Extra styling/stamps for one band when authored pages are active. */
interface IBandRenderOptions {
  breakBefore?: boolean;
  footer?: string;
}

export interface IDocumentRenderOptions {
  /**
   * Skip the filter on TOP-LEVEL `items` loop regions. Set when the caller has
   * already chosen the exact rows (an `ids` scope), where a second, list-level
   * filter can only delete the very record that was asked for — see
   * scopedItemsRegion(). Nested regions (subtasks/linked/dynamic) keep theirs.
   */
  ignoreItemsRegionFilter?: boolean;
  /** public.users.id used for the `exportedBy` meta field. */
  exportedByUserId?: string | null;
  /** Timestamp for the `exportDate` meta field (defaults to now). */
  exportDate?: Date;
  /** Template identity for the `templateName` / `templateDescription` /
   *  `templateUpdatedAt` meta fields. Supplied by the caller because the
   *  renderer never loads the template row itself. */
  templateName?: string | null;
  templateDescription?: string | null;
  templateUpdatedAt?: Date | null;
  /**
   * Maps a storage-kind image source to a URL (signed URL, data URI, …).
   * Without it, storage images render empty with a warning. `data`/`url`
   * kinds never consult the resolver.
   */
  resolveImageSrc?: (src: DocImageSrc) => string;
  /**
   * Design-time preview only — never set for a real export. With zero
   * matching items, renders the static layout with one placeholder pass
   * (empty field/loop content) instead of the "No items matched" message,
   * so a template author can see their design before real data exists.
   */
  isPreview?: boolean;
}

export interface IDocumentRenderResult {
  html: string;
  warnings: string[];
}

/** One vertical slice of a fixed_document page: a gap (statics only) or a loop region. */
export interface IFixedDocBand {
  start: number;
  end: number;
  region: IDocLoopRegionElement | null;
  statics: IDocElement[];
}

/** Result of {@link decomposeFixedDocumentBands} — shared by HTML and DOCX renderers. */
export interface IFixedDocDecomposition {
  anchored: IDocElement[];
  bands: IFixedDocBand[];
  tailEnd: number;
}

interface RenderEnv {
  definition: IDocumentTemplateDefinition;
  dataCtx: IDocumentDataContext;
  options: IDocumentRenderOptions;
  warnings: string[];
  evaluator: ElementConditionEvaluator;
  childrenByParent: Map<string, IDocElement[]>;
  pageWidth: number;
  pageHeight: number;
  /**
   * A `data:` image element on a repeat_per_item page is re-rendered once per
   * item — without dedup its full base64 payload would be duplicated in the
   * HTML on every occurrence (a single 157 KB image across 200 items alone
   * blew a real export to ~31 MB, tripping MAX_HTML_BYTES). Keyed by the
   * dataUri itself, so every occurrence of the SAME image — however many
   * elements/items reference it — shares one CSS rule; the payload appears in
   * the output exactly once regardless of how many times it's placed.
   */
  imageClassesByUri: Map<string, string>;
  /**
   * Runtime template variables (variable_set elements). Fully computed by
   * computeFinalVariables BEFORE the real render walk begins — see that
   * function's doc for why (display AND conditions must both see a
   * variable's FINAL post-document value, not a mid-walk snapshot, so the
   * mutation walk runs to completion first and the real render only ever
   * reads this map, never mutates it).
   */
  variables: Map<string, unknown>;
  /**
   * `{{live.X}}` support — additive, opt-in alongside `{{var.X}}` (final
   * value, unaffected). Per-element, in-visit-order snapshots of each
   * referenced variable's value AT THE POINT the pre-pass walk reached that
   * element — recorded by computeFinalVariables, consumed by
   * resolveLiveToken during the real render. See computeFinalVariables's doc.
   */
  liveTokenCache: Map<string, Map<string, unknown[]>>;
  /** Per-element "next snapshot index to consume" during the real render — see resolveLiveToken. */
  liveTokenVisitIndex: Map<string, number>;
}

const DATA_IMAGE_URI_RE =
  /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

@Injectable()
export class DocumentRenderService {
  render(
    definition: IDocumentTemplateDefinition,
    dataCtx: IDocumentDataContext,
    options: IDocumentRenderOptions = {},
  ): IDocumentRenderResult {
    const warnings: string[] = [];
    const { width, height } = getPageDimensionsPx(
      definition.page.size,
      definition.page.orientation,
    );

    const env: RenderEnv = {
      definition,
      dataCtx,
      options,
      warnings,
      evaluator: new ElementConditionEvaluator(
        getSourceEntityConfig(definition.sourceEntity).itemEntityType,
      ),
      childrenByParent: groupChildren(definition.elements),
      pageWidth: width,
      pageHeight: height,
      imageClassesByUri: new Map(),
      variables: new Map(),
      liveTokenCache: new Map(),
      liveTokenVisitIndex: new Map(),
    };

    computeFinalVariables(env, (itemIndex, itemCount) =>
      this.buildMeta(env, itemIndex, itemCount),
    );

    let body: string;
    if (dataCtx.items.length === 0 && !options.isPreview) {
      body = this.renderEmptyState(env);
    } else if (definition.mode === 'repeat_per_item') {
      body = this.renderRepeatPerItem(env);
    } else {
      body = this.renderFixedDocument(env);
    }

    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      `<style>${this.buildStylesheet(env)}</style>`,
      '</head>',
      '<body>',
      body,
      '</body>',
      '</html>',
    ].join('\n');

    return { html, warnings };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Stylesheet
  // ───────────────────────────────────────────────────────────────────────────

  private buildStylesheet(env: RenderEnv): string {
    const { pageWidth, pageHeight } = env;
    const defaultFont = DEFAULT_ELEMENT_STYLE.fontFamily;

    // One rule per UNIQUE data: image, however many elements/items placed it —
    // this is what keeps a repeated page-level image from multiplying the
    // rendered HTML size by the item count. Called after the body is built
    // (env.imageClassesByUri is only populated during element rendering).
    const imageRules = Array.from(env.imageClassesByUri.entries()).map(
      ([uri, cls]) => `.${cls} { background-image: url("${uri}"); }`,
    );

    // NOTE: `.doc-root` deliberately carries NO padding — element coordinates
    // are page-origin (see the COORDINATE MODEL header); template margins are
    // designer guides only and must never shift render output.
    return [
      `@page { size: ${pageWidth}px ${pageHeight}px; margin: 0; }`,
      'html, body { margin: 0; padding: 0; }',
      // tabular-nums: every org's every template's PDF output (shared stylesheet) —
      // uniform digit width for dates/percentages/counters, never affects layout/clipping.
      `body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: ${defaultFont}, sans-serif; font-size: ${DEFAULT_ELEMENT_STYLE.fontSize}px; color: ${DEFAULT_ELEMENT_STYLE.color}; font-variant-numeric: tabular-nums; }`,
      `.doc-root { position: relative; width: ${pageWidth}px; box-sizing: border-box; }`,
      // overflow-wrap backstops the Puppeteer shrink-to-fit pass: a single unbroken
      // token (long key/URL) still wraps within the box width instead of overflowing.
      '.el { position: absolute; box-sizing: border-box; overflow: hidden; overflow-wrap: break-word; }',
      '.doc-band { position: relative; }',
      '.doc-region-item { position: relative; break-inside: avoid; page-break-inside: avoid; }',
      'img { max-width: 100%; }',
      'a { color: inherit; }',
      // `text`/`field` elements are fixed-height `.el` boxes with overflow:hidden — the
      // browser's default block-level margins (e.g. `p { margin-block: 1em }`) push content
      // out of the box and get clipped, making short text look cut off or blank. Elements
      // only ever appear inside `.el`, so a blanket reset here is safe.
      'p, h1, h2, h3, h4, h5, h6, blockquote { margin: 0; }',
      // Minimal borders for `grid` custom-field cells — otherwise a bare <table> renders with none.
      '.doc-grid-table { border-collapse: collapse; width: 100%; }',
      '.doc-grid-table th, .doc-grid-table td { border: 1px solid #d1d5db; padding: 2px 4px; text-align: left; }',
      // Screen-only page separation for the preview iframe — print/PDF output
      // (print media) ignores this block and stays byte-identical.
      '@media screen {',
      '  body { background: #9ca3af; }',
      '  .doc-band, .doc-item, .doc-root > section { background: #ffffff; }',
      '  .doc-page-start { margin-top: 24px; box-shadow: 0 1px 6px rgba(0,0,0,0.35); }',
      '}',
      ...imageRules,
      // Only documents with task lists get the flow rules, so every other stylesheet stays unchanged.
      ...(env.definition.elements.some(isListRegion)
        ? [
            '.el.el-flow { position: relative; overflow: visible; height: auto; }',
            '.doc-flow-line { position: relative; display: flex; align-items: flex-start; }',
            '.doc-flow-line > * { flex: none; }',
            // Task lists render as tables: header row repeats on every PDF page, rows never split.
            '.doc-list-table { width: 100%; border-collapse: collapse; table-layout: fixed; border: 1px solid #e2e8f0; }',
            '.doc-list-table thead { display: table-header-group; }',
            '.doc-list-table tfoot { display: table-footer-group; }',
            // A list's title stays on the page its table starts on.
            '.doc-flow-line:has(+ .doc-flow-line .doc-list-table) { break-after: avoid; page-break-after: avoid; }',
            '.doc-list-table td.doc-list-foot { height: 0; padding: 0; border-top: 1px solid #e2e8f0; border-bottom: 0; }',
            '.doc-list-table th { background: #f1f5f9; color: #475569; font-family: Arial, sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; text-align: left; vertical-align: bottom; padding: 6px 8px; border-bottom: 1px solid #cbd5e1; overflow-wrap: anywhere; }',
            '.doc-list-table td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; overflow-wrap: anywhere; }',
            '.doc-list-table tbody tr:nth-child(even) { background-color: #f8fafc; }',
            '.doc-list-table tr { break-inside: avoid; page-break-inside: avoid; }',
            '.doc-list-table td > .el { width: auto !important; margin: 0 !important; }',
            // Preview only: an item's own page card is at least one page tall.
            `@media screen { .doc-list-page { min-height: ${env.pageHeight}px; box-sizing: border-box; } }`,
            // Fixed documents: every page keeps the template's bottom margin and pages after the designed
            // first one its top margin, so a continued table never touches the paper edge.
            ...(env.definition.mode === 'fixed_document' &&
            (env.definition.pages?.length ?? 0) <= 1
              ? [
                  `@page { margin-top: ${round(listPageTop(env.definition))}px; margin-bottom: ${round(env.definition.page.margins.bottom)}px; }`,
                  '@page :first { margin-top: 0; }',
                  '@media print { .doc-list-page { padding-top: 0 !important; } }',
                ]
              : []),
            // Repeat mode: every page an item runs onto repeats the margins (cloned padding); the flow is
            // pulled back up by the top one, so the item's designed first page is unchanged.
            ...(env.definition.mode === 'repeat_per_item'
              ? [
                  `@media print { .doc-list-section { box-sizing: border-box; padding-top: ${round(listPageTop(env.definition))}px; padding-bottom: ${round(env.definition.page.margins.bottom)}px; box-decoration-break: clone; -webkit-box-decoration-break: clone; } .doc-list-section > .doc-flow { margin-top: -${round(listPageTop(env.definition))}px; } }`,
                ]
              : []),
            '.doc-list-badge { float: right; margin-left: 6px; padding: 1px 6px; border-radius: 3px; color: #ffffff; font-family: Arial, sans-serif; font-size: 10px; font-weight: 700; line-height: 1.4; }',
          ]
        : []),
    ].join('\n');
  }

  /** Get-or-create the shared CSS class for a `data:` image URI — see RenderEnv.imageClassesByUri. */
  private getDedupedImageClass(env: RenderEnv, dataUri: string): string {
    let cls = env.imageClassesByUri.get(dataUri);

    if (!cls) {
      cls = `img-${env.imageClassesByUri.size}`;
      env.imageClassesByUri.set(dataUri, cls);
    }

    return cls;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Empty state
  // ───────────────────────────────────────────────────────────────────────────

  private renderEmptyState(env: RenderEnv): string {
    return [
      '<div class="doc-root">',
      `<section style="position:relative; width:${env.pageWidth}px; min-height:${env.pageHeight}px;">`,
      '<div style="position:absolute; left:0; top:0; right:0; bottom:0; display:flex; align-items:center; justify-content:center; color:#9ca3af; font-size:14px;">No items matched this export.</div>',
      '</section>',
      '</div>',
    ].join('');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // repeat_per_item
  // ───────────────────────────────────────────────────────────────────────────

  private renderRepeatPerItem(env: RenderEnv): string {
    const { definition, dataCtx } = env;
    const sections: string[] = [];
    const itemCount = dataCtx.items.length;
    const pageEls = topLevelElements(definition.elements);

    // Preview with zero matching items: one placeholder pass so the static
    // layout still shows (fields/loop regions render empty, same as any
    // other unresolved binding — see formatSystemField's `!rawItem` case).
    // `itemCount` above stays the real 0 for the itemIndex/itemCount meta
    // fields; only the iteration source is synthetic.
    const items: typeof dataCtx.items =
      itemCount > 0
        ? dataCtx.items
        : [
            {
              id: '',
              entityType: getSourceEntityConfig(definition.sourceEntity)
                .itemEntityType,
              raw: {},
            },
          ];

    const hasLists = pageEls.some(isListRegion);

    items.forEach((item, index) => {
      const meta = this.buildMeta(env, index + 1, itemCount);

      if (hasLists) {
        sections.push(this.renderFlowSection(pageEls, item, index, meta, env));
        return;
      }

      // Rendered heights of loop regions for this item (reflow + canvas calc).
      const regionHeights = new Map<string, number>();
      for (const el of pageEls) {
        if (el.type === 'loop_region') {
          regionHeights.set(el.id, this.regionRenderedHeight(el, item, env, 1));
        }
      }

      const shiftFor = (el: IDocElement): number => {
        if (el.positionMode !== 'relative') return 0;
        let shift = 0;
        for (const region of pageEls) {
          if (region.type !== 'loop_region') continue;
          if (region.id === el.id) continue;
          if (region.y + region.height <= el.y) {
            shift += Math.max(
              0,
              (regionHeights.get(region.id) ?? region.height) - region.height,
            );
          }
        }
        return shift;
      };

      // Every item starts a fresh page; items 2..n are pushed down by
      // pageBreakMargin — the designed clearance after each forced break.
      // (`padding-top` would NOT move absolutely positioned children — the
      // containing block is the padding box — so the offset is added to each
      // child's top instead.)
      const pageTopOffset = index > 0 ? definition.page.pageBreakMargin : 0;

      let maxBottom = 0;
      const parts: string[] = [];
      for (const el of sortByZIndex(pageEls)) {
        const condition = env.evaluator.evaluate(
          el.condition,
          item.raw,
          undefined,
          env.variables,
        );
        if (condition.warning) env.warnings.push(condition.warning);
        if (!condition.show) continue;

        const y = el.y + shiftFor(el) + pageTopOffset;
        if (el.type === 'loop_region') {
          const renderedHeight = regionHeights.get(el.id) ?? el.height;
          parts.push(
            this.renderRegion(el, item, y, renderedHeight, env, meta, 1),
          );
          maxBottom = Math.max(maxBottom, y + renderedHeight);
        } else {
          parts.push(this.renderElement(el, item, meta, env, { top: y }));
          maxBottom = Math.max(maxBottom, y + el.height);
        }
      }

      // Full-page floor keeps single-item pages exactly one page tall (also in
      // the non-paginated HTML preview); taller content grows the section and
      // simply spans onto further pages.
      const sectionHeight = Math.max(env.pageHeight, Math.ceil(maxBottom));
      const breaksPage = index > 0;
      const breakBefore = breaksPage
        ? ' break-before:page; page-break-before:always;'
        : '';

      sections.push(
        `<section class="doc-item${breaksPage ? ' doc-page-start' : ''}" style="position:relative; width:${env.pageWidth}px; min-height:${sectionHeight}px;${breakBefore}">${parts.join('')}</section>`,
      );
    });

    return `<div class="doc-root">${sections.join('')}</div>`;
  }

  /** A repeat_per_item page with task lists: relative elements and lists flow, absolute ones stay put. */
  private renderFlowSection(
    pageEls: IDocElement[],
    item: IDocumentContextItem,
    index: number,
    meta: IDocumentMetaContext,
    env: RenderEnv,
  ): string {
    const pageTopOffset = index > 0 ? env.definition.page.pageBreakMargin : 0;
    const { absolute, absoluteBottom, entries } = this.collectFlowChildren(
      pageEls,
      item,
      undefined,
      meta,
      env,
      true,
      pageTopOffset,
    );
    const flow = renderFlowLines(entries, 0, -pageTopOffset);
    const sectionHeight = Math.max(env.pageHeight, Math.ceil(absoluteBottom));
    const breaksPage = index > 0;

    return `<section class="doc-item doc-list-section${breaksPage ? ' doc-page-start' : ''}" style="position:relative; width:${env.pageWidth}px; min-height:${sectionHeight}px;${breaksPage ? BREAK_BEFORE_STYLE : ''}">${absolute}<div class="doc-flow" style="position:relative;">${flow.html}</div></section>`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // fixed_document — band decomposition
  // ───────────────────────────────────────────────────────────────────────────

  private renderFixedDocument(env: RenderEnv): string {
    const { definition, dataCtx } = env;
    const itemCount = dataCtx.items.length;
    const docMeta = this.buildMeta(env, undefined, itemCount);

    // Authored multi-page support (fixed_document only; repeat_per_item
    // ignores `pages`/`showPageNumbers`). Legacy defs (no pages) keep the
    // free-flow band flow byte-identical.
    const authoredPages =
      definition.mode === 'fixed_document' ? definition.pages : undefined;
    const useAuthoredPages = !!authoredPages && authoredPages.length > 1;
    const totalPages = useAuthoredPages ? authoredPages.length : 0;

    // Bands are decomposed in FULL-PAGE space (page-origin coordinates) so
    // printed page breaks line up with the canvas PageBreakGuides.
    const { anchored, bands: rawBands } = decomposeFixedDocumentBands(
      definition.elements,
      env.pageHeight,
      env.warnings,
    );
    let bands = rawBands;

    if (useAuthoredPages) {
      // Extend the tail BEFORE splitting so the splitter cuts it at every
      // authored boundary — otherwise trailing empty pages merge into one
      // mid-page band and their "Page k of M" footers never render.
      const fullHeight = totalPages * env.pageHeight;
      const last = rawBands[rawBands.length - 1];
      if (last && last.end < fullHeight) last.end = fullHeight;

      bands = splitBandsAtAuthoredBoundaries(bands, env.pageHeight, totalPages);
    }

    const parts: string[] = [];

    // Anchored elements: emitted once; position:fixed repeats them on every
    // printed page. Page-origin coordinates, like everything else.
    for (const el of sortByZIndex(anchored)) {
      const condition = env.evaluator.evaluate(
        el.condition,
        null,
        docMeta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);
      if (!condition.show) continue;
      parts.push(
        `<div style="position:fixed; left:${el.x}px; top:${el.y}px; width:${el.width}px; height:${el.height}px; z-index:${el.zIndex};">${this.renderElement(
          el,
          null,
          docMeta,
          env,
          { left: 0, top: 0 },
        )}</div>`,
      );
    }

    const bandHtml: string[] = [];
    for (const band of bands) {
      // Authored pages: a band starting exactly on a boundary k*pageHeight is
      // the FIRST band of authored page k+1 — force the break there and, when
      // page numbers are on, stamp its footer (band k maps 1:1 to physical
      // page k because the boundaries force the breaks).
      const pageIndex =
        useAuthoredPages && band.start % env.pageHeight === 0
          ? band.start / env.pageHeight
          : -1;
      const bandOpts: IBandRenderOptions = {
        breakBefore: pageIndex > 0,
        footer:
          pageIndex >= 0 && definition.showPageNumbers
            ? this.pageFooterHtml(pageIndex + 1, totalPages, env)
            : '',
      };

      if (band.region) {
        // The region's own show/hide condition is honored (meta-only context —
        // see ElementConditionEvaluator). A hidden region keeps its DESIGNED
        // height as a gap band so later bands stay at their canvas positions.
        const regionCondition = env.evaluator.evaluate(
          band.region.condition,
          null,
          docMeta,
          env.variables,
        );
        if (regionCondition.warning) env.warnings.push(regionCondition.warning);
        if (!regionCondition.show) {
          bandHtml.push(this.renderGapBand(band, docMeta, env, bandOpts));
          continue;
        }
        bandHtml.push(
          this.renderItemsRegionBand(
            band.region,
            band.statics,
            docMeta,
            env,
            bandOpts,
          ),
        );
      } else {
        bandHtml.push(this.renderGapBand(band, docMeta, env, bandOpts));
      }
    }

    parts.push(`<div class="doc-root">${bandHtml.join('')}</div>`);
    return parts.join('');
  }

  /** A statics-only band (gap between regions, or a hidden items region). */
  private renderGapBand(
    band: IFixedDocBand,
    docMeta: IDocumentMetaContext,
    env: RenderEnv,
    opts: IBandRenderOptions = {},
  ): string {
    const height = band.end - band.start;
    const children = sortByZIndex(band.statics)
      .map((el) => {
        const condition = env.evaluator.evaluate(
          el.condition,
          null,
          docMeta,
          env.variables,
        );
        if (condition.warning) env.warnings.push(condition.warning);
        if (!condition.show) return '';
        return this.renderElement(el, null, docMeta, env, {
          top: el.y - band.start,
        });
      })
      .join('');

    return `<div class="doc-band${opts.breakBefore ? ' doc-page-start' : ''}" style="height:${height}px;${opts.breakBefore ? BREAK_BEFORE_STYLE : ''}">${children}${opts.footer ?? ''}</div>`;
  }

  /** One items-region band: expands as a flow sibling, one sub-band per item. */
  private renderItemsRegionBand(
    region: IDocLoopRegionElement,
    coStatics: IDocElement[],
    docMeta: IDocumentMetaContext,
    env: RenderEnv,
    opts: IBandRenderOptions = {},
  ): string {
    const itemCount = env.dataCtx.items.length;
    const items = this.applyRegionListOps(
      scopedItemsRegion(region, env.options.ignoreItemsRegionFilter),
      env.dataCtx.items.map((item) => ({ row: item.raw, item })),
      env,
    );

    const staticHtml = sortByZIndex(coStatics)
      .map((el) => {
        const condition = env.evaluator.evaluate(
          el.condition,
          null,
          docMeta,
          env.variables,
        );
        if (condition.warning) env.warnings.push(condition.warning);
        if (!condition.show) return '';
        return this.renderElement(el, null, docMeta, env, {
          top: el.y - region.y,
        });
      })
      .join('');

    // Task lists make every item long: each item after the first starts on a new page.
    if ((env.childrenByParent.get(region.id) ?? []).some(isListRegion)) {
      return this.renderItemPages(
        region,
        items,
        staticHtml,
        docMeta,
        env,
        opts,
      );
    }

    const itemBands = items
      .map(({ item }) => {
        if (!item) return '';
        const index = env.dataCtx.items.indexOf(item);
        const meta = this.buildMeta(env, index + 1, itemCount);
        return this.renderRegionItemBand(region, item, meta, env);
      })
      .join('');

    // Item bands live in an offset wrapper that carries the region's designed
    // horizontal geometry — child coordinates are region-relative, so without
    // it the region's x and width would be lost (co-located statics keep their
    // own page-origin x). `overflow-x:clip` enforces the region width without
    // creating a scroll container (which would block page fragmentation).
    if (items.length > 0 && !itemBands) {
      env.warnings.push(
        `Loop region ${region.id} matched ${items.length} item(s) but none produced visible content — check that fields/elements are bound inside this region`,
      );
    }

    const itemsWrapper = itemBands
      ? `<div style="position:relative; margin-left:${round(region.x)}px; width:${round(region.width)}px; overflow-x:clip;">${itemBands}</div>`
      : '';

    return `<div class="doc-band doc-region-band${opts.breakBefore ? ' doc-page-start' : ''}" style="min-height:${itemBands ? 0 : region.height}px;${opts.breakBefore ? BREAK_BEFORE_STYLE : ''}">${staticHtml}${itemsWrapper}${opts.footer ?? ''}</div>`;
  }

  /**
   * Items region holding task lists: the first item stays in the region's own
   * band (under the page header), every further item gets its own band that
   * starts a new page — in print and as a separate page card in the preview.
   */
  private renderItemPages(
    region: IDocLoopRegionElement,
    items: Array<{ item?: IDocumentContextItem | null }>,
    staticHtml: string,
    docMeta: IDocumentMetaContext,
    env: RenderEnv,
    opts: IBandRenderOptions,
  ): string {
    const itemCount = env.dataCtx.items.length;
    const bands = items
      .map(({ item }) => {
        if (!item) return '';
        const index = env.dataCtx.items.indexOf(item);
        const meta = this.buildMeta(env, index + 1, itemCount);
        return this.renderRegionItemBand(region, item, meta, env);
      })
      .filter(Boolean);

    if (items.length > 0 && bands.length === 0) {
      env.warnings.push(
        `Loop region ${region.id} matched ${items.length} item(s) but none produced visible content — check that fields/elements are bound inside this region`,
      );
    }

    const wrap = (band: string) =>
      `<div style="position:relative; margin-left:${round(region.x)}px; width:${round(region.width)}px; overflow-x:clip;">${band}</div>`;
    const first = `<div class="doc-band doc-region-band${opts.breakBefore ? ' doc-page-start' : ''}" style="min-height:${bands.length > 0 ? 0 : region.height}px;${opts.breakBefore ? BREAK_BEFORE_STYLE : ''}">${staticHtml}${bands.length > 0 ? wrap(bands[0]) : ''}${opts.footer ?? ''}</div>`;
    // Every new page opens like page 1: top margin, the region's column header, then the item.
    const header = regionHeaderElements(region, env.definition.elements);
    const headerTop =
      header.length > 0 ? Math.min(...header.map((el) => el.y)) : region.y;
    const headerHtml =
      header.length > 0
        ? `<div style="position:relative; height:${round(region.y - headerTop)}px;">${sortByZIndex(
            header,
          )
            .map((el) => {
              const condition = env.evaluator.evaluate(
                el.condition,
                null,
                docMeta,
                env.variables,
              );
              if (condition.warning) env.warnings.push(condition.warning);

              return condition.show
                ? this.renderElement(el, null, docMeta, env, {
                    top: el.y - headerTop,
                  })
                : '';
            })
            .join('')}</div>`
        : '';
    const pageTop = listPageTop(env.definition);
    const rest = bands
      .slice(1)
      .map(
        (band) =>
          `<div class="doc-band doc-region-band doc-page-start doc-list-page" style="padding-top:${round(pageTop)}px;${BREAK_BEFORE_STYLE}">${headerHtml}${wrap(band)}</div>`,
      )
      .join('');

    return first + rest;
  }

  /**
   * Literal "Page k of M" footer stamped inside an authored page's first band
   * (`.doc-band` is position:relative, so this absolute box anchors to the
   * band = page top). Plain text — no CSS counters / @page margin boxes.
   */
  private pageFooterHtml(page: number, total: number, env: RenderEnv): string {
    return `<div style="position:absolute; left:0; right:0; top:${env.pageHeight - PAGE_FOOTER_BOTTOM_OFFSET_PX - PAGE_FOOTER_LINE_HEIGHT_PX}px; text-align:center; font-size:${PAGE_FOOTER_FONT_SIZE_PX}px; color:#9ca3af;">Page ${page} of ${total}</div>`;
  }

  /**
   * One item's sub-band inside a fixed_document items region.
   *
   * `bandHeight` starts at 0 (not `region.itemHeight`) and only grows from
   * ACTUAL rendered content — a nested loop_region contributes nothing when
   * it resolves zero rows (regionRenderedHeight returns 0 for that case), and
   * a row with literally nothing to show returns '' (no div, no margin) so
   * it costs zero space, instead of unconditionally reserving itemHeight per
   * row regardless of content. `region.itemHeight` is still applied as a
   * floor, but ONLY once real content exists — a populated row's height is
   * therefore byte-identical to before this change.
   */
  private renderRegionItemBand(
    region: IDocLoopRegionElement,
    item: IDocumentContextItem,
    meta: IDocumentMetaContext,
    env: RenderEnv,
  ): string {
    const children = env.childrenByParent.get(region.id) ?? [];
    if (children.some(isListRegion)) {
      return this.renderFlowBand(region, children, item, meta, env);
    }

    let bandHeight = 0;
    const parts: string[] = [];

    for (const el of sortByZIndex(children)) {
      const condition = env.evaluator.evaluate(
        el.condition,
        item.raw,
        undefined,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);
      if (!condition.show) continue;

      if (el.type === 'loop_region') {
        const renderedHeight = this.regionRenderedHeight(el, item, env, 1);
        if (renderedHeight <= 0) continue;
        parts.push(
          this.renderRegion(el, item, el.y, renderedHeight, env, meta, 1),
        );
        bandHeight = Math.max(bandHeight, el.y + renderedHeight);
      } else {
        parts.push(this.renderElement(el, item, meta, env, {}));
        bandHeight = Math.max(bandHeight, el.y + el.height);
      }
    }

    if (bandHeight === 0) return '';

    const contentHeight = bandHeight;
    bandHeight = Math.max(bandHeight, region.itemHeight);
    const tintHtml = this.rowTestStatusTintHtml(
      region,
      item.raw,
      meta,
      env,
      contentHeight,
    );

    return `<div class="doc-region-item" style="height:${Math.ceil(bandHeight)}px; margin-bottom:${region.itemSpacing}px;">${tintHtml}${parts.join('')}</div>`;
  }

  /**
   * Item band holding task lists: absolute children stay where designed,
   * relative children and lists flow so every list row grows to its content.
   * The designed space below the flow is kept up to itemHeight.
   */
  private renderFlowBand(
    region: IDocLoopRegionElement,
    children: IDocElement[],
    item: IDocumentContextItem,
    meta: IDocumentMetaContext,
    env: RenderEnv,
  ): string {
    const { absolute, absoluteBottom, entries } = this.collectFlowChildren(
      children,
      item,
      undefined,
      meta,
      env,
      true,
      0,
    );
    if (!absolute && !entries.some((entry) => entry.render)) return '';

    const flow = renderFlowLines(entries, 0, 0);
    const padding = Math.max(0, region.itemHeight - flow.bottom);
    const tintHtml = this.rowTestStatusTintHtml(
      region,
      item.raw,
      meta,
      env,
      0,
      true,
    );

    // Tables inside may run past a page: the band can break between rows.
    return `<div class="doc-region-item" style="min-height:${Math.ceil(absoluteBottom)}px; margin-bottom:${region.itemSpacing}px; break-inside:auto; page-break-inside:auto;">${tintHtml}${absolute}<div class="doc-flow" style="position:relative; padding-bottom:${round(padding)}px;">${flow.html}</div></div>`;
  }

  /**
   * Splits children for flow layout: absolute ones render as in a normal
   * band, relative ones and task lists (everything with `flowAll`) become
   * flow entries. A hidden or empty list stays as an empty entry so it collapses.
   */
  private collectFlowChildren(
    children: IDocElement[],
    item: IDocumentContextItem,
    conditionMeta: IDocumentMetaContext | undefined,
    meta: IDocumentMetaContext,
    env: RenderEnv,
    flowAll: boolean,
    topOffset: number,
  ): { absolute: string; absoluteBottom: number; entries: IFlowEntry[] } {
    const absolute: string[] = [];
    let absoluteBottom = 0;
    const entries: IFlowEntry[] = [];

    for (const el of sortByZIndex(children)) {
      const condition = env.evaluator.evaluate(
        el.condition,
        item.raw,
        conditionMeta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);
      const list = isListRegion(el) ? el : null;
      if (!condition.show) {
        if (list) entries.push({ el, render: null });
        continue;
      }
      if (el.type === 'variable_set') continue;

      // Anchored and rotated elements keep their exact spot even when everything else flows.
      const pinned =
        !flowAll || el.positionMode === 'anchored' || Boolean(el.rotation);

      if (pinned && !list && el.positionMode !== 'relative') {
        const top = el.y + topOffset;
        if (el.type === 'loop_region') {
          const height = this.regionRenderedHeight(el, item, env, 1);
          if (height <= 0) continue;
          absolute.push(this.renderRegion(el, item, top, height, env, meta, 1));
          absoluteBottom = Math.max(absoluteBottom, top + height);
        } else {
          absolute.push(this.renderElement(el, item, meta, env, { top }));
          absoluteBottom = Math.max(absoluteBottom, top + el.height);
        }
        continue;
      }

      if (list) {
        const rows = this.renderListTable(list, item, meta, env);
        entries.push({
          el,
          render: rows
            ? (left, top) =>
                `<div class="doc-list" style="position:relative; margin-left:${round(left)}px; margin-top:${round(top)}px; width:${round(el.width)}px; z-index:${el.zIndex};">${rows}</div>`
            : null,
        });
      } else if (el.type === 'loop_region') {
        const height = this.regionRenderedHeight(el, item, env, 1);
        if (height <= 0) continue;
        // Reserves the region's estimated height in the flow.
        entries.push({
          el,
          render: (left, top) =>
            `<div style="position:relative; margin-left:${round(left)}px; margin-top:${round(top)}px; width:${round(el.width)}px; height:${Math.ceil(height)}px;">${this.renderRegion({ ...el, x: 0 }, item, 0, height, env, meta, 1)}</div>`,
        });
      } else {
        entries.push({
          el,
          // Every element's HTML opens with its own `.el` div.
          render: (left, top) =>
            this.renderElement(el, item, meta, env, {
              flow: {
                marginLeft: left,
                marginTop: top,
                // A box placed at a fixed spot keeps its designed height and only grows with its content.
                ...(el.positionMode === 'relative'
                  ? {}
                  : { minHeight: el.height }),
              },
            }).replace('<div class="el', '<div class="el el-flow'),
        });
      }
    }

    return { absolute: absolute.join(''), absoluteBottom, entries };
  }

  /**
   * A task list as a table: a header row of column labels, then one row per
   * record with one cell per column (see listTableColumns); '' when no row
   * shows anything, so an empty list collapses.
   */
  private renderListTable(
    region: IDocLoopRegionElement,
    contextItem: IDocumentContextItem,
    meta: IDocumentMetaContext,
    env: RenderEnv,
  ): string {
    const columns = listTableColumns(env.childrenByParent.get(region.id) ?? []);
    const rows = this.regionLoopRows(region, contextItem, env);
    const body = rows
      .map((row) => {
        const rowItem = rowContextItem(row);
        const cells = columns.map((el) => {
          const condition = env.evaluator.evaluate(
            el.condition,
            rowItem.raw,
            meta,
            env.variables,
          );
          if (condition.warning) env.warnings.push(condition.warning);
          if (!condition.show) return '';

          // Every element's HTML opens with its own `.el` div.
          return this.renderElement(el, rowItem, meta, env, {
            flow: { marginLeft: 0, marginTop: 0 },
          }).replace('<div class="el', '<div class="el el-flow');
        });
        if (!cells.some(Boolean)) return '';

        const status = resolvePassFailStatus(region, row, meta, env);
        const tokens = status ? TEST_STATUS_ROW_COLORS[status] : null;
        const tint = tokens ? sanitizeCssColor(tokens.htmlTint, null) : null;
        const solid = tokens ? sanitizeCssColor(tokens.solid, null) : null;
        const badge =
          tokens && solid
            ? `<span class="doc-list-badge" style="background-color:${solid};">${escapeHtml(tokens.label)}</span>`
            : '';

        return `<tr${tint ? ` style="background-color:${tint};"` : ''}>${cells
          .map((cell, index) => `<td>${index === 0 ? badge : ''}${cell}</td>`)
          .join('')}</tr>`;
      })
      .join('');

    if (!body) {
      if (rows.length > 0) {
        env.warnings.push(
          `Loop region ${region.id} matched ${rows.length} row(s) but none produced visible content — check that fields/elements are bound inside this region`,
        );
      }

      return '';
    }

    const source = isTaskListSource(region.dataSource)
      ? region.dataSource
      : null;
    const total = columns.reduce((sum, el) => sum + Math.max(1, el.width), 0);
    const cols = columns
      .map(
        (el) =>
          `<col style="width:${round((100 * Math.max(1, el.width)) / total)}%;">`,
      )
      .join('');
    const head = columns
      .map(
        (el) =>
          `<th>${escapeHtml(source ? listColumnLabel(source, el) : '')}</th>`,
      )
      .join('');

    // The empty footer repeats at the bottom of every page the table runs over, closing it with a border.
    return `<table class="doc-list-table"><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot><tr><td class="doc-list-foot" colspan="${columns.length}"></td></tr></tfoot></table>`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Loop regions (subtasks / linked_tasks / dynamic_query — arbitrarily
  // nested up to MAX_LOOP_REGION_DEPTH, inside an item context)
  // ───────────────────────────────────────────────────────────────────────────

  private regionLoopRows(
    region: IDocLoopRegionElement,
    contextItem: IDocumentContextItem,
    env: RenderEnv,
  ): Array<Record<string, unknown>> {
    return resolveRegionLoopRows(
      region,
      contextItem,
      env.dataCtx,
      env.evaluator,
      env.warnings,
      env.variables,
    );
  }

  private applyRegionListOps<
    T extends {
      row: Record<string, unknown>;
      item: IDocumentContextItem | null;
    },
  >(region: IDocLoopRegionElement, entries: T[], env: RenderEnv): T[] {
    return applyRegionListOps(
      region,
      entries,
      env.evaluator,
      env.warnings,
      env.variables,
    );
  }

  /**
   * Total rendered height of `region` for `contextItem`, accounting for any
   * NESTED region growing an individual row taller than `region.itemHeight`
   * (summed per-row via regionRowHeight, not a uniform multiply) — so a
   * downstream absolute-positioned sibling never overlaps a region that grew
   * from deep content. Reduces to the ORIGINAL `rows.length *
   * (itemHeight+itemSpacing)` formula whenever the region has no nested
   * loop_region children AND has at least one child of some kind, EXCEPT the
   * per-row height floor also accounts for any non-loop child (text/field)
   * authored taller than `itemHeight` — matching the bandHeight computation
   * renderRegionItemBand/renderRegion already do when actually drawing each
   * row (`Math.max(bandHeight, el.y + el.height)` there). Without this, a
   * single oversized text element in an otherwise-flat region would make
   * this estimate under-reserve space, causing a downstream sibling
   * (e.g. an absolutely-positioned text element authored assuming this
   * region's designed size) to visually overlap what actually renders.
   * True no-op for every template where itemHeight already fits its own
   * content — the common, correctly-authored case. A region with ZERO
   * children of any kind (e.g. an accidentally content-less loop region)
   * returns 0 regardless of row count — renderRegion's per-row loop has
   * nothing to iterate either way, so every one of its rows collapses to no
   * output; the estimate must match that, not reserve height for rows that
   * render nothing.
   */
  private regionRenderedHeight(
    region: IDocLoopRegionElement,
    contextItem: IDocumentContextItem,
    env: RenderEnv,
    depth: number,
  ): number {
    const rows = this.regionLoopRows(region, contextItem, env);
    if (rows.length === 0) return 0;

    const children = env.childrenByParent.get(region.id) ?? [];
    if (children.length === 0) return 0;

    const nestedRegions = children.filter(
      (el): el is IDocLoopRegionElement => el.type === 'loop_region',
    );

    if (nestedRegions.length === 0 || depth >= MAX_LOOP_REGION_DEPTH) {
      const nonLoopMaxBottom = children.reduce(
        (max, el) =>
          el.type === 'loop_region' ? max : Math.max(max, el.y + el.height),
        0,
      );
      const rowHeight = Math.max(region.itemHeight, nonLoopMaxBottom);
      const rendered = rows.length * (rowHeight + region.itemSpacing);
      return Math.max(region.height, rendered);
    }

    let total = 0;
    for (const row of rows) {
      const rowHeight = this.regionRowHeight(
        region,
        row,
        nestedRegions,
        env,
        depth,
      );
      if (rowHeight === 0) continue;
      total += rowHeight + region.itemSpacing;
    }
    return Math.max(region.height, total);
  }

  /**
   * One row's rendered height within `region` — designed itemHeight, grown by
   * any nested region. Returns 0 (not itemHeight) when every nested region is
   * itself empty for this row, matching regionRenderedHeight/renderRegion's
   * "no content, no reserved space" rule — the itemHeight floor only applies
   * once at least one nested region actually has something to show.
   */
  private regionRowHeight(
    region: IDocLoopRegionElement,
    row: Record<string, unknown>,
    nestedRegions: IDocLoopRegionElement[],
    env: RenderEnv,
    depth: number,
  ): number {
    let height = 0;
    const rowItem = rowContextItem(row);

    for (const nested of nestedRegions) {
      const nestedHeight = this.regionRenderedHeight(
        nested,
        rowItem,
        env,
        depth + 1,
      );
      if (nestedHeight <= 0) continue;
      height = Math.max(height, nested.y + nestedHeight);
    }

    return height === 0 ? 0 : Math.max(height, region.itemHeight);
  }

  /**
   * Render a subtasks/linked/dynamic_query region wrapper, one band per loop
   * row — recurses into nested regions. Same "start at 0, floor at
   * itemHeight only when something rendered" fix as renderRegionItemBand —
   * see that method's doc for why. A populated row's height is unchanged.
   */
  private renderRegion(
    region: IDocLoopRegionElement,
    contextItem: IDocumentContextItem,
    top: number,
    renderedHeight: number,
    env: RenderEnv,
    meta: IDocumentMetaContext,
    depth: number,
  ): string {
    const rows = this.regionLoopRows(region, contextItem, env);
    const children = env.childrenByParent.get(region.id) ?? [];

    const bands = rows
      .map((row) => {
        const rowItem = rowContextItem(row);
        let bandHeight = 0;

        const parts = sortByZIndex(children)
          .map((el) => {
            const condition = env.evaluator.evaluate(
              el.condition,
              row,
              meta,
              env.variables,
            );
            if (condition.warning) env.warnings.push(condition.warning);
            if (!condition.show) return '';

            if (el.type === 'loop_region') {
              if (depth >= MAX_LOOP_REGION_DEPTH) {
                env.warnings.push(
                  `Loop region ${el.id} exceeds the maximum nesting depth of ${MAX_LOOP_REGION_DEPTH} (rendered empty)`,
                );
                return '';
              }
              const nestedHeight = this.regionRenderedHeight(
                el,
                rowItem,
                env,
                depth + 1,
              );
              if (nestedHeight <= 0) return '';
              bandHeight = Math.max(bandHeight, el.y + nestedHeight);
              return this.renderRegion(
                el,
                rowItem,
                el.y,
                nestedHeight,
                env,
                meta,
                depth + 1,
              );
            }

            bandHeight = Math.max(bandHeight, el.y + el.height);
            return this.renderElement(el, rowItem, meta, env, {});
          })
          .join('');

        if (bandHeight === 0) return '';

        const contentHeight = bandHeight;
        bandHeight = Math.max(bandHeight, region.itemHeight);
        const tintHtml = this.rowTestStatusTintHtml(
          region,
          row,
          meta,
          env,
          contentHeight,
        );

        return `<div class="doc-region-item" style="height:${Math.ceil(bandHeight)}px; margin-bottom:${region.itemSpacing}px;">${tintHtml}${parts}</div>`;
      })
      .join('');

    if (rows.length > 0 && !bands) {
      env.warnings.push(
        `Loop region ${region.id} matched ${rows.length} row(s) but none produced visible content — check that fields/elements are bound inside this region`,
      );
    }

    return `<div class="doc-region" style="position:absolute; left:${region.x}px; top:${top}px; width:${region.width}px; min-height:${Math.ceil(renderedHeight)}px; z-index:${region.zIndex};">${bands}</div>`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Single elements
  // ───────────────────────────────────────────────────────────────────────────

  private renderElement(
    el: IDocElement,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: RenderEnv,
    positionOverride: {
      left?: number;
      top?: number;
      /** Flow layout: flex margins instead of left/top (see renderFlowLines). */
      flow?: IFlowMargins;
    },
  ): string {
    const left = positionOverride.left ?? el.x;
    const top = positionOverride.top ?? el.y;
    const { flow } = positionOverride;
    const style = this.buildElementStyle(el, left, top, flow);

    switch (el.type) {
      case 'line': {
        const stroke = Math.max(1, el.style.borderWidth ?? 1);
        const color =
          el.style.backgroundColor && el.style.backgroundColor !== 'transparent'
            ? el.style.backgroundColor
            : (el.style.borderColor ?? DEFAULT_ELEMENT_STYLE.borderColor);
        const lineStyle = this.buildElementStyle(
          { ...el, height: stroke, style: { ...el.style, borderWidth: 0 } },
          left,
          top,
          flow,
        );
        return `<div class="el" style="${lineStyle} background-color:${sanitizeCssColor(color, DEFAULT_ELEMENT_STYLE.borderColor)};"></div>`;
      }
      case 'rectangle':
        return `<div class="el" style="${style}"></div>`;
      case 'ellipse':
        return `<div class="el" style="${style} border-radius:50%;"></div>`;
      case 'text': {
        const withLive = substituteLiveTokens(el.html, el.id, env);
        const interpolated = this.interpolate(withLive, item, meta, env);
        return `<div class="el" style="${style}">${sanitizeHtml(interpolated)}</div>`;
      }
      case 'link': {
        const textSrc = substituteLiveTokens(el.text, el.id, env);
        const hrefSrc = substituteLiveTokens(el.href, el.id, env);
        const text = escapeHtml(this.interpolateText(textSrc, item, meta, env));
        const href = this.interpolateText(hrefSrc, item, meta, env).trim();
        if (/^https?:\/\//i.test(href)) {
          return `<div class="el" style="${style}"><a href="${escapeHtml(href)}">${text}</a></div>`;
        }
        env.warnings.push(
          `Link element ${el.id} resolved to a non-http(s) URL and was rendered as text`,
        );
        return `<div class="el" style="${style}">${text}</div>`;
      }
      case 'image': {
        const src = this.resolveImageSource(el.src, env, el.id);
        if (!src) return `<div class="el" style="${style}"></div>`;

        if (DATA_IMAGE_URI_RE.test(src)) {
          const cls = this.getDedupedImageClass(env, src);
          const bgSize = el.objectFit === 'fill' ? '100% 100%' : el.objectFit;

          return `<div class="el ${cls}" style="${style} background-size:${bgSize}; background-position:center; background-repeat:no-repeat;"></div>`;
        }

        // url/storage sources are short strings already — no duplication concern, unchanged.
        return `<div class="el" style="${style}"><img src="${escapeHtml(src)}" style="width:100%; height:100%; object-fit:${el.objectFit};" alt=""></div>`;
      }
      case 'field': {
        const value = formatFieldValue(
          el.binding,
          item?.raw ?? null,
          env.dataCtx,
          meta,
          env.warnings,
        );
        return `<div class="el" style="${style}">${value}</div>`;
      }
      default:
        // variable_set: non-visual — its mutation already ran in
        // computeFinalVariables before this real render walk started.
        return '';
    }
  }

  private buildElementStyle(
    el: IDocElement,
    left: number,
    top: number,
    flow?: IFlowMargins,
  ): string {
    const style = el.style ?? {};
    const parts: string[] = flow
      ? [
          `margin-left:${round(flow.marginLeft)}px;`,
          `margin-top:${round(flow.marginTop)}px;`,
          `width:${round(el.width)}px;`,
          // Text-like boxes take their content's height; shapes and images keep theirs.
          ...(el.type === 'text' || el.type === 'field' || el.type === 'link'
            ? flow.minHeight
              ? [`min-height:${round(flow.minHeight)}px;`]
              : []
            : [`height:${round(el.height)}px;`]),
          `z-index:${el.zIndex};`,
        ]
      : [
          `left:${round(left)}px;`,
          `top:${round(top)}px;`,
          `width:${round(el.width)}px;`,
          `height:${round(el.height)}px;`,
          `z-index:${el.zIndex};`,
        ];

    if (el.rotation && !flow) {
      parts.push(
        `transform:rotate(${el.rotation}deg); transform-origin:center center;`,
      );
    }

    const push = (css: string) => parts.push(css);
    const value = <K extends keyof IDocElementStyle>(key: K) =>
      style[key] ?? (DEFAULT_ELEMENT_STYLE as Record<string, unknown>)[key];

    // String style values are emitted through CSS-value sanitizers, NOT
    // escapeHtml — HTML escaping keeps the attribute intact but preserves
    // CSS metacharacters (';', ':', 'url(') that would let a template author
    // smuggle extra declarations (e.g. an external background-image beacon)
    // into the exported document. Rejected values fall back to defaults.
    const fontFamily = sanitizeCssFontFamily(style.fontFamily);
    if (fontFamily) push(`font-family:${fontFamily};`);
    if (style.fontSize != null) push(`font-size:${style.fontSize}px;`);
    if (style.fontWeight != null) push(`font-weight:${style.fontWeight};`);
    if (style.lineHeight != null) push(`line-height:${style.lineHeight};`);
    if (style.textAlign) push(`text-align:${style.textAlign};`);
    if (style.color)
      push(
        `color:${sanitizeCssColor(style.color, DEFAULT_ELEMENT_STYLE.color)};`,
      );
    if (style.backgroundColor && style.backgroundColor !== 'transparent') {
      const backgroundColor = sanitizeCssColor(style.backgroundColor, null);
      if (backgroundColor) push(`background-color:${backgroundColor};`);
    }

    const borderWidth = value('borderWidth') as number;
    if (borderWidth > 0) {
      const borderColor =
        style.borderColor ?? DEFAULT_ELEMENT_STYLE.borderColor;
      push(
        `border:${borderWidth}px solid ${sanitizeCssColor(borderColor, DEFAULT_ELEMENT_STYLE.borderColor)};`,
      );
    }
    if (style.borderRadius != null && style.borderRadius > 0)
      push(`border-radius:${style.borderRadius}px;`);
    if (style.opacity != null && style.opacity < 1)
      push(`opacity:${style.opacity};`);
    if (style.padding != null && style.padding > 0)
      push(`padding:${style.padding}px;`);

    return parts.join(' ');
  }

  /**
   * Pass/fail background tint + a small "Pass"/"Fail" text badge for one loop
   * row — the tint alone can be too subtle to read as a clear signal (e.g.
   * screenshotted, printed in grayscale, or just a small color difference),
   * so the row's classification is also stated as text, not color alone.
   * Both are absolutely-positioned inner divs (the row wrapper
   * `.doc-region-item` is `position:relative`), not wrapper-level styles, so
   * neither ever changes the wrapper's own height/position — zero effect on
   * row spacing or fixed_document page pagination. The tint is sized to the
   * row's actual content height (`contentHeight`, computed BEFORE the
   * `region.itemHeight` floor) so it hugs the text; the badge sits fixed in
   * the row's top-right corner with a high z-index so it renders on top of
   * whatever content the row's own layout happens to place there.
   * `fill` stretches the tint over the whole row (flow rows have no fixed height).
   */
  private rowTestStatusTintHtml(
    region: IDocLoopRegionElement,
    row: Record<string, unknown>,
    meta: IDocumentMetaContext,
    env: RenderEnv,
    contentHeight: number,
    fill = false,
  ): string {
    const status = resolvePassFailStatus(region, row, meta, env);
    if (!status) return '';

    const tokens = TEST_STATUS_ROW_COLORS[status];
    const bg = sanitizeCssColor(tokens.htmlTint, null);
    const solid = sanitizeCssColor(tokens.solid, null);
    const extent = fill ? 'bottom:0;' : `height:${Math.ceil(contentHeight)}px;`;
    const tintHtml = bg
      ? `<div style="position:absolute; left:0; top:0; right:0; ${extent} background-color:${bg}; z-index:0;"></div>`
      : '';
    const badgeHtml = solid
      ? `<div style="position:absolute; top:2px; right:4px; z-index:999; padding:1px 6px; border-radius:3px; background-color:${solid}; color:#ffffff; font-family:Arial,sans-serif; font-size:10px; font-weight:700; line-height:1.4;">${escapeHtml(tokens.label)}</div>`
      : '';

    return `${tintHtml}${badgeHtml}`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tokens
  // ───────────────────────────────────────────────────────────────────────────

  /** Interpolate for HTML context: values escaped, sanitize AFTER. */
  private interpolate(
    html: string,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: RenderEnv,
  ): string {
    return html.replace(TOKEN_REGEX, (_match, key: string) => {
      if (key.startsWith('var.')) {
        return escapeHtml(formatVarValue(env.variables.get(key.slice(4))));
      }
      return escapeHtml(
        resolveTokenText(
          key,
          item?.raw ?? null,
          env.dataCtx,
          meta,
          env.warnings,
        ),
      );
    });
  }

  /** Interpolate for plain-text/attribute context (caller escapes). */
  private interpolateText(
    text: string,
    item: IDocumentContextItem | null,
    meta: IDocumentMetaContext,
    env: RenderEnv,
  ): string {
    return interpolateTokensToText(
      text,
      item?.raw ?? null,
      env.dataCtx,
      meta,
      env.warnings,
      env.variables,
    );
  }

  private resolveImageSource(
    src: DocImageSrc,
    env: RenderEnv,
    elementId: string,
  ): string {
    if (src.kind === 'data') return src.dataUri;
    if (src.kind === 'url') return src.url;
    if (env.options.resolveImageSrc) {
      try {
        return env.options.resolveImageSrc(src) ?? '';
      } catch {
        env.warnings.push(
          `Image element ${elementId}: storage image could not be resolved`,
        );
        return '';
      }
    }
    env.warnings.push(
      `Image element ${elementId}: storage images require an image resolver (rendered empty)`,
    );
    return '';
  }

  private buildMeta(
    env: RenderEnv,
    itemIndex: number | undefined,
    itemCount: number,
  ): IDocumentMetaContext {
    return {
      exportDate: env.options.exportDate ?? new Date(),
      exportedByUserId: env.options.exportedByUserId ?? null,
      itemIndex,
      itemCount,
      templateName: env.options.templateName ?? null,
      templateDescription: env.options.templateDescription ?? null,
      templateUpdatedAt: env.options.templateUpdatedAt ?? null,
      sourceEntity: env.definition.sourceEntity,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (exported ones are shared with the DOCX renderer — keep both formats
// consuming the SAME algorithms so content never diverges between exports)
// ─────────────────────────────────────────────────────────────────────────────

export function topLevelElements(elements: IDocElement[]): IDocElement[] {
  return elements.filter((el) => !el.parentId);
}

export function groupChildren(
  elements: IDocElement[],
): Map<string, IDocElement[]> {
  const map = new Map<string, IDocElement[]>();
  for (const el of elements) {
    if (!el.parentId) continue;
    const list = map.get(el.parentId) ?? [];
    list.push(el);
    map.set(el.parentId, list);
  }
  return map;
}

export function sortByZIndex<T extends IDocElement>(elements: T[]): T[] {
  return [...elements].sort((a, b) => a.zIndex - b.zIndex);
}

/** A task-list loop region (comments, history, …). */
// ponytail: geometric guess (the block touching the region's top, max 200px); add a per-element "repeat on
// every page" flag if a template ever needs something else repeated.
const REGION_HEADER_MAX_HEIGHT = 200;

/**
 * Page-level elements forming an items region's column header: those ending
 * at its top edge plus everything vertically overlapping them, within the
 * region's x-range. Empty when nothing touches the region's top.
 */
function regionHeaderElements(
  region: IDocLoopRegionElement,
  elements: IDocElement[],
): IDocElement[] {
  const candidates = elements.filter(
    (el) =>
      !el.parentId &&
      el.type !== 'loop_region' &&
      el.type !== 'variable_set' &&
      el.positionMode !== 'anchored' &&
      el.y < region.y &&
      el.x < region.x + region.width &&
      region.x < el.x + el.width,
  );
  const header = candidates.filter(
    (el) => Math.abs(region.y - (el.y + el.height)) <= 4,
  );
  if (header.length === 0) return [];

  let top = Math.min(...header.map((el) => el.y));
  let grew = true;

  while (grew) {
    grew = false;
    for (const el of candidates) {
      if (!header.includes(el) && el.y + el.height > top) {
        header.push(el);
        top = Math.min(top, el.y);
        grew = true;
      }
    }
  }

  return region.y - top <= REGION_HEADER_MAX_HEIGHT ? header : [];
}

/** Top space of every page after the first in a document with task lists. */
function listPageTop(definition: IDocumentTemplateDefinition): number {
  return Math.max(definition.page.pageBreakMargin, definition.page.margins.top);
}

function isListRegion(el: IDocElement): el is IDocLoopRegionElement {
  return el.type === 'loop_region' && isTaskListSource(el.dataSource);
}

interface IFlowMargins {
  marginLeft: number;
  marginTop: number;
  minHeight?: number;
}

/** A flow child: its designed geometry plus its HTML at given margins (null = collapsed). */
interface IFlowEntry {
  el: IDocElement;
  render: ((marginLeft: number, marginTop: number) => string) | null;
}

/**
 * Lays entries out in document flow: entries whose designed vertical ranges
 * overlap share a line; lines keep the designed vertical gaps as padding (a
 * margin could collapse or escape the parent) and items keep their designed
 * x and in-line y as flex margins. Returns the designed bottom of the last line.
 */
function renderFlowLines(
  entries: IFlowEntry[],
  originX: number,
  originY: number,
): { html: string; bottom: number } {
  const lines: Array<{ top: number; bottom: number; entries: IFlowEntry[] }> =
    [];
  for (const entry of [...entries].sort((a, b) => a.el.y - b.el.y)) {
    const last = lines[lines.length - 1];
    const bottom = entry.el.y + entry.el.height;
    if (last && entry.el.y < last.bottom) {
      last.entries.push(entry);
      last.bottom = Math.max(last.bottom, bottom);
    } else {
      lines.push({ top: entry.el.y, bottom, entries: [entry] });
    }
  }

  let previousBottom = originY;
  const html = lines
    .map((line) => {
      let previousRight = originX;
      const items = [...line.entries]
        .sort((a, b) => a.el.x - b.el.x)
        .map((entry) => {
          // A collapsed entry is not in the DOM, so it moves nothing.
          if (!entry.render) return '';
          const itemHtml = entry.render(
            entry.el.x - previousRight,
            entry.el.y - line.top,
          );
          previousRight = entry.el.x + entry.el.width;
          return itemHtml;
        })
        .join('');
      const gap = Math.max(0, line.top - previousBottom);
      previousBottom = line.bottom;
      return `<div class="doc-flow-line" style="padding-top:${round(gap)}px;">${items}</div>`;
    })
    .join('');

  return { html, bottom: previousBottom };
}

/**
 * Interpolate `{{token}}` placeholders to PLAIN TEXT (unescaped — HTML callers
 * escape before insertion; the DOCX renderer consumes the text directly).
 * `{{var.name}}` reads a runtime template variable's CURRENT value in
 * `variables` — a live Map lookup, never undefined-throws, missing/unset
 * resolves to `''` (see formatVarValue).
 */
export function interpolateTokensToText(
  text: string,
  rawItem: Record<string, unknown> | null,
  dataCtx: IDocumentDataContext,
  meta: IDocumentMetaContext,
  warnings: string[],
  variables?: Map<string, unknown>,
): string {
  return text.replace(TOKEN_REGEX, (_match, key: string) => {
    if (key.startsWith('var.')) {
      return formatVarValue(variables?.get(key.slice(4)));
    }
    return resolveTokenText(key, rawItem, dataCtx, meta, warnings);
  });
}

/**
 * `undefined`/`null` (never assigned, or explicitly cleared) → `''`;
 * otherwise stringified. A variable only ever holds what applyVariableMutation
 * stores — a string (assign/concat) or a number (increment/decrement) — so
 * the JSON.stringify branch is unreachable in practice, kept only as a safe
 * fallback rather than assuming the narrower type.
 */
function formatVarValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/** Structural subset RenderEnv/DocxEnv both satisfy — shared by resolveLiveToken/substituteLiveTokens. */
interface ILiveTokenEnv {
  liveTokenCache: Map<string, Map<string, unknown[]>>;
  liveTokenVisitIndex: Map<string, number>;
  variables: Map<string, unknown>;
  warnings: string[];
}

const LIVE_TOKEN_REGEX = /\{\{\s*live\.([\w.]+)\s*\}\}/g;

/** Distinct `{{live.X}}` variable names referenced in a text/link element's content. */
function extractLiveTokenVarNames(content: string): string[] {
  const names = new Set<string>();
  const re = new RegExp(LIVE_TOKEN_REGEX);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) names.add(match[1]);
  return Array.from(names);
}

/**
 * Resolve one `{{live.X}}` occurrence for `elementId`, consuming the next
 * snapshot in visit order (recorded by computeFinalVariables's pre-pass into
 * liveTokenCache — see its doc). The real render visits elements in the same
 * order as the pre-pass, so the Nth real visit of (elementId, varName) reads
 * the Nth recorded snapshot for that pair — independent counters per varName
 * so an element referencing two different live variables never cross-advances
 * them. Falls back to the FINAL value (identical to {{var.X}}) with a
 * warning when nothing was recorded — e.g. used outside any loop iteration,
 * or the variable is never mutated in that element's own walk position —
 * fail-open, matching how ElementConditionEvaluator already handles
 * unresolvable references elsewhere in this file: never a crash, never a
 * blanked export.
 */
function resolveLiveToken(
  env: ILiveTokenEnv,
  elementId: string,
  varName: string,
): unknown {
  const history = env.liveTokenCache.get(elementId)?.get(varName);
  if (!history || history.length === 0) {
    env.warnings.push(
      `{{live.${varName}}} on element ${elementId} has no recorded per-row value; showing the final value instead`,
    );
    return env.variables.get(varName);
  }

  const counterKey = `${elementId} ${varName}`;
  const nextIndex = env.liveTokenVisitIndex.get(counterKey) ?? 0;
  env.liveTokenVisitIndex.set(counterKey, nextIndex + 1);
  return history[Math.min(nextIndex, history.length - 1)];
}

/**
 * Pre-substitute every `{{live.X}}` occurrence in `content` with its resolved
 * value BEFORE the existing `{{var.X}}`/`{{token}}` interpolation runs, so
 * neither `interpolate()` nor `interpolateTokensToText()` needs to know
 * `live.` exists — `{{var.X}}` and every other token keep their current
 * implementation, untouched. No-op (returns `content` unchanged) when no
 * `live.` token is present, which is every existing template today.
 */
export function substituteLiveTokens(
  content: string,
  elementId: string,
  env: ILiveTokenEnv,
): string {
  if (!content.includes('{{live.')) return content;
  return content.replace(LIVE_TOKEN_REGEX, (_match, varName: string) =>
    formatVarValue(resolveLiveToken(env, elementId, varName)),
  );
}

/** Snapshot every `{{live.X}}` variable a text/link element references, at THIS point in the pre-pass walk — see computeFinalVariables's doc. */
function recordLiveTokenSnapshots(
  env: {
    liveTokenCache: Map<string, Map<string, unknown[]>>;
    variables: Map<string, unknown>;
  },
  el: IDocElement,
): void {
  const content =
    el.type === 'text'
      ? el.html
      : el.type === 'link'
        ? `${el.text} ${el.href}`
        : '';
  if (!content.includes('{{live.')) return;

  const names = extractLiveTokenVarNames(content);
  if (names.length === 0) return;

  let perElement = env.liveTokenCache.get(el.id);
  if (!perElement) {
    perElement = new Map();
    env.liveTokenCache.set(el.id, perElement);
  }
  for (const name of names) {
    const history = perElement.get(name) ?? [];
    history.push(env.variables.get(name));
    perElement.set(name, history);
  }
}

/** Minimal IDocumentContextItem for a loop row — id from the row when present, entityType always 'task' (matches the pre-existing loop-row convention). */
function rowContextItem(row: Record<string, unknown>): IDocumentContextItem {
  const rowId = row['id'];
  return {
    id: typeof rowId === 'string' ? rowId : '',
    entityType: 'task',
    raw: row,
  };
}

/**
 * Apply one variable_set element's mutation. `value` is resolved through the
 * SAME {{token}} interpolation every text/field element uses (a literal like
 * "1", a row token like "{{issue.summary}}", or another variable's current
 * value via "{{var.other}}"). Type coercion on assign/increment/decrement/
 * concat is explicit, not implicit: increment/decrement treat an unset or
 * non-numeric prior value as 0 (never "NaN" or string-concatenated "01"),
 * concat treats unset as '', assign always overwrites.
 */
export function applyVariableMutation(
  el: IDocVariableSetElement,
  rawRow: Record<string, unknown> | null,
  dataCtx: IDocumentDataContext,
  meta: IDocumentMetaContext,
  variables: Map<string, unknown>,
  warnings: string[],
): void {
  const resolvedValue = interpolateTokensToText(
    el.value,
    rawRow,
    dataCtx,
    meta,
    warnings,
    variables,
  );
  const current = variables.get(el.varName);

  switch (el.op) {
    case 'assign':
      variables.set(el.varName, resolvedValue);
      return;
    case 'concat': {
      variables.set(el.varName, formatVarValue(current) + resolvedValue);
      return;
    }
    case 'increment':
    case 'decrement': {
      const currentNum =
        typeof current === 'number' ? current : Number(current);
      const base = Number.isFinite(currentNum) ? currentNum : 0;
      const deltaNum = Number(resolvedValue);
      const delta = Number.isFinite(deltaNum) ? deltaNum : 0;
      variables.set(
        el.varName,
        el.op === 'increment' ? base + delta : base - delta,
      );
      return;
    }
  }
}

/** Structural subset of RenderEnv/DocxEnv computeFinalVariables needs — lets both renderers share one pre-pass implementation. */
interface IVariableWalkEnv {
  definition: IDocumentTemplateDefinition;
  dataCtx: IDocumentDataContext;
  evaluator: ElementConditionEvaluator;
  childrenByParent: Map<string, IDocElement[]>;
  variables: Map<string, unknown>;
  warnings: string[];
  liveTokenCache: Map<string, Map<string, unknown[]>>;
}

/**
 * Pre-pass shared by both renderers: walks the render tree ONCE — same walk
 * order the real render will use — evaluating conditions and applying every
 * variable_set mutation, so `env.variables` is FULLY COMPUTED before the real
 * render starts. Both display ({{var.x}} tokens) and condition-reading
 * ('var.x' in a rule) then read the one finished map: a variable's value is
 * always its value at the END of the whole document, never a mid-walk
 * snapshot — this sidesteps needing a second (placeholder-substitution) pass
 * over the real output, and keeps HTML/PDF and DOCX byte-for-byte consistent
 * since both call this exact same function.
 *
 * ponytail: deliberate simplification — a condition can't observe a
 * variable's value mid-loop, only after the full document is processed.
 * Upgrade path: a genuine two-pass/placeholder scheme, only if a template
 * ever needs a running-total DISPLAYED during its own loop (not just after).
 */
export function computeFinalVariables(
  env: IVariableWalkEnv,
  buildMeta: (
    itemIndex: number | undefined,
    itemCount: number,
  ) => IDocumentMetaContext,
): void {
  const { definition, dataCtx } = env;
  if (dataCtx.items.length === 0) return;

  const walk = (
    elements: IDocElement[],
    contextRow: Record<string, unknown> | null,
    meta: IDocumentMetaContext,
    depth: number,
  ): void => {
    for (const el of sortByZIndex(elements)) {
      const condition = env.evaluator.evaluate(
        el.condition,
        contextRow,
        meta,
        env.variables,
      );
      if (condition.warning) env.warnings.push(condition.warning);
      if (!condition.show) continue;

      if (el.type === 'variable_set') {
        applyVariableMutation(
          el,
          contextRow,
          dataCtx,
          meta,
          env.variables,
          env.warnings,
        );
        continue;
      }

      if (el.type === 'text' || el.type === 'link') {
        recordLiveTokenSnapshots(env, el);
      }

      if (
        el.type === 'loop_region' &&
        el.dataSource !== 'items' &&
        depth < MAX_LOOP_REGION_DEPTH
      ) {
        const contextItem = rowContextItem(contextRow ?? {});
        const rows = resolveRegionLoopRows(
          el,
          contextItem,
          dataCtx,
          env.evaluator,
          env.warnings,
          env.variables,
        );
        const children = env.childrenByParent.get(el.id) ?? [];
        for (const row of rows) walk(children, row, meta, depth + 1);
      }
    }
  };

  if (definition.mode === 'repeat_per_item') {
    const pageEls = topLevelElements(definition.elements);
    dataCtx.items.forEach((item, index) => {
      const meta = buildMeta(index + 1, dataCtx.items.length);
      walk(pageEls, item.raw, meta, 0);
    });
  } else {
    const docMeta = buildMeta(undefined, dataCtx.items.length);
    const pageEls = topLevelElements(definition.elements);
    const nonRegionTop = pageEls.filter((el) => el.type !== 'loop_region');
    walk(nonRegionTop, null, docMeta, 0);

    const itemRegions = pageEls.filter(
      (el): el is IDocLoopRegionElement => el.type === 'loop_region',
    );
    for (const region of itemRegions) {
      const entries = applyRegionListOps(
        region,
        dataCtx.items.map((item) => ({ row: item.raw, item })),
        env.evaluator,
        env.warnings,
        env.variables,
      );
      const children = env.childrenByParent.get(region.id) ?? [];
      for (const entry of entries) {
        if (!entry.item) continue;
        const index = dataCtx.items.indexOf(entry.item);
        const meta = buildMeta(index + 1, dataCtx.items.length);
        walk(children, entry.row, meta, 1);
      }
    }
  }
}

/**
 * fixed_document band decomposition: slice the document's y axis (FULL-PAGE
 * space — element y is page-origin, the flow starts at the physical page top)
 * into alternating gap/region bands, assign statics to the band containing
 * their y origin, and split off `anchored` elements (repeated on every
 * printed page). `pageHeight` floors the tail band so a short document still
 * fills one full page.
 */
export function decomposeFixedDocumentBands(
  elements: IDocElement[],
  pageHeight: number,
  warnings: string[],
): IFixedDocDecomposition {
  const pageEls = topLevelElements(elements);

  const anchored = pageEls.filter((el) => el.positionMode === 'anchored');
  const regions = pageEls
    .filter(
      (el): el is IDocLoopRegionElement =>
        el.type === 'loop_region' && el.positionMode !== 'anchored',
    )
    .sort((a, b) => a.y - b.y);
  const statics = pageEls.filter(
    (el) => el.type !== 'loop_region' && el.positionMode !== 'anchored',
  );

  // Build bands: alternating gap / region slices of the page's y axis.
  const bands: IFixedDocBand[] = [];
  let cursor = 0;
  for (const region of regions) {
    const start = Math.max(cursor, region.y);
    if (region.y < cursor) {
      warnings.push(
        `Loop region ${region.id} overlaps the previous region; it was pushed down`,
      );
    }
    if (start > cursor) {
      bands.push({ start: cursor, end: start, region: null, statics: [] });
    }
    bands.push({
      start,
      end: start + region.height,
      region,
      statics: [],
    });
    cursor = start + region.height;
  }

  const maxStaticBottom = statics.reduce(
    (acc, el) => Math.max(acc, el.y + el.height),
    0,
  );
  const tailEnd = Math.max(pageHeight, maxStaticBottom, cursor);
  if (tailEnd > cursor) {
    bands.push({ start: cursor, end: tailEnd, region: null, statics: [] });
  }
  if (bands.length === 0) {
    bands.push({ start: 0, end: pageHeight, region: null, statics: [] });
  }

  // Assign static elements to the band containing their y origin.
  for (const el of statics) {
    const band =
      bands.find((entry) => el.y >= entry.start && el.y < entry.end) ??
      bands[bands.length - 1];
    band.statics.push(el);
    if (band.end !== tailEnd && el.y + el.height > band.end) {
      warnings.push(
        `Element ${el.id} spans across a loop region boundary; it cannot reflow with the region`,
      );
    }
  }

  return { anchored, bands, tailEnd };
}

/**
 * Authored multi-page support (fixed_document): split bands at every authored
 * page boundary k*pageHeight so each authored page's content is one or more
 * WHOLE bands — renderers then force a page break at each boundary and band k
 * maps 1:1 to physical page k. Statics are re-assigned to the half containing
 * their y origin; elements straddling a boundary stay in their origin's half
 * (straddling is allowed by the contract). pageCount ≤ 1 is a no-op.
 */
export function splitBandsAtAuthoredBoundaries(
  bands: IFixedDocBand[],
  pageHeight: number,
  pageCount: number,
): IFixedDocBand[] {
  if (pageCount <= 1 || pageHeight <= 0) return bands;

  const out: IFixedDocBand[] = [];

  for (const band of bands) {
    let start = band.start;
    let statics = band.statics;
    const firstBoundary = Math.floor(start / pageHeight) + 1;

    for (let k = firstBoundary; k < pageCount; k++) {
      const boundary = k * pageHeight;
      if (boundary <= start || boundary >= band.end) continue;

      out.push({
        ...band,
        start,
        end: boundary,
        statics: statics.filter((el) => el.y < boundary),
      });
      start = boundary;
      statics = statics.filter((el) => el.y >= boundary);
    }

    out.push({ ...band, start, end: band.end, statics });
  }

  return out;
}

/** Rows for a subtasks/linked_tasks/dynamic_query loop region (filter/sort/limit applied). */
export function resolveRegionLoopRows(
  region: IDocLoopRegionElement,
  contextItem: IDocumentContextItem,
  dataCtx: IDocumentDataContext,
  evaluator: ElementConditionEvaluator,
  warnings: string[],
  variables?: Map<string, unknown>,
): Array<Record<string, unknown>> {
  let rows: Array<Record<string, unknown>>;
  if (region.dataSource === 'subtasks') {
    rows = dataCtx.subtasksByItemId[contextItem.id] ?? [];
  } else if (region.dataSource === 'linked_tasks') {
    let entries: IDocumentLinkedEntry[] =
      dataCtx.linkedByItemId[contextItem.id] ?? [];
    if (region.relationTypeId) {
      entries = entries.filter(
        (entry) => entry.relationTypeId === region.relationTypeId,
      );
    }
    rows = entries.map((entry) => ({
      ...entry.task,
      _relation_name: entry.relationName,
      _relation_direction: entry.direction,
    }));
  } else if (region.dataSource === 'dynamic_query') {
    rows = dataCtx.dynamicQueryByRegionId[region.id]?.[contextItem.id] ?? [];
  } else if (isTaskListSource(region.dataSource)) {
    rows =
      dataCtx.taskListsByTaskId?.[contextItem.id]?.[region.dataSource] ?? [];
  } else {
    // 'items' regions are handled by the band decomposition; reaching this
    // path means an invalid definition slipped through validation.
    warnings.push(
      `Loop region ${region.id} with dataSource 'items' cannot nest; rendered empty`,
    );
    rows = [];
  }

  return applyRegionListOps(
    region,
    rows.map((row) => ({ row, item: null })),
    evaluator,
    warnings,
    variables,
  ).map((entry) => entry.row);
}

/**
 * A top-level `items` region with its filter dropped when the caller opted out.
 *
 * That filter exists to narrow a broad, query-shaped item list. When the items
 * were selected explicitly instead (an `ids` scope — e.g. the Export by Template
 * automation rendering the one record that fired its trigger), re-applying it can
 * only ever remove the record that was explicitly requested, producing a document
 * that is silently empty. Only the top-level list is affected; nested
 * subtask/linked/dynamic-query regions keep their own filters.
 */
export function scopedItemsRegion(
  region: IDocLoopRegionElement,
  ignoreFilter: boolean | undefined,
): IDocLoopRegionElement {
  return ignoreFilter && region.filter ? { ...region, filter: null } : region;
}

/** Apply a region's filter/sortBy/maxItems list operations. */
export function applyRegionListOps<
  T extends {
    row: Record<string, unknown>;
    item: IDocumentContextItem | null;
  },
>(
  region: IDocLoopRegionElement,
  entries: T[],
  evaluator: ElementConditionEvaluator,
  warnings: string[],
  variables?: Map<string, unknown>,
): T[] {
  let result = entries;

  if (region.filter) {
    const beforeCount = result.length;
    result = result.filter((entry) => {
      const condition = evaluator.evaluate(
        region.filter,
        entry.row,
        undefined,
        variables,
      );
      if (condition.warning) warnings.push(condition.warning);
      return condition.show;
    });
    if (beforeCount > 0 && result.length === 0) {
      warnings.push(
        `Loop region ${region.id}'s filter matched 0 of ${beforeCount} candidate item(s) — region will render empty`,
      );
    }
  }

  if (region.sortBy) {
    const key = region.sortBy;
    const dir = region.sortDir === 'desc' ? -1 : 1;
    result = [...result].sort(
      (a, b) =>
        compareValues(
          regionSortValue(a.row, key),
          regionSortValue(b.row, key),
        ) * dir,
    );
  }

  if (region.maxItems != null && region.maxItems > 0) {
    result = result.slice(0, region.maxItems);
  }

  return result;
}

/**
 * Resolve a region sortBy key against a loop row. The designer stores custom
 * fields under their BARE field_key (and older definitions may carry the
 * `cf_` prefix) — try the row column first, then custom_field_values under
 * both shapes, mirroring the condition evaluator's key mapping.
 */
function regionSortValue(
  row: Record<string, unknown>,
  sortKey: string,
): unknown {
  if (sortKey in row) return row[sortKey];

  const bare = sortKey.startsWith('cf_') ? sortKey.slice(3) : sortKey;
  if (bare in row) return row[bare];

  const customValues = row['custom_field_values'];
  if (customValues && typeof customValues === 'object') {
    return (customValues as Record<string, unknown>)[bare];
  }
  return undefined;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // nulls last
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return comparableText(a).localeCompare(comparableText(b));
}

function comparableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS value sanitizers — escapeHtml is HTML-safe, not CSS-safe: it preserves
// ';', ':', '(' and '/' so a style value like `x;background:url(https://…)`
// would survive into the inline style attribute. These whitelists reject any
// value that could carry extra declarations or fetch external resources.
// ─────────────────────────────────────────────────────────────────────────────

/** Letters/digits/underscore, spaces, commas, quotes and hyphens only. */
const SAFE_FONT_FAMILY_REGEX = /^[\w\s,'-]+$/;

/** Hex / rgb() / rgba() / hsl() / named-color charset; no ';' ':' '/' 'url'. */
const SAFE_CSS_COLOR_REGEX = /^[a-zA-Z#0-9(),.%\s]+$/;

/** Returns the value when safe for a font-family declaration, else null. */
export function sanitizeCssFontFamily(
  value: string | undefined,
): string | null {
  if (!value) return null;
  return SAFE_FONT_FAMILY_REGEX.test(value) ? value : null;
}

/**
 * Returns the value when safe for a CSS color declaration, else `fallback`
 * (a known-safe default color, or null to drop the declaration entirely).
 */
export function sanitizeCssColor<F extends string | null>(
  value: string | undefined,
  fallback: F,
): string | F {
  if (!value) return fallback;
  return SAFE_CSS_COLOR_REGEX.test(value) ? value : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass/fail row styling — fixed, render-time-only design tokens for Loop rows.
// Deliberately narrow word-boundary match (not a broad synonym list): this
// app's default seeded statuses (open/in_progress/review/done/closed/blocked)
// contain neither substring, so this can never recolor an ordinary task loop.
// ─────────────────────────────────────────────────────────────────────────────

export const TEST_STATUS_ROW_COLORS = {
  pass: { htmlTint: '#10B98115', solid: '#10B981', label: 'Pass' },
  fail: { htmlTint: '#EF444415', solid: '#EF4444', label: 'Fail' },
} as const;

const PASS_STATUS_REGEX = /\bpass(ed|ing)?\b/i;
const FAIL_STATUS_REGEX = /\bfail(ed|ing)?\b/i;

/** Pure text classifier — checks name, falls back to key. No I/O. */
export function classifyTestStatus(
  name?: string | null,
  key?: string | null,
): 'pass' | 'fail' | null {
  for (const text of [name, key]) {
    if (!text) continue;
    if (FAIL_STATUS_REGEX.test(text)) return 'fail';
    if (PASS_STATUS_REGEX.test(text)) return 'pass';
  }
  return null;
}

/**
 * Every bindable field key for `sourceEntity`, system fields first (in
 * SYSTEM_FIELDS_BY_ENTITY's own catalog order — the same order the
 * Pass/Fail field picker itself lists them in) then every currently-loaded
 * custom field def, `cf_`-prefixed. Used as the scan list when a region has
 * no explicit `passFailFieldKeys` configured.
 */
function defaultPassFailScanKeys(
  sourceEntity: DocumentSourceEntity,
  dataCtx: Pick<IDocumentDataContext, 'orgFieldDefs' | 'fieldDefsBySpace'>,
): string[] {
  const systemKeys = (SYSTEM_FIELDS_BY_ENTITY[sourceEntity] ?? []).map(
    (field) => field.key,
  );

  const customKeys = new Set(Object.keys(dataCtx.orgFieldDefs));
  for (const spaceDefs of Object.values(dataCtx.fieldDefsBySpace)) {
    for (const key of Object.keys(spaceDefs)) customKeys.add(key);
  }

  return [...systemKeys, ...[...customKeys].map((key) => `cf_${key}`)];
}

/**
 * Resolves a loop row's Pass/Fail status. Checks each of the region's
 * configured `passFailFieldKeys` (bare system key or `cf_`-prefixed custom
 * field key, same convention as `sortBy`/`filterField`) in order, via the
 * same formatFieldValue() pipeline every visible field binding already
 * uses, and returns the first one that classifies as Pass/Fail. When no
 * keys are configured, scans every bindable field for this region's source
 * entity instead (defaultPassFailScanKeys) — so an unconfigured region still
 * gets automatic styling, at the cost of a wider false-positive surface
 * (accepted trade-off — a template author who wants a narrow, precise match
 * should explicitly configure the field(s) to check). The scan path routes
 * formatFieldValue's warnings to a throwaway sink, not env.warnings — most
 * scanned fields legitimately don't apply to a given row (e.g. a task-only
 * column absent on a wiki row), which is expected/silent during a broad
 * speculative probe, not something a template author needs to see. An
 * EXPLICITLY configured key still reports to env.warnings — there, a
 * warning is actionable feedback about the author's own configuration.
 */
export function resolvePassFailStatus(
  region: IDocLoopRegionElement,
  row: Record<string, unknown>,
  meta: IDocumentMetaContext,
  env: Pick<RenderEnv, 'dataCtx' | 'warnings' | 'definition'>,
): 'pass' | 'fail' | null {
  // List rows have no status to scan for — skip the per-field HTML parsing.
  if (!region.passFailFieldKeys?.length && taskListRowSource(row)) return null;

  const explicit = Boolean(region.passFailFieldKeys?.length);
  const keys = explicit
    ? (region.passFailFieldKeys as string[])
    : defaultPassFailScanKeys(env.definition.sourceEntity, env.dataCtx);
  const scanWarnings: string[] = [];

  for (const key of keys) {
    const isCustom = key.startsWith('cf_');
    const binding: IDocFieldBinding = {
      source: isCustom ? 'custom_field' : 'system',
      fieldKey: isCustom ? key.slice(3) : key,
    };
    const display = formatFieldValue(
      binding,
      row,
      env.dataCtx,
      meta,
      explicit ? env.warnings : scanWarnings,
    );
    const result = classifyTestStatus(stripHtmlToText(display));
    if (result) return result;
  }

  return null;
}
