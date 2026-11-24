/**
 * @fileoverview Rewrites archived rows so they belong to a different organization.
 * @module src/backup/engine/restore-id-remapper
 *
 * Pure functions. No database, no archive, no clock — the same discipline as
 * `restore-row-preparer.ts`, and for the same reason: this is where the rules that decide whether a
 * cross-organization restore corrupts data live, and none of them should need a running system to
 * be proven.
 *
 * ## Why anything has to be rewritten at all
 *
 * A restore normally preserves primary keys. That is safe when the rows are going back where they
 * came from, and impossible when they are not: both organizations live in the same database, so the
 * archived ids are still in use by the source tenant. Writing them again collides. Every row
 * therefore gets a NEW id, and everything that pointed at the old one has to be repointed — which is
 * the whole of this file.
 *
 * ## The two things a foreign-key-driven remapper would get wrong
 *
 *   - `tasks.parent_task_id` points at another row in the SAME table, and the parent may appear
 *     later in the archive than the child. Nothing here can resolve that mid-stream, so the caller
 *     must seed the map with every id in the table first — see `seedIds`. Without it a child whose
 *     parent came later would have its parent quietly cleared, flattening the hierarchy in silence.
 *   - `task_relationships.source_id` / `target_id` carry no foreign key at all. They are polymorphic,
 *     paired with `source_type` / `target_type`, and can name a wiki page or an asset item as easily
 *     as a task. A remapper that walks foreign keys never sees them, and leaving them alone points
 *     the restored organization straight back at the source tenant's rows.
 *
 * ## What is deliberately NOT rewritten
 *
 * A uuid inside jsonb that the map does not know. It may be a user id, a custom-field id, or
 * something unrelated — rewriting it would be a guess, and a wrong guess inside a jsonb blob is
 * invisible. Only ids this restore actually minted are replaced.
 */

import { randomUUID } from 'node:crypto';
import {
  COMPONENT_REGISTRY,
  IDENTITY_COLUMN_TABLES,
  SEQUENCE_PRIMARY_KEY_TABLES,
  UNMOVABLE_PRIMARY_KEY_TABLES,
  tableEntry,
  type ComponentTable,
} from '../registry/component-registry';
import { fkEdgesFor } from '../registry/restore-fk-graph';

/** Why a row could not be moved to the other organization. Stable keys — the UI maps them. */
export type RemapSkipReason =
  | 'unmapped_reference'
  | 'unsupported_reference_type'
  | 'unmatched_config';

export interface RemapSkip {
  kind: 'skip';
  reason: RemapSkipReason;
  detail: string;

  /**
   * The table the refused reference pointed at, when one is known.
   *
   * The operator-facing question after a restore skips is never "which column" but "what did I fail
   * to include" — and this is the only place in the system that can answer it exactly. For an
   * ordinary foreign key a static source could work it out; for a polymorphic column it cannot,
   * because the target depends on the row's own `entity_type` and is resolved here, per row.
   *
   * Kept because the alternative was predicting it afterwards from `requires` or the FK graph, and
   * both have been shown to be wrong: four key-sequence tables declare a `requires` component they
   * have no foreign key to, and the generated FK graph is missing three live constraints on
   * `form_builder_orders`. This is measured rather than inferred.
   *
   * Optional: `unsupported_reference_type` has no target by definition — the type did not resolve to
   * a table at all, which is what makes it unsupported.
   */
  referencesTable?: string;
}

export interface RemapInsert {
  kind: 'insert';
  row: Record<string, unknown>;
  /** Columns cleared because nothing in the destination matched. Counted, never silent. */
  clearedColumns: string[];
}

export type RemapOutcome = RemapInsert | RemapSkip;

/**
 * A reference to another row this restore is carrying.
 *
 * `typeColumn` marks a polymorphic reference: the id only means a row in the restored set when its
 * companion type column says so.
 */
export interface RowReferenceSpec {
  column: string;
  /** True when the row cannot exist without it — an unmapped value drops the row rather than nulls it. */
  required: boolean;
  typeColumn?: string;
  /** Type values that denote a row in the restored set. Only meaningful with `typeColumn`. */
  mappableTypes?: string[];

  /**
   * Target table per type value, for a polymorphic reference whose types name DIFFERENT tables.
   *
   * The richer half of `mappableTypes`, and the distinction matters. `task_relationships` points at
   * one table, so knowing the type is mappable is knowing where it points; `file_attachments.entity_id`
   * names a task, a wiki page or an asset item by turns, and "mappable" alone cannot say which. This
   * resolves `referencesTable` per ROW, which is what the two lookups below need: the composite
   * `alreadyRestored` key, and the test for whether the target is one this run is re-keying at all.
   *
   * Only meaningful with `typeColumn`, and mutually exclusive with `mappableTypes` in practice — a
   * spec carrying this takes the resolved path, one carrying only `mappableTypes` the older one.
   */
  typeToTable?: Record<string, string>;

  /**
   * The table this column points at, where it is known.
   *
   * Set on derived specs, where the foreign-key graph supplies it. It is what lets an unmapped
   * reference be told apart from an INVALID one: a target this run is writing has been re-keyed, so
   * a missing mapping means trouble, while a target the run is not touching still sits in the
   * database under the id the archive recorded.
   *
   * Left unset by the hand-written specs, which then take the older, stricter path.
   */
  referencesTable?: string;
}

/**
 * A reference to per-organization configuration — a status, a priority, a relation type.
 *
 * These are matched by natural key upstream, because the destination organization has its own rows
 * with its own ids. `onMissing: 'null'` is for configuration this restore will not create on
 * somebody else's behalf.
 */
export interface ConfigReferenceSpec {
  column: string;
  onMissing: 'null' | 'skip';
}

export interface TableRemapSpec {
  table: string;

  /**
   * The column naming the owning organization, where the table has one.
   *
   * Optional because some space-scoped tables do not: `automation_versions` belongs to a tenant
   * through the automation it hangs off, not through a column of its own. Treating that absence as
   * "cannot be moved" refused the table outright and took 95 `automation_runs` down with it.
   */
  tenantColumn?: string;
  spaceColumn?: string;
  rowReferences: RowReferenceSpec[];

  /**
   * Whether a REQUIRED reference may keep its archived id when its target is not part of this run.
   *
   * Set by the DERIVED builder and deliberately absent from every hand-written spec, which is the
   * distinction the two were always drawing — `referencesTable` merely made it visible. A derived
   * table points at whatever the schema says it points at, and a target this run is not touching is
   * still sitting in the database under the archived id; keeping it is what let 95 `automation_runs`
   * land instead of being discarded.
   *
   * A hand-written spec exists precisely because something about the table is NOT derivable, and for
   * three of them the un-derivable part is that the reference must never be kept:
   * `form_builder_webhook_deliveries` and `form_builder_integration_deliveries` point at tables
   * holding encrypted endpoint credentials, which this restore does not carry — a delivery written
   * with its archived `webhook_id` would arrive pointed at a credential in the space it came from.
   * Their tests say so in as many words, and they are the reason this flag is opt-in rather than
   * derived from `Boolean(referencesTable)`.
   */
  keepReferencesOutsideRun?: boolean;
  configReferences: ConfigReferenceSpec[];
  jsonColumns: string[];
  /**
   * Columns cleared so the destination generates its own.
   *
   * `tasks.key` encodes the space it was created in (`NEWSPACE-T93`), which names nothing in the
   * destination. Nulling it lets `task_key_trigger` issue a correct key there and keeps
   * `task_key_sequences_space` in step — reusing machinery that already exists rather than
   * inventing keys here.
   */
  regenerateColumns: string[];
}

/**
 * The tables a remapped restore may carry, in the order they must be written.
 *
 * The order the registry actually writes in is `insertLevel`, a longest-path depth over the
 * DECLARED foreign keys (`orderForInsert` in `restore-planner.ts` sorts by it and nothing else).
 * That depth is wrong for any table whose references carry no foreign key, because the graph it was
 * derived from cannot see them:
 *
 *   - `task_relationships` sits at level 2, ahead of `tasks` at 5. Its `source_id` / `target_id`
 *     hold task ids with no constraint behind them.
 *   - `form_builder_orders` sits at level 1, ahead of `form_builder` at 3 and
 *     `form_builder_submissions` at 6. Its `form_id` and `submission_id` have no constraint either
 *     — verified against `pg_constraint`, which returns not one foreign key for that table.
 *
 * NO LONGER THE ORDER THE PLANNER USES. `orderForInsert` now computes depth from the generated
 * foreign-key graph, plus a `LOGICAL_DEPENDENCIES` map for exactly the two tables named above, whose
 * references the database does not enforce and which therefore cannot appear in that graph. That is
 * what fixed the refusals this comment used to describe as expected.
 *
 * Kept as the readable statement of the intended order, and asserted against the planner's output in
 * the specs, so the two cannot drift. It is documentation with a test behind it, not an input.
 */
export const CROSS_ORG_TABLE_ORDER = [
  'tasks',
  'task_comments',
  'task_history',
  'task_relationships',
  'form_builder',
  'form_builder_submissions',
  'form_builder_approvals',
  'form_builder_approval_steps',
  'form_builder_assignments',
  'form_builder_orders',
  'form_builder_webhook_deliveries',
  'form_builder_integration_deliveries',
  'wiki_pages',
] as const;

export const CROSS_ORG_REMAP_SPECS: Record<string, TableRemapSpec> = {
  tasks: {
    table: 'tasks',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    rowReferences: [
      // Optional: a task whose parent is not in the archive is a legitimate top-level task in the
      // destination. Cleared rather than dropped, and counted so the flattening is visible.
      { column: 'parent_task_id', required: false, referencesTable: 'tasks' },
    ],
    configReferences: [
      { column: 'status_id', onMissing: 'null' },
      { column: 'priority_id', onMissing: 'null' },
      { column: 'resolution_id', onMissing: 'null' },
      // Never created on the destination's behalf: a business process is space-scoped and far more
      // than a lookup value. Unmatched means the task arrives without one.
      { column: 'process_id', onMissing: 'null' },
    ],
    jsonColumns: ['custom_field_values', 'labels'],
    // The copy is a new ticket: its support request still belongs to the original, which the SLA trigger enforces.
    regenerateColumns: ['key', 'support_request_origin_id'],
  },
  task_comments: {
    table: 'task_comments',
    tenantColumn: 'organization_id',
    rowReferences: [
      { column: 'task_id', required: true, referencesTable: 'tasks' },
    ],
    configReferences: [],
    jsonColumns: [],
    regenerateColumns: [],
  },
  task_history: {
    table: 'task_history',
    tenantColumn: 'organization_id',
    rowReferences: [
      { column: 'task_id', required: true, referencesTable: 'tasks' },
    ],
    configReferences: [],
    jsonColumns: ['old_value', 'new_value'],
    regenerateColumns: [],
  },
  task_relationships: {
    table: 'task_relationships',
    tenantColumn: 'organization_id',
    rowReferences: [
      {
        column: 'source_id',
        required: true,
        typeColumn: 'source_type',
        mappableTypes: ['task', 'tasks'],
      },
      {
        column: 'target_id',
        required: true,
        typeColumn: 'target_type',
        mappableTypes: ['task', 'tasks'],
      },
    ],
    configReferences: [{ column: 'relation_type_id', onMissing: 'skip' }],
    jsonColumns: [],
    regenerateColumns: [],
  },

  // ===========================================================================================
  // The form_builder family and wiki_pages
  // ===========================================================================================
  //
  // Added because a restore that chose a DESTINATION SPACE skipped every one of them. The writer
  // computes `canRescope` as "does this table have a spec here", and `refuseUnmovableRow` refuses
  // any space-scoped row of a table without one. Every table below is `spaceScope: own` on a NOT
  // NULL `space_id`, so every row of it is in a space — which made the refusal total. One real run
  // selecting these tables restored 0 of 275 rows, each with the advice "restore without choosing a
  // destination space", which is not the operation the operator asked for.
  //
  // The refusal was doing its job: without a spec these rows would have been inserted carrying the
  // SOURCE space's id and the source rows' primary keys. What was missing is the rewrite that makes
  // moving them safe, and that is what these specs are.
  //
  // Three things every one of them relies on, none of which is restated per table:
  //
  //   - Duplication is prevented by the entity map, not by anything here. The writer looks up
  //     `entityMapKey(table, sourceId)` in `RemapState.alreadyRestored` BEFORE calling `remapRow`
  //     and skips a row an earlier run already wrote; `RemapState.minted` collects the pairs of
  //     rows that actually landed and `restore_entity_map` persists them. That path is keyed on the
  //     table name and the row's `id` and is therefore generic — every table below has a `uuid`
  //     primary key called `id`, so adding it to this map turns on re-scoping and the repeat-run
  //     guard together. There is no table here that gets one without the other.
  //   - User columns are NOT listed. `created_by`, `updated_by`, `deleted_by`, `submitted_by`,
  //     `assigned_by`, `assignee_user_id`, `approver_user_id` are handled before `remapRow` ever
  //     runs, by the registry's `userFkPolicy` in `prepareRow`, against the DESTINATION's members.
  //     Listing them here would null a user who is present in the destination.
  //   - A reference is `required: true` only where the column is NOT NULL. A `required: false`
  //     reference that cannot be mapped is set to null, and nulling a NOT NULL column does not
  //     produce a refusal — it produces a 23502 on insert, which `classifyInsertError` treats as
  //     `rowLevel: false` and which therefore fails the WHOLE table. Refusing the row is the
  //     cheaper failure and it names the actual cause.
  form_builder: {
    table: 'form_builder',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    rowReferences: [],
    configReferences: [],
    // Free-form form configuration. Walked because the map only ever replaces ids it minted, so a
    // form whose settings embed a field or form id is corrected and ordinary settings are not
    // touched.
    jsonColumns: ['settings'],
    /**
     * `form_key` is deliberately NOT regenerated, which is the opposite of `tasks.key`.
     *
     * The two look alike — both are space-scoped counters, `FORM-7` from
     * `form_builder_key_sequences` against `NEWSPACE-T93` from `task_key_sequences_space` — and the
     * difference is what reissues them. A task's key is reissued by `task_key_trigger`, which fires
     * on insert when the key is null, so nulling it is how the destination gets a correct one.
     * A form's key is allocated by `generate_form_builder_key(p_space_id)`, an RPC the application
     * calls; NO trigger on `form_builder` touches it (the table's only trigger is
     * `trg_form_builder_updated_at`). Nulling it would leave the restored form with no key at all,
     * permanently, because nothing downstream would ever issue one.
     *
     * So the archived key survives. There is no unique constraint on it, so nothing breaks — but
     * the destination space's sequence is not advanced either, and a form created there later can
     * be issued a key a restored form is already using. Cosmetic, and named here so it is not
     * rediscovered as a mystery.
     */
    regenerateColumns: [],
  },
  /**
   * A page carried its funnel id across unchanged, which is how it came to be refused.
   *
   * `site_studio_pages.funnel_id` is a real foreign key and is declared in the FK graph, but that
   * graph is not what this map is built from — references are listed here by hand, and this table
   * had no entry. So a page restored into another organization kept pointing at the funnel it came
   * FROM, and `idx_site_studio_pages_funnel_path` refused it as a duplicate of the source
   * organization's own page.
   *
   * The refusal was the only thing preventing a page being written into a different tenant's
   * funnel. Repointing it at the funnel this run actually restored is the fix; the collision then
   * cannot arise, because the new funnel has no pages of its own.
   *
   * No `spaceColumn`: `spaceScope` is `organization`, so a page is not confined to a space.
   */
  site_studio_pages: {
    table: 'site_studio_pages',
    tenantColumn: 'organization_id',
    rowReferences: [
      // NOT NULL, and a page outside a funnel is not addressable. Required, so a page whose funnel
      // is not in this restore is refused rather than left aimed at the source organization.
      {
        column: 'funnel_id',
        required: true,
        referencesTable: 'site_studio_funnels',
      },
    ],

    // A page holds no ids inside its stored configuration or its JSON body that this restore
    // rewrites — the funnel above is the whole of it.
    configReferences: [],
    jsonColumns: [],
    regenerateColumns: [],
  },
  form_builder_submissions: {
    table: 'form_builder_submissions',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    rowReferences: [
      // NOT NULL. A submission of no form is not a thing that can exist.
      { column: 'form_id', required: true, referencesTable: 'form_builder' },
      /**
       * Optional, and the reason it must be listed at all.
       *
       * `task_id` is nullable and points at `tasks`, which this restore may or may not be carrying.
       * Carried: the id is repointed at the task's new row, because `tasks` is written first
       * (`insertLevel` 5 against 6). Not carried: there is no new id, and the archived one names a
       * task still living in the space this submission came from. Cleared and counted rather than
       * left as a pointer out of the destination space.
       */
      { column: 'task_id', required: false, referencesTable: 'tasks' },
    ],
    configReferences: [],
    // The answers, and the copy of the form's fields taken when they were given. Both are keyed by
    // `field_key` rather than by field id, so in practice nothing here is rewritten — walked
    // because "in practice" is not a guarantee and the walk cannot misfire.
    jsonColumns: ['data', 'field_snapshot'],
    regenerateColumns: [],
  },
  form_builder_approvals: {
    table: 'form_builder_approvals',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    // Both NOT NULL, both `ON DELETE CASCADE`: an approval exists only for a submission of a form.
    rowReferences: [
      { column: 'form_id', required: true, referencesTable: 'form_builder' },
      {
        column: 'submission_id',
        required: true,
        referencesTable: 'form_builder_submissions',
      },
    ],
    configReferences: [],
    jsonColumns: [],
    regenerateColumns: [],
  },
  form_builder_approval_steps: {
    table: 'form_builder_approval_steps',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    // NOT NULL. The step's only structural parent — it reaches the form and the submission through
    // the approval, so neither is repeated here.
    rowReferences: [
      {
        column: 'approval_id',
        required: true,
        referencesTable: 'form_builder_approvals',
      },
    ],
    configReferences: [],
    jsonColumns: [],
    regenerateColumns: [],
  },
  form_builder_assignments: {
    table: 'form_builder_assignments',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    rowReferences: [
      { column: 'form_id', required: true, referencesTable: 'form_builder' },
      // Nullable, and null for every assignment nobody has completed yet. An assignment whose
      // completed submission is not in the archive is still a valid outstanding assignment.
      {
        column: 'completed_submission_id',
        required: false,
        referencesTable: 'form_builder_submissions',
      },
    ],
    configReferences: [],
    jsonColumns: [],
    regenerateColumns: [],
  },
  /**
   * Payment orders.
   *
   * `pg_constraint` returns NO foreign keys for this table — not on `form_id`, not on
   * `submission_id`, not even on `organization_id`. Both ids are therefore invisible to anything
   * that walks declared relationships, which is the same trap `task_relationships` sets and the
   * reason its registry `insertLevel` is 1: a longest-path depth over an empty edge set is zero
   * hops. Written before `form_builder`, its `form_id` cannot resolve. See `CROSS_ORG_TABLE_ORDER`.
   */
  form_builder_orders: {
    table: 'form_builder_orders',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    rowReferences: [
      { column: 'form_id', required: true, referencesTable: 'form_builder' },
      // Nullable: an order is created when checkout starts, and the submission it belongs to is
      // attached when the payment settles.
      {
        column: 'submission_id',
        required: false,
        referencesTable: 'form_builder_submissions',
      },
    ],
    configReferences: [],
    // Stripe's line items and metadata. No id of ours is expected in either; walked for the same
    // reason as everything else here — the map replaces only what it minted.
    jsonColumns: ['line_items', 'metadata'],
    regenerateColumns: [],
  },
  /**
   * Webhook delivery attempts.
   *
   * `webhook_id` is NOT NULL and points at `form_builder_webhooks`, which has NO spec in this map.
   * That is a deliberate omission, not an oversight: the webhook row carries `secret_encrypted` /
   * `secret_iv` / `secret_tag`, and this map is also what `RestoreApprovalsService` derives
   * `CROSS_ORG_SUPPORTED_TABLES` from — adding it here would make an encrypted endpoint credential
   * movable into another tenant, which is a decision for a person rather than a side effect of
   * fixing a space move.
   *
   * The consequence is that every row of this table is refused `unmapped_reference` while that
   * holds. That refusal is the correct one and it is the reason `webhook_id` is `required` — a
   * delivery record pointing at a webhook in the space it came from is worse than no delivery
   * record. Covering `form_builder_webhooks` is what makes this table restorable.
   */
  form_builder_webhook_deliveries: {
    table: 'form_builder_webhook_deliveries',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    rowReferences: [
      {
        column: 'webhook_id',
        required: true,
        referencesTable: 'form_builder_webhooks',
      },
      {
        column: 'submission_id',
        required: false,
        referencesTable: 'form_builder_submissions',
      },
    ],
    configReferences: [],
    jsonColumns: [],
    regenerateColumns: [],
  },
  /** Same shape and the same open question as `form_builder_webhook_deliveries`, one table over:
   * `integration_id` is NOT NULL and `form_builder_integrations` holds encrypted provider
   * credentials, so it is not covered here either. */
  form_builder_integration_deliveries: {
    table: 'form_builder_integration_deliveries',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    rowReferences: [
      {
        column: 'integration_id',
        required: true,
        referencesTable: 'form_builder_integrations',
      },
      {
        column: 'submission_id',
        required: false,
        referencesTable: 'form_builder_submissions',
      },
    ],
    configReferences: [],
    jsonColumns: [],
    regenerateColumns: [],
  },
  wiki_pages: {
    table: 'wiki_pages',
    tenantColumn: 'organization_id',
    spaceColumn: 'space_id',
    rowReferences: [
      /**
       * Self-referencing, exactly like `tasks.parent_task_id`, and it depends on the same pre-scan.
       *
       * The writer runs `seedIds` over the whole table first when a spec has a reference that has
       * no type column and whose name starts with `parent` — `parent_id` matches, so wiki pages get
       * the pre-scan for free. Without it a child appearing before its parent in the archive would
       * have its parent quietly cleared and the page tree would flatten with nothing said.
       */
      { column: 'parent_id', required: false, referencesTable: 'wiki_pages' },
      // Nullable, and points at `ai_generated_content` — a table with no spec here, so its ids are
      // never minted and this always clears. Listed anyway so the clearing is counted and reported
      // rather than being an FK failure at insert time.
      {
        column: 'ai_generation_id',
        required: false,
        referencesTable: 'ai_generated_content',
      },
      // The wiki tree's link row for a board. Remapped to the board's new id when `whiteboards` is
      // in the run (inserted at level 3, before this table). Otherwise nulled like any optional
      // reference, and the row lands as an ordinary page: the composite FK would reject it, and
      // pointing at a board in the source space is exactly what that FK forbids.
      {
        column: 'whiteboard_id',
        required: false,
        referencesTable: 'whiteboards',
      },
    ],
    /**
     * `category_id` points at `space_categories`, which is space-scoped.
     *
     * Treated as configuration rather than as a carried row because that is what it is: the
     * destination space has its own categories, with its own ids, and matching them is a natural-key
     * decision made upstream in `buildRemapPlan`. Until it makes one there is no entry for this
     * column and `onMissing: 'null'` clears it — a page arriving uncategorised, counted, instead of
     * a page filed under a category belonging to the space it was taken from.
     */
    configReferences: [{ column: 'category_id', onMissing: 'null' }],
    // `metadata` is free-form. `tags` holds labels rather than ids, and is walked only because a
    // walk that replaces nothing costs nothing while a tag that did hold an id would otherwise
    // survive as a pointer into the source space.
    //
    // `content` is deliberately absent. It is TEXT holding HTML, so a page id inside a link is a
    // substring of a document, never a value the map can match — rewriting it would mean pattern
    // matching inside prose, which is the guess this module refuses to make everywhere else. Links
    // between restored pages therefore still address the originals.
    jsonColumns: ['metadata', 'tags'],
    /**
     * `path` is the ancestor chain as `text[]` of PAGE IDS — `ARRAY[NEW.id::TEXT]` at the root.
     *
     * Nulled rather than rewritten because `wiki_pages_path` is a BEFORE INSERT OR UPDATE trigger
     * that assigns `NEW.path` unconditionally from `NEW.id` and the parent's stored path, so
     * whatever arrives is overwritten regardless. Sending null makes that explicit and means the
     * archived chain of SOURCE ids cannot survive by accident if the trigger is ever narrowed to
     * UPDATE. `level` is left alone: the same trigger derives it, and it holds a depth, not an id.
     */
    regenerateColumns: ['path'],
  },
};

/** Everything the rewrite needs that had to be looked up in the database first. */
/**
 * Columns cleared on a re-scope so the destination's own trigger reissues them.
 *
 * Only for keys a trigger will actually regenerate. Both of these fire `IF ... IS NULL`, so a
 * restore that copies the archived key through leaves the trigger silent and the key colliding:
 * `idx_boards_key_unique (space_id, board_key)` and `idx_business_processes_key
 * (organization_id, key)` are partial unique indexes that a fresh row id does nothing to satisfy.
 * `tasks.key` is the same idea and is already handled by its hand-written spec.
 */
const REGENERATE_ON_RESCOPE: Record<string, string[]> = {
  boards: ['board_key'],
  business_processes: ['key'],

  // `UNIQUE (organization_id, schema_id, object_key)` — no space in it. Re-scoping an asset object
  // into another space of the SAME organization therefore lands on the original's key and the row
  // was skipped as a duplicate, which is the one outcome a restore must not produce for a row the
  // destination space does not have.
  //
  // `generate_asset_object_key` returns early when a key is supplied ("caller supplied an explicit
  // key (import path)"), so carrying it also meant the destination never got to number the row.
  // Stripped here, the trigger issues one from the schema's prefix and its own counter — and that
  // counter now self-heals, so the number it picks cannot collide either.
  asset_objects: ['object_key'],

  // `UNIQUE (space_id, key_number)`. Cleared so `tm_assign_key` issues the destination space's next key.
  test_preconditions: ['key', 'key_number'],
};

/**
 * Encrypted credentials, cleared when a row crosses into a different organization.
 *
 * These tables hold secrets that authenticate as somebody: a Stripe key that can take payments, a
 * webhook signing secret, an integration's endpoint credential. Copying one into another tenant is
 * a decision for a person, not a side effect of choosing a destination organization in a restore
 * dialog — so the row moves and the secret does not. The endpoint arrives inert and someone with
 * the authority to hold that credential enters it again.
 *
 * Cleared ONLY on a cross-organization move. Between spaces of the same organization the secret has
 * not left the tenant that owns it, and wiping it would break a working integration for no gain.
 *
 * `form_builder_webhooks` and `form_builder_integrations` were previously kept out of re-scoping
 * altogether for this reason, which also meant their 119 delivery rows could never be restored.
 * `form_builder_payment_configs` was never excluded at all — it simply had no spec, so nothing had
 * ever looked at it. Deriving specs from the schema made all three movable at once, and this is what
 * keeps that from moving the credentials with them.
 */
const SECRET_COLUMNS: Record<string, string[]> = {
  form_builder_payment_configs: [
    'secret_encrypted',
    'secret_iv',
    'secret_tag',
    'webhook_secret_encrypted',
    'webhook_secret_iv',
    'webhook_secret_tag',
  ],
  form_builder_webhooks: ['secret_encrypted', 'secret_iv', 'secret_tag'],
  form_builder_integrations: ['secret_encrypted', 'secret_iv', 'secret_tag'],

  // Every column below is nullable, or NOT NULL with a default that mints a fresh value —
  // `site_studio_domains.verification_token` defaults to `encode(gen_random_bytes(16),'hex')`, so
  // omitting it hands the destination a new token rather than the source tenant's. That property is
  // what makes a column safe to list here at all; see MANDATORY_SECRET_TABLES for the ones that
  // fail it.
  automations: [
    'webhook_secret_encrypted',
    'webhook_secret_iv',
    'webhook_secret_tag',
    'webhook_token',
  ],

  // A share link and its password are addressed to people in the tenant that made them. Carried
  // across, the same URL would keep working against somebody else's files.
  fe_shares: ['password_hash', 'token'],
  site_studio_domains: ['verification_token'],

  // Not a credential, but a lease: a lock held by the source tenant's worker means nothing in the
  // destination, and copying it would import a workflow that is already locked by nobody.
  workflows: ['lock_token'],

  // CI secrets of an automation setting: the setting moves, the secrets are entered again.
  test_automation_configs: ['secrets_enc', 'ci_headers_enc'],
};

/**
 * Tables whose secret is NOT NULL with no default, so it cannot be cleared on the way across.
 *
 * `SECRET_COLUMNS` works by leaving the column out of the insert and letting the destination supply
 * its own. That only works where the column is nullable or defaulted. These four are neither —
 * `ai_provider_configs.encrypted_api_key`, `automation_connections.encrypted_secret`,
 * `automation_oauth_states.state_token` and `migration_connections.encrypted_secret` are all
 * `NOT NULL` with no default, so omitting them fails every row with a not-null violation.
 *
 * The alternative — writing a placeholder — is worse than not moving the row. A string that is not
 * a valid ciphertext still looks like a configured credential: the destination shows a connected
 * integration that fails at the first call, and the failure surfaces far from this decision.
 *
 * So they do not cross. The row stays in the tenant that owns the credential, the picker withholds
 * the table with the ordinary cross-organization reason, and the approval gate refuses it — which
 * is the same treatment `spaces` and `partner_document_sequences` already get for their own
 * reasons.
 *
 * Cross-organization ONLY. Between spaces of the same organization the secret has not left the
 * tenant that owns it, so these tables re-scope normally.
 */
const MANDATORY_SECRET_TABLES = [
  'ai_provider_configs',
  'automation_connections',
  'automation_oauth_states',
  'ci_servers',
  'migration_connections',
  'test_management_api_keys',
  'test_management_api_tokens',
] as const;

/**
 * Restorable tables that are never re-keyed — not into another space, not into another tenant.
 *
 * Both were previously withheld as a SIDE EFFECT of `IDENTITY_COLUMN_TABLES` sitting in the early
 * returns below. That list is now empty — `20260813140000_restore_identity_columns.sql` moved both
 * columns to GENERATED BY DEFAULT so their archived values write back — and emptying it would have
 * silently handed both tables a remap spec, put them into `CROSS_ORG_SUPPORTED_TABLES`, and offered
 * an approval for a move neither should make. Stated here on its own terms so the guard survives the
 * list that used to imply it, and holding the SAME shape it had before: unconditional, so a restore
 * puts these rows back where they came from or not at all.
 *
 * Now holds one table, for the one reason that is structural:
 *
 *  - `migration_logs` CANNOT be re-keyed. Its primary key is `bigint` and re-keying mints a uuid — a
 *    structural impossibility, not a policy. Verified against `information_schema.columns`.
 *
 * `support_requests` was here too and has been removed deliberately. Both halves of its stated
 * rationale were checked and neither survives:
 *
 *  - The technical half named `support_requests_org_ticket_uidx`. **That index does not exist** —
 *    the only unique index on the table is the primary key on `id`. There is no collision to avoid,
 *    and `ticket_number` is now stripped as a generated column (`GENERATED_COLUMNS` in
 *    restore-planner.ts) so the destination assigns a fresh one.
 *  - The policy half — that a ticket records a conversation with a named person about one tenant's
 *    incident, and carrying it across is a disclosure its author never agreed to — was a real
 *    product decision, and it has been reversed by the product owner rather than overlooked.
 *    Restoring an archive into another organization now carries its tickets with it.
 *
 * Restoring these tables IN PLACE is unaffected: a plain same-organization restore carries no remap
 * at all and never reaches this function.
 */
const NEVER_REKEYED_TABLES = ['migration_logs'] as const;

/**
 * Polymorphic references the FK graph cannot see, ADDED to a derived spec rather than replacing it.
 *
 * `entity_id` is paired with `entity_type` and carries no foreign key, so `fkEdgesFor` returns
 * nothing for it and the derived spec left it alone. A re-scoped attachment therefore kept the id of
 * the entity it hung off in the SOURCE space. That is not merely a stale pointer: neither table
 * scopes its unique key, so
 *
 *     file_attachments_entity_filename_unique  UNIQUE (entity_type, entity_id, file_name)
 *     entity_file_links_entity_node_unique     UNIQUE (entity_type, entity_id, node_id)
 *
 * matched the source space's own row, Postgres answered 23505, and the writer classified it
 * `duplicate` — so a restore into a destination space holding nothing at all reported every
 * attachment as "already present" and finished green. The rows were lost and the report said they
 * had been left alone deliberately.
 *
 * MERGED INTO the derived spec, never a hand-written one. `remapSpecFor` returns
 * `CROSS_ORG_REMAP_SPECS[table]` whole and early, so a hand-written entry here would REPLACE the
 * derived spec and silently drop what the FK graph already supplies — `current_version_id` for
 * `file_attachments`, `node_id` for `entity_file_links`. Additive is the only shape that keeps both.
 *
 * The maps differ, and are the CHECK constraints' own members rather than a guess: `file_attachments`
 * admits `gdpr_record` and not `asset_object`, `entity_file_links` the reverse. A type absent from the
 * map resolves to no table and takes the same path as a target outside the run — see `remapReference`.
 * `LOGICAL_DEPENDENCIES` in `restore-planner.ts` must name these same tables, or the ordering that
 * makes the mapping available has nothing to do with the mapping being asked for.
 */
const POLYMORPHIC_REFERENCES: Record<string, RowReferenceSpec[]> = {
  file_attachments: [
    {
      column: 'entity_id',
      required: true,
      typeColumn: 'entity_type',
      typeToTable: {
        task: 'tasks',
        process: 'business_processes',
        wiki_page: 'wiki_pages',
        asset_item: 'asset_items',
        gdpr_record: 'gdpr_records',
        space_gdpr_record: 'space_gdpr_records',
        support_request: 'support_requests',
        test_case: 'test_cases',
        test_run_attempt: 'test_run_attempts',
        test_execution: 'test_executions',
      },
    },
  ],
  entity_file_links: [
    {
      column: 'entity_id',
      required: true,
      typeColumn: 'entity_type',
      typeToTable: {
        task: 'tasks',
        process: 'business_processes',
        wiki_page: 'wiki_pages',
        asset_item: 'asset_items',
        asset_object: 'asset_objects',
        space_gdpr_record: 'space_gdpr_records',
        support_request: 'support_requests',
        test_case: 'test_cases',
        test_run_attempt: 'test_run_attempts',
        test_execution: 'test_executions',
      },
    },
  ],
};

/** Id lists and jsonb that no foreign key describes, rewritten with `remapJson` on a re-scope. */
const DERIVED_JSON_COLUMNS: Record<string, string[]> = {
  // A test case lists its preconditions by id.
  test_cases: ['precondition_ids'],
  // The case as it was when the attempt ran, including its linked preconditions.
  test_run_attempts: ['snapshot'],
  // The setting as it was when the run started, and the cases its result names.
  test_automation_runs: ['config_snapshot', 'result_summary'],
};

/** jsonb objects keyed by row id, whose keys are rewritten too. */
const JSON_KEY_COLUMNS: Record<string, string[]> = {
  test_run_attempts: ['precondition_results'],
};

/** Globally unique values with no default, given a fresh value whenever the row moves. */
const REMINT_ON_RESCOPE: Record<string, string[]> = {
  // `UNIQUE (request_id)` across all organizations, so a copy would collide with its original.
  test_automation_runs: ['request_id'],
};

/**
 * How to rewrite one table's rows for a different space or tenant.
 *
 * Hand-written specs win, because they carry what a foreign key cannot express: polymorphic
 * references, ids buried in jsonb, and configuration lookups. Everything else is DERIVED from the
 * generated FK graph, which is the whole point — a hand-maintained list of thirteen tables meant
 * that `form_builder` could be restored into another space while the fields, webhooks and
 * integrations belonging to it were refused one row at a time as `other_space`. A table is now
 * movable because the schema says where its references point, not because somebody remembered it.
 *
 * @param crossOrganization Whether the rows are also changing tenant. It decides which tables may
 *   be re-keyed at all: moving to another organization means every archived id belongs to somebody
 *   else, so everything must be rewritten. Moving between spaces of the SAME organization is
 *   narrower — only rows that actually live in a space need new ids. Re-keying an organization-level
 *   row there would write a second copy of something that is already correct and already shared.
 * @param recreateSpaces Whether the run is RECREATING the archived spaces in the destination rather
 *   than folding every source space onto one the operator chose. Only ever true alongside
 *   `crossOrganization`. It changes two things and nothing else: `spaces` becomes re-keyable, and
 *   references INTO `spaces` are resolved through that re-keying instead of being overwritten from
 *   the plan. Defaulted to false so every existing caller keeps the folding answer verbatim.
 * @returns The spec, or undefined when this table must not be re-keyed for this kind of move.
 */
export function remapSpecFor(
  table: string,
  entry: Pick<ComponentTable, 'tenantColumn' | 'spaceScope'>,
  crossOrganization: boolean,
  recreateSpaces = false,
): TableRemapSpec | undefined {
  const explicit = CROSS_ORG_REMAP_SPECS[table];

  if (explicit) {
    return explicit;
  }

  const spaceScope = entry.spaceScope;

  // `spaces` itself. Folding a restore onto a chosen destination space must never re-key it: the
  // operator picked a space that already exists, and every row being moved is on its way into it, so
  // minting a new SPACE id is the one outcome that cannot be right. `refuseUnmovableRow` also rejects
  // `self` before a row reaches this machinery, but relying on that leaves the invariant stated in a
  // different file that merely happens to run first.
  //
  // Recreating is the opposite request and needs the opposite answer. There is no chosen space, so
  // nothing is being folded onto anything: the archived spaces are being minted in the destination
  // and every space-scoped row follows its own space across. Re-keying is then mandatory rather than
  // forbidden — the archived space id belongs to the source tenant, and writing it verbatim would
  // point the destination's rows at another organization's space.
  if (spaceScope.kind === 'self' && !recreateSpaces) {
    return undefined;
  }

  // Three separate reasons a table is never carried into a different space, kept together because
  // the answer is the same and splitting the check would let one of them be forgotten.
  //
  //  - SEQUENCE_PRIMARY_KEY_TABLES: now EMPTY, and kept in the check rather than removed from it so
  //    a future member is refused without anyone having to remember to re-add the guard. It held
  //    `automation_event_outbox`, which has moved to `SEQUENCE_REKEYED_TABLES`: its key is a plain
  //    sequence the destination can reissue, and the hazard that justified refusing it — an
  //    unrelayed row firing the destination space's automations — is neutralised on the row instead,
  //    by guaranteeing `relayed_at` is non-null. The registry docblock has the full account.
  //  - UNMOVABLE_PRIMARY_KEY_TABLES: no surrogate key exists to reissue.
  //  - IDENTITY_COLUMN_TABLES: GENERATED ALWAYS, so PostgREST cannot write the key at all. Load
  //    bearing here, not merely tidy: `migration_logs` has a `tenantColumn`, so without this guard it
  //    clears every remaining check below and starts returning a spec — which would silently add it
  //    to `CROSS_ORG_SUPPORTED_TABLES` (derived from this function in `restore-approvals.service.ts`)
  //    and offer an approval for a table whose every insert answers `428C9`.
  if (
    (SEQUENCE_PRIMARY_KEY_TABLES as readonly string[]).includes(table) ||
    (UNMOVABLE_PRIMARY_KEY_TABLES as readonly string[]).includes(table) ||
    (IDENTITY_COLUMN_TABLES as readonly string[]).includes(table) ||
    (NEVER_REKEYED_TABLES as readonly string[]).includes(table)
  ) {
    return undefined;
  }

  // A credential that cannot be left behind means the row cannot go. Cross-organization only: the
  // same table re-scopes freely between spaces of the tenant that already owns the secret. See
  // MANDATORY_SECRET_TABLES for why a placeholder is not an option.
  if (
    crossOrganization &&
    (MANDATORY_SECRET_TABLES as readonly string[]).includes(table)
  ) {
    return undefined;
  }

  const livesInASpace = spaceScope.kind !== 'organization';

  if (!crossOrganization && !livesInASpace) {
    return undefined;
  }

  // Genuinely global: no tenant column AND no space. Nothing about a destination makes its ids
  // wrong, so re-keying one would manufacture a duplicate of a row everybody shares.
  //
  // A table with no tenant column that DOES live in a space is a different thing entirely, and
  // refusing it here was wrong. `automation_versions` is exactly that — its tenancy comes through
  // the automation it belongs to rather than a column of its own — and it was refused `other_space`,
  // which then cascaded: all 95 `automation_runs` were dropped as `unmapped_reference` because the
  // versions they require had never been given ids. One guard, 108 rows.
  if (!entry.tenantColumn && !livesInASpace) {
    return undefined;
  }

  const spaceColumn = spaceScope.kind === 'own' ? spaceScope.column : undefined;

  const rowReferences: RowReferenceSpec[] = fkEdgesFor(table)
    .filter((edge) => {
      // The table's OWN space column, in BOTH modes, because neither mode resolves it from an edge.
      // Folding assigns it from the plan; recreating resolves it in `remapRow` against the spaces
      // this run minted.
      //
      // Deliberately not left to the FK graph even when recreating, which would look tidier. Five
      // live tables carry a space column with NO foreign key to `spaces` — `form_builder_versions`,
      // `form_builder_payment_configs`, `asset_object_key_sequences`, `workflow_trigger_events` and
      // an old `space_members` backup — three of them NOT NULL. A rule that only saw FK edges would
      // leave those holding the SOURCE tenant's space id, in the destination, with no constraint to
      // object and nothing in the report to notice.
      if (edge.column === spaceColumn) {
        return false;
      }

      // Other columns that name a space — `migration_jobs.target_space_id` and the like.
      //
      // Folding cannot move them: the destination space is CHOSEN rather than minted, `spaces` is
      // not in the run, and there is no mapping to resolve them against. `spaces` being itself a
      // restorable table is exactly why this has to be explicit — without it these edges look like
      // any other reference into the restore set.
      //
      // Recreating mints precisely that mapping, so they become ordinary references and are handled
      // by the same machinery as every other one, refusal semantics included.
      if (edge.references === 'spaces' && !recreateSpaces) {
        return false;
      }

      // The tenant: written from the plan, and already checked before we get here.
      if (edge.column === entry.tenantColumn) {
        return false;
      }

      // ONLY references to rows that live in a space.
      //
      // An unmapped row reference is nulled, and on a space move that is deliberate: a page keeping
      // a link to something left behind would point out of the space it was just restored into.
      // Organization-level rows are the opposite case — statuses, priorities, relation types and
      // custom fields are shared by every space in the tenant, so the row is still there and still
      // ours, and nulling it would quietly strip a task of its status while reporting success.
      //
      // The hand-written specs encode the same split by listing those columns under
      // `configReferences` instead. Deriving it from the target's own scope means a new table gets
      // the distinction without anyone having to notice it needs one.
      const target = tableEntry(edge.references);

      if (!target) {
        return false;
      }

      // The paragraph above is true of a SPACE MOVE and false of a change of tenant, so the split
      // has to be made here rather than assumed.
      //
      // "the row is still there and still ours" is what makes keeping an organization-level id
      // correct — and it holds only while the organization does not change. Cross-organization the
      // row belongs to the SOURCE tenant and a fresh copy is being minted in the destination, so
      // writing the archived id verbatim points the restored row at another tenant's data. For
      // most of these that is a wrong status or a missing filter; for `custom_roles` and
      // `user_groups` it is a GRANT pointing at another tenant's principal, which is the reason
      // this was found at all.
      //
      // Decided from `crossOrganization` alone, deliberately NOT by asking whether the target
      // itself gets a spec: `custom_roles` and `user_groups` reference each other, so that
      // question recurses.
      if (crossOrganization) {
        return true;
      }

      return target.spaceScope.kind !== 'organization';
    })
    .map((edge) => ({
      column: edge.column,
      required: edge.required,
      referencesTable: edge.references,
    }));

  return {
    table,
    tenantColumn: entry.tenantColumn ?? undefined,
    spaceColumn,

    // Appended, not substituted. The FK graph supplies what the database enforces; this supplies the
    // polymorphic columns it cannot see. A table with neither gets an empty tail and is unchanged.
    rowReferences: [...rowReferences, ...(POLYMORPHIC_REFERENCES[table] ?? [])],

    // Derived tables get the lenient rule: a target this run is not writing still answers to the id
    // the archive recorded, so keeping it beats discarding the row. Hand-written specs do not opt
    // in — see the field's docblock for the three where keeping it would be actively wrong.
    keepReferencesOutsideRun: true,

    // Neither can be derived from a foreign key: a configuration lookup needs to know what counts
    // as the same setting in the destination, and a jsonb column needs to know which of its values
    // are ids at all. A table that needs either still needs a hand-written spec.
    configReferences: [],
    jsonColumns: DERIVED_JSON_COLUMNS[table] ?? [],

    // Secrets only on the way out of the tenant that owns them. `regenerateColumns` is the right
    // mechanism because it means exactly this — write the row without these columns and let the
    // destination supply its own — and it already runs before any reference is resolved.
    regenerateColumns: [
      ...(REGENERATE_ON_RESCOPE[table] ?? []),
      ...(crossOrganization ? (SECRET_COLUMNS[table] ?? []) : []),
    ],
  };
}

/**
 * Every table the engine can rewrite into a different organization.
 *
 * The single source of truth for "can this cross a tenant boundary", with two consumers that must
 * never disagree: the approval gate in `restore-approvals.service.ts`, which refuses a request
 * naming anything outside this set, and the component tree served to the restore picker, which uses
 * it to decide what to offer.
 *
 * That pairing is the whole point. The gate was once a hand-kept copy of thirteen spec names and did
 * not follow the engine when it began deriving specs from the schema, so `form_builder_fields` was
 * refused by a rule that no longer described what the engine could do. The picker then repeated the
 * mistake one layer up with a four-name literal, which is how a restore into another organization
 * came to hide forty-nine of fifty-two areas. Both now read this.
 *
 * Computed once at module load. `remapSpecFor` walks the foreign-key graph per table, so deriving
 * this per request would do that 185 times for an answer that cannot change without a deploy.
 */
const CROSS_ORG_RESTORABLE = new Set(
  COMPONENT_REGISTRY.filter((entry) =>
    remapSpecFor(entry.table, entry, true),
  ).map((entry) => entry.table),
);

/**
 * The same question asked of a run that RECREATES the archived spaces.
 *
 * A superset of its sibling, and today by exactly one member: `spaces`. Computed rather than written
 * as `new Set([...CROSS_ORG_RESTORABLE, 'spaces'])` so it keeps answering correctly if a second
 * `self`-scoped table is ever added — the derivation is the contract, a hand-listed member is a copy
 * that goes stale, and this file already carries the scars of both.
 *
 * Built at module load beside the other for the same stated reason: `remapSpecFor` walks the FK graph
 * per table, so deriving either per request would repeat that work for an answer fixed at deploy.
 */
const CROSS_ORG_RESTORABLE_RECREATING = new Set(
  COMPONENT_REGISTRY.filter((entry) =>
    remapSpecFor(entry.table, entry, true, true),
  ).map((entry) => entry.table),
);

/**
 * @param recreateSpaces Whether the run mints the archived spaces in the destination instead of
 *   folding onto a chosen one. Defaulted to false so an existing caller gets the folding answer it
 *   already got — the approval gate and the picker must be asked with the SAME value, or one offers
 *   what the other refuses.
 * @see CROSS_ORG_RESTORABLE
 */
export function crossOrgRestorableTables(
  recreateSpaces = false,
): ReadonlySet<string> {
  return recreateSpaces
    ? CROSS_ORG_RESTORABLE_RECREATING
    : CROSS_ORG_RESTORABLE;
}

/**
 * The same question asked of a SPACE move: which tables are re-keyed when the tenant does not change.
 *
 * A strictly smaller set, and the difference is the point. Moving between spaces of one organization
 * only re-keys rows that live in a space; an organization-level table keeps its ids, because they are
 * already correct and already shared. `gdpr_records` is exactly that, and it is `restoreByDefault`.
 *
 * Needed because "is this table in the run" and "is this table being re-keyed" are not the same
 * question, and `remapReference` was only able to ask the first. `tablesInRun` holds every table the
 * run is writing, so a GDPR attachment naming a `gdpr_record` found the table present, no mapping —
 * there never is one — and, being a required reference, dropped the row. Asking whether the target is
 * re-keyed at all sends it down the branch that keeps the archived id, which for a table whose ids did
 * not move is the right answer and the only non-destructive one.
 *
 * Computed at module load beside its sibling, for the same reason: `remapSpecFor` walks the FK graph
 * per table, and doing that per ROW — once per attachment — would be the cost of the lookup times the
 * size of the table.
 */
const SPACE_MOVE_REKEYABLE = new Set(
  COMPONENT_REGISTRY.filter((entry) =>
    remapSpecFor(entry.table, entry, false),
  ).map((entry) => entry.table),
);

export interface RemapPlan {
  /** The organization the archive belongs to. A row from anywhere else is not ours to move. */
  archiveOrganizationId: string;
  targetOrganizationId: string;

  /**
   * The one space every space-scoped row lands in, or null when the run recreates the archived
   * spaces instead.
   *
   * Nullable rather than an empty string because the two states are answers to different questions
   * and the caller must not be able to conflate them: a space id means FOLD everything onto this,
   * null means each row follows its own space across. `''` would satisfy the type and write an empty
   * uuid into every `space_id`.
   */
  destinationSpaceId: string | null;

  /**
   * Whether the archived spaces are being minted in the destination.
   *
   * Always the inverse of `destinationSpaceId` being set, and stated separately anyway. Deriving it
   * at each use — `!plan.destinationSpaceId` — would put the definition of the mode in a dozen
   * places, which is how one of them ends up asking a subtly different question.
   *
   * Optional, and absent means FOLD. That direction is deliberate: the default is what every plan
   * built before this field existed meant, so a constructor that has not been taught about the mode
   * cannot accidentally opt into it. `buildRemapPlan` is the only one in production and sets it
   * explicitly.
   */
  recreateSpaces?: boolean;

  /** Column name → (source configuration id → destination configuration id). */
  config: Map<string, Map<string, string>>;
}

/** Old row id → new row id, accumulated across the run. */
export interface RemapState {
  ids: Map<string, string>;
  /**
   * Source ids an EARLIER restore already wrote into this destination space.
   *
   * Keyed `"<table> <sourceId>"` — the same composite the map's unique constraint uses, and NOT the
   * raw id that `ids` above is keyed by. The two key spaces are deliberately different: `ids` is the
   * within-run rename table, where an id is looked up without knowing which table it came from,
   * while this answers "has this row of this table already been written here".
   *
   * Without it the operation is not idempotent: re-running the same restore would mint a second set
   * of ids and write a second copy of every row, because the ids differ by construction and the
   * natural keys do not survive either — a task's `key` is regenerated for its new space, so
   * matching on it would find nothing.
   *
   * Empty for a cross-organization run, which has no such history to consult.
   */
  alreadyRestored: Map<string, string>;
  /**
   * Pairs this run minted AND actually inserted, waiting to be recorded.
   *
   * Filled only once a row has landed, never when it is merely prepared: recording a row that then
   * failed its insert would make the next run skip a row that is not there.
   */
  minted: { table: string; sourceId: string; destinationId: string }[];

  /**
   * Every table this run is actually writing.
   *
   * Decides what an unmapped reference MEANS. A target in here is being re-keyed, so no mapping is a
   * genuine problem — the row would otherwise be written pointing at the space it came from. A
   * target that is NOT in here is untouched by this restore and still sits in the database under the
   * id the archive recorded, so that id is the correct value to keep.
   *
   * Empty by default, which reproduces the older, stricter behaviour: with nothing known to be in
   * the run, every reference is treated as one that should have been mapped.
   */
  tablesInRun: Set<string>;
}

/**
 * The key `RemapState.alreadyRestored` and `restore_entity_map` agree on.
 *
 * Defined here rather than in the service so the engine does not have to reach back up a layer for
 * it, and so the two places that build it cannot drift — a mismatch is a lookup that never matches,
 * which turns every repeat restore back into a duplicating one without failing anything.
 *
 * ` ` cannot occur in a table name or in a uuid, so the composite cannot collide.
 */
export function entityMapKey(table: string, sourceId: string): string {
  return `${table} ${sourceId}`;
}

/**
 * @param alreadyRestored Keyed `"<table> <sourceId>"`. NOT copied into `ids`, which is keyed by the
 *   raw id — seeding one from the other would put composite keys into the rename table, where every
 *   lookup would miss and every already-restored row would be minted a second identity.
 */
export function createRemapState(
  alreadyRestored: Map<string, string> = new Map(),
  tablesInRun: Set<string> = new Set(),
): RemapState {
  return { ids: new Map(), alreadyRestored, minted: [], tablesInRun };
}

/**
 * Mints a new id for an archived row, or returns the one already minted.
 *
 * Called twice for the same row — once by the pre-scan, once while writing — and must answer the
 * same thing both times, or a child would be repointed at an id its parent never received.
 */
export function mapId(oldId: string, state: RemapState): string {
  const existing = state.ids.get(oldId);

  if (existing) {
    return existing;
  }

  const minted = randomUUID();

  state.ids.set(oldId, minted);

  return minted;
}

/**
 * Reads a table's ids before any of it is written.
 *
 * The reason `tasks` needs this is `parent_task_id`: the archive is a file in whatever order it was
 * written, so a child can precede its parent. Deliberately NOT solved by inserting with a null
 * parent and updating afterwards — an UPDATE on `tasks` fires `tasks_history_trigger`, which is
 * `AFTER INSERT OR UPDATE`, and would manufacture a history row per restored task.
 */
export function seedIds(rows: unknown[], state: RemapState): void {
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }

    const id = (row as Record<string, unknown>).id;

    if (typeof id === 'string' && id) {
      mapId(id, state);
    }
  }
}

/** A value as a comparable string, or null when it is not a scalar. */
function scalarString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Rewrites every id in one archived row so it belongs to the destination.
 *
 * @returns The row to insert, or the reason it cannot be moved. Never throws — a refusal is data.
 */
export function remapRow(
  source: Record<string, unknown>,
  spec: TableRemapSpec,
  plan: RemapPlan,
  state: RemapState,
): RemapOutcome {
  const row: Record<string, unknown> = { ...source };
  const clearedColumns: string[] = [];

  // The row's own identity. Already minted by the pre-scan for `tasks`; minted here for the rest.
  const ownId = scalarString(row.id);

  if (ownId) {
    row.id = mapId(ownId, state);
  }

  // Only where the table has one. A space-scoped table without a tenant column inherits its tenancy
  // from the row it belongs to, and inventing a column here would write a field that does not exist.
  if (spec.tenantColumn) {
    row[spec.tenantColumn] = plan.targetOrganizationId;
  }

  if (spec.spaceColumn) {
    if (!plan.recreateSpaces) {
      // Folding. The operator chose one destination and every space-scoped row goes there.
      row[spec.spaceColumn] = plan.destinationSpaceId;
    } else {
      const archivedSpace = scalarString(row[spec.spaceColumn]);

      // A NULL space column is not a missing answer, it is a different KIND of row: fifteen
      // space-scoped tables allow it and it means the row belongs to the whole organization — a
      // shared task status, an org-wide custom field. Those are not in any space, so no space is
      // minted for them and the column is left exactly as it is. Overwriting it would confine a
      // tenant-wide default to one recreated space.
      if (archivedSpace) {
        const recreated = state.ids.get(archivedSpace);

        // `state.ids.get`, never `mapId`. Minting here would invent an id for a space this run is
        // not writing, and every row of that space would then be inserted pointing at a space that
        // does not exist — a foreign key violation for the 90-odd tables that have one, and silent
        // corruption for the five that do not.
        //
        // Reachable when `spaces` was deselected, or when its own row was refused. The planner makes
        // the first case hard to arrive at, and this is the backstop for both.
        if (!recreated) {
          return {
            kind: 'skip',
            reason: 'unmapped_reference',
            referencesTable: 'spaces',
            detail:
              `${spec.spaceColumn} names a space this restore did not recreate, so there is nowhere ` +
              'in the destination organization to put this row. Include Spaces in the selection.',
          };
        }

        row[spec.spaceColumn] = recreated;
      }
    }
  }

  for (const column of spec.regenerateColumns) {
    row[column] = null;
  }

  for (const reference of spec.rowReferences) {
    const outcome = remapReference(
      row,
      reference,
      state,
      plan.archiveOrganizationId !== plan.targetOrganizationId,

      // A reference may keep its archived id only when the SPEC allows it and the row is itself
      // being re-scoped. Both are explained on `remapReference`'s parameter.
      Boolean(spec.keepReferencesOutsideRun) && Boolean(spec.spaceColumn),
    );

    if (outcome.kind === 'skip') {
      return outcome;
    }

    if (outcome.cleared) {
      clearedColumns.push(reference.column);
    }
  }

  for (const reference of spec.configReferences) {
    const value = scalarString(row[reference.column]);

    if (!value) {
      continue;
    }

    const mapped = plan.config.get(reference.column)?.get(value);

    if (mapped) {
      row[reference.column] = mapped;
      continue;
    }

    if (reference.onMissing === 'skip') {
      return {
        kind: 'skip',
        reason: 'unmatched_config',
        detail:
          `${reference.column} names something that does not exist in the destination organization ` +
          'and could not be created there, so this row was not restored.',
      };
    }

    // Cleared rather than left pointing at the source organization's row, which is the
    // cross-tenant reference this whole path exists to prevent.
    row[reference.column] = null;
    clearedColumns.push(reference.column);
  }

  for (const column of spec.jsonColumns) {
    if (column in row) {
      row[column] = remapJson(row[column], state);
    }
  }

  for (const column of JSON_KEY_COLUMNS[spec.table] ?? []) {
    if (column in row) {
      row[column] = remapJsonKeys(row[column], state);
    }
  }

  for (const column of REMINT_ON_RESCOPE[spec.table] ?? []) {
    const value = scalarString(row[column]);

    if (value) {
      row[column] = mapId(value, state);
    }
  }

  return { kind: 'insert', row, clearedColumns };
}

/**
 * Repoints one reference at the row's new id.
 *
 * A polymorphic reference is only ours when its type column says so. Anything else — a wiki page,
 * an asset item — is a row this restore is not carrying, so there is no new id to point at and the
 * old one belongs to the source tenant. Refused rather than carried across.
 */
function remapReference(
  row: Record<string, unknown>,
  reference: RowReferenceSpec,
  state: RemapState,
  crossOrganization: boolean,

  /**
   * Whether a REQUIRED reference whose target is outside this run may keep its archived id.
   *
   * Two things have to hold, and the caller ands them together:
   *
   *  - the spec opts in (`keepReferencesOutsideRun`) — hand-written specs do not, because for three
   *    of them the whole point is to refuse rather than point at the source space;
   *  - the table carries its own space column, so `remapRow` is moving the row into the destination.
   *    A table scoped THROUGH its parent has no space of its own, so keeping the parent id files the
   *    row straight back under the SOURCE parent — not a preserved link but a duplicate, written
   *    with a fresh id and nothing to recognise it by. 37 tables are scoped that way, including
   *    `task_comments` and `task_history`.
   */
  mayKeepOutsideRun: boolean,
): { kind: 'ok'; cleared: boolean } | RemapSkip {
  const value = scalarString(row[reference.column]);

  if (!value) {
    return { kind: 'ok', cleared: false };
  }

  /**
   * Which table this particular ROW points at.
   *
   * Static for an ordinary reference, because a foreign key names one table. A polymorphic column
   * carrying `typeToTable` names a different one per row, and resolving it here is what lets the two
   * lookups below work at all: the composite `alreadyRestored` key needs a table name, and so does
   * the question of whether this run is re-keying the target.
   */
  let referencesTable = reference.referencesTable;

  if (reference.typeColumn) {
    const type = scalarString(row[reference.typeColumn]);

    if (reference.typeToTable) {
      // An unrecognised type resolves to no table and falls through to the branches below, which
      // treat it exactly as a target this run is not touching: keep the archived id within one
      // tenant, refuse it across tenants. Unreachable while the CHECK constraints hold — stated so
      // that a type added to the database ahead of this map degrades instead of misbehaving.
      referencesTable = type ? reference.typeToTable[type] : undefined;
    } else {
      const mappable = reference.mappableTypes ?? [];

      if (!type || !mappable.includes(type)) {
        return {
          kind: 'skip',
          reason: 'unsupported_reference_type',
          detail:
            `${reference.column} points at a ${type ?? 'unknown'}, which this restore is not ` +
            'carrying, so the reference cannot be moved to the other organization.',
        };
      }
    }
  }

  // This run's rename table first, then what an EARLIER attempt already wrote.
  //
  // The second lookup is what makes a restore resumable. `state.ids` only holds rows this attempt
  // minted, so after an interrupted restore is picked up again, a child whose parent landed in the
  // previous attempt finds nothing here — and the two branches below then either drop the row
  // (`unmapped_reference`, for a required reference) or silently null the link (for an optional
  // one). Neither announces itself as data loss, and both are wrong: the parent is present in the
  // destination, under the id the entity map recorded when it was written.
  //
  // Looked up POINT-WISE rather than by merging `alreadyRestored` into `ids`. The two are keyed
  // differently on purpose — `ids` by the raw source id, this by `"<table> <sourceId>"` — and
  // `createRemapState`'s contract spells out what merging them would cost: composite keys in the
  // rename table, where every lookup misses and every already-restored row is minted a SECOND
  // identity. That is the duplicate this map exists to prevent. Building the composite key here
  // keeps both key spaces intact.
  //
  // Only possible when the reference names its table, which is exactly when the composite key can
  // be built. A polymorphic reference resolved above already carries its concrete table.
  const mapped =
    state.ids.get(value) ??
    (referencesTable
      ? state.alreadyRestored.get(entityMapKey(referencesTable, value))
      : undefined);

  if (mapped) {
    row[reference.column] = mapped;

    return { kind: 'ok', cleared: false };
  }

  // Nothing minted an id for this target. That is only a fault when the target is one this run is
  // re-keying — otherwise the row it names was never moved, and still answers to the id the archive
  // recorded.
  //
  // The two cases produced the same refusal, and it cost 103 rows on a real restore:
  // `automation_runs.automation_id` and `automation_event_subscriptions.automation_id` point at
  // `automations`, which was not in the archive because it sits in a different component and scheme
  // selection is stored exactly as ticked. The automations themselves were never deleted — all of
  // them were still in the database, in the space the rows came from — so keeping the archived id
  // satisfies the foreign key and the rows land.
  //
  // A polymorphic reference has to ask a second question, and the difference is not academic. Being
  // IN the run does not mean being RE-KEYED by it: `gdpr_records` is organization-level, so a move
  // between spaces of one tenant leaves its ids exactly as they are, while `tablesInRun` still lists
  // it. A GDPR attachment then found its target present, found no mapping — there is never going to
  // be one — and, being a required reference, was dropped. Asking whether the target is re-keyed at
  // all routes it to the branch below that keeps the archived id, which for ids that did not move is
  // both correct and the only choice that does not destroy the row.
  //
  // Asked ONLY of polymorphic references. A derived reference is already filtered to space-scoped
  // targets when the spec is built, so the two questions have the same answer there, and widening the
  // test would change a path every other table depends on for no gain here.
  const targetOutsideRun = reference.typeToTable
    ? !referencesTable ||
      !state.tablesInRun.has(referencesTable) ||
      !(crossOrganization ? CROSS_ORG_RESTORABLE : SPACE_MOVE_REKEYABLE).has(
        referencesTable,
      )
    : Boolean(referencesTable && !state.tablesInRun.has(referencesTable));

  if (reference.required) {
    // Same organization, and the row it points at is not moving: keep the reference. The only
    // alternative is discarding the row, and a valid reference beats no row at all.
    //
    // Cross-organization is the opposite: the id belongs to the source tenant, nothing in the
    // destination answers to it, and keeping it would either violate the constraint or — worse —
    // match an unrelated row that happens to share the id.
    //
    // And only for a row that is itself being re-scoped. `rescopesItself` is the difference between
    // "this row moves into the destination space and keeps a link to something left behind" — the
    // documented concession that recovered 95 `automation_runs` — and "this row has no space of its
    // own, so keeping its parent id files it right back under the SOURCE parent". The second is not
    // a preserved link, it is a duplicate: restore `task_comments` without `tasks` and every comment
    // is written a second time onto the space being restored FROM, with a new id and nothing to
    // recognise it by. 37 tables are scoped that way.
    if (targetOutsideRun && !crossOrganization && mayKeepOutsideRun) {
      return { kind: 'ok', cleared: false };
    }

    return {
      kind: 'skip',
      reason: 'unmapped_reference',

      // Resolved above, and for a polymorphic column resolved from THIS row's type rather than from
      // the schema. Reported so the run can say which component was missing instead of leaving the
      // operator to infer it from a column name.
      referencesTable,
      detail:
        `${reference.column} refers to a row that is not part of this restore, and the row cannot ` +
        'exist without it.',
    };
  }

  // Optional references are deliberately NOT given the same treatment. Clearing one costs a link;
  // clearing a required one is impossible, which is why the branch above exists at all. A page that
  // kept an optional link to something left behind would point out of the space it was just restored
  // into — the behaviour the space-move tests pin.

  // A parent that is genuinely absent from the archive. The row becomes top-level in the
  // destination, which is reported rather than left for someone to notice.
  row[reference.column] = null;

  return { kind: 'ok', cleared: true };
}

/**
 * Replaces ids buried inside a jsonb value.
 *
 * Sampled shapes this has to survive: `{"assign_users": ["<user uuid>"]}` on
 * `tasks.custom_field_values`, where the key is whatever a custom field was called, and
 * `{"id": "<task uuid>", "key": "NEWSPACE-T93", …}` on `task_history.new_value`.
 *
 * Only strings the map knows are replaced. The `key` above is display text describing what a field
 * used to hold, not a reference, and rewriting free text would be a guess.
 */
export function remapJson(value: unknown, state: RemapState): unknown {
  if (typeof value === 'string') {
    return state.ids.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => remapJson(entry, state));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = remapJson(entry, state);
    }

    return out;
  }

  return value;
}

/** `remapJson` for an object keyed by row id: keys and values both move. Anything else is unchanged. */
export function remapJsonKeys(value: unknown, state: RemapState): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[state.ids.get(key) ?? key] = remapJson(entry, state);
  }

  return out;
}

/**
 * Whether a row belongs to the archive's own organization.
 *
 * The tenant check cannot simply be dropped for a remapped run. An archive can contain a row that
 * was never the source organization's — a tampered file, or a bug upstream — and rewriting that to
 * the destination would move data nobody agreed to move. So the comparison changes target rather
 * than disappearing: against the ARCHIVE's organization, not the session's.
 */
export function belongsToArchiveOrganization(
  row: Record<string, unknown>,
  spec: TableRemapSpec,
  plan: RemapPlan,
): boolean {
  // No tenant column means the row cannot claim to be from anywhere, so there is nothing here to
  // disagree with. Its tenancy is enforced through the parent it points at, which is checked when
  // that reference is remapped.
  if (!spec.tenantColumn) {
    return true;
  }

  const value = scalarString(row[spec.tenantColumn]);

  return value !== null && value === plan.archiveOrganizationId;
}
