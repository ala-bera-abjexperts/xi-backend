// Format-aware sanitizer for wiki page content, applied on WRITE (create/update)
// so stored + served content can never carry XSS. Wiki content is stored either
// as HTML (legacy TipTap, `content_format='html'`) or as Editor.js JSON
// (default). The renderers inject a number of Editor.js fields via
// `dangerouslySetInnerHTML` (Header/Paragraph `data.text`, Raw `data.html`,
// Quote `data.text`/`data.caption`, Warning `data.title`/`data.message`,
// Toggle/Notice, list items, table cells), so each of those HTML-bearing fields
// is run through the shared DOMPurify sanitizer.
//
// IMPORTANT: only the HTML-content fields are sanitized. Structural/URL fields
// (level, alignment, link, alt, style, stretched, …) are left byte-for-byte
// intact so the Editor.js document is never corrupted — sanitizing a URL like
// `?a=1&b=2` would entity-encode the `&` and break it. Unparseable content
// degrades to HTML sanitization; anything that is valid JSON but not an
// Editor.js `{blocks:[...]}` document is returned unchanged (never throws).

import { sanitizeRichText } from './sanitize-rich-text';

// `data` keys that carry rich HTML rendered via dangerouslySetInnerHTML.
const HTML_FIELDS = new Set(['text', 'html', 'title', 'message', 'caption']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeString(value: unknown): unknown {
  return typeof value === 'string' ? (sanitizeRichText(value) ?? '') : value;
}

// Editor.js list/checklist item: a bare HTML string, or `{ text|content, items? }`
// with arbitrarily nested sub-items.
function sanitizeItem(item: unknown): unknown {
  if (typeof item === 'string') return sanitizeRichText(item) ?? '';
  if (!isRecord(item)) return item;

  const out: Record<string, unknown> = { ...item };

  if (typeof out['text'] === 'string')
    out['text'] = sanitizeRichText(out['text']) ?? '';
  if (typeof out['content'] === 'string')
    out['content'] = sanitizeRichText(out['content']) ?? '';
  if (Array.isArray(out['items']))
    out['items'] = out['items'].map(sanitizeItem);

  return out;
}

function sanitizeBlockData(data: unknown): unknown {
  if (!isRecord(data)) return data;

  const out: Record<string, unknown> = { ...data };

  for (const [key, value] of Object.entries(out)) {
    if (HTML_FIELDS.has(key)) {
      out[key] = sanitizeString(value);
    } else if (key === 'items' && Array.isArray(value)) {
      out[key] = value.map(sanitizeItem);
    } else if (key === 'content' && Array.isArray(value)) {
      // Table block: `content` is a 2D array of cell HTML strings.
      out[key] = value.map((row) =>
        Array.isArray(row) ? row.map(sanitizeString) : row,
      );
    }
  }

  return out;
}

/**
 * Sanitize wiki page content before persisting.
 *
 * @param content - Raw `wiki_pages.content` value (HTML string or Editor.js JSON).
 * @param format - `'html'` or `'editorjs'` (default). When unknown, Editor.js is
 *   assumed; content that fails to parse as JSON degrades to HTML sanitization,
 *   so an html-format payload mislabeled as editorjs is still sanitized.
 * @returns The sanitized content string (never throws).
 */
export function sanitizeWikiContentForStorage(
  content: string | null | undefined,
  format: string | null | undefined,
): string {
  if (typeof content !== 'string' || !content.trim()) {
    return typeof content === 'string' ? content : '';
  }

  if (format === 'html') {
    return sanitizeRichText(content) ?? '';
  }

  // Editor.js (default): parse, sanitize HTML fields, re-serialize.
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    // Not JSON — treat defensively as HTML.
    return sanitizeRichText(content) ?? '';
  }

  if (
    !isRecord(parsed) ||
    !Array.isArray((parsed as { blocks?: unknown }).blocks)
  ) {
    // Valid JSON but not an Editor.js block document — don't risk corrupting a
    // shape we don't understand.
    return content;
  }

  const doc = parsed as Record<string, unknown> & { blocks: unknown[] };

  const sanitizedBlocks = doc.blocks.map((block) => {
    if (!isRecord(block)) return block;

    return { ...block, data: sanitizeBlockData(block['data']) };
  });

  return JSON.stringify({ ...doc, blocks: sanitizedBlocks });
}
