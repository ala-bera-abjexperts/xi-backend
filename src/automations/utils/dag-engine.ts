import { evaluateExpression, type EvalContext } from './expression';

export interface DagNode {
  id: string;
  type?: string;
  data?: {
    kind?: string;
    config?: Record<string, unknown>;
    [key: string]: unknown;
  };
  position?: { x: number; y: number };
}

export interface DagEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface DagDefinition {
  nodes: DagNode[];
  edges: DagEdge[];
  variables?: Record<string, unknown>;
}

export type ControlOutcome =
  | { kind: 'sleep'; wakeupAt: Date }
  | { kind: 'filter_out' }
  | {
      kind: 'condition' | 'parallel' | 'loop';
      output?: unknown;
      nextNodes: DagNode[];
    };

export function findFirstActionableNodes(definition: DagDefinition): DagNode[] {
  const trigger = definition.nodes.find(
    (n) =>
      n.type === 'trigger' || definition.edges.every((e) => e.target !== n.id),
  );
  if (!trigger) throw new Error('Definition has no trigger node');
  return definition.edges
    .filter((e) => e.source === trigger.id)
    .map((e) => definition.nodes.find((n) => n.id === e.target))
    .filter((n): n is DagNode => n !== undefined);
}

/**
 * Like findFirstActionableNodes but starts from the trigger node whose
 * data.kind matches triggerKind. When multiple trigger nodes are present
 * (multi-trigger automations) this ensures the correct action chain is
 * executed for the event that actually fired.
 *
 * Falls back to the first trigger node when no exact kind match is found
 * (e.g. for older single-trigger definitions).
 */
export function findFirstActionableNodesForTrigger(
  definition: DagDefinition,
  triggerKind: string,
): DagNode[] {
  const trigger =
    definition.nodes.find(
      (n) => n.type === 'trigger' && n.data?.kind === triggerKind,
    ) ??
    definition.nodes.find(
      (n) =>
        n.type === 'trigger' &&
        definition.edges.every((e) => e.target !== n.id),
    );
  if (!trigger) throw new Error('Definition has no trigger node');
  return definition.edges
    .filter((e) => e.source === trigger.id)
    .map((e) => definition.nodes.find((n) => n.id === e.target))
    .filter((n): n is DagNode => n !== undefined);
}

export function advanceDag(
  definition: DagDefinition,
  fromNodeId: string,
  sourceHandle?: string,
): DagNode[] {
  return definition.edges
    .filter(
      (e) =>
        e.source === fromNodeId &&
        (sourceHandle === undefined || e.sourceHandle === sourceHandle),
    )
    .map((e) => definition.nodes.find((n) => n.id === e.target))
    .filter((n): n is DagNode => n !== undefined);
}

export function isControlNode(kind: string): boolean {
  return kind.startsWith('control.');
}

export function parseDuration(duration: string): number {
  const patterns: Array<{ re: RegExp; mult: number }> = [
    { re: /^(\d+(?:\.\d+)?)\s*(?:ms|milliseconds?)$/i, mult: 1 },
    { re: /^(\d+(?:\.\d+)?)\s*(?:s|seconds?)$/i, mult: 1000 },
    { re: /^(\d+(?:\.\d+)?)\s*(?:m|mins?|minutes?)$/i, mult: 60_000 },
    { re: /^(\d+(?:\.\d+)?)\s*(?:h|hours?)$/i, mult: 3_600_000 },
    { re: /^(\d+(?:\.\d+)?)\s*(?:d|days?)$/i, mult: 86_400_000 },
  ];
  for (const { re, mult } of patterns) {
    const m = duration.trim().match(re);
    if (m) return Math.round(parseFloat(m[1]) * mult);
  }
  const plain = parseFloat(duration);
  if (!isNaN(plain)) return Math.round(plain * 1000);
  throw new Error(`Cannot parse duration: "${duration}"`);
}

export function controlNodeOutcome(
  node: DagNode,
  definition: DagDefinition,
  _stepInput: Record<string, unknown>,
  evalCtx: EvalContext,
): ControlOutcome {
  if (!node.data?.kind) {
    throw new Error(`controlNodeOutcome: node ${node.id} is missing data.kind`);
  }
  const config = node.data.config ?? {};

  switch (node.data.kind) {
    case 'control.condition': {
      const expression = (config.expression as string | undefined) ?? '';
      if (!expression.trim()) {
        const nextNodes = advanceDag(definition, node.id, 'true');
        return {
          kind: 'condition',
          output: {
            branch: 'true',
            reason: 'empty expression defaults to true',
          },
          nextNodes,
        };
      }
      let result = false;
      try {
        result = evaluateExpression(expression, evalCtx);
      } catch (err) {
        throw new Error(
          `Condition expression error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const handle = result ? 'true' : 'false';
      return {
        kind: 'condition',
        output: { branch: handle, expression, result },
        nextNodes: advanceDag(definition, node.id, handle),
      };
    }

    case 'control.filter': {
      const expression = (config.expression as string | undefined) ?? '';
      if (!expression.trim()) {
        return {
          kind: 'condition',
          output: { passed: true, reason: 'empty expression passes all' },
          nextNodes: advanceDag(definition, node.id),
        };
      }
      let result = false;
      try {
        result = evaluateExpression(expression, evalCtx);
      } catch (err) {
        throw new Error(
          `Filter expression error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!result) return { kind: 'filter_out' };
      return {
        kind: 'condition',
        output: { passed: true, expression },
        nextNodes: advanceDag(definition, node.id),
      };
    }

    case 'control.wait': {
      const duration = (config.duration as string | undefined) ?? '5 minutes';
      return {
        kind: 'sleep',
        wakeupAt: new Date(Date.now() + parseDuration(duration)),
      };
    }

    case 'control.parallel': {
      const nextNodes = advanceDag(definition, node.id);
      return {
        kind: 'parallel',
        output: { branches: nextNodes.length },
        nextNodes,
      };
    }

    case 'control.loop': {
      const overField = (config.overField as string | undefined) ?? 'trigger';
      const maxIterations = Math.min(
        (config.maxIterations as number | undefined) ?? 100,
        1000,
      );
      let items: unknown[] = [];
      try {
        const raw = (evalCtx as unknown as Record<string, unknown>)[overField];
        items = Array.isArray(raw) ? raw.slice(0, maxIterations) : [];
      } catch {
        items = [];
      }
      if (items.length === 0) {
        return {
          kind: 'condition',
          output: { iterations: 0, reason: 'empty collection — loop skipped' },
          nextNodes: advanceDag(definition, node.id),
        };
      }
      return {
        kind: 'loop',
        output: { iterations: items.length, items },
        nextNodes: advanceDag(definition, node.id),
      };
    }

    case 'control.end':
      return { kind: 'condition', nextNodes: [] };

    default:
      throw new Error(`Unknown control node kind: ${node.data.kind}`);
  }
}
