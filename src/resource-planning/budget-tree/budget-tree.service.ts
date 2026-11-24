/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * @fileoverview Sub Task 1 (Ressource Tree with tickets). Walks the task PARENT/
 * CHILD hierarchy (dependency links from task_relationships are only attached,
 * one hop and never rolled up, when include_dependencies is set), using the get_task_descendant_ids RPC
 * (a flat, org-scoped, process-agnostic parent_task_id walk, already relied on
 * by resource-planning.service.ts's rollup sums and the Filters "include
 * subissues" toggle) rather than get_task_tree: the latter's base case
 * requires `t.process_id = p_process_id`, a strict SQL equality that never
 * matches for tasks created outside a Business Process (process_id IS NULL),
 * so it silently returned an empty tree for any process-less root -- the
 * whole reason this ever showed "no child tickets" for tasks that visibly had
 * children. get_task_descendant_ids has no process_id dependency at all, so
 * level is computed here via BFS instead of coming from the RPC. Cycle safety
 * is verified, not assumed: check_task_circular_dependency (a DB trigger)
 * makes a parent_task_id cycle unwritable, get_task_descendant_ids itself is
 * UNION-deduped, and the BFS below only ever assigns a level to an id once.
 * @module src/resource-planning/budget-tree/budget-tree.service
 */

import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import {
  inSpaceScope,
  ResourcePlanningService,
  type SpaceScope,
} from '../resource-planning.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { WorkingCalendarService } from '../calendar/working-calendar.service';
import { countWorkingDaysInRange } from '../calendar/working-calendar.engine';
import { roundCents } from '../budget-split/budget-split.analysis';
import {
  BudgetSplitService,
  type BudgetSplitRow,
} from '../budget-split/budget-split.service';
import {
  type BudgetUsage,
  BudgetUsageService,
} from '../overall-budget/budget-usage.service';
import {
  BUDGET_TREE_MAX_DEPTH,
  BUDGET_TREE_MAX_NODES,
} from './dto/budget-tree-query.dto';
import type {
  BudgetAggregation,
  BudgetSplitWarning,
  BudgetTreeBudget,
  BudgetTreeFunding,
  BudgetTreeNode,
  BudgetTreeResponse,
  BudgetTreeSplit,
} from './budget-tree.types';

type BudgetRef = Omit<
  BudgetTreeBudget,
  | 'allocated_amount'
  | 'over_allocated_by'
  | 'has_hidden_funded_tasks'
  | keyof BudgetUsage
>;

interface NodeFunding {
  funding: BudgetTreeFunding[];
  funding_other_currency: boolean;
}

export interface TaskTreeRow {
  id: string;
  key: string;
  summary: string;
  level: number;
  parent_task_id: string | null;
}

export interface RootTaskRow {
  id: string;
  key: string;
  summary: string;
  organization_id: string;
  process_id: string | null;
  space_id: string | null;
}

export interface TaskDetailRow {
  id: string;
  key: string;
  summary: string;
  parent_task_id: string | null;
  space_id: string | null;
}

export interface BudgetTreeOptions {
  depth?: number;
  /** Fixed-space view (T523). */
  spaceId?: string;
  includeDependencies?: boolean;
}

/** The access-checked, pruned tree (see resolveScopedTree). */
export interface ScopedBudgetTree {
  depth: number;
  rootTask: RootTaskRow;
  scope: SpaceScope;
  /** Depth-limited, node-capped, visible tickets in level order. */
  included: Map<string, TaskTreeRow>;
  truncated: boolean;
  hiddenCount: number;
  otherSpaceCount: number;
  /** Every descendant (not depth-limited, not pruned); the root is not in it. */
  detailById: Map<string, TaskDetailRow>;
  childrenByParentId: Map<string, string[]>;
  spaceByTaskId: Map<string, string | null>;
}

interface LinkedTask {
  anchorId: string;
  spaceId: string | null;
  row: TaskTreeRow;
  link: { relation_type_name: string; label: string };
}

interface BudgetEntryForTree {
  task_id: string;
  cost_category_id: string | null;
  currency: string;
  quantity: number;
  unit_cost: number;
  amount: number;
  aggregation: BudgetAggregation;
  start_date: string | null;
  end_date: string | null;
}

// PostgREST's .in() filter embeds every id directly in the request's query
// string -- a large subtree's descendant/entry id lists (bounded by
// BUDGET_TREE_MAX_NODES, but that's still up to 300) can exceed the stack's
// URL-length limit in one shot. Splitting into batches keeps each request
// small regardless of tree size; 100 ids/batch is comfortably under any
// realistic limit even for full 36-char UUIDs.
const IN_FILTER_CHUNK_SIZE = 100;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

/** System relation types that mean "one ticket's work hangs on another": the
 *  four Gantt types plans.service.ts uses, plus Blocks and Depends. */
const DEPENDENCY_RELATION_NAMES = [
  'Blocks',
  'Depends',
  'Finish to Start',
  'Start to Start',
  'Finish to Finish',
  'Start to Finish',
];

export interface TaskLinkRow {
  source_id: string;
  target_id: string;
  relation_type_id: string;
}

export interface LinkedTaskPick {
  anchorId: string;
  linkedId: string;
  relationTypeId: string;
  /** True when the anchor is the relationship's source (use outward wording). */
  anchorIsSource: boolean;
}

/**
 * One hop of dependency links off the tree. A row with both ends in the tree
 * (or neither) is skipped, which is also what stops a link back into the tree
 * from looping. Each linked ticket is attached once, under its deepest in-tree
 * anchor (ties: first row wins), and at most `limit` tickets come back.
 */
export function pickLinkedTasks(
  rows: TaskLinkRow[],
  levelById: ReadonlyMap<string, number>,
  limit: number,
): LinkedTaskPick[] {
  const byLinkedId = new Map<string, LinkedTaskPick>();
  for (const row of rows) {
    const sourceIn = levelById.has(row.source_id);
    if (sourceIn === levelById.has(row.target_id)) continue;
    const pick: LinkedTaskPick = sourceIn
      ? {
          anchorId: row.source_id,
          linkedId: row.target_id,
          relationTypeId: row.relation_type_id,
          anchorIsSource: true,
        }
      : {
          anchorId: row.target_id,
          linkedId: row.source_id,
          relationTypeId: row.relation_type_id,
          anchorIsSource: false,
        };
    const current = byLinkedId.get(pick.linkedId);
    if (
      !current ||
      levelById.get(pick.anchorId)! > levelById.get(current.anchorId)!
    ) {
      byLinkedId.set(pick.linkedId, pick);
    }
  }
  return [...byLinkedId.values()].slice(0, Math.max(0, limit));
}

@Injectable()
export class BudgetTreeService {
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModulesService: OrganizationModulesService,
    private readonly resourcePlanningService: ResourcePlanningService,
    private readonly workingCalendarService: WorkingCalendarService,
    private readonly budgetSplitService: BudgetSplitService,
    private readonly budgetUsageService: BudgetUsageService,
  ) {}

  private async assertModuleEnabled(organizationId: string): Promise<void> {
    if (
      !(await this.orgModulesService.isEnabled(
        organizationId,
        'resource_planning',
      ))
    ) {
      throw new ForbiddenException('Resource Planning module is not enabled');
    }
  }

  /**
   * Module gate, access checks, descendant walk and top-down pruning, shared by
   * the graph (getBudgetTree) and the month timeline so both show the same
   * tickets. `included` is the depth-limited, node-capped tree the user may
   * see; `detailById` and `childrenByParentId` cover every descendant.
   */
  async resolveScopedTree(
    taskId: string,
    organizationId: string,
    userId: string,
    options: Pick<BudgetTreeOptions, 'depth' | 'spaceId'> = {},
  ): Promise<ScopedBudgetTree> {
    await this.assertModuleEnabled(organizationId);

    // depth=0 (root only, no children) is a valid, meaningful value
    // -- `|| 3` would treat it as falsy and silently override it back to the
    // default, which is exactly the bug this depth range exists to avoid.
    const depth = Math.min(
      Math.max(0, options.depth ?? 3),
      BUDGET_TREE_MAX_DEPTH,
    );
    const { spaceId } = options;

    // One scope for the whole walk, replacing a per-node access check. A
    // null space_id is tenant-level and always visible (see inSpaceScope).
    const scope = await this.resourcePlanningService.resolveSpaceScope(
      organizationId,
      userId,
    );
    if (spaceId && !scope.allowedSpaceIds.has(spaceId)) {
      throw new ForbiddenException(
        'Resource Planning is not available in this space',
      );
    }

    const { data: root, error: rootError } = await this.client
      .from('tasks')
      .select('id, key, summary, organization_id, process_id, space_id')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (rootError) throw new InternalServerErrorException(rootError.message);
    if (!root) throw new NotFoundException('Task not found');
    const rootTask = root as RootTaskRow;

    // Fixed-space view: a root elsewhere (or with no space) is not in it.
    if (spaceId && rootTask.space_id !== spaceId) {
      throw new NotFoundException('Task not found');
    }
    await this.resourcePlanningService.assertSpaceAllowed(
      organizationId,
      rootTask.space_id,
    );
    if (!inSpaceScope(scope, rootTask.space_id)) {
      throw new ForbiddenException(
        'You do not have access to this task’s space',
      );
    }

    // Process-agnostic: walks parent_task_id regardless of whether any task
    // in the chain has a process_id at all (see the file header for why
    // get_task_tree can't be used here).
    const { data: descendantIdsData, error: descendantsError } =
      await this.client.rpc('get_task_descendant_ids', {
        p_root_ids: [taskId],
        p_organization_id: organizationId,
      });
    if (descendantsError) {
      throw new InternalServerErrorException(descendantsError.message);
    }
    const descendantIds = (descendantIdsData ?? []) as string[];

    // One batched (chunked) query for every candidate node's
    // key/summary/parent/space -- covers both the depth-limiting BFS below
    // and the space-access check.
    const detailRows: TaskDetailRow[] = [];
    for (const chunk of chunkArray(
      descendantIds.length > 0 ? descendantIds : [taskId],
      IN_FILTER_CHUNK_SIZE,
    )) {
      const { data, error: detailError } = await this.client
        .from('tasks')
        .select('id, key, summary, parent_task_id, space_id')
        .in('id', chunk)
        .eq('organization_id', organizationId);
      if (detailError) {
        throw new InternalServerErrorException(detailError.message);
      }
      detailRows.push(...((data ?? []) as TaskDetailRow[]));
    }
    const detailById = new Map(detailRows.map((row) => [row.id, row]));

    // BFS from the root so level is correct regardless of the flat RPC
    // result's order. Each id is assigned a level at most once, which is also
    // the cycle guard (redundant with the DB trigger and the RPC's own
    // UNION-dedup, kept anyway as defense in depth).
    const childrenByParentId = new Map<string, string[]>();
    for (const row of detailById.values()) {
      if (!row.parent_task_id) continue;
      const list = childrenByParentId.get(row.parent_task_id) ?? [];
      list.push(row.id);
      childrenByParentId.set(row.parent_task_id, list);
    }
    // `depth` counts levels below the root (depth=0 is the root alone,
    // depth=1 is root+children, depth=2 is root+children+grandchildren, ...).
    const levelById = new Map<string, number>([[taskId, 0]]);
    const bfsQueue = [taskId];
    while (bfsQueue.length > 0) {
      const parentId = bfsQueue.shift() as string;
      const parentLevel = levelById.get(parentId) as number;
      if (parentLevel >= depth) continue;
      for (const childId of childrenByParentId.get(parentId) ?? []) {
        if (levelById.has(childId)) continue;
        levelById.set(childId, parentLevel + 1);
        bfsQueue.push(childId);
      }
    }

    const withinDepth: TaskTreeRow[] = [...levelById.entries()].map(
      ([id, level]) => {
        if (id === taskId) {
          return {
            id,
            key: rootTask.key,
            summary: rootTask.summary,
            level,
            parent_task_id: null,
          };
        }
        const detail = detailById.get(id);
        return {
          id,
          key: detail?.key ?? '',
          summary: detail?.summary ?? '',
          level,
          parent_task_id: detail?.parent_task_id ?? null,
        };
      },
    );

    const spaceByTaskId = new Map<string, string | null>(
      [...levelById.keys()].map((id) => [
        id,
        id === taskId
          ? rootTask.space_id
          : (detailById.get(id)?.space_id ?? null),
      ]),
    );

    // Prune top-down: a node is included only if its parent was included AND
    // it itself is accessible. This deliberately drops the whole subtree
    // under an inaccessible node rather than leaving orphaned descendants
    // dangling with no visible parent.
    const included = new Map<string, TaskTreeRow>();
    included.set(
      taskId,
      withinDepth.find((row) => row.id === taskId) ?? withinDepth[0],
    );
    const sortedByLevel = [...withinDepth].sort((a, b) => a.level - b.level);
    let truncated = false;

    // Counts only nodes actually evaluated and found inaccessible -- not the
    // further descendants cascaded away with them (their reachability was
    // never checked) and not nodes dropped by the truncation cap below. This
    // keeps the count a true lower bound that's never misattributed to the
    // wrong reason (a UI warning conflating "hidden for access" with
    // "truncated" would be worse than a slight undercount).
    let hiddenCount = 0;
    // Same counting rule, for the fixed-space view's "in other spaces" note.
    let otherSpaceCount = 0;
    for (const row of sortedByLevel) {
      if (row.id === taskId) continue;
      if (!row.parent_task_id || !included.has(row.parent_task_id)) continue;
      if (included.size >= BUDGET_TREE_MAX_NODES) {
        truncated = true;
        break;
      }
      const rowSpaceId = spaceByTaskId.get(row.id) ?? null;
      if (spaceId && rowSpaceId !== spaceId) {
        otherSpaceCount += 1;
        continue;
      }
      if (!inSpaceScope(scope, rowSpaceId)) {
        hiddenCount += 1;
        continue;
      }
      included.set(row.id, row);
    }

    return {
      depth,
      rootTask,
      scope,
      included,
      truncated,
      hiddenCount,
      otherSpaceCount,
      detailById,
      childrenByParentId,
      spaceByTaskId,
    };
  }

  async getBudgetTree(
    taskId: string,
    organizationId: string,
    userId: string,
    options: BudgetTreeOptions = {},
  ): Promise<BudgetTreeResponse> {
    const {
      depth,
      rootTask,
      scope,
      included,
      truncated,
      hiddenCount,
      otherSpaceCount,
      detailById,
      childrenByParentId,
      spaceByTaskId,
    } = await this.resolveScopedTree(taskId, organizationId, userId, options);
    const { spaceId } = options;

    // Dependency links hang off the pruned tree and obey the same space rules.
    const linked = options.includeDependencies
      ? await this.loadLinkedTasks(organizationId, included, (linkedSpaceId) =>
          spaceId
            ? linkedSpaceId === spaceId
            : inSpaceScope(scope, linkedSpaceId),
        )
      : [];
    const linkedByAnchor = new Map<string, LinkedTask[]>();
    for (const item of linked) {
      spaceByTaskId.set(item.row.id, item.spaceId);
      const list = linkedByAnchor.get(item.anchorId) ?? [];
      list.push(item);
      linkedByAnchor.set(item.anchorId, list);
    }

    // Linked tickets load their own entries so their card can show them, but
    // they live in `linked`, never `children`, so no rollup ever reads them.
    const includedIds = [
      ...included.keys(),
      ...linked.map((item) => item.row.id),
    ];

    // One batched (chunked) query for every included node's budget entries —
    // no N+1, and no single request embedding all (up to 300) ids at once.
    const entryRows: BudgetEntryForTree[] = [];
    for (const chunk of chunkArray(includedIds, IN_FILTER_CHUNK_SIZE)) {
      const { data, error: entryError } = await this.client
        .from('resource_budget_entries')
        .select(
          'task_id, cost_category_id, currency, quantity, unit_cost, amount, aggregation, start_date, end_date',
        )
        .eq('organization_id', organizationId)
        .in('task_id', chunk)
        .not('task_id', 'is', null)
        .not('cost_category_id', 'is', null);
      if (entryError) {
        throw new InternalServerErrorException(entryError.message);
      }
      entryRows.push(...((data ?? []) as BudgetEntryForTree[]));
    }
    const entriesByTask = new Map<string, BudgetEntryForTree[]>();
    for (const entry of entryRows) {
      const list = entriesByTask.get(entry.task_id) ?? [];
      list.push(entry);
      entriesByTask.set(entry.task_id, list);
    }

    // Org default working calendar only — a ticket's budget range is not
    // owned by one specific person (confirmed decision).
    const dateBounds = {
      from: null as string | null,
      to: null as string | null,
    };
    for (const entries of entriesByTask.values()) {
      for (const entry of entries) {
        if (!entry.start_date || !entry.end_date) continue;
        if (!dateBounds.from || entry.start_date < dateBounds.from)
          dateBounds.from = entry.start_date;
        if (!dateBounds.to || entry.end_date > dateBounds.to)
          dateBounds.to = entry.end_date;
      }
    }
    const calendar =
      dateBounds.from && dateBounds.to
        ? await this.workingCalendarService.resolveCalendarContext(
            organizationId,
            null,
            dateBounds.from,
            dateBounds.to,
          )
        : null;

    // Budget Splits on the lines (XE-T616). A split from a budget outside the
    // scope is hidden, like an out-of-scope node.
    const treeSplits = await this.budgetSplitService.listByTaskIds(
      organizationId,
      includedIds,
    );
    const budgets = await this.loadBudgets(
      organizationId,
      rootTask.space_id,
      treeSplits.map((split) => split.overall_budget_id),
      (budgetSpaceId) => inSpaceScope(scope, budgetSpaceId),
    );
    const budgetById = new Map(budgets.map((budget) => [budget.id, budget]));
    // Full DB data (all splits and ancestors), so the org view and the space
    // view show the same figures.
    const { rows: budgetSplitRows, analysis } =
      await this.budgetSplitService.analyzeBudgets(organizationId, budgets);
    // ponytail: actual cost is recomputed on every tree request, i.e. once
    // per root the client loads; cache it per request or move it to a SQL
    // aggregate if trees get slow.
    const [usageByBudgetId, hiddenFundedBudgetIds] = await Promise.all([
      budgets.length > 0
        ? this.budgetUsageService.usedByBudget(
            organizationId,
            budgets.map((budget) => budget.id),
          )
        : new Map<string, BudgetUsage>(),
      this.loadHiddenFundedBudgetIds(
        organizationId,
        budgetSplitRows,
        (taskSpaceId) => inSpaceScope(scope, taskSpaceId),
      ),
    ]);

    const splitsByTask = new Map<string, BudgetTreeSplit[]>();
    for (const split of treeSplits) {
      const budget = budgetById.get(split.overall_budget_id);
      if (!budget) continue;
      const nesting = analysis.splits.get(split.id);
      const overAllocatedBy =
        analysis.budgets.get(budget.id)?.over_allocated_by ?? 0;
      const childrenExceedBy = nesting?.children_exceed_by ?? 0;
      const warnings: BudgetSplitWarning[] = [];
      if (overAllocatedBy > 0) warnings.push('budget_over_allocated');
      if (childrenExceedBy > 0) warnings.push('children_exceed');
      if (budget.space_id !== (spaceByTaskId.get(split.task_id) ?? null)) {
        warnings.push('budget_other_space');
      }
      const list = splitsByTask.get(split.task_id) ?? [];
      list.push({
        id: split.id,
        overall_budget_id: budget.id,
        budget_name: budget.name,
        budget_space_id: budget.space_id,
        currency: budget.currency,
        amount: split.amount,
        budget_amount: budget.amount,
        percent_of_budget:
          budget.amount > 0
            ? roundCents((split.amount / budget.amount) * 100)
            : 0,
        note: split.note,
        parent_split_id: nesting?.parent_split_id ?? null,
        children_amount: nesting?.children_amount ?? 0,
        children_exceed_by: childrenExceedBy,
        budget_over_allocated_by: overAllocatedBy,
        warnings,
      });
      splitsByTask.set(split.task_id, list);
    }

    // Linked tickets never get funding: they are not part of this subtree.
    const fundingByTaskId = await this.loadFunding(
      organizationId,
      [...included.keys()].filter((id) => splitsByTask.has(id)),
      splitsByTask,
      childrenByParentId,
      (childId) => {
        const childSpaceId = detailById.get(childId)?.space_id ?? null;
        return spaceId
          ? childSpaceId === spaceId
          : inSpaceScope(scope, childSpaceId);
      },
    );

    const nodesByParent = new Map<string, TaskTreeRow[]>();
    for (const row of included.values()) {
      if (!row.parent_task_id || !included.has(row.parent_task_id)) continue;
      const list = nodesByParent.get(row.parent_task_id) ?? [];
      list.push(row);
      nodesByParent.set(row.parent_task_id, list);
    }

    const buildNode = (row: TaskTreeRow): BudgetTreeNode => {
      const children = (nodesByParent.get(row.id) ?? []).map(buildNode);
      const ownEntries = entriesByTask.get(row.id) ?? [];

      let workingDays: number | null = null;
      if (calendar) {
        const rowBounds = ownEntries.reduce<{
          from: string | null;
          to: string | null;
        }>(
          (acc, entry) => {
            if (!entry.start_date || !entry.end_date) return acc;
            return {
              from:
                !acc.from || entry.start_date < acc.from
                  ? entry.start_date
                  : acc.from,
              to: !acc.to || entry.end_date > acc.to ? entry.end_date : acc.to,
            };
          },
          { from: null, to: null },
        );
        if (rowBounds.from && rowBounds.to) {
          workingDays = countWorkingDaysInRange(
            calendar.dayHours,
            rowBounds.from,
            rowBounds.to,
          );
        }
      }

      // The budget-planning table allows multiple named line items under the same
      // (cost_category_id, currency) -- group them into one row here so this stays
      // the single place that promise ("one row per category+currency") is kept,
      // rather than every consumer (React key, rollup-into-parent) re-discovering
      // the violation on its own.
      const groupsByKey = new Map<string, BudgetEntryForTree[]>();
      for (const entry of ownEntries) {
        if (!entry.cost_category_id) continue;
        const key = `${entry.cost_category_id}::${entry.currency}`;
        const list = groupsByKey.get(key) ?? [];
        list.push(entry);
        groupsByKey.set(key, list);
      }

      const ownByCategory = [...groupsByKey.values()].map((group) => {
        // Every entry's own `amount` counts toward manual_amount, including a rollup
        // entry's -- that's its retained pre-toggle value (see the column comment on
        // resource_budget_entries.aggregation), not a live cost fact, but still what
        // toggling back to manual must restore.
        const manualAmount = group.reduce(
          (sum, entry) => sum + (Number(entry.amount) || 0),
          0,
        );

        // At most one entry per group is expected to be a rollup (the fx toggle
        // only ever flips one entry at a time); if several are, the first found
        // wins deterministically rather than erroring.
        const rollupEntry = group.find(
          (entry) => entry.aggregation !== 'manual',
        );

        let effectiveAmount = manualAmount;
        if (rollupEntry) {
          const childValues = children
            .flatMap((child) =>
              child.own_by_category.filter(
                (c) =>
                  c.cost_category_id === rollupEntry.cost_category_id &&
                  c.currency === rollupEntry.currency,
              ),
            )
            .map((c) => c.effective_amount);
          effectiveAmount = aggregate(rollupEntry.aggregation, childValues);
        }

        return {
          cost_category_id: group[0].cost_category_id as string,
          currency: group[0].currency,
          aggregation: rollupEntry?.aggregation ?? 'manual',
          manual_amount: manualAmount,
          effective_amount: round(effectiveAmount),
        };
      });

      return {
        task_id: row.id,
        key: row.key,
        summary: row.summary,
        level: row.level,
        parent_task_id: row.parent_task_id,
        space_id: spaceByTaskId.get(row.id) ?? null,
        accessible: true,
        own_by_category: ownByCategory,
        working_days: workingDays,
        children,
        linked: (linkedByAnchor.get(row.id) ?? []).map((item) => ({
          ...buildNode(item.row),
          link: item.link,
          has_hidden_children: false,
        })),
        // childrenByParentId is built from the full descendant set fetched via
        // get_task_descendant_ids, before either the depth or node-count cutoff
        // is applied -- so it still knows about real children even when this
        // node's own (cut-off) `children` above came back empty. In a
        // fixed-space view only children in that space count.
        has_hidden_children:
          children.length === 0 &&
          (childrenByParentId.get(row.id) ?? []).some(
            (childId) =>
              !spaceId || detailById.get(childId)?.space_id === spaceId,
          ),
        budget_splits: splitsByTask.get(row.id) ?? [],
        funding: fundingByTaskId.get(row.id)?.funding ?? [],
        funding_other_currency:
          fundingByTaskId.get(row.id)?.funding_other_currency ?? false,
      };
    };

    const rootRow = included.get(taskId)!;

    return {
      root_task_id: taskId,
      depth,
      node_count: included.size + linked.length,
      truncated,
      hidden_count: hiddenCount,
      other_space_count: otherSpaceCount,
      tree: buildNode(rootRow),
      budgets: budgets.map((budget) => ({
        ...budget,
        allocated_amount:
          analysis.budgets.get(budget.id)?.allocated_amount ?? 0,
        over_allocated_by:
          analysis.budgets.get(budget.id)?.over_allocated_by ?? 0,
        used_amount: usageByBudgetId.get(budget.id)?.used_amount ?? 0,
        used_percent: usageByBudgetId.get(budget.id)?.used_percent ?? 0,
        used_other_currencies:
          usageByBudgetId.get(budget.id)?.used_other_currencies ?? [],
        missing_rate_hours:
          usageByBudgetId.get(budget.id)?.missing_rate_hours ?? 0,
        has_hidden_funded_tasks: hiddenFundedBudgetIds.has(budget.id),
      })),
    };
  }

  /**
   * The root space's budgets plus any budget a tree split uses, kept only
   * when `isVisible` allows its space, sorted by name.
   */
  private async loadBudgets(
    organizationId: string,
    rootSpaceId: string | null,
    referencedIds: string[],
    isVisible: (spaceId: string) => boolean,
  ): Promise<BudgetRef[]> {
    const columns = 'id, name, amount, currency, space_id';
    const byId = new Map<string, BudgetRef>();
    const add = (rows: unknown[] | null) => {
      for (const row of (rows ?? []) as BudgetRef[]) {
        byId.set(row.id, { ...row, amount: Number(row.amount) });
      }
    };

    if (rootSpaceId) {
      const { data, error } = await this.client
        .from('overall_budgets')
        .select(columns)
        .eq('organization_id', organizationId)
        .eq('space_id', rootSpaceId);
      if (error) throw new InternalServerErrorException(error.message);
      add(data);
    }
    const missingIds = [...new Set(referencedIds)].filter(
      (id) => !byId.has(id),
    );
    for (const chunk of chunkArray(missingIds, IN_FILTER_CHUNK_SIZE)) {
      const { data, error } = await this.client
        .from('overall_budgets')
        .select(columns)
        .eq('organization_id', organizationId)
        .in('id', chunk);
      if (error) throw new InternalServerErrorException(error.message);
      add(data);
    }

    return [...byId.values()]
      .filter((budget) => isVisible(budget.space_id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Budgets with a split on a task `isVisible` rejects, over all their splits
   * (not only this tree's), with one chunked read of those tasks' spaces. A
   * task not found counts as hidden, like inSpaceScope's unknown space.
   */
  private async loadHiddenFundedBudgetIds(
    organizationId: string,
    splits: BudgetSplitRow[],
    isVisible: (spaceId: string | null | undefined) => boolean,
  ): Promise<Set<string>> {
    const spaceByTaskId = new Map<string, string | null>();
    const taskIds = [...new Set(splits.map((split) => split.task_id))];
    for (const chunk of chunkArray(taskIds, IN_FILTER_CHUNK_SIZE)) {
      const { data, error } = await this.client
        .from('tasks')
        .select('id, space_id')
        .eq('organization_id', organizationId)
        .in('id', chunk);
      if (error) throw new InternalServerErrorException(error.message);
      for (const row of (data ?? []) as {
        id: string;
        space_id: string | null;
      }[]) {
        spaceByTaskId.set(row.id, row.space_id);
      }
    }
    return new Set(
      splits
        .filter((split) => !isVisible(spaceByTaskId.get(split.task_id)))
        .map((split) => split.overall_budget_id),
    );
  }

  /**
   * Per funded node, per split currency: the manual planned entries of the
   * node's subtree next to what its splits fund. Subtrees come from the full
   * descendant set (not depth-limited) and skip a hidden child with its whole
   * subtree, like the pruning. One chunked entries read for all nodes.
   * ponytail: overlapping subtrees are walked once per funded node (nodes x
   * descendants); accumulate bottom-up if trees outgrow that.
   */
  private async loadFunding(
    organizationId: string,
    fundedTaskIds: string[],
    splitsByTask: ReadonlyMap<string, BudgetTreeSplit[]>,
    childrenByParentId: ReadonlyMap<string, string[]>,
    isVisibleChild: (childId: string) => boolean,
  ): Promise<Map<string, NodeFunding>> {
    const subtreeByTaskId = new Map<string, Set<string>>();
    for (const taskId of fundedTaskIds) {
      const ids = new Set([taskId]);
      const stack = [taskId];
      while (stack.length > 0) {
        for (const childId of childrenByParentId.get(stack.pop()!) ?? []) {
          if (ids.has(childId) || !isVisibleChild(childId)) continue;
          ids.add(childId);
          stack.push(childId);
        }
      }
      subtreeByTaskId.set(taskId, ids);
    }

    const plannedByTaskId = new Map<string, Map<string, number>>();
    const allIds = [
      ...new Set([...subtreeByTaskId.values()].flatMap((ids) => [...ids])),
    ];
    for (const chunk of chunkArray(allIds, IN_FILTER_CHUNK_SIZE)) {
      const { data, error } = await this.client
        .from('resource_budget_entries')
        .select('task_id, currency, amount')
        .eq('organization_id', organizationId)
        .eq('entry_type', 'planned')
        .eq('aggregation', 'manual')
        .in('task_id', chunk)
        .not('task_id', 'is', null)
        .not('cost_category_id', 'is', null);
      if (error) throw new InternalServerErrorException(error.message);
      for (const entry of (data ?? []) as {
        task_id: string;
        currency: string;
        amount: number | string;
      }[]) {
        const byCurrency =
          plannedByTaskId.get(entry.task_id) ?? new Map<string, number>();
        byCurrency.set(
          entry.currency,
          (byCurrency.get(entry.currency) ?? 0) + (Number(entry.amount) || 0),
        );
        plannedByTaskId.set(entry.task_id, byCurrency);
      }
    }

    const result = new Map<string, NodeFunding>();
    for (const [taskId, subtreeIds] of subtreeByTaskId) {
      const planned = new Map<string, number>();
      for (const id of subtreeIds) {
        for (const [currency, amount] of plannedByTaskId.get(id) ?? []) {
          planned.set(currency, (planned.get(currency) ?? 0) + amount);
        }
      }
      const funded = new Map<string, number>();
      for (const split of splitsByTask.get(taskId) ?? []) {
        funded.set(
          split.currency,
          (funded.get(split.currency) ?? 0) + split.amount,
        );
      }
      const funding = [...funded.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, fundedAmount]) => {
          const plannedAmount = roundCents(planned.get(currency) ?? 0);
          const fundedRounded = roundCents(fundedAmount);
          return {
            currency,
            planned_amount: plannedAmount,
            funded_amount: fundedRounded,
            underfunded_by: roundCents(
              Math.max(0, plannedAmount - fundedRounded),
            ),
          };
        });
      result.set(taskId, {
        funding,
        funding_other_currency:
          funding.length > 0 &&
          [...planned.values()].some((amount) => roundCents(amount) > 0) &&
          funding.every((row) => row.planned_amount <= 0),
      });
    }
    return result;
  }

  /**
   * Tickets one dependency hop away from the tree, within the node cap and
   * visible under `isVisible`. Only task-to-task rows: task_relationships
   * also carries wiki-page targets.
   */
  private async loadLinkedTasks(
    organizationId: string,
    included: Map<string, TaskTreeRow>,
    isVisible: (spaceId: string | null) => boolean,
  ): Promise<LinkedTask[]> {
    const limit = BUDGET_TREE_MAX_NODES - included.size;
    if (limit <= 0) return [];

    const { data: typeRows, error: typesError } = await this.client
      .from('relation_types')
      .select('id, name, outward_description, inward_description')
      .eq('organization_id', organizationId)
      .eq('is_system', true)
      .in('name', DEPENDENCY_RELATION_NAMES);
    if (typesError) throw new InternalServerErrorException(typesError.message);
    const typeById = new Map(
      (
        (typeRows ?? []) as Array<{
          id: string;
          name: string;
          outward_description: string;
          inward_description: string;
        }>
      ).map((type) => [type.id, type]),
    );
    if (typeById.size === 0) return [];

    const includedIds = [...included.keys()];
    const linkRows: TaskLinkRow[] = [];
    for (const column of ['source_id', 'target_id'] as const) {
      for (const chunk of chunkArray(includedIds, IN_FILTER_CHUNK_SIZE)) {
        const { data, error } = await this.client
          .from('task_relationships')
          .select('source_id, target_id, relation_type_id')
          .eq('organization_id', organizationId)
          .eq('source_type', 'task')
          .eq('target_type', 'task')
          .in('relation_type_id', [...typeById.keys()])
          .in(column, chunk);
        if (error) throw new InternalServerErrorException(error.message);
        linkRows.push(...((data ?? []) as TaskLinkRow[]));
      }
    }

    const levelById = new Map(
      [...included.values()].map((row) => [row.id, row.level]),
    );
    const candidateIds = [
      ...new Set(
        linkRows
          .flatMap((row) => [row.source_id, row.target_id])
          .filter((id) => !levelById.has(id)),
      ),
    ];
    if (candidateIds.length === 0) return [];

    // Details before picking, so the space filter runs before the cap does.
    const details = new Map<string, TaskDetailRow>();
    for (const chunk of chunkArray(candidateIds, IN_FILTER_CHUNK_SIZE)) {
      const { data, error } = await this.client
        .from('tasks')
        .select('id, key, summary, parent_task_id, space_id')
        .in('id', chunk)
        .eq('organization_id', organizationId);
      if (error) throw new InternalServerErrorException(error.message);
      for (const row of (data ?? []) as TaskDetailRow[]) {
        details.set(row.id, row);
      }
    }
    const visibleRows = linkRows.filter((row) => {
      const other = details.get(
        levelById.has(row.source_id) ? row.target_id : row.source_id,
      );
      return other !== undefined && isVisible(other.space_id);
    });

    return pickLinkedTasks(visibleRows, levelById, limit).map((pick) => {
      const detail = details.get(pick.linkedId)!;
      const type = typeById.get(pick.relationTypeId)!;
      return {
        anchorId: pick.anchorId,
        spaceId: detail.space_id,
        row: {
          id: detail.id,
          key: detail.key,
          summary: detail.summary,
          level: levelById.get(pick.anchorId)! + 1,
          parent_task_id: detail.parent_task_id,
        },
        link: {
          relation_type_name: type.name,
          label: pick.anchorIsSource
            ? type.outward_description
            : type.inward_description,
        },
      };
    });
  }
}

function aggregate(mode: BudgetAggregation, values: number[]): number {
  if (values.length === 0) return 0;
  if (mode === 'rollup_avg')
    return values.reduce((a, b) => a + b, 0) / values.length;
  if (mode === 'rollup_max') return Math.max(...values);
  return values.reduce((a, b) => a + b, 0);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
