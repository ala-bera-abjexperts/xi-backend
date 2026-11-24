/**
 * @fileoverview Source-agnostic Confluence macro (scaffold — semantic translation via the
 * macro registry lands in Phase 10; unknown macros fall back to `body.view` + lossy report).
 */

export interface NormalizedMacro {
  /** Macro name (e.g. "info", "code", "jira"). */
  name: string;
  params: Record<string, string>;
  /** Rich-text body (storage XHTML) for container macros. */
  richTextBody?: string;
  /** Plain-text body (e.g. code macro contents). */
  plainTextBody?: string;
}
