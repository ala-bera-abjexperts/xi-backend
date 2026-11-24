/**
 * @fileoverview Non-Turing-complete token expander for workflow rule templates.
 * Mirrors the frontend `expand.ts` character-for-character.
 * @module src/workflow-engine/templating/expand
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';

const TOKEN_RE =
  /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/**
 * Safely look up a dotted path on an object. Rejects __proto__, constructor,
 * prototype to prevent prototype pollution. Returns undefined for any miss.
 */
export function safeGet(obj: unknown, path: string): unknown {
  const segments = path.split('.');
  let cur: unknown = obj;

  for (const seg of segments) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
      return undefined;
    }
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }

  return cur;
}

/**
 * Expand `{{path.to.value}}` or `{{path | fallback}}` against a context object.
 * Unknown tokens are left as-is in the output. No conditionals, no loops, no
 * function calls — purely a string substitution.
 */
export function expand(template: string, ctx: Record<string, unknown>): string {
  return template.replace(
    TOKEN_RE,
    (match, rawPath: string, rawFallback?: string) => {
      const value = safeGet(ctx, rawPath);

      if (value === undefined || value === null) {
        if (rawFallback !== undefined) return rawFallback;

        return match; // leave the literal token untouched
      }
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
      if (value instanceof Date) return value.toISOString();
      try {
        return JSON.stringify(value);
      } catch {
        return match;
      }
    },
  );
}

@Injectable()
export class TemplatingService {
  expand = expand;
  safeGet = safeGet;
}
