/**
 * @fileoverview The component tree with restore-specific facts added.
 * @module src/backup/engine/restore-component-tree
 *
 * `buildComponentTree()` describes what the registry HOLDS — tiers, components, tables, their scope
 * and whether the engine will restore them at all. It cannot describe whether a table can cross into
 * another organization, because that answer lives in `remapSpecFor()`, and the registry is the
 * bottom of the dependency graph: importing the engine into it would invert that. This module sits
 * above both and joins them, which is why it is here and not in `registry/`.
 *
 * It exists because the restore picker had been guessing. `offerableContents` in `RestoreWizard.tsx`
 * carried a four-name literal — `tasks` and its three companions — while the engine had grown to
 * move 176 tables. Choosing another destination organization therefore hid forty-nine of fifty-two
 * areas behind "cannot be moved to another organization", which was false for all but two of them.
 * The approval gate had already had, and already fixed, the identical bug; the picker never
 * followed. Publishing the fact is what stops it happening a third time.
 */

import {
  buildComponentTree,
  type BackupTier,
  type RestoreRefusalCode,
  type TableScopeLabel,
} from '../registry/component-registry';
import { crossOrgRestorableTables } from './restore-id-remapper';

export interface RestoreComponentTree {
  tiers: {
    tier: BackupTier;
    components: {
      component: string;
      tables: string[];
      tableScopes: Record<string, TableScopeLabel>;
      tableRestorable: Record<string, boolean>;

      /**
       * Why each unrestorable table is unrestorable, keyed only by the tables that are. Flows
       * through from `buildComponentTree()` untouched — stated here because this interface is what
       * the picker is typed against.
       */
      tableRestoreRefusal: Partial<Record<string, RestoreRefusalCode>>;

      /**
       * Whether each table can be carried into a DIFFERENT organization, keyed by table for the
       * same reason its two neighbours are: components hold both kinds. `migration_runs` moves four
       * of its five tables; a per-component verdict would be wrong about it either way.
       *
       * Independent of `tableRestorable`, not a narrowing of it. A table can be restorable and
       * unmovable (`spaces`), and the picker has to apply both.
       */
      tableCrossOrgRestorable: Record<string, boolean>;

      /**
       * The same question asked of a run that RECREATES the archived spaces rather than folding
       * every source space onto one the operator chose.
       *
       * Differs from its neighbour by exactly one table today — `spaces`, which is unmovable while
       * folding and movable while recreating — but it is derived, not that name written down.
       *
       * Sent ALONGSIDE the folding answer rather than instead of it, and that is the point. The
       * picker needs both at once to tell "this can never cross" (`migration_logs`,
       * `partner_document_sequences`) from "this would cross if you cleared the destination space",
       * and those two deserve opposite advice. Serving one answer per request could not express the
       * difference, and made the mode a cache key — so toggling the space blanked the picker while
       * the other answer loaded, and blamed the server for it.
       */
      tableCrossOrgRestorableWhenRecreating: Record<string, boolean>;

      /** Other components this one's tables cannot be fully restored without. @see buildComponentTree */
      requires: string[];
    }[];
  }[];
}

/**
 * Built once at module load.
 *
 * `remapSpecFor` walks the foreign-key graph for every table it is asked about, and the answer
 * cannot change without a deploy — so doing this per request would repeat 185 graph walks for a
 * constant. `crossOrgRestorableTables()` memoises for the same reason.
 */
const TREE: RestoreComponentTree = (() => {
  const movable = crossOrgRestorableTables();
  const movableWhenRecreating = crossOrgRestorableTables(true);
  const base = buildComponentTree();

  return {
    tiers: base.tiers.map((tier) => ({
      ...tier,
      components: tier.components.map((component) => ({
        ...component,
        tableCrossOrgRestorable: Object.fromEntries(
          component.tables.map((table) => [table, movable.has(table)]),
        ),
        tableCrossOrgRestorableWhenRecreating: Object.fromEntries(
          component.tables.map((table) => [
            table,
            movableWhenRecreating.has(table),
          ]),
        ),
      })),
    })),
  };
})();

/**
 * The registry projected for the restore picker.
 *
 * Takes no mode. Both movability answers ride in the one response, so the caller chooses between
 * them in memory instead of asking again — which is what keeps the picker from emptying itself
 * mid-wizard, and keeps the offer and the approval gate reading the same derivation.
 *
 * @see RestoreComponentTree
 */
export function buildRestoreComponentTree(): RestoreComponentTree {
  return TREE;
}
