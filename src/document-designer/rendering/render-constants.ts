// =============================================================================
// DOCUMENT DESIGNER — SHARED RENDER CONSTANTS
//
// SYNC RULE: the values in this file MUST stay identical to the frontend copy
// in src/views/document-designer/editor/designer-constants.ts (shared block).
// The designer canvas positions elements with these numbers and the backend
// renderer prints with them — divergence breaks WYSIWYG.
//
// Units: CSS px at 96 dpi (1in = 96px; A4 210mm → 794px).
// =============================================================================

import type {
  DocumentPaperOrientation,
  DocumentPaperSize,
} from '../template-definition/template-definition.types';

/** Portrait dimensions; swap width/height for landscape. */
export const PAGE_SIZES_PX: Record<
  DocumentPaperSize,
  { width: number; height: number }
> = {
  A4: { width: 794, height: 1123 },
  Letter: { width: 816, height: 1056 },
  Legal: { width: 816, height: 1344 },
  A3: { width: 1123, height: 1587 },
  A5: { width: 559, height: 794 },
};

export function getPageDimensionsPx(
  size: DocumentPaperSize,
  orientation: DocumentPaperOrientation,
): { width: number; height: number } {
  const dims = PAGE_SIZES_PX[size];

  return orientation === 'landscape'
    ? { width: dims.height, height: dims.width }
    : dims;
}

/** PDF-safe font whitelist offered by the designer typography inspector. */
export const DOCUMENT_FONT_FAMILIES = [
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Georgia',
  'Courier New',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
] as const;

/** Style fallbacks applied by the renderer when an element omits a key. */
export const DEFAULT_ELEMENT_STYLE = {
  fontFamily: 'Arial',
  fontSize: 16,
  fontWeight: 400,
  lineHeight: 1.4,
  textAlign: 'left',
  color: '#000000',
  backgroundColor: 'transparent',
  borderColor: '#000000',
  borderWidth: 0,
  borderRadius: 0,
  opacity: 1,
  padding: 0,
} as const;

export const DEFAULT_PAGE_MARGINS_PX = {
  top: 48,
  right: 48,
  bottom: 48,
  left: 48,
} as const;
