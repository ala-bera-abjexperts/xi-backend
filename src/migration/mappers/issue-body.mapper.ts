/**
 * @fileoverview Jira issue description → HTML for `tasks.description`. Pure — no DI, no DB.
 *
 * Jira Server returns descriptions as WIKI MARKUP (`{code}`, `h1.`, `*bold*`), which is useless to
 * a browser — but the search call already asks for `expand=renderedFields`, so the server hands us
 * its OWN rendered HTML alongside. Using that is strictly more faithful than re-implementing Jira's
 * wiki renderer, and it is what `RawBody.renderedHtml` exists to carry. (It was previously never
 * consumed by anything.)
 *
 * `TasksService.create` runs `sanitizeRichText(dto.description, { allowTables: true })` itself, so
 * callers must NOT pre-sanitize. Tables survive that policy, so a Jira table imports as a real
 * table and stays editable. `describeLoss` still reports the losses that remain real — chiefly
 * wiki markup the source never rendered for us.
 */

import type { RawBody } from '../model/normalized';
import { adfToCir } from '../transformers/adf-to-html';
import { cirToHtml, type CirResolved } from '../transformers/cir-serializer';

/**
 * ADF (Cloud) bodies convert through the same pure pipeline the Confluence page path uses
 * (`adfToCir` → `cirToHtml`). No crosswalk is consulted here: task/comment surfaces have no
 * `pageSourceId`, so inline attachment/page refs cannot resolve — they render display-only, and the
 * separate `attachments` stage carries the files. `nativeTables: true` matches the `allowTables`
 * policy `TasksService` applies to descriptions and comments, so an ADF table lands as semantic
 * `<table>` markup the task editor can render and edit rather than a flattened cell-text list.
 */
const ADF_RESOLVED: CirResolved = {
  users: new Map(),
  pages: new Map(),
  attachments: new Map(),
  nativeTables: true,
};

/**
 * Convert an ADF document object to allow-listed HTML. Pure; unknown Cloud macros (extensions)
 * defer to a placeholder node rather than importing the storage-format renderer, which pulls in
 * jsdom and would break this mapper's no-DOM contract.
 */
function adfToHtml(value: unknown): string {
  const cir = adfToCir(value, {
    onMacro: (macro) => ({ type: 'macroDeferred', name: macro.name }),
  });

  return cirToHtml(cir, ADF_RESOLVED);
}

/** Minimal escape for the plain-text fallback path. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wiki markup with no server-rendered HTML: emit the text faithfully as paragraphs rather than
 * dumping raw markup into the page or dropping it. Blank-line separated blocks → <p>, single
 * newlines → <br>. Never attempts to interpret markup — a half-parsed `{code}` block is worse than
 * honest plain text, and the loss is reported by `describeLoss`.
 */
function plainTextToHtml(text: string): string {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${escapeHtml(block).replace(/\r?\n/g, '<br />')}</p>`)
    .join('\n');
}

/**
 * The HTML to hand `TasksService.create`, or `undefined` when the issue has no description.
 *
 * Order of preference:
 *  1. `renderedHtml` — Jira's own rendering of its own markup. Most faithful.
 *  2. `format: 'html'` — already HTML.
 *  3. `format: 'wiki'` string with no rendering — plain-text paragraphs (honest, lossy).
 *  4. ADF (Cloud) — converted structurally via `adfToCir` → `cirToHtml`; `undefined` only when the
 *     document is genuinely empty, so an image-only body does not become a blank row.
 */
export function issueDescriptionToHtml(
  body: RawBody | undefined,
): string | undefined {
  if (!body) return undefined;

  if (typeof body.renderedHtml === 'string' && body.renderedHtml.trim()) {
    return body.renderedHtml;
  }

  if (body.format === 'html' && typeof body.value === 'string') {
    return body.value.trim() ? body.value : undefined;
  }

  if (body.format === 'adf') {
    const html = adfToHtml(body.value);

    return html.trim() ? html : undefined;
  }

  if (body.format === 'wiki' && typeof body.value === 'string') {
    const html = plainTextToHtml(body.value);

    return html || undefined;
  }

  return undefined;
}

/**
 * A human-readable fidelity note when the conversion loses something, else `undefined`.
 * The stage logs this to `migration_logs` — silent loss is the failure mode this project has
 * already been bitten by.
 */
export function describeLoss(body: RawBody | undefined): string | undefined {
  if (!body) return undefined;

  // ADF converts structurally, tables included, so there is no loss left to report on this branch.
  if (body.format === 'adf' && !body.renderedHtml) return undefined;

  if (
    body.format === 'wiki' &&
    typeof body.value === 'string' &&
    !body.renderedHtml
  ) {
    return 'Wiki-markup description with no rendered HTML from the source — migrated as plain-text paragraphs, markup not interpreted';
  }

  // Rendered HTML from Jira Server passes through verbatim and is sanitized with `allowTables`, so
  // its tables keep their grid. Jira's cosmetic `style`/`width` attributes are dropped, which is a
  // presentation change rather than a data loss and is deliberately not reported.
  return undefined;
}
