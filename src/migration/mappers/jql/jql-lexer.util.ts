/**
 * @fileoverview JQL tokenizer. Pure and dependency-free — the whole `jql/` pipeline is unit-tested
 * without NestJS (jsdom cannot transform decorated classes under this repo's Jest config).
 *
 * Deliberately small surface: the lexer only distinguishes shapes (word, quoted string, `cf[n]`,
 * operator, punctuation). Keywords (`AND`, `IN`, `WAS`, ...) are ordinary words here and become
 * meaningful in the parser — JQL keywords are case-insensitive and legal as parts of values, so
 * classifying them lexically would misread `summary ~ "and then"`.
 *
 * Never throws on malformed input: an unlexable character yields an `error` result, and the caller
 * (the transpiler) falls back to storing the query verbatim. A migration must degrade, not die,
 * on a query this grammar subset does not cover.
 *
 * @module src/migration/mappers/jql/jql-lexer.util
 */

export type JqlToken =
  | { t: 'word'; v: string }
  | { t: 'str'; v: string; quote: '"' | "'" }
  | { t: 'cf'; v: string }
  | { t: 'op'; v: '=' | '!=' | '~' | '!~' | '>' | '>=' | '<' | '<=' }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' };

export type LexResult =
  | { ok: true; tokens: JqlToken[] }
  | { ok: false; error: string };

/** Characters that terminate a bare word. */
const WORD_BREAK = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '(',
  ')',
  ',',
  '"',
  "'",
  '=',
  '!',
  '~',
  '>',
  '<',
]);

/** `cf[10138]` — the numeric custom-field reference form. */
const CF_RE = /^cf\[(\d+)\]/i;

export function lexJql(input: string): LexResult {
  const tokens: JqlToken[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;

      continue;
    }

    if (ch === '(') {
      tokens.push({ t: 'lparen' });
      i++;

      continue;
    }

    if (ch === ')') {
      tokens.push({ t: 'rparen' });
      i++;

      continue;
    }

    if (ch === ',') {
      tokens.push({ t: 'comma' });
      i++;

      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '';
      let j = i + 1;
      let closed = false;

      while (j < input.length) {
        const c = input[j];

        if (c === '\\' && j + 1 < input.length) {
          // JQL string escapes: \" \' \\ pass the escaped character through.
          value += input[j + 1];
          j += 2;

          continue;
        }

        if (c === quote) {
          closed = true;
          j++;

          break;
        }

        value += c;
        j++;
      }

      if (!closed) {
        return { ok: false, error: `unterminated ${quote}-quoted string` };
      }

      tokens.push({ t: 'str', v: value, quote });
      i = j;

      continue;
    }

    if (ch === '!') {
      if (input[i + 1] === '=') {
        tokens.push({ t: 'op', v: '!=' });
        i += 2;
      } else if (input[i + 1] === '~') {
        tokens.push({ t: 'op', v: '!~' });
        i += 2;
      } else {
        return { ok: false, error: `stray "!" at position ${i}` };
      }

      continue;
    }

    if (ch === '=') {
      tokens.push({ t: 'op', v: '=' });
      i++;

      continue;
    }

    if (ch === '~') {
      tokens.push({ t: 'op', v: '~' });
      i++;

      continue;
    }

    if (ch === '>' || ch === '<') {
      if (input[i + 1] === '=') {
        tokens.push({ t: 'op', v: (ch + '=') as '>=' | '<=' });
        i += 2;
      } else {
        tokens.push({ t: 'op', v: ch });
        i++;
      }

      continue;
    }

    // `cf[10138]` before the generic word path — "[" is a legal word character otherwise.
    const cf = CF_RE.exec(input.slice(i));

    if (cf) {
      tokens.push({ t: 'cf', v: cf[1] });
      i += cf[0].length;

      continue;
    }

    // Bare word: anything up to a break character. Covers field names, keywords, numbers,
    // durations (-7d), dates (2026-07-01), and function names.
    let word = '';

    while (i < input.length && !WORD_BREAK.has(input[i])) {
      word += input[i];
      i++;
    }

    if (!word) {
      return {
        ok: false,
        error: `unexpected character "${ch}" at position ${i}`,
      };
    }

    tokens.push({ t: 'word', v: word });
  }

  return { ok: true, tokens };
}
