/**
 * @fileoverview Geometry helpers for the v2 Word layout used by
 * DocxRenderService (renderRepeatPerItemV2 / renderFixedDocumentV2): columns
 * that keep their designed x (explicit gap cells), containment-aware row
 * clustering, element box styling (background, border, padding, opacity) and
 * the Word structure guards (separator between adjacent tables, a cell never
 * ending with a table). Pure — `docx` plus type-only imports.
 * @module src/document-designer/rendering/docx-layout
 */

import {
  BorderStyle,
  HeightRule,
  Paragraph,
  ShadingType,
  Table,
  TableLayoutType,
  TableRow,
  WidthType,
} from 'docx';
import type {
  IDocElement,
  IDocElementStyle,
} from '../template-definition/template-definition.types';
import {
  blendOverWhite,
  cssColorToHex,
  separatorParagraph,
  xmlSafe,
} from './docx-html';

/** Deep copy with XML-illegal control characters stripped from every string (list rows reach Word through the legacy cell path). */
export function xmlSafeDeep<T>(value: T): T {
  if (typeof value === 'string') return xmlSafe(value) as T;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((entry) => xmlSafeDeep(entry)) as T;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        xmlSafeDeep(entry),
      ]),
    ) as T;
  }

  return value;
}

/** `{{token}}` — the same shape document-render's TOKEN_REGEX interpolates. */
export const TOKEN_PATTERN = /\{\{\s*[\w.]+\s*\}\}/g;

/** Escapes a resolved token value for insertion into HTML text/attributes. */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 'legacy' keeps the original table flow — rollback via DOCUMENT_DESIGNER_DOCX_LAYOUT=legacy. */
export function resolveDocxLayout(
  requested?: 'v2' | 'legacy',
): 'v2' | 'legacy' {
  if (requested) return requested;

  return process.env.DOCUMENT_DESIGNER_DOCX_LAYOUT?.trim().toLowerCase() ===
    'legacy'
    ? 'legacy'
    : 'v2';
}

/** CSS px at 96 dpi → twips (×15 exact). */
export function twip(px: number): number {
  return Math.round(px * 15);
}

/** Geometry tolerance: designed boxes within 2px of the row edges fill it. */
export const SNAP_PX = 2;

/** A resolved text longer than this lets its row split across pages. */
export const SHORT_ROW_TEXT = 400;

export const NO_BORDER = {
  style: BorderStyle.NONE,
  size: 0,
  color: 'auto',
} as const;

export interface IBorderEdge {
  style: (typeof BorderStyle)[keyof typeof BorderStyle];
  size: number;
  color: string;
}

export interface ICellBorders {
  top: IBorderEdge | typeof NO_BORDER;
  bottom: IBorderEdge | typeof NO_BORDER;
  left: IBorderEdge | typeof NO_BORDER;
  right: IBorderEdge | typeof NO_BORDER;
}

export const NO_CELL_BORDERS: ICellBorders = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
};

export interface ILayoutColumn {
  x: number;
  widthPx: number;
  elements: IDocElement[];
}

export interface ILayoutCell {
  kind: 'gap' | 'content';
  x: number;
  widthPx: number;
  widthTwip: number;
  elements: IDocElement[];
  /** Left inset when a gap column was folded in (Word's 63-column limit). */
  padLeftPx: number;
}

/** Word rejects tables wider than 63 grid columns. */
export const MAX_WORD_COLUMNS = 63;

/** Elements sharing an exact x stack in one column (same rule as groupByX); vertically disjoint overlaps stack too. */
export function groupColumns(elements: IDocElement[]): ILayoutColumn[] {
  const byX = new Map<number, IDocElement[]>();

  for (const el of elements) {
    const group = byX.get(el.x) ?? [];
    group.push(el);
    byX.set(el.x, group);
  }

  const columns = Array.from(byX.entries())
    .sort(([xa], [xb]) => xa - xb)
    .map(([x, els]) => ({
      x,
      widthPx: Math.max(...els.map((el) => el.width)),
      elements: [...els].sort((a, b) => a.y - b.y),
    }));

  // A band above an inset body shares one column (stacked), not side by side.
  const merged: ILayoutColumn[] = [];
  for (const column of columns) {
    const last = merged[merged.length - 1];
    if (last && stacksWith(last, column)) {
      last.widthPx =
        Math.max(last.x + last.widthPx, column.x + column.widthPx) - last.x;
      last.elements = [...last.elements, ...column.elements].sort(
        (a, b) => a.y - b.y,
      );
    } else {
      merged.push(column);
    }
  }

  return merged;
}

/** Horizontally overlapping columns whose elements never overlap vertically. */
function stacksWith(left: ILayoutColumn, right: ILayoutColumn): boolean {
  if (right.x >= left.x + left.widthPx - SNAP_PX) return false;

  return left.elements.every((a) =>
    right.elements.every(
      (b) => a.y + a.height <= b.y + SNAP_PX || b.y + b.height <= a.y + SNAP_PX,
    ),
  );
}

/**
 * Content cells plus explicit gap cells so every column starts at its
 * designed x. Overlapping columns shrink the left one (Word can't overlap);
 * everything is clamped to [minX, maxRight]. `leadingGap` adds a gap cell
 * from minX to the first column (loop regions — their table indent is the
 * region's own x); otherwise the first column's x becomes the table indent.
 */
export function layoutColumns(
  columns: ILayoutColumn[],
  minX: number,
  maxRight: number,
  leadingGap: boolean,
): { indentPx: number; cells: ILayoutCell[] } {
  let cells: Array<Omit<ILayoutCell, 'widthTwip'>> = [];
  const sorted = [...columns].sort((a, b) => a.x - b.x);
  let cursor: number | null = leadingGap ? minX : null;
  let indentPx = leadingGap ? minX : 0;

  for (const column of sorted) {
    let start = Math.min(Math.max(column.x, minX), maxRight - 1);
    const end = Math.max(
      start + 1,
      Math.min(column.x + column.widthPx, maxRight),
    );

    if (cursor === null) {
      indentPx = start;
      cursor = start;
    } else if (start > cursor) {
      cells.push({
        kind: 'gap',
        x: cursor,
        widthPx: start - cursor,
        elements: [],
        padLeftPx: 0,
      });
    } else if (start < cursor) {
      const previous = cells[cells.length - 1];
      const previousEnd = Math.max(previous.x + 1, start);
      previous.widthPx = previousEnd - previous.x;
      start = Math.max(start, previousEnd);
    }

    const width = Math.max(1, end - start);
    cells.push({
      kind: 'content',
      x: start,
      widthPx: width,
      elements: column.elements,
      padLeftPx: 0,
    });
    cursor = start + width;
  }

  // Too many columns for Word: fold each gap into the next content cell as a left inset.
  if (cells.length > MAX_WORD_COLUMNS) {
    const folded: typeof cells = [];
    let pending: (typeof cells)[number] | null = null;
    for (const cell of cells) {
      if (cell.kind === 'gap') {
        pending = cell;
        continue;
      }
      folded.push(
        pending
          ? {
              ...cell,
              x: pending.x,
              widthPx: cell.widthPx + pending.widthPx,
              padLeftPx: pending.widthPx,
            }
          : cell,
      );
      pending = null;
    }
    cells = folded;
  }

  // Cumulative rounding so the twip widths always sum to the row's extent.
  const sized = cells.map((cell) => ({
    ...cell,
    widthTwip: Math.max(1, twip(cell.x + cell.widthPx) - twip(cell.x)),
  }));

  return { indentPx: Math.max(0, indentPx), cells: sized };
}

function isShape(el: IDocElement): boolean {
  return el.type === 'rectangle' || el.type === 'ellipse';
}

function contains(shape: IDocElement, el: IDocElement): boolean {
  return (
    el.x >= shape.x &&
    el.y >= shape.y &&
    el.x + el.width <= shape.x + shape.width &&
    el.y + el.height <= shape.y + shape.height &&
    el.zIndex > shape.zIndex
  );
}

/**
 * Visual rows by y-range overlap with the last-added element (the legacy
 * clusterRows rule), plus: an element fully inside a lower-z rectangle/ellipse
 * always joins that shape's row, so a card with stacked lines stays one row.
 */
export function clusterRowsV2(elements: IDocElement[]): IDocElement[][] {
  const sorted = [...elements].sort((a, b) => a.y - b.y);
  const rows: IDocElement[][] = [];
  const shapeRows: Array<{ shape: IDocElement; row: IDocElement[] }> = [];
  let current: IDocElement[] = [];
  let lastEnd = -Infinity;

  for (const el of sorted) {
    const host = shapeRows
      .filter((entry) => entry.shape !== el && contains(entry.shape, el))
      .pop();
    if (host) {
      host.row.push(el);
      if (isShape(el)) shapeRows.push({ shape: el, row: host.row });
      continue;
    }

    if (current.length > 0 && el.y < lastEnd) {
      current.push(el);
    } else {
      current = [el];
      rows.push(current);
    }
    lastEnd = el.y + el.height;
    if (isShape(el)) shapeRows.push({ shape: el, row: current });
  }

  return rows;
}

/** Element opacity clamped to [0, 1]. */
export function opacityOf(style: IDocElementStyle | undefined): number {
  const value = style?.opacity;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;

  return Math.min(1, Math.max(0, value));
}

/** Word colour (RRGGBB) for a CSS colour after opacity over `beneath`. */
export function boxColor(
  value: string | undefined,
  opacity: number,
  beneath?: string,
): string | undefined {
  const hex = cssColorToHex(value);
  if (!hex) return undefined;

  return opacity < 1 ? blendOverWhite(hex, opacity, beneath) : hex;
}

export function hasBoxStyle(style: IDocElementStyle | undefined): boolean {
  return (
    !!cssColorToHex(style?.backgroundColor) ||
    (style?.borderWidth ?? 0) > 0 ||
    (style?.padding ?? 0) > 0
  );
}

export interface IBoxCellOptions {
  shading?: {
    type: (typeof ShadingType)[keyof typeof ShadingType];
    fill: string;
    color: string;
  };
  borders: ICellBorders;
  padding: number;
  fill?: string;
}

/** Background → shading, border → cell borders, padding → cell margins. */
export function boxCellOptions(
  style: IDocElementStyle | undefined,
  beneath?: string,
): IBoxCellOptions {
  const opacity = opacityOf(style);
  const fill = boxColor(style?.backgroundColor, opacity, beneath);
  const borderWidth = style?.borderWidth ?? 0;
  const borderColor =
    boxColor(style?.borderColor ?? '#000000', opacity, beneath) ?? '000000';
  const edge: IBorderEdge = {
    style: BorderStyle.SINGLE,
    size: Math.max(1, Math.round(borderWidth * 6)),
    color: borderColor,
  };

  return {
    ...(fill
      ? { shading: { type: ShadingType.CLEAR, fill, color: 'auto' }, fill }
      : {}),
    borders:
      borderWidth > 0
        ? { top: edge, bottom: edge, left: edge, right: edge }
        : NO_CELL_BORDERS,
    padding: Math.max(0, style?.padding ?? 0),
  };
}

/** A designed minimum row height that grows with its content (never clips). */
export function atLeast(heightPx: number): {
  value: number;
  rule: (typeof HeightRule)[keyof typeof HeightRule];
} {
  return { value: Math.max(1, twip(heightPx)), rule: HeightRule.ATLEAST };
}

/** Zero-padding, fixed-layout, borderless table — widths are honoured exactly. */
export function flowTable(
  rows: TableRow[],
  widthsTwip: number[],
  indentPx = 0,
): Table {
  return new Table({
    width: {
      size: widthsTwip.reduce((sum, width) => sum + width, 0),
      type: WidthType.DXA,
    },
    columnWidths: widthsTwip,
    layout: TableLayoutType.FIXED,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    ...(indentPx > 0
      ? { indent: { size: twip(indentPx), type: WidthType.DXA } }
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

/** A designed vertical gap inside a cell: 1pt paragraph with space before. */
export function gapParagraph(gapPx: number): Paragraph {
  return new Paragraph({
    children: [],
    run: { size: 2 },
    spacing: { before: twip(Math.max(0, gapPx)), after: 0 },
  });
}

/** Word merges directly adjacent tables — keep a 1pt paragraph between them. */
export function separateTables<T>(blocks: T[]): Array<T | Paragraph> {
  const out: Array<T | Paragraph> = [];

  for (const block of blocks) {
    const previous = out[out.length - 1];
    if (block instanceof Table && previous instanceof Table) {
      out.push(separatorParagraph());
    }
    out.push(block);
  }

  return out;
}

/** A table cell must hold a paragraph and must not end with a table. */
export function cellChildren<T>(blocks: T[]): Array<T | Paragraph> {
  const out = separateTables(blocks);
  if (out.length === 0 || out[out.length - 1] instanceof Table) {
    out.push(separatorParagraph());
  }

  return out;
}

/** Short, block-free rows stay whole on a page; long ones may split (never clipped). */
export function keepRowTogether(texts: string[]): boolean {
  let length = 0;

  for (const text of texts) {
    if (/<(ul|ol|table|pre|h[1-6]|blockquote)\b/i.test(text)) return false;
    // [^<>]: linear time even on hostile input with many '<'.
    length += text.replace(/<[^<>]*>/g, '').length;
    if (length > SHORT_ROW_TEXT) return false;
  }

  return true;
}

/** Contain-fit a natural size into a box (no crop support in Word). */
export function fitInto(
  natural: { width: number; height: number } | null,
  box: { width: number; height: number },
): { width: number; height: number } {
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return {
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
    };
  }
  const scale = Math.min(
    box.width / natural.width,
    box.height / natural.height,
  );

  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  };
}
