/**
 * @fileoverview Renders a document template + resolved data context into a
 * TipTap document (JSON), for pushing into a Wiki2 page. Reuses document-
 * render.service's shared helpers, same as docx-render.service.ts does.
 * A `loop_region` always renders as a table (one column per child element,
 * x-order). PURE — no I/O; image resolution happens in the orchestrator.
 * @module src/document-designer/rendering/tiptap-render.service
 */

import { Injectable } from '@nestjs/common';
import type {
  DocImageSrc,
  IDocElement,
  IDocFieldElement,
  IDocImageElement,
  IDocLinkElement,
  IDocLoopRegionElement,
  IDocTextElement,
  IDocumentTemplateDefinition,
} from '../template-definition/template-definition.types';
import { getSourceEntityConfig } from '../source-entities';
import { MAX_LOOP_REGION_DEPTH } from '../template-definition/template-definition.schema';
import { ElementConditionEvaluator } from './element-condition-evaluator';
import type {
  IDocumentContextItem,
  IDocumentDataContext,
  IDocumentFieldDef,
} from './document-data-resolver.service';
import {
  applyRegionListOps,
  scopedItemsRegion,
  computeFinalVariables,
  groupChildren,
  interpolateTokensToText,
  resolvePassFailStatus,
  resolveRegionLoopRows,
  sortByZIndex,
  substituteLiveTokens,
  TEST_STATUS_ROW_COLORS,
  topLevelElements,
} from './document-render.service';
import {
  formatFieldValue,
  resolveFieldDef,
  type IDocumentMetaContext,
} from './field-formatter';
import { sanitizeHtml, stripHtmlToText } from './html-sanitizer';
import {
  isTaskListSource,
  TASK_LIST_LABELS,
  taskListRowSource,
} from './task-list-sources';
import {
  parseHtmlFragmentToInlineNodes,
  parseHtmlFragmentToTipTapNodes,
  type TipTapNode,
} from './doc-text-html-to-tiptap';

export interface ITipTapRenderOptions {
  /** See IDocumentRenderOptions.ignoreItemsRegionFilter — same contract. */
  ignoreItemsRegionFilter?: boolean;
  exportedByUserId?: string | null;
  exportDate?: Date;
  templateName?: string | null;
  templateDescription?: string | null;
  templateUpdatedAt?: Date | null;
  /** Storage-kind images only — data:/url: sources are read directly off the (already `prepareImages`-processed) definition. */
  resolveImageSrc?: (src: DocImageSrc) => string;
}

export interface ITipTapRenderResult {
  doc: { type: 'doc'; content: TipTapNode[] };
  warnings: string[];
}

interface TipTapRenderEnv {
  definition: IDocumentTemplateDefinition;
  dataCtx: IDocumentDataContext;
  options: ITipTapRenderOptions;
  warnings: string[];
  evaluator: ElementConditionEvaluator;
  childrenByParent: Map<string, IDocElement[]>;
  variables: Map<string, unknown>;
  liveTokenCache: Map<string, Map<string, unknown[]>>;
  liveTokenVisitIndex: Map<string, number>;
}

function toContextItem(
  row: Record<string, unknown> | null,
): IDocumentContextItem {
  const id = row?.['id'];

  return {
    id: typeof id === 'string' ? id : '',
    entityType: 'task',
    raw: row ?? {},
  };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

@Injectable()
export class TipTapRenderService {
  render(
    definition: IDocumentTemplateDefinition,
    dataCtx: IDocumentDataContext,
    options: ITipTapRenderOptions = {},
  ): ITipTapRenderResult {
    const warnings: string[] = [];
    const env: TipTapRenderEnv = {
      definition,
      dataCtx,
      options,
      warnings,
      evaluator: new ElementConditionEvaluator(
        getSourceEntityConfig(definition.sourceEntity).itemEntityType,
      ),
      childrenByParent: groupChildren(definition.elements),
      variables: new Map(),
      liveTokenCache: new Map(),
      liveTokenVisitIndex: new Map(),
    };

    computeFinalVariables(env, (itemIndex, itemCount) =>
      this.buildMeta(env, itemIndex, itemCount),
    );

    let content: TipTapNode[];

    if (dataCtx.items.length === 0) {
      content = [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'No items matched this export.' }],
        },
      ];
    } else if (definition.mode === 'repeat_per_item') {
      content = this.renderRepeatPerItem(env);
    } else {
      content = this.renderFixedDocument(env);
    }

    return { doc: { type: 'doc', content }, warnings };
  }

  private buildMeta(
    env: TipTapRenderEnv,
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

  // Top-level modes

  private renderRepeatPerItem(env: TipTapRenderEnv): TipTapNode[] {
    const { definition, dataCtx } = env;
    const pageEls = topLevelElements(definition.elements);
    const sections: TipTapNode[] = [];

    dataCtx.items.forEach((item, index) => {
      const meta = this.buildMeta(env, index + 1, dataCtx.items.length);

      if (index > 0) sections.push({ type: 'horizontalRule' });
      sections.push(...this.walkElements(pageEls, item.raw, meta, env, 0));
    });

    return sections;
  }

  private renderFixedDocument(env: TipTapRenderEnv): TipTapNode[] {
    const { definition, dataCtx } = env;
    const pageEls = topLevelElements(definition.elements);
    const docMeta = this.buildMeta(env, undefined, dataCtx.items.length);
    const nonRegionTop = pageEls.filter((el) => el.type !== 'loop_region');
    const nodes = this.walkElements(nonRegionTop, null, docMeta, env, 0);

    const itemRegions = pageEls.filter(
      (el): el is IDocLoopRegionElement => el.type === 'loop_region',
    );

    for (const region of itemRegions) {
      const entries = applyRegionListOps(
        scopedItemsRegion(region, env.options.ignoreItemsRegionFilter),
        dataCtx.items.map((item) => ({ row: item.raw, item })),
        env.evaluator,
        env.warnings,
        env.variables,
      );

      nodes.push(
        this.buildLoopRegionTable(
          region,
          entries.map((e) => e.row),
          docMeta,
          env,
          0,
        ),
      );
    }

    return nodes;
  }

  // Element walk

  private walkElements(
    elements: IDocElement[],
    contextRow: Record<string, unknown> | null,
    meta: IDocumentMetaContext,
    env: TipTapRenderEnv,
    depth: number,
  ): TipTapNode[] {
    const nodes: TipTapNode[] = [];

    for (const el of sortByZIndex(elements)) {
      const condition = env.evaluator.evaluate(
        el.condition,
        contextRow,
        meta,
        env.variables,
      );

      if (condition.warning) env.warnings.push(condition.warning);
      if (!condition.show) continue;

      switch (el.type) {
        case 'variable_set':
          // Already applied by the computeFinalVariables pre-pass — nothing to emit.
          continue;
        case 'line':
        case 'rectangle':
        case 'ellipse':
          env.warnings.push(
            `${el.type} element ${el.id} is a decorative shape and was skipped in the wiki push`,
          );
          continue;
        case 'text':
          nodes.push(...this.renderTextElement(el, contextRow, meta, env));
          continue;
        case 'link':
          nodes.push(this.renderLinkElement(el, contextRow, meta, env));
          continue;
        case 'field':
          nodes.push(...this.renderFieldElement(el, contextRow, env, meta));
          continue;
        case 'image': {
          const node = this.renderImageElement(el, env);

          if (node) nodes.push({ type: 'paragraph', content: [node] });
          continue;
        }
        case 'loop_region': {
          if (depth >= MAX_LOOP_REGION_DEPTH) {
            env.warnings.push(
              `Loop region ${el.id} exceeds the max nesting depth and was skipped`,
            );
            continue;
          }

          const rows = resolveRegionLoopRows(
            el,
            toContextItem(contextRow),
            env.dataCtx,
            env.evaluator,
            env.warnings,
            env.variables,
          );

          // An empty task list is left out (the HTML render collapses it too).
          if (rows.length === 0 && isTaskListSource(el.dataSource)) continue;

          nodes.push(this.buildLoopRegionTable(el, rows, meta, env, depth));
          continue;
        }
      }
    }

    return nodes;
  }

  // Element renderers

  private renderTextElement(
    el: IDocTextElement,
    contextRow: Record<string, unknown> | null,
    meta: IDocumentMetaContext,
    env: TipTapRenderEnv,
  ): TipTapNode[] {
    const withLive = substituteLiveTokens(el.html, el.id, env);
    const withTokens = interpolateTokensToText(
      withLive,
      contextRow,
      env.dataCtx,
      meta,
      env.warnings,
      env.variables,
    );
    const safe = sanitizeHtml(withTokens);

    return parseHtmlFragmentToTipTapNodes(safe);
  }

  private renderLinkElement(
    el: IDocLinkElement,
    contextRow: Record<string, unknown> | null,
    meta: IDocumentMetaContext,
    env: TipTapRenderEnv,
  ): TipTapNode {
    const text = interpolateTokensToText(
      el.text,
      contextRow,
      env.dataCtx,
      meta,
      env.warnings,
      env.variables,
    );
    const href = interpolateTokensToText(
      el.href,
      contextRow,
      env.dataCtx,
      meta,
      env.warnings,
      env.variables,
    );

    if (!text) return { type: 'paragraph', content: [] };

    return {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text,
          ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}),
        },
      ],
    };
  }

  private renderFieldElement(
    el: IDocFieldElement,
    contextRow: Record<string, unknown> | null,
    env: TipTapRenderEnv,
    meta: IDocumentMetaContext,
  ): TipTapNode[] {
    if (
      el.binding.source === 'custom_field' &&
      !taskListRowSource(contextRow)
    ) {
      const key = el.binding.fieldKey.startsWith('cf_')
        ? el.binding.fieldKey.slice(3)
        : el.binding.fieldKey;
      const def = resolveFieldDef(key, contextRow, env.dataCtx);

      if (def?.field_type === 'grid') {
        return [this.renderGridFieldValue(key, contextRow, def)];
      }
    }

    const html = formatFieldValue(
      el.binding,
      contextRow,
      env.dataCtx,
      meta,
      env.warnings,
    );
    const inline = parseHtmlFragmentToInlineNodes(html);

    return inline.length > 0 ? [{ type: 'paragraph', content: inline }] : [];
  }

  private renderImageElement(
    el: IDocImageElement,
    env: TipTapRenderEnv,
  ): TipTapNode | null {
    let src = '';

    if (el.src.kind === 'data') src = el.src.dataUri;
    else if (el.src.kind === 'url')
      src = el.src.url; // already blanked by prepareImages upstream if disallowed
    else src = env.options.resolveImageSrc?.(el.src) ?? '';

    if (!src) {
      env.warnings.push(
        `Image element ${el.id} could not be resolved for the wiki push (rendered empty)`,
      );

      return null;
    }

    return { type: 'image', attrs: { src } };
  }

  private renderGridFieldValue(
    key: string,
    contextRow: Record<string, unknown> | null,
    def: IDocumentFieldDef,
  ): TipTapNode {
    const customValues = contextRow?.['custom_field_values'] as
      | Record<string, unknown>
      | undefined;
    const value = customValues?.[key];
    const rows = Array.isArray(value) ? value : [];
    const columns = def.options ?? [];

    if (columns.length === 0) {
      const text = rows
        .map((row) =>
          cellText(
            row && typeof row === 'object'
              ? (row as Record<string, unknown>)['values']
              : row,
          ),
        )
        .join('; ');

      return {
        type: 'paragraph',
        content: text ? [{ type: 'text', text }] : [],
      };
    }

    const headerRow: TipTapNode = {
      type: 'tableRow',
      content: columns.map((col) => ({
        type: 'tableHeader',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: col.label }] },
        ],
      })),
    };

    const bodyRows: TipTapNode[] = rows.map((row) => {
      const cellValues =
        row && typeof row === 'object'
          ? ((row as Record<string, unknown>)['values'] as
              | Record<string, unknown>
              | undefined)
          : undefined;

      return {
        type: 'tableRow',
        content: columns.map((col) => {
          const text = cellText(cellValues?.[col.value]);

          return {
            type: 'tableCell',
            content: text
              ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
              : [],
          };
        }),
      };
    });

    return { type: 'table', content: [headerRow, ...bodyRows] };
  }

  // Loop region → table

  private buildLoopRegionTable(
    region: IDocLoopRegionElement,
    rows: Array<Record<string, unknown>>,
    meta: IDocumentMetaContext,
    env: TipTapRenderEnv,
    depth = 0,
  ): TipTapNode {
    const children = (env.childrenByParent.get(region.id) ?? []).filter(
      (
        c,
      ): c is
        | IDocFieldElement
        | IDocTextElement
        | IDocImageElement
        | IDocLinkElement
        | IDocLoopRegionElement =>
        c.type === 'field' ||
        c.type === 'text' ||
        c.type === 'image' ||
        c.type === 'link' ||
        c.type === 'loop_region',
    );
    const sortedChildren = [...children].sort((a, b) => a.x - b.x);

    if (sortedChildren.length === 0) {
      env.warnings.push(
        `Loop region ${region.id} has no bindable child elements — rendered as an empty paragraph`,
      );

      return { type: 'paragraph', content: [] };
    }

    const headerRow: TipTapNode = {
      type: 'tableRow',
      content: sortedChildren.map((child) => ({
        type: 'tableHeader',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: this.columnLabel(child) }],
          },
        ],
      })),
    };

    const bodyRows: TipTapNode[] = rows.map((row) => {
      // Pass/fail row tint only — mirrors docx-render.service.ts's testStatusRowStyle, no text badge needed since the table color reads fine in a wiki page.
      const status = resolvePassFailStatus(region, row, meta, {
        dataCtx: env.dataCtx,
        warnings: env.warnings,
        definition: env.definition,
      });
      const backgroundColor = status
        ? TEST_STATUS_ROW_COLORS[status].htmlTint
        : undefined;

      return {
        type: 'tableRow',
        content: sortedChildren.map((child) => {
          const content = this.renderCellContent(child, row, meta, env, depth);

          return {
            type: 'tableCell',
            ...(backgroundColor ? { attrs: { backgroundColor } } : {}),
            content:
              content.length > 0
                ? content
                : [{ type: 'paragraph', content: [] }],
          };
        }),
      };
    });

    return { type: 'table', content: [headerRow, ...bodyRows] };
  }

  private renderCellContent(
    child:
      | IDocFieldElement
      | IDocTextElement
      | IDocImageElement
      | IDocLinkElement
      | IDocLoopRegionElement,
    row: Record<string, unknown>,
    meta: IDocumentMetaContext,
    env: TipTapRenderEnv,
    depth: number,
  ): TipTapNode[] {
    switch (child.type) {
      case 'field':
        return this.renderFieldElement(child, row, env, meta);
      case 'text':
        return this.renderTextElement(child, row, meta, env);
      case 'link':
        return [this.renderLinkElement(child, row, meta, env)];
      case 'image': {
        const node = this.renderImageElement(child, env);

        return node ? [{ type: 'paragraph', content: [node] }] : [];
      }
      case 'loop_region': {
        if (depth + 1 >= MAX_LOOP_REGION_DEPTH) {
          env.warnings.push(
            `Loop region ${child.id} exceeds the max nesting depth and was skipped`,
          );

          return [];
        }

        const nestedRows = resolveRegionLoopRows(
          child,
          toContextItem(row),
          env.dataCtx,
          env.evaluator,
          env.warnings,
          env.variables,
        );

        if (nestedRows.length === 0 && isTaskListSource(child.dataSource)) {
          return [];
        }

        return [
          this.buildLoopRegionTable(child, nestedRows, meta, env, depth + 1),
        ];
      }
    }
  }

  private columnLabel(
    child:
      | IDocFieldElement
      | IDocTextElement
      | IDocImageElement
      | IDocLinkElement
      | IDocLoopRegionElement,
  ): string {
    if (child.type === 'field') {
      if (child.binding.label) return child.binding.label;

      const bare = child.binding.fieldKey.startsWith('cf_')
        ? child.binding.fieldKey.slice(3)
        : child.binding.fieldKey;

      return bare.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    }

    if (child.type === 'text') {
      const plain = stripHtmlToText(child.html);

      return plain.slice(0, 40) || 'Text';
    }

    if (child.type === 'loop_region') {
      if (isTaskListSource(child.dataSource)) {
        return TASK_LIST_LABELS[child.dataSource].en;
      }

      const labels: Record<string, string> = {
        subtasks: 'Subtasks',
        linked_tasks: 'Linked items',
        dynamic_query: 'Items',
        items: 'Items',
      };

      return labels[child.dataSource] ?? 'Sub-items';
    }

    return child.type === 'image' ? 'Image' : 'Link';
  }

  /** Recursive node count — pre-flight check against tiptap-sanitizer.ts's MAX_NODES before this ever reaches WikiService. */
  countNodes(node: TipTapNode): number {
    let count = 1;

    for (const child of node.content ?? []) count += this.countNodes(child);

    return count;
  }
}
