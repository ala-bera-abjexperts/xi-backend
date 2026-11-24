import jexl from 'jexl';

import type { EvalContext } from './expression';
import { hasUnresolvedPlaceholder, substitute } from './template';

/** Matches a string that is exactly one placeholder and nothing else. */
const WHOLE_PLACEHOLDER = /^\{\{\s*([^}]+?)\s*\}\}$/;

const PLACEHOLDER_GLOBAL = /\{\{\s*[^}]+?\s*\}\}/g;

function countPlaceholders(value: string): number {
  return (value.match(PLACEHOLDER_GLOBAL) ?? []).length;
}

export interface DeepSubstituteOptions {
  /** Keys never substituted, anywhere in the tree. */
  denyKeys?: ReadonlySet<string>;
  /** Keys denied only inside a named array, e.g. 'field_groups' -> {'name'}. */
  scopedDenyKeys?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface DeepSubstituteResult<T> {
  value: T;
  /** Placeholders that resolved to a value. */
  substitutedCount: number;
  /** Placeholders still present after the pass, with their JSON path. */
  unresolved: Array<{ path: string; value: string }>;
}

/**
 * Walks an arbitrary JSON structure and substitutes {{ }} placeholders in every string leaf.
 *
 * Two behaviours the flat `substitute()` cannot provide, and the reason this exists:
 *
 * 1. **Type preservation.** A string that is exactly one placeholder resolves to the *raw* value,
 *    so a templated `default_value` on a number field stays a number instead of becoming "4711".
 *    Mixed strings ("Project {{ x }}") still interpolate to a string.
 * 2. **Deny-listing.** Some keys are portable foreign keys that other parts of the same document
 *    reference by string equality; rewriting them silently breaks those references.
 *
 * Substitution runs exactly once per leaf — output is never re-scanned, so a value that itself
 * contains {{ }} is inert rather than evaluated.
 */
export function deepSubstitute<T>(
  input: T,
  ctx: EvalContext,
  options: DeepSubstituteOptions = {},
): DeepSubstituteResult<T> {
  const denyKeys = options.denyKeys ?? new Set<string>();
  const scopedDenyKeys =
    options.scopedDenyKeys ?? new Map<string, ReadonlySet<string>>();
  const evalFn = jexl.evalSync.bind(jexl) as (e: string, c: unknown) => unknown;

  let substitutedCount = 0;
  const unresolved: Array<{ path: string; value: string }> = [];

  const isDenied = (
    key: string | undefined,
    arrayField: string | undefined,
  ): boolean => {
    if (key === undefined) return false;
    if (denyKeys.has(key)) return true;

    return (
      arrayField !== undefined &&
      (scopedDenyKeys.get(arrayField)?.has(key) ?? false)
    );
  };

  const walkString = (node: string, path: string): unknown => {
    const before = countPlaceholders(node);

    if (before === 0) return node;

    // Whole-string placeholder: return the raw value so numbers/booleans/objects survive.
    const whole = WHOLE_PLACEHOLDER.exec(node);

    if (whole) {
      try {
        const resolved: unknown = evalFn(whole[1], ctx);

        if (
          resolved !== null &&
          resolved !== undefined &&
          typeof resolved !== 'symbol'
        ) {
          substitutedCount += 1;

          return resolved;
        }
      } catch {
        // Fall through to the string path, which degrades to the literal placeholder.
      }
    }

    const out = substitute(node, ctx);

    substitutedCount += before - countPlaceholders(out);

    if (hasUnresolvedPlaceholder(out)) unresolved.push({ path, value: out });

    return out;
  };

  const walk = (
    node: unknown,
    path: string,
    key: string | undefined,
    arrayField: string | undefined,
  ): unknown => {
    if (typeof node === 'string') {
      return isDenied(key, arrayField) ? node : walkString(node, path);
    }

    if (Array.isArray(node)) {
      // The array's own property name becomes the scope for its elements, so a scoped
      // denial like field_groups[].name can be resolved one level down.
      return node.map((item, i) => walk(item, `${path}[${i}]`, key, key));
    }

    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, path ? `${path}.${k}` : k, k, arrayField);
      }

      return out;
    }

    return node;
  };

  return {
    value: walk(input, '', undefined, undefined) as T,
    substitutedCount,
    unresolved,
  };
}
