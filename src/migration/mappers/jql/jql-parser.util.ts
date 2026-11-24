/**
 * @fileoverview JQL recursive-descent parser: tokens → AST.
 *
 * Pure, never throws. `{ok:false, error}` on anything outside the grammar, so the transpiler can
 * fall back to storing the query verbatim — a migration degrades, it does not die.
 *
 * Precedence, loosest first: OR < AND < prefix NOT < primary (parenthesised group | clause). This
 * matches JQL's own binding: `a AND b OR c` parses as `(a AND b) OR c`.
 *
 * HISTORY CLAUSES (`WAS`, `WAS IN`, `WAS NOT`, `CHANGED` + predicates) are parsed as opaque
 * `history` nodes: their raw text is captured for the fallback reason, and no attempt is made to
 * model their predicate grammar. XISUITE has no field-history query surface, so a faithful parse
 * would be dead weight — the only thing the transpiler ever does with one is refuse the query.
 *
 * `ORDER BY` is split off before parsing and returned separately: RuleGroups carry no ordering, and
 * stripping it cannot change which cards match, so it is the one construct that is dropped rather
 * than either translated or fallen back on.
 *
 * @module src/migration/mappers/jql/jql-parser.util
 */

import { lexJql, type JqlToken } from './jql-lexer.util';

export interface JqlField {
  /** Lower-cased bare name, or the raw quoted name (case preserved) for quoted fields. */
  name: string;
  quoted: boolean;
  /** Set for `cf[10138]` references — the numeric Jira custom-field id. */
  cfId?: string;
}

export type JqlValue =
  | { kind: 'text'; text: string; quoted: boolean }
  | { kind: 'func'; name: string; args: string[] };

export type JqlClause =
  | {
      kind: 'cmp';
      field: JqlField;
      op: '=' | '!=' | '~' | '!~' | '>' | '>=' | '<' | '<=';
      value: JqlValue;
    }
  | { kind: 'list'; field: JqlField; negated: boolean; values: JqlValue[] }
  | { kind: 'is'; field: JqlField; negated: boolean }
  /**
   * `field WAS [NOT] value` / `WAS [NOT] IN (...)`, MODELLED (not opaque) so the transpiler can
   * translate the plain status-history forms. `predicate` holds any trailing temporal qualifier
   * (`BEFORE`/`AFTER`/`ON`/`DURING`/`BY …`) verbatim, or null when there is none — a present
   * predicate constrains WHEN the value held and has no XISUITE equivalent, so the transpiler
   * refuses it. `CHANGED` stays a `history` node (its predicate grammar is not modelled).
   */
  | {
      kind: 'was';
      field: JqlField;
      negated: boolean;
      values: JqlValue[];
      predicate: string | null;
    }
  | { kind: 'history'; field: JqlField; raw: string };

export interface JqlGroup {
  kind: 'group';
  op: 'and' | 'or';
  not: boolean;
  children: JqlNode[];
}

export type JqlNode = JqlGroup | JqlClause;

export type ParseResult =
  | { ok: true; ast: JqlNode; orderBy: string | null }
  | { ok: false; error: string };

/** Keyword test on a word token, case-insensitive (JQL keywords are). */
function isKw(tok: JqlToken | undefined, kw: string): boolean {
  return !!tok && tok.t === 'word' && tok.v.toUpperCase() === kw;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: JqlToken[]) {}

  private peek(offset = 0): JqlToken | undefined {
    return this.tokens[this.pos + offset];
  }

  private next(): JqlToken | undefined {
    return this.tokens[this.pos++];
  }

  private fail(message: string): never {
    throw new Error(message);
  }

  parseQuery(): JqlNode {
    const node = this.parseOr();

    if (this.pos < this.tokens.length) {
      const tok = this.peek();

      this.fail(
        `unexpected ${tok?.t === 'word' ? `"${tok.v}"` : tok?.t} after end of query`,
      );
    }

    return node;
  }

  private parseOr(): JqlNode {
    const children = [this.parseAnd()];

    while (isKw(this.peek(), 'OR')) {
      this.next();
      children.push(this.parseAnd());
    }

    if (children.length === 1) return children[0];

    return { kind: 'group', op: 'or', not: false, children };
  }

  private parseAnd(): JqlNode {
    const children = [this.parseNot()];

    while (isKw(this.peek(), 'AND')) {
      this.next();
      children.push(this.parseNot());
    }

    if (children.length === 1) return children[0];

    return { kind: 'group', op: 'and', not: false, children };
  }

  private parseNot(): JqlNode {
    if (isKw(this.peek(), 'NOT')) {
      this.next();

      const inner = this.parseNot();

      // NOT over a bare clause still needs a group to carry the flag — both target engines only
      // support negation at group level.
      if (inner.kind === 'group' && !inner.not) return { ...inner, not: true };

      return { kind: 'group', op: 'and', not: true, children: [inner] };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): JqlNode {
    if (this.peek()?.t === 'lparen') {
      this.next();

      const inner = this.parseOr();

      if (this.peek()?.t !== 'rparen') this.fail('missing closing parenthesis');

      this.next();

      return inner;
    }

    return this.parseClause();
  }

  private parseClause(): JqlClause {
    const fieldTok = this.next();

    if (!fieldTok) this.fail('expected a field, found end of query');

    let field: JqlField;

    if (fieldTok.t === 'cf') {
      field = { name: `cf[${fieldTok.v}]`, quoted: false, cfId: fieldTok.v };
    } else if (fieldTok.t === 'str') {
      field = { name: fieldTok.v, quoted: true };
    } else if (fieldTok.t === 'word') {
      field = { name: fieldTok.v.toLowerCase(), quoted: false };
    } else {
      this.fail(`expected a field, found ${fieldTok.t}`);
    }

    const opTok = this.peek();

    // WAS — modelled so the transpiler can translate the plain status-history forms. Any trailing
    // temporal predicate is captured verbatim (the transpiler refuses it).
    if (isKw(opTok, 'WAS')) {
      this.next(); // WAS

      let negated = false;

      if (isKw(this.peek(), 'NOT')) {
        negated = true;
        this.next();
      }

      let values: JqlValue[];

      if (isKw(this.peek(), 'IN')) {
        this.next(); // IN
        values = this.parseInOperands();
      } else {
        values = [this.parseValue()];
      }

      return {
        kind: 'was',
        field,
        negated,
        values,
        predicate: this.capturePredicateTail(),
      };
    }

    // CHANGED — capture the whole history clause opaquely (its predicate grammar is not modelled).
    if (isKw(opTok, 'CHANGED')) {
      return { kind: 'history', field, raw: this.captureHistoryClause(field) };
    }

    // IS [NOT] EMPTY|NULL
    if (isKw(opTok, 'IS')) {
      this.next();

      let negated = false;

      if (isKw(this.peek(), 'NOT')) {
        negated = true;
        this.next();
      }

      const val = this.peek();

      if (!isKw(val, 'EMPTY') && !isKw(val, 'NULL')) {
        this.fail(`IS ${negated ? 'NOT ' : ''}expects EMPTY or NULL`);
      }

      this.next();

      return { kind: 'is', field, negated };
    }

    // [NOT] IN (...)
    if (isKw(opTok, 'NOT') || isKw(opTok, 'IN')) {
      let negated = false;

      if (isKw(opTok, 'NOT')) {
        this.next();

        if (!isKw(this.peek(), 'IN'))
          this.fail('NOT must be followed by IN here');
        negated = true;
      }

      this.next(); // IN

      return { kind: 'list', field, negated, values: this.parseInOperands() };
    }

    if (opTok?.t !== 'op') {
      this.fail(
        `expected an operator after "${field.name}", found ${
          opTok
            ? opTok.t === 'word'
              ? `"${opTok.v}"`
              : opTok.t
            : 'end of query'
        }`,
      );
    }

    this.next();

    const value = this.parseValue();

    // `field = EMPTY` / `= NULL` are JQL's other spelling of the IS forms — normalize here so the
    // mapper has ONE null-check shape to deal with.
    if (
      value.kind === 'text' &&
      !value.quoted &&
      (value.text.toUpperCase() === 'EMPTY' ||
        value.text.toUpperCase() === 'NULL')
    ) {
      if (opTok.v === '=') return { kind: 'is', field, negated: false };
      if (opTok.v === '!=') return { kind: 'is', field, negated: true };
      this.fail(`EMPTY is not a valid operand for "${opTok.v}"`);
    }

    return { kind: 'cmp', field, op: opTok.v, value };
  }

  private parseValue(): JqlValue {
    const tok = this.next();

    if (!tok) this.fail('expected a value, found end of query');

    if (tok.t === 'str') return { kind: 'text', text: tok.v, quoted: true };

    if (tok.t === 'word') {
      // Function call: word immediately followed by "(" — args are words/strings until ")".
      if (this.peek()?.t === 'lparen') {
        this.next();

        const args: string[] = [];

        while (this.peek() && this.peek()?.t !== 'rparen') {
          const arg = this.next()!;

          if (arg.t === 'word' || arg.t === 'str') args.push(arg.v);
          else if (arg.t === 'comma') continue;
          else this.fail(`unexpected ${arg.t} inside function arguments`);
        }

        if (this.peek()?.t !== 'rparen')
          this.fail('unterminated function call');

        this.next();

        return { kind: 'func', name: tok.v.toLowerCase(), args };
      }

      return { kind: 'text', text: tok.v, quoted: false };
    }

    this.fail(`expected a value, found ${tok.t}`);
  }

  /**
   * Parse the operand list AFTER an `IN` keyword: a bare function call as the whole list
   * (`IN unreleasedVersions()`) or a parenthesised `(v1, v2, …)`. Shared by `IN` and `WAS IN`.
   */
  private parseInOperands(): JqlValue[] {
    const fnTok = this.peek();

    if (fnTok?.t === 'word' && this.peek(1)?.t === 'lparen') {
      return [this.parseValue()];
    }

    if (this.peek()?.t !== 'lparen')
      this.fail('IN expects a parenthesised list');

    this.next();

    const values: JqlValue[] = [];

    for (;;) {
      values.push(this.parseValue());

      const sep = this.peek();

      if (sep?.t === 'comma') {
        this.next();

        continue;
      }

      if (sep?.t === 'rparen') {
        this.next();

        break;
      }

      this.fail('IN list expects "," or ")"');
    }

    if (values.length === 0) this.fail('IN list is empty');

    return values;
  }

  /**
   * Swallow a `WAS` clause's trailing temporal predicate (`BEFORE`/`AFTER`/`ON`/`DURING`/`BY …`),
   * verbatim, up to the next AND/OR/`)` at this nesting level. Returns null when the clause ends
   * cleanly (no predicate) — that is the translatable case.
   */
  private capturePredicateTail(): string | null {
    const parts: string[] = [];
    let depth = 0;

    while (this.pos < this.tokens.length) {
      const tok = this.peek()!;

      if (depth === 0 && (isKw(tok, 'AND') || isKw(tok, 'OR'))) break;
      if (tok.t === 'rparen') {
        if (depth === 0) break;
        depth--;
      }
      if (tok.t === 'lparen') depth++;

      this.next();

      if (tok.t === 'word') parts.push(tok.v);
      else if (tok.t === 'str') parts.push(`"${tok.v}"`);
      else if (tok.t === 'cf') parts.push(`cf[${tok.v}]`);
      else if (tok.t === 'op') parts.push(tok.v);
      else if (tok.t === 'lparen') parts.push('(');
      else if (tok.t === 'rparen') parts.push(')');
      else if (tok.t === 'comma') parts.push(',');
    }

    return parts.length ? parts.join(' ') : null;
  }

  /**
   * Swallow a WAS/CHANGED clause: everything up to the next AND/OR/`)` at this nesting level.
   * Predicates may contain function parens (`WAS "x" BEFORE now()`), so depth is tracked.
   */
  private captureHistoryClause(field: JqlField): string {
    const parts: string[] = [field.name];
    let depth = 0;

    while (this.pos < this.tokens.length) {
      const tok = this.peek()!;

      if (depth === 0 && (isKw(tok, 'AND') || isKw(tok, 'OR'))) break;
      if (tok.t === 'rparen') {
        if (depth === 0) break;
        depth--;
      }
      if (tok.t === 'lparen') depth++;

      this.next();

      if (tok.t === 'word') parts.push(tok.v);
      else if (tok.t === 'str') parts.push(`"${tok.v}"`);
      else if (tok.t === 'cf') parts.push(`cf[${tok.v}]`);
      else if (tok.t === 'op') parts.push(tok.v);
      else if (tok.t === 'lparen') parts.push('(');
      else if (tok.t === 'rparen') parts.push(')');
      else if (tok.t === 'comma') parts.push(',');
    }

    return parts.join(' ');
  }
}

/** Split a trailing `ORDER BY ...` off the raw JQL before lexing the query proper. */
function splitOrderBy(jql: string): { query: string; orderBy: string | null } {
  const match = /\border\s+by\b/i.exec(jql);

  if (!match) return { query: jql, orderBy: null };

  return {
    query: jql.slice(0, match.index).trim(),
    orderBy: jql.slice(match.index).trim(),
  };
}

export function parseJql(jql: string): ParseResult {
  const trimmed = (jql ?? '').trim();

  if (!trimmed) return { ok: false, error: 'empty query' };

  const { query, orderBy } = splitOrderBy(trimmed);

  if (!query) return { ok: false, error: 'query is only an ORDER BY clause' };

  const lexed = lexJql(query);

  if (!lexed.ok) return { ok: false, error: lexed.error };

  try {
    const ast = new Parser(lexed.tokens).parseQuery();

    return { ok: true, ast, orderBy };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
