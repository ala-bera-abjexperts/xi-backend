/**
 * Safe arithmetic expression engine for Form Builder `calculated` fields.
 * Hand-written tokenizer -> recursive-descent parser -> AST -> evaluator.
 * NO `eval`, NO `new Function` — references are restricted to the form's own
 * `{field_key}` tokens and functions to a fixed allow-list. Mirrored byte-for-
 * behaviour from the frontend copy (`src/lib/form-builder/expression-engine.ts`);
 * the server value is authoritative and shared test vectors guarantee parity.
 *
 * Grammar:
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := NUMBER | REF | FUNC '(' args? ')' | '(' expr ')' | '-' factor
 *   args   := expr (',' expr)*
 */

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// re-enforced server-side so a crafted payload can never bypass the DoS bound
const MAX_EXPRESSION_LENGTH = 1000;
const MAX_TOKENS = 500;

const FUNCTIONS = new Set(['min', 'max', 'round', 'abs', 'sum']);

type TokenType =
  | 'num'
  | 'ref'
  | 'ident'
  | '+'
  | '-'
  | '*'
  | '/'
  | '('
  | ')'
  | ','
  | 'eof';

interface Token {
  type: TokenType;
  value?: string;
  num?: number;
}

type Ast =
  | { k: 'num'; v: number }
  | { k: 'ref'; key: string }
  | { k: 'neg'; a: Ast }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Ast; b: Ast }
  | { k: 'call'; fn: string; args: Ast[] };

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const ch = src[i];

    if (isSpace(ch)) {
      i++;
      continue;
    }

    if (
      ch === '+' ||
      ch === '-' ||
      ch === '*' ||
      ch === '/' ||
      ch === '(' ||
      ch === ')' ||
      ch === ','
    ) {
      tokens.push({ type: ch });
      i++;
    } else if (ch === '{') {
      const end = src.indexOf('}', i + 1);

      if (end === -1) throw new ExpressionError('Unterminated field reference');

      const key = src.slice(i + 1, end);

      if (!/^[a-zA-Z0-9_]+$/.test(key))
        throw new ExpressionError(`Invalid field reference: {${key}}`);

      tokens.push({ type: 'ref', value: key });
      i = end + 1;
    } else if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i + 1;

      while (j < n && (isDigit(src[j]) || src[j] === '.')) j++;

      const numStr = src.slice(i, j);
      const num = Number(numStr);

      if (!Number.isFinite(num))
        throw new ExpressionError(`Invalid number: ${numStr}`);

      tokens.push({ type: 'num', num });
      i = j;
    } else if (isIdentStart(ch)) {
      let j = i + 1;

      while (j < n && isIdentPart(src[j])) j++;

      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
    } else {
      throw new ExpressionError(`Unexpected character: ${ch}`);
    }

    if (tokens.length > MAX_TOKENS)
      throw new ExpressionError('Expression too complex');
  }

  tokens.push({ type: 'eof' });

  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const t = this.next();

    if (t.type !== type) throw new ExpressionError(`Expected '${type}'`);

    return t;
  }

  parse(): Ast {
    const node = this.parseExpr();

    if (this.peek().type !== 'eof')
      throw new ExpressionError('Unexpected trailing input');

    return node;
  }

  private parseExpr(): Ast {
    let left = this.parseTerm();

    while (this.peek().type === '+' || this.peek().type === '-') {
      const op = this.next().type as '+' | '-';
      const right = this.parseTerm();

      left = { k: 'bin', op, a: left, b: right };
    }

    return left;
  }

  private parseTerm(): Ast {
    let left = this.parseFactor();

    while (this.peek().type === '*' || this.peek().type === '/') {
      const op = this.next().type as '*' | '/';
      const right = this.parseFactor();

      left = { k: 'bin', op, a: left, b: right };
    }

    return left;
  }

  private parseFactor(): Ast {
    const t = this.peek();

    if (t.type === '-') {
      this.next();

      return { k: 'neg', a: this.parseFactor() };
    }

    if (t.type === 'num') {
      this.next();

      return { k: 'num', v: t.num ?? 0 };
    }

    if (t.type === 'ref') {
      this.next();

      return { k: 'ref', key: t.value ?? '' };
    }

    if (t.type === '(') {
      this.next();

      const node = this.parseExpr();

      this.expect(')');

      return node;
    }

    if (t.type === 'ident') {
      const name = t.value ?? '';

      if (!FUNCTIONS.has(name))
        throw new ExpressionError(`Unknown function: ${name}`);

      this.next();
      this.expect('(');

      const args: Ast[] = [];

      if (this.peek().type !== ')') {
        args.push(this.parseExpr());

        while (this.peek().type === ',') {
          this.next();
          args.push(this.parseExpr());
        }
      }

      this.expect(')');

      return { k: 'call', fn: name, args };
    }

    throw new ExpressionError('Unexpected token in expression');
  }
}

/** Coerce any stored field value to a number for arithmetic; non-numeric -> 0. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;

  if (typeof v === 'boolean') return v ? 1 : 0;

  if (typeof v === 'string') {
    const t = v.trim();

    if (t === '') return 0;

    const n = Number(t);

    return Number.isFinite(n) ? n : 0;
  }

  return 0;
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function evalAst(node: Ast, values: Record<string, unknown>): number {
  switch (node.k) {
    case 'num':
      return node.v;
    case 'ref':
      return toNumber(values[node.key]);
    case 'neg':
      return finite(-evalAst(node.a, values));
    case 'bin': {
      const a = evalAst(node.a, values);
      const b = evalAst(node.b, values);

      if (node.op === '+') return finite(a + b);
      if (node.op === '-') return finite(a - b);
      if (node.op === '*') return finite(a * b);

      // Division by zero is defined as 0 (never NaN/Infinity).
      return b === 0 ? 0 : finite(a / b);
    }
    case 'call': {
      const args = node.args.map((a) => evalAst(a, values));

      switch (node.fn) {
        case 'min':
          return args.length ? finite(Math.min(...args)) : 0;
        case 'max':
          return args.length ? finite(Math.max(...args)) : 0;
        case 'round':
          return finite(Math.round(args[0] ?? 0));
        case 'abs':
          return finite(Math.abs(args[0] ?? 0));
        case 'sum':
          return finite(args.reduce((s, x) => s + x, 0));
        default:
          return 0;
      }
    }
    default:
      return 0;
  }
}

/**
 * Compile a `{field_key}`-based arithmetic expression into a pure evaluator.
 * @throws {ExpressionError} on empty/too-long/malformed input or unknown function.
 */
export function compileExpression(
  src: string,
): (values: Record<string, unknown>) => number {
  if (typeof src !== 'string')
    throw new ExpressionError('Expression must be a string');

  if (src.length > MAX_EXPRESSION_LENGTH)
    throw new ExpressionError('Expression too long');

  if (src.trim() === '') throw new ExpressionError('Empty expression');

  const ast = new Parser(tokenize(src)).parse();

  return (values: Record<string, unknown>): number =>
    finite(evalAst(ast, values ?? {}));
}

/** Unique `{field_key}` references in an expression (dedup, order-preserving). */
export function extractRefs(src: string): string[] {
  const refs = new Set<string>();

  for (const t of tokenize(src)) {
    if (t.type === 'ref' && t.value) refs.add(t.value);
  }

  return [...refs];
}
