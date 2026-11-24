/**
 * @fileoverview Detect a raw body's format BY VALUE (never by cloud/server assumption):
 * an object → ADF; a string with `ac:`/`ri:` markup → Confluence storage; a string that looks
 * like rendered HTML → html; anything else → wiki markup.
 */

import type { RawBody } from '../model/normalized';

export type DetectedFormat = 'adf' | 'storage' | 'html' | 'wiki';

export function detectFormat(body: RawBody): DetectedFormat {
  if (
    body.format === 'adf' ||
    (typeof body.value === 'object' && body.value !== null)
  ) {
    return 'adf';
  }

  const value = typeof body.value === 'string' ? body.value : '';

  if (body.format === 'storage' || /<ac:|<ri:/.test(value)) return 'storage';

  if (body.format === 'html') return 'html';

  // A string with HTML tags but no Confluence markup — treat as rendered HTML.
  if (/<[a-z][\s\S]*>/i.test(value)) return 'html';

  return 'wiki';
}
