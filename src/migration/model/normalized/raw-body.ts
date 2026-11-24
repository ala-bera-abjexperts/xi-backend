/**
 * @fileoverview Raw rich-text body carried through extraction untransformed.
 *
 * The content transformer (Phase 6) decides the format BY VALUE, never by
 * cloud/server assumption: object → ADF, string containing `ac:` → Confluence
 * storage XHTML, other string → Jira wiki markup, pre-rendered → html.
 */

export type RawBodyFormat = 'adf' | 'wiki' | 'storage' | 'html';

export interface RawBody {
  format: RawBodyFormat;
  /** ADF document object, or the raw markup string. */
  value: unknown;
  /** Server's pre-rendered HTML (`expand=renderedFields`) when available — transformer fallback. */
  renderedHtml?: string;
}
