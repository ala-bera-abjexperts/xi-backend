/**
 * Dependency graph + topological sort for Form Builder `calculated` fields.
 * Guarantees calculated fields are evaluated in dependency order and that cycles
 * (including self-reference) are rejected. Mirrored from the frontend copy
 * (`src/lib/form-builder/calc-graph.ts`).
 */

export class CalcCycleError extends Error {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Calculation cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'CalcCycleError';
    this.cycle = cycle;
  }
}

export interface CalcNode {
  fieldKey: string;

  // field_keys referenced by this field's calculation expression
  refs: string[];
}

/**
 * Kahn's-algorithm topological order over calculated fields. Only edges between
 * two calc fields constrain ordering (a ref to a non-calc field is a constant).
 * @returns field_keys in evaluation order (dependencies first).
 * @throws {CalcCycleError} on any cycle or self-reference.
 */
export function topoSortCalcs(calcs: CalcNode[]): string[] {
  const calcKeys = new Set(calcs.map((c) => c.fieldKey));
  const inDeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const c of calcs) {
    inDeg.set(c.fieldKey, 0);
    dependents.set(c.fieldKey, []);
  }

  for (const c of calcs) {
    if (c.refs.includes(c.fieldKey))
      throw new CalcCycleError([c.fieldKey, c.fieldKey]);

    const deps = new Set(
      c.refs.filter((r) => calcKeys.has(r) && r !== c.fieldKey),
    );

    inDeg.set(c.fieldKey, deps.size);

    for (const d of deps) dependents.get(d)?.push(c.fieldKey);
  }

  const queue: string[] = [];

  for (const [key, deg] of inDeg) {
    if (deg === 0) queue.push(key);
  }

  const order: string[] = [];

  while (queue.length > 0) {
    const key = queue.shift() as string;

    order.push(key);

    for (const dep of dependents.get(key) ?? []) {
      const nd = (inDeg.get(dep) ?? 0) - 1;

      inDeg.set(dep, nd);

      if (nd === 0) queue.push(dep);
    }
  }

  if (order.length !== calcs.length) {
    const done = new Set(order);
    const remaining = calcs.map((c) => c.fieldKey).filter((k) => !done.has(k));

    throw new CalcCycleError(remaining);
  }

  return order;
}
