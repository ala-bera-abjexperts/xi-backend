/**
 * @fileoverview HTML sanitizer for the document renderer. All user-authored
 * HTML (TipTap text elements, editor custom-field values) passes through this
 * before being embedded in the rendered document, which is later printed by
 * headless Chromium — so script execution and external-resource smuggling must
 * be impossible.
 *
 * Mirrors the jsdom + DOMPurify singleton pattern from
 * `src/common/utils/sanitize-rich-text.ts`, but uses a blocklist profile
 * tailored to print output: forbidden active tags/handlers, and URI schemes
 * restricted to http(s) and data:image.
 * @module src/document-designer/rendering/html-sanitizer
 */

import createDOMPurify, { type WindowLike } from 'dompurify';
import type { DOMWindow } from 'jsdom';
import * as jsdomModule from 'jsdom';

interface JSDOMConstructor {
  new (html: string): { window: DOMWindow };
}

const typedJsdom = jsdomModule as unknown as { JSDOM: JSDOMConstructor };
const DOMPurify = createDOMPurify(
  new typedJsdom.JSDOM('').window as unknown as WindowLike,
);

/** http(s) and inline data:image URIs only — no file:, javascript:, blob:, … */
const ALLOWED_URI_REGEXP = /^(?:https?:|data:image\/)/i;

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form'];

const FORBID_ATTR = [
  'onerror',
  'onload',
  'onclick',
  'onmouseover',
  'onmouseout',
  'onmousedown',
  'onmouseup',
  'onfocus',
  'onblur',
  'onchange',
  'onsubmit',
  'oninput',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onwheel',
  'onscroll',
  'onanimationstart',
  'ontransitionend',
];

/**
 * Sanitize an HTML fragment for embedding into the rendered document.
 * DOMPurify strips all `on*` handlers and `javascript:` URIs by default;
 * the explicit lists above are defense-in-depth per the module contract.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Strip ALL tags and return entity-safe text content. Used when an
 * HTML-capable field is rendered without `format.renderHtml`.
 * The output is safe to embed directly into HTML (DOMPurify keeps
 * entity encoding for `<`, `>`, `&`).
 */
export function stripHtmlToText(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  }).trim();
}
