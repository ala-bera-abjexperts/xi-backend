/**
 * @fileoverview Locks the component registry against a snapshot of the live catalog.
 * @module src/backup/registry/component-registry.spec
 *
 * A hand-written list is only safer than a runtime column scan if something notices when the two
 * disagree. These tests are that something.
 *
 * ORG_SCOPED_TABLES below is a snapshot of the live catalog taken on 2026-07-30 and
 * refreshed on 2026-08-18 with:
 *
 *   select c.relname from pg_class c
 *   join pg_namespace n on n.oid = c.relnamespace
 *   where n.nspname = 'public' and c.relkind = 'r'
 *     and exists (select 1 from pg_attribute a
 *                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
 *                    and lower(a.attname) in ('organization_id', 'organizationid'));
 *
 * When a migration adds or removes an org-scoped table, this snapshot has to be refreshed in the
 * same change — and refreshing it forces whoever added the table to classify it here, which is the
 * whole point. The tests fail loudly rather than letting a new table go silently un-backed-up.
 */

import {
  COMPONENT_REGISTRY,
  HARD_EXCLUDED_RELATIONS,
  IDENTITY_COLUMN_TABLES,
  REISSUED_COLUMNS,
  CROSS_ORG_REISSUED_COLUMNS,
  REISSUED_COLUMNS,
  SEQUENCE_PRIMARY_KEY_TABLES,
  crossOrgReissuedColumnsFor,
  UNMOVABLE_PRIMARY_KEY_TABLES,
  reissuedColumnsFor,
  buildComponentTree,
  componentsWithParents,
  isHardExcluded,
  listComponentKeys,
  selectionHasSecrets,
  sequenceRekeyFor,
  tableRestorable,
  tableEntry,
  tablesForComponent,
  type BackupTier,
} from './component-registry';

/**
 * Every base table carrying organization_id or organizationid. Snapshot: 216 tables.
 *
 * +2: whiteboards, whiteboard_files, migration 20260925120100_whiteboards.sql (both carry their own
 * organization_id). +1: whiteboard_versions, migration 20261001130000_whiteboard_versions.sql.
 * +2: whiteboard_timers, whiteboard_private_sessions, migrations
 * 20261006150100_whiteboard_timers.sql and 20261006150300_whiteboard_private_mode.sql (each
 * carries its own organization_id).
 * +16: the Test Management tables (migrations 20261016183215 onward), its API keys and tokens, and
 * ci_servers.
 * +5: the Test Management automation tables (settings, runs, custom images and their approvals and votes).
 */
const ORG_SCOPED_TABLES = [
  'active_timers',
  'ai_generated_content',
  'ai_module_config',
  'ai_provider_configs',
  'ai_usage_logs',
  'ai_wiki_generations',
  'asset_item_attachments',
  'asset_item_changes',
  'asset_item_comments',
  'asset_item_links',
  'asset_item_relations',
  'asset_items',
  'asset_object_attachments',
  'asset_object_changes',
  'asset_object_comments',
  'asset_object_key_sequences',
  'asset_object_references',
  'asset_object_schemas',
  'asset_object_task_links',
  'asset_object_type_attributes',
  'asset_object_types',
  'asset_objects',
  'asset_schema_custom_fields',
  'asset_schemas',
  'audit_logs',
  'automation_connections',
  'automation_event_outbox',
  'automation_event_subscriptions',
  'automation_oauth_states',
  'automation_runs',
  'automations',
  'base_role_permission_overrides',
  'boards',
  'business_processes',
  'calculation_results',
  'ci_servers',
  'custom_fields',
  'custom_roles',
  'dashboard_activity_log',
  'dashboard_permissions',
  'dashboards',
  'document_exports',
  'document_templates',
  'employee_capacity',
  'entity_file_links',
  'fe_labels',
  'fe_nodes',
  'fe_reminders',
  'fe_shares',
  'field_groups',
  'file_attachments',
  'form_builder',
  'form_builder_approval_steps',
  'form_builder_approvals',
  'form_builder_assignments',
  'form_builder_fields',
  'form_builder_integration_deliveries',
  'form_builder_integrations',
  'form_builder_orders',
  'form_builder_payment_configs',
  'form_builder_submissions',
  'form_builder_versions',
  'form_builder_webhook_deliveries',
  'form_builder_webhooks',
  'gdpr_record_attachments',
  'gdpr_record_changes',
  'gdpr_record_comments',
  'gdpr_records',
  'gdpr_spreadsheets',
  'heatmap_configurations',
  'hierarchy_configurations',
  'invitations',
  'level_field_assignments',
  'level_field_group_assignments',
  'level_permissions',
  'license_audit_events',
  'mcp_idempotency_keys',
  'mcp_oauth_grants',
  'mcp_organization_settings',
  'mcp_tool_invocations',
  'menu_permissions',
  'migration_connections',
  'migration_entity_map',
  'migration_jobs',
  'migration_logs',
  'migration_rate_state',
  'migration_run_items',
  'migration_runs',
  'notification_preferences',
  'notifications',
  'organization_auth_providers',
  'organization_branding',
  'organization_license_change_requests',
  'organization_license_usage_counters',
  'organization_licenses',
  'organization_members',
  'organization_modules',
  'organization_storage_config',
  'organization_time_settings',
  'partner_contacts',
  'partner_customer_addresses',
  'partner_customers',
  'partner_document_sequences',
  'partner_invoice_items',
  'partner_invoices',
  'partner_kickback_entries',
  'partner_lead_comments',
  'partner_leads',
  'partner_license_package_items',
  'partner_license_packages',
  'partner_offerings',
  'partner_onprem_installations',
  'partner_profiles',
  'partner_public_listings',
  'partner_quote_items',
  'partner_quotes',
  'plan_ai_generations',
  'plan_comments',
  'plan_items_deprecated',
  'plan_resource_allocations',
  'plan_risks',
  'plans',
  'portfolio_gantt_saved_views',
  'portfolio_key_sequences',
  'portfolio_management_letters',
  'portfolios',
  'process_attachments',
  'process_comments',
  'process_diagrams',
  'process_relationships',
  'relation_types',
  'resolutions',
  'risk_configurations',
  'saved_filters',
  'service_principals',
  'site_studio_analytics',
  'site_studio_contacts',
  'site_studio_domains',
  'site_studio_form_fields',
  'site_studio_funnels',
  'site_studio_key_sequences',
  'site_studio_pages',
  'space_categories',
  'space_custom_field_overrides',
  'space_gdpr_record_attachments',
  'space_gdpr_record_changes',
  'space_gdpr_record_comments',
  'space_gdpr_records',
  'space_gdpr_spreadsheets',
  'space_lists',
  'space_priority_overrides',
  'space_robots',
  'space_status_overrides',
  'space_templates',
  'space_types',
  'spaces',
  'sprints',
  'starred_spaces',
  'status_categories',
  'support_requests',
  'task_attachments',
  'task_comments',
  'task_hierarchy_configurations',
  'task_history',
  'task_key_sequences',
  'task_priorities',
  'task_relationships',
  'task_resource_allocations',
  'task_status_transitions',
  'task_statuses',
  'tasks',
  'test_automation_configs',
  'test_automation_runs',
  'test_automation_user_image_approval_votes',
  'test_automation_user_image_approvals',
  'test_automation_user_images',
  'test_case_history',
  'test_cases',
  'test_executions',
  'test_folders',
  'test_management_api_keys',
  'test_management_api_tokens',
  'test_management_space_settings',
  'test_plan_tests',
  'test_plans',
  'test_preconditions',
  'test_run_attempts',
  'test_runs',
  'test_set_members',
  'test_sets',
  'test_ticket_links',
  'time_entries',
  'user_column_preferences',
  'user_groups',
  'user_recent_items',
  'user_role_assignments',
  'user_sidebar_preferences',
  'user_storage_overrides',
  'whiteboard_files',
  'whiteboard_private_sessions',
  'whiteboard_timers',
  'whiteboard_versions',
  'whiteboards',
  'wiki_field_assignments',
  'wiki_page_collab_snapshots',
  'wiki_pages',
  'wiki_space_settings',
  'workflow_assignments',
  'workflow_github_connections',
  'workflow_github_trigger_events',
  'workflow_github_webhooks',
  'workflow_health_issues',
  'workflow_outbox',
  'workflow_publish_jobs',
  'workflow_trigger_events',
  'workflows',
];

/**
 * Tables with NO tenant column of their own, scoped through an org-scoped parent instead.
 *
 * The registry was originally built from "every table carrying organization_id", which made these
 * invisible to it — not excluded, never considered. They hold the payload their parent points at,
 * so an archive without them restores a File Explorer node whose file path is unknown and an
 * automation with no definition.
 *
 * Produced by the query in the sibling test below, which is the check that catches the next one.
 */
const PARENT_SCOPED_TABLES = [
  'automation_versions',
  'fe_versions',
  'file_versions',
  'workflow_nodes',
  'workflow_transitions',
];

/**
 * Parent-scoped entries reached the other way round: a child that POINTS AT an org-scoped table.
 *
 * They use the same parentScope mechanism as PARENT_SCOPED_TABLES but are found by a different
 * query, so they are listed separately — the 'parent-scoped coverage' snapshot below only contains
 * tables an org-scoped table references, and these are not among them. See 'child-table coverage'.
 */
const CHILD_SCOPED_TABLES = [
  'wiki_attachments',
  'wiki_page_attachments',

  // Points at `user_groups` and carries no tenant column of its own. It was missing from the
  // registry entirely until now, which is why it appears here rather than having always been
  // listed: `user_groups` restored and reported success while producing EMPTY groups.
  'user_group_members',
];

/**
 * The space access model, reached the same way the child-scoped pair was: tables that point AT an
 * org-scoped table (`spaces`) without carrying a tenant column of their own.
 *
 * Listed apart from CHILD_SCOPED_TABLES because they are not attachments hanging off content —
 * they are the authorisation model, and their absence was the defect this list records being
 * fixed: a restored space had no permissions and no module visibility, and the run still reported
 * success. Kept as a named bucket so 'child-table coverage' below can tell "classified" from
 * "still unbacked-up" without the count being the only evidence.
 */
const SPACE_ACCESS_TABLES = ['space_module_permissions', 'space_permissions'];

/**
 * Non-org-scoped tables that org-scoped tables reference but which are deliberately NOT backed up,
 * because they are platform-level rather than tenant content. Restoring a tenant must not recreate
 * them.
 */
const PLATFORM_LEVEL_REFERENCED = ['license_plans', 'mcp_oauth_clients'];

/** The seven tables that spell the tenant column without an underscore. */
const FLAT_TENANT_COLUMN_TABLES = [
  'space_gdpr_record_attachments',
  'space_gdpr_record_changes',
  'space_gdpr_record_comments',
  'space_gdpr_records',
  'space_gdpr_spreadsheets',
  'space_lists',
  'space_robots',
];

/**
 * User FK columns that are NOT NULL, so a missing user must drop the row rather than null the
 * column. Snapshot covers the org-scoped tables only: 237 user FK columns, 25 of them NOT NULL.
 *
 * +4 columns, all nullable so none is listed here: whiteboards.archived_by / created_by /
 * updated_by and whiteboard_files.created_by, migration 20260925120100_whiteboards.sql.
 * +3 more, nullable too: whiteboard_timers.updated_by and whiteboard_private_sessions.started_by /
 * ended_by (migrations 20261006150100, 20261006150300).
 */
const NOT_NULL_USER_FK_COLUMNS = [
  'active_timers.user_id',
  'ai_generated_content.generated_by',
  'ai_usage_logs.user_id',
  'automation_oauth_states.user_id',
  'employee_capacity.user_id',
  'fe_reminders.user_id',
  'form_builder_approval_steps.approver_user_id',
  'invitations.invited_by',
  'mcp_oauth_grants.user_id',
  'notification_preferences.user_id',
  'notifications.user_id',
  'plan_comments.created_by',
  'plan_resource_allocations.user_id',
  'portfolio_gantt_saved_views.user_id',
  'saved_filters.owner_id',
  'service_principals.user_id',
  'starred_spaces.user_id',
  'support_requests.created_by',
  'task_resource_allocations.user_id',
  'time_entries.user_id',
  'user_column_preferences.user_id',
  'user_recent_items.user_id',
  'user_role_assignments.user_id',
  'user_sidebar_preferences.user_id',
  'user_storage_overrides.user_id',
];

const LEGAL_TIERS: BackupTier[] = [
  'content',
  'configuration',
  'binary_files',
  'identity',
];

describe('component registry', () => {
  it('covers every org-scoped base table and nothing else', () => {
    const expected = [
      ...ORG_SCOPED_TABLES,
      ...PARENT_SCOPED_TABLES,
      ...CHILD_SCOPED_TABLES,
      ...SPACE_ACCESS_TABLES,
    ]
      .filter((t) => !isHardExcluded(t))
      .sort();
    const actual = COMPONENT_REGISTRY.map((e) => e.table).sort();

    // Named diffs, so a failure says which table rather than just a count.
    const missing = expected.filter((t) => !actual.includes(t));
    const extra = actual.filter((t) => !expected.includes(t));

    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(actual).toEqual(expected);
  });

  it('matches the recorded catalog counts', () => {
    // 190 -> 192 and 198 -> 200 below. +2: whiteboards, whiteboard_files, migration
    // 20260925120100_whiteboards.sql. 192 -> 193 and 200 -> 201: whiteboard_versions, migration
    // 20261001130000_whiteboard_versions.sql.
    //
    // 193 -> 195 and 201 -> 203: whiteboard_timers and whiteboard_private_sessions (migrations
    // 20261006150100, 20261006150300).
    // 195 -> 211 and 203 -> 219: Test Management (15 tables) and ci_servers.
    // 211 -> 216 and 219 -> 224: the five Test Management automation tables.
    expect(ORG_SCOPED_TABLES).toHaveLength(216);
    expect(FLAT_TENANT_COLUMN_TABLES).toHaveLength(7);
    expect(PARENT_SCOPED_TABLES).toHaveLength(5);
    expect(CHILD_SCOPED_TABLES).toHaveLength(3);
    expect(SPACE_ACCESS_TABLES).toHaveLength(2);
    expect(PLATFORM_LEVEL_REFERENCED).toHaveLength(2);
    expect(COMPONENT_REGISTRY).toHaveLength(224);
  });

  it('refuses every hard exclusion by name', () => {
    for (const excluded of HARD_EXCLUDED_RELATIONS) {
      expect(COMPONENT_REGISTRY.some((e) => e.table === excluded)).toBe(false);
    }
  });

  it('assigns exactly one entry, and therefore one tier, per table', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const entry of COMPONENT_REGISTRY) {
      if (seen.has(entry.table)) duplicates.push(entry.table);
      seen.add(entry.table);
    }

    expect(duplicates).toEqual([]);

    for (const entry of COMPONENT_REGISTRY) {
      expect(LEGAL_TIERS).toContain(entry.tier);
    }
  });

  it('declares the right tenant column for every table', () => {
    for (const entry of COMPONENT_REGISTRY) {
      const expected = [
        ...PARENT_SCOPED_TABLES,
        ...CHILD_SCOPED_TABLES,
        ...SPACE_ACCESS_TABLES,
      ].includes(entry.table)
        ? null
        : FLAT_TENANT_COLUMN_TABLES.includes(entry.table)
          ? 'organizationid'
          : 'organization_id';

      expect({ table: entry.table, column: entry.tenantColumn }).toEqual({
        table: entry.table,
        column: expected,
      });
    }
  });

  it('drops rows rather than nulling a NOT NULL user FK', () => {
    for (const column of NOT_NULL_USER_FK_COLUMNS) {
      const dot = column.indexOf('.');
      const table = column.slice(0, dot);
      const field = column.slice(dot + 1);
      const entry = COMPONENT_REGISTRY.find((e) => e.table === table);

      if (!entry) continue; // hard-excluded tables have no entry

      // The invariant is that a NOT NULL column is never NULLED, not that one particular policy
      // is used. `skip_row` drops the row; `keep_required` keeps the archived id and drops the row
      // only when it is unusable. Both honour it — `set_null` is the one that would answer 23502,
      // which is classified NOT row-level and would abandon the whole table.
      expect(['skip_row', 'keep_required']).toContain(
        entry.userFkPolicy[field],
      );
    }
  });

  it('uses only legal user FK policies', () => {
    for (const entry of COMPONENT_REGISTRY) {
      for (const policy of Object.values(entry.userFkPolicy)) {
        expect(['skip_row', 'set_null', 'keep', 'keep_required']).toContain(
          policy,
        );
      }
    }
  });

  it('assigns an insert level in 1..9 and only real component dependencies', () => {
    const components = new Set(listComponentKeys());

    for (const entry of COMPONENT_REGISTRY) {
      expect(entry.insertLevel).toBeGreaterThanOrEqual(1);
      expect(entry.insertLevel).toBeLessThanOrEqual(9);
      expect(entry.requires).not.toContain(entry.component);

      for (const required of entry.requires) {
        expect(components).toContain(required);
      }
    }
  });

  it('projects a tree containing every table exactly once and nothing excluded', () => {
    const tree = buildComponentTree();

    expect(tree.tiers.map((t) => t.tier)).toEqual(LEGAL_TIERS);

    const tabled = tree.tiers.flatMap((t) =>
      t.components.flatMap((c) => c.tables),
    );

    expect(tabled.sort()).toEqual(
      COMPONENT_REGISTRY.map((e) => e.table).sort(),
    );

    for (const excluded of HARD_EXCLUDED_RELATIONS) {
      expect(tabled).not.toContain(excluded);
    }
  });
});

/**
 * The engine looks a table up by name because a run item carries only `table_name`. Defaulting the
 * tenant column instead is what made seven tables unexportable: every read of them would have
 * failed with PostgREST 42703, dormant only because no run ever got far enough to reach them.
 */
describe('tableEntry', () => {
  it('reports the non-standard tenant column rather than assuming organization_id', () => {
    // The registry has always held the right value — the engine simply never asked for it, and
    // read every one of these tables with `organization_id`. This is the lookup that fixes that.
    for (const table of FLAT_TENANT_COLUMN_TABLES) {
      expect(tableEntry(table)?.tenantColumn).toBe('organizationid');
    }
  });

  it('resolves every registered table', () => {
    for (const entry of COMPONENT_REGISTRY) {
      expect(tableEntry(entry.table)).toBe(entry);
    }
  });

  it('returns null for an unknown table so the caller must decide, not guess', () => {
    expect(tableEntry('not_a_real_table')).toBeNull();
  });
});

/**
 * The check that did not exist, and whose absence let five tables go unbacked-up for the life of
 * this module.
 *
 * Every assertion above answers "is every ORG-SCOPED table classified?" — so a table without an
 * `organization_id` was outside the question by construction. These lock the second axis: a table
 * that an org-scoped table references must be either backed up or deliberately named as platform
 * data. Refresh both snapshots with:
 *
 *   with org_scoped as (
 *     select c.oid, c.relname from pg_class c
 *     join pg_namespace n on n.oid = c.relnamespace
 *     where n.nspname='public' and c.relkind='r'
 *       and exists (select 1 from pg_attribute a
 *                    where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
 *                      and lower(a.attname) in ('organization_id','organizationid')))
 *   select distinct tgt.relname
 *     from pg_constraint con
 *     join org_scoped src on src.oid = con.conrelid
 *     join pg_class tgt on tgt.oid = con.confrelid
 *     join pg_namespace tn on tn.oid = tgt.relnamespace
 *    where con.contype='f' and tn.nspname='public'
 *      and tgt.oid not in (select oid from org_scoped);
 */
describe('parent-scoped coverage', () => {
  it('backs up every parent-scoped table, or names it as platform data', () => {
    // Snapshot of the query above, minus users/organizations which are hard-excluded by name.
    const REFERENCED_NON_ORG_TABLES = [
      ...PARENT_SCOPED_TABLES,
      ...PLATFORM_LEVEL_REFERENCED,
    ].sort();

    const classified = [
      ...COMPONENT_REGISTRY.filter((e) => e.parentScope)
        .map((e) => e.table)
        // Child-scoped and space-access entries use the same mechanism but answer a different
        // query, and are asserted by 'child-table coverage' instead.
        .filter(
          (t) =>
            !CHILD_SCOPED_TABLES.includes(t) &&
            !SPACE_ACCESS_TABLES.includes(t),
        ),
      ...PLATFORM_LEVEL_REFERENCED,
    ].sort();

    // A new table referenced from org-scoped data must land in one list or the other. Adding it
    // to neither is what happened last time, and produced an archive with dangling references.
    expect(classified).toEqual(REFERENCED_NON_ORG_TABLES);
  });

  it('gives every parent-scoped table a real, org-scoped parent', () => {
    for (const entry of COMPONENT_REGISTRY.filter((e) => e.parentScope)) {
      const parent = tableEntry(entry.parentScope!.parentTable);

      // The parent must itself be backed up and carry a tenant column, or the filter this scope
      // relies on has nothing to stand on.
      expect(parent).not.toBeNull();
      expect(parent?.tenantColumn).toBe(entry.parentScope!.parentTenantColumn);
    }
  });

  it('pairs a null tenant column with a parent scope, both ways', () => {
    for (const entry of COMPONENT_REGISTRY) {
      // Exactly one of the two must be set. A table with neither cannot be narrowed to one
      // organization at all, and a table with both would have two conflicting filters.
      expect(entry.tenantColumn === null).toBe(Boolean(entry.parentScope));
    }
  });

  it('inserts a parent-scoped table after its parent', () => {
    for (const entry of COMPONENT_REGISTRY.filter((e) => e.parentScope)) {
      const parent = tableEntry(entry.parentScope!.parentTable);

      expect(entry.insertLevel).toBeGreaterThanOrEqual(
        parent?.insertLevel ?? 0,
      );
    }
  });
});

/**
 * The exporter's central assumption, which nothing asserted until six tables failed a real run.
 *
 * `table-exporter.service.ts` orders and keyset-pages on a column. It used to hard-code `id`, so
 * every table without one died with PostgREST 42703 — `mcp_organization_settings` was simply the
 * first the run reached.
 *
 * Snapshot from the live catalog:
 *
 *   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 *    where n.nspname='public' and c.relkind='r'
 *      and exists (select 1 from pg_attribute a
 *                   where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
 *                     and lower(a.attname) in ('organization_id','organizationid'))
 *      and not exists (select 1 from pg_attribute a
 *                       where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
 *                         and a.attname='id');
 */
describe('ordering key', () => {
  /** Backed-up tables with no `id` column, and the primary key each one actually has. */
  const NO_ID_TABLES: Record<string, string[]> = {
    mcp_organization_settings: ['organization_id'],
    task_key_sequences: ['organization_id'],
    portfolio_key_sequences: ['organization_id'],
    site_studio_key_sequences: ['organization_id'],
    asset_object_key_sequences: ['schema_id'],
    partner_document_sequences: ['organization_id', 'doc_type', 'year'],
    // Added 2026-08-18 with the wiki collab/settings tables. Both are keyed by their parent
    // rather than an `id` column (verified against the live catalog).
    wiki_page_collab_snapshots: ['wiki_page_id'],
    wiki_space_settings: ['space_id'],
    // Added 2026-10-12 with the whiteboard rail tables (verified against the live catalog). The
    // timer is keyed by its board.
    whiteboard_timers: ['whiteboard_id'],
    // Test Management: settings are keyed by their space, the two link tables by both ends.
    test_management_space_settings: ['space_id'],
    test_plan_tests: ['plan_id', 'case_id'],
    test_set_members: ['set_id', 'case_id'],
  };

  it('declares an ordering key for every table that has no id', () => {
    for (const [table, key] of Object.entries(NO_ID_TABLES)) {
      const entry = tableEntry(table);

      // Without this the exporter falls back to `id` and the run dies on that table.
      expect(entry).not.toBeNull();
      expect(entry?.orderBy).toEqual(key);
    }
  });

  it('leaves every other table on the default id key', () => {
    const declared = COMPONENT_REGISTRY.filter((e) => e.orderBy).map(
      (e) => e.table,
    );

    // Exactly the ones above. Another appearing means a migration added a table without `id` and
    // the snapshot above needs refreshing — which is the point of pinning it.
    expect(declared.sort()).toEqual(Object.keys(NO_ID_TABLES).sort());
  });

  it('never declares an empty ordering key', () => {
    for (const entry of COMPONENT_REGISTRY) {
      if (entry.orderBy) {
        // An empty array would page non-deterministically and silently reorder rows.
        expect(entry.orderBy.length).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * How the snapshot at the top of this file goes stale, and what it costs.
 *
 * The first test compares the registry against ORG_SCOPED_TABLES — both sides of a hand-maintained
 * pair. When the pair agrees with each other but not with the database, it passes, and any table
 * the database has gained is silently never backed up. That is exactly what happened: the snapshot
 * was taken 2026-07-30, the Confluence/Jira migration tool landed seven org-scoped tables, and
 * every backup since ran without them while every test stayed green.
 *
 * The snapshot has been refreshed against the live catalog on 2026-08-05 and those seven are now
 * classified, so the list below is empty. It stays as a test because the reconciliation is the part
 * that actually catches the next one: a count that no longer adds up says the database moved.
 */
describe('org-scoped snapshot drift', () => {
  /** Live org-scoped tables absent from ORG_SCOPED_TABLES. Empty as of 2026-08-05. */
  const ORG_SCOPED_NOT_CLASSIFIED: string[] = [];

  it('has no org-scoped table left unclassified', () => {
    expect(ORG_SCOPED_NOT_CLASSIFIED).toEqual([]);

    for (const table of ORG_SCOPED_NOT_CLASSIFIED) {
      expect(ORG_SCOPED_TABLES).not.toContain(table);
      expect(COMPONENT_REGISTRY.some((e) => e.table === table)).toBe(false);
      expect(isHardExcluded(table)).toBe(false);
    }
  });

  it('backs up the migration tool that the stale snapshot hid', () => {
    const MIGRATION_TABLES = [
      'migration_connections',
      'migration_entity_map',
      'migration_jobs',
      'migration_logs',
      'migration_rate_state',
      'migration_run_items',
      'migration_runs',
    ];

    for (const table of MIGRATION_TABLES) {
      expect({ table, registered: !!tableEntry(table) }).toEqual({
        table,
        registered: true,
      });
    }
  });

  it('reconciles the recorded counts against the live catalog', () => {
    // Hard exclusions that carry no tenant column, so they are not org-scoped and must not be
    // counted here: users and organizations are keyed by id, task_history_with_users is a view,
    // and impersonation_sessions is scoped by user rather than organization.
    const NOT_ORG_SCOPED = [
      'users',
      'organizations',
      'task_history_with_users',
      'impersonation_sessions',
    ];

    // 192 snapshotted + 14 backup and restore tables + 0 unclassified = 206 live org-scoped.
    //
    // Was 10 and 190 until restore_run_records joined the module (migration
    // 20260807000001_restore_run_records.sql). It is org-scoped and hard-excluded for the same
    // reason as its siblings — and more sharply, because it stores redacted copies of tenant rows,
    // so archiving it would put skipped-row content into a second archive that no retention rule
    // covers.
    //
    // Then 11 and 191 until restore_entity_map joined (migration
    // 20260807000002_restore_entity_map.sql). Hard-excluded because it is this module's own
    // bookkeeping — and because archiving it would be actively harmful: restored into another
    // instance it would claim that rows which were never written there had already been restored,
    // and the next run would skip them.
    //
    // Then 190 snapshotted and 204 in total until the whiteboards feature. +2: whiteboards,
    // whiteboard_files, migration 20260925120100_whiteboards.sql. Both are backed up, not
    // hard-excluded, so the 14 below is unchanged.
    const HARD_EXCLUDED_ORG_SCOPED = HARD_EXCLUDED_RELATIONS.filter(
      (t) => !NOT_ORG_SCOPED.includes(t) && !ORG_SCOPED_TABLES.includes(t),
    );

    //
    // Then 21 and 211 when the seven SSO / SCIM tables joined (migration
    // 20260913120000_sso_saml_scim.sql), hard-excluded because they carry credentials and identity
    // bindings.
    //
    // Then 214 with whiteboard_versions (migration 20261001130000_whiteboard_versions.sql), backed
    // up, so the 21 is unchanged.
    //
    // Then 216 with whiteboard_timers and whiteboard_private_sessions (migrations 20261006150100,
    // 20261006150300), backed up too.
    //
    // Then 25 and 220 with the four org-scoped Git integration tables (git_credentials,
    // git_connections, git_repositories, git_integration_settings; migration
    // 20261016120000_git_integrations.sql), hard-excluded because they carry provider bindings,
    // tokens and webhook secrets. git_webhook_deliveries has no tenant column and is not counted.
    //
    // Then 26 and 221 with git_branch_settings (migration 20261016160000_git_branch_settings.sql).
    //
    // Then 29 and 224 with git_pull_requests, git_pull_request_tasks and task_key_aliases
    // (migration 20261019120000_git_pull_requests.sql).
    //
    // Then 32 and 227 with git_pull_request_reviews, git_branches and git_branch_tasks
    // (migration 20261020120000_git_development_panel.sql).
    //
    // Then 34 and 229 with git_commits and git_commit_tasks (migration 20261021120000_git_commits.sql).
    //
    // Then 35 and 230 with git_builds (migration 20261022120000_git_builds.sql).
    //
    // Then 36 and 231 with git_servers (migration 20261026120000_git_servers.sql): app secrets.
    //
    // Then 37 and 232 with git_space_repositories (migration 20261030130000_git_space_repositories.sql).
    //
    // Then 38 and 233 with git_azure_project_hooks (migration 20261102120000_git_azure_devops.sql): webhook
    // passwords.
    //
    // Then 254 with the 16 backed-up Test Management tables above. The five automation tables are backed
    // up too, so the exclusions stay at 38.
    expect(HARD_EXCLUDED_ORG_SCOPED).toHaveLength(38);
    expect(
      ORG_SCOPED_TABLES.length +
        HARD_EXCLUDED_ORG_SCOPED.length +
        ORG_SCOPED_NOT_CLASSIFIED.length,
    ).toBe(254);
  });
});

/**
 * The third axis, and the only one still open. These tests record a defect; they do not fix it.
 *
 * 'parent-scoped coverage' above walks FKs OUTWARD — an org-scoped table pointing AT something
 * non-org-scoped — which finds parents. Nothing walks INWARD: a non-org-scoped table pointing at
 * org-scoped data. That direction is where the children live, and 60 of them are not backed up.
 *
 * They are not obscure. `space_members` and `space_permissions` are who may see a space;
 * `board_columns` is what a board is; `dashboard_widgets` is what a dashboard shows;
 * `wiki_page_versions` is a page's history; `plan_tasks` and `portfolio_plans` are what a plan and
 * a portfolio contain. An archive without them restores a tenant whose boards have no columns,
 * dashboards no widgets, and spaces no members — and reports success, because every table it was
 * told about exported cleanly.
 *
 * The registry's own docstring is the reason: "every org-scoped base table, one entry per
 * relation." A table without organization_id was never in the question, exactly as the five
 * parent-scoped tables were not until they were found.
 *
 * Transitive closure from the live catalog — depth 1 finds 67, depth 2 finds 5 more
 * (workflow_transition_sources hangs off workflow_transitions, itself parent-scoped):
 *
 *   with recursive org_scoped as (
 *     select c.oid, c.relname from pg_class c
 *     join pg_namespace n on n.oid = c.relnamespace
 *     where n.nspname='public' and c.relkind='r'
 *       and exists (select 1 from pg_attribute a
 *                    where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
 *                      and lower(a.attname) in ('organization_id','organizationid'))),
 *   reach(oid, relname, depth) as (
 *     select oid, relname, 0 from org_scoped
 *     union
 *     select src.oid, src.relname, r.depth + 1
 *       from pg_constraint con
 *       join pg_class src on src.oid = con.conrelid
 *       join pg_namespace sn on sn.oid = src.relnamespace
 *       join reach r on r.oid = con.confrelid
 *      where con.contype='f' and sn.nspname='public' and src.relkind='r' and r.depth < 6)
 *   select relname from reach group by relname having min(depth) > 0;
 */
describe('child-table coverage', () => {
  /**
   * Snapshot of the closure above, taken 2026-08-05. 72 tables, and 73 since 2026-10-12:
   * wiki_page_comment_reads (migration 20261007120000_wiki_page_comment_reads.sql, not backed up,
   * see the count below).
   */
  const CHILD_TABLES_OF_ORG_SCOPED = [
    'automation_permissions',
    'automation_run_steps',
    'automation_schedules',
    'automation_templates',
    'automation_versions',
    'automation_webhook_deliveries',
    'board_card_fields',
    'board_column_statuses',
    'board_column_user_state',
    'board_columns',
    'board_issue_ranking',
    'board_key_sequences_space',
    'board_permissions',
    'board_quick_filter_user_state',
    'board_quick_filters',
    'board_swimlanes',
    'dashboard_favorites',
    'dashboard_filter_widget_targets',
    'dashboard_widgets',
    'fe_node_labels',
    'fe_stars',
    'fe_versions',
    'field_group_fields',
    'field_group_permissions',
    'file_versions',
    'form_builder_key_sequences',
    'form_builder_task_field_roles',
    'impersonation_sessions',
    'level_field_group_field_permissions',
    'level_field_group_permissions',
    'level_field_permissions',
    'mcp_oauth_access_tokens',
    'mcp_oauth_authorization_codes',
    'mcp_oauth_refresh_tokens',
    'organization_license_feature_overrides',
    'organizations',
    'plan_baselines',
    'plan_item_dependencies_deprecated',
    'plan_key_sequences_space',
    'plan_permissions',
    'plan_stakeholders',
    'plan_tasks',
    'portfolio_plans',
    'process_key_sequences',
    'saved_filter_permissions',
    'saved_filter_subscriptions',
    'space_list_items',
    'space_members',
    'space_module_permissions',
    'space_modules',
    'space_permissions',
    'space_robot_executions',
    'sprint_completion_log',
    'sprint_key_sequences_board',
    'task_key_sequences_space',
    'task_list_display_config',
    'task_reminders',
    'tenant_switch_audit',
    'user_group_members',
    'wiki_attachments',
    'wiki_comments',
    'wiki_labels',
    'wiki_page_attachments',
    'wiki_page_comment_reads',
    'wiki_page_comments',
    'wiki_page_labels',
    'wiki_page_links',
    'wiki_page_permissions',
    'wiki_page_versions',
    'workflow_decision_branches',
    'workflow_nodes',
    'workflow_transition_sources',
    'workflow_transitions',
  ];

  /**
   * Children that must stay out of a tenant archive: live credentials, licence grants, and a
   * platform audit surface. Same reasoning as HARD_EXCLUDED_RELATIONS, one level down.
   */
  const CHILD_PLATFORM_OR_SECURITY = [
    'mcp_oauth_access_tokens',
    'mcp_oauth_authorization_codes',
    'mcp_oauth_refresh_tokens',
    'organization_license_feature_overrides',
    'tenant_switch_audit',
  ];

  /**
   * KNOWN DEFECT, not a decision. Tenant content that no backup currently captures.
   *
   * Pinned so the count can only move deliberately: adding a child table without classifying it
   * fails 'accounts for every child table', and backing one of these up properly fails the count
   * below until the name is removed from this list.
   */
  const CHILD_TENANT_CONTENT_NOT_BACKED_UP = CHILD_TABLES_OF_ORG_SCOPED.filter(
    (t) =>
      !CHILD_PLATFORM_OR_SECURITY.includes(t) &&
      !isHardExcluded(t) &&
      !COMPONENT_REGISTRY.some((e) => e.table === t),
  );

  it('accounts for every child table', () => {
    const registered = CHILD_TABLES_OF_ORG_SCOPED.filter((t) =>
      COMPONENT_REGISTRY.some((e) => e.table === t),
    );
    const excluded = CHILD_TABLES_OF_ORG_SCOPED.filter(isHardExcluded);

    // Every child lands in exactly one bucket. A new one landing in none means the snapshot is
    // stale and someone has to say which bucket it belongs in — which is the whole point.
    const classified = [
      ...registered,
      ...excluded,
      ...CHILD_PLATFORM_OR_SECURITY,
      ...CHILD_TENANT_CONTENT_NOT_BACKED_UP,
    ].sort();

    expect(classified).toEqual([...CHILD_TABLES_OF_ORG_SCOPED].sort());
    expect(new Set(classified).size).toBe(CHILD_TABLES_OF_ORG_SCOPED.length);
  });

  it('backs up only the children anyone has classified so far', () => {
    const registered = CHILD_TABLES_OF_ORG_SCOPED.filter((t) =>
      COMPONENT_REGISTRY.some((e) => e.table === t),
    ).sort();

    // The parent-scoped five, the two wiki attachment tables, and the two space access tables.
    // Every other child is unbacked-up, deliberately or otherwise.
    expect(registered).toEqual(
      [
        ...PARENT_SCOPED_TABLES,
        ...CHILD_SCOPED_TABLES,
        ...SPACE_ACCESS_TABLES,
      ].sort(),
    );
  });

  it('holds the unbacked-up tenant table count at its recorded 56', () => {
    // Down is the only direction this number should ever move. If it rises, a migration added
    // tenant content that the next restore will silently lose.
    //
    // Was 58 until space_permissions and space_module_permissions were classified — the two that
    // decide who may act in a restored space and which modules it shows.
    //
    // 56 -> 55 when `user_group_members` was classified. It had never been in the registry, so a
    // group restored as an empty group and the run reported success.
    //
    // 55 -> 56, the one time it rose, and deliberately: `wiki_page_comment_reads` (migration
    // 20261007120000_wiki_page_comment_reads.sql) holds each user's read receipts for comment
    // threads. Its only parent is `wiki_page_comments`, which is itself in this list, so a receipt
    // has nothing to point at after a restore. It can be backed up when the comments are, not before.
    expect(CHILD_TENANT_CONTENT_NOT_BACKED_UP).toHaveLength(56);
  });

  it('never claims to back up a table it also calls unbacked-up', () => {
    for (const table of CHILD_TENANT_CONTENT_NOT_BACKED_UP) {
      expect(COMPONENT_REGISTRY.some((e) => e.table === table)).toBe(false);
    }
  });
});

describe('componentsWithParents', () => {
  it('pulls in the forms that submissions belong to', () => {
    // The case that motivated this: an archive of form_submissions alone restores rows whose
    // form_id points at a form no archive contains.
    const closed = componentsWithParents(['form_submissions']);

    expect(closed).toContain('form_submissions');
    expect(closed).toContain('forms');
  });

  it('pulls in the pages that captured site studio leads', () => {
    expect(componentsWithParents(['site_studio_leads'])).toContain(
      'site_studio',
    );
  });

  it('pulls in the workflows that runtime rows refer to', () => {
    const closed = componentsWithParents(['workflow_runtime']);

    expect(closed).toContain('workflows');
    expect(closed).toContain('tasks');
  });

  it('closes transitively, not one hop', () => {
    // A parent's own parents are just as absent from the archive as the parent was.
    const closed = new Set(componentsWithParents(['form_submissions']));

    for (const component of closed) {
      for (const entry of tablesForComponent(component)) {
        for (const parent of entry.requires) {
          expect(closed.has(parent)).toBe(true);
        }
      }
    }
  });

  it('is idempotent', () => {
    const once = componentsWithParents(['form_submissions']);

    expect(componentsWithParents(once).sort()).toEqual([...once].sort());
  });

  it('returns input components untouched, including unknown ones', () => {
    // Validation belongs to the caller; silently dropping a name here would turn a rejected
    // scheme into an accepted one that backs up less than was asked for.
    expect(componentsWithParents(['not_a_component'])).toEqual([
      'not_a_component',
    ]);
  });

  it('adds nothing to a selection that already holds its parents', () => {
    const all = listComponentKeys();

    expect(componentsWithParents(all).sort()).toEqual([...all].sort());
  });

  it('terminates on components that require each other', () => {
    // tasks/spaces reference each other in places; a naive walk would spin here.
    expect(() => componentsWithParents(listComponentKeys())).not.toThrow();
  });
});

/**
 * The space axis.
 *
 * Every table now states how it is narrowed to one space, because the field that used to answer it
 * was optional and its absence meant three different things at once: genuinely organization-level,
 * space-scoped through a parent row, and `spaces` itself. The engine could not tell them apart, so
 * a restore scoped to one space wrote 99 task_history rows belonging to another and recreated every
 * archived space of the tenant.
 *
 * These tests pin the classification. The FK claims are checkable against the live catalog via the
 * `restore_foreign_key_graph()` RPC; here they are checked against each other, which catches the
 * mistakes a human actually makes — naming a parent that is not space-scoped, or a space column the
 * parent does not have.
 */
describe('space scope', () => {
  const byTable = new Map(
    COMPONENT_REGISTRY.map((entry) => [entry.table, entry]),
  );

  it('classifies every table', () => {
    // Not a tautology while `spaceScope` could still be widened by a bad cast: this asserts the
    // value is one of the four the engine switches on, not merely that the field is present.
    for (const entry of COMPONENT_REGISTRY) {
      expect(['organization', 'own', 'self', 'parent']).toContain(
        entry.spaceScope.kind,
      );
    }
  });

  it('holds the four buckets at their recorded sizes', () => {
    // The single most useful line here: any reclassification becomes a visible, reviewed diff
    // rather than a quiet change to what a per-space restore writes.
    const counts = COMPONENT_REGISTRY.reduce<Record<string, number>>(
      (acc, entry) => ({
        ...acc,
        [entry.spaceScope.kind]: (acc[entry.spaceScope.kind] ?? 0) + 1,
      }),
      {},
    );

    // `own` was 69 until space_permissions and space_module_permissions were classified: both
    // carry space_id directly, they just have no organization_id to have been found by.
    //
    // 79 -> 81. +2: whiteboards, whiteboard_files, migration 20260925120100_whiteboards.sql. Both
    // carry their own NOT NULL space_id. 81 -> 82: whiteboard_versions, same reason.
    //
    // 82 -> 84: whiteboard_timers, whiteboard_private_sessions, same reason again.
    expect(counts).toEqual({
      // 82 -> 85: ci_servers and the two API key tables. 84 -> 97: the 13 Test Management space tables.
      // 85 -> 86: custom images. 97 -> 101: automation settings, runs, image approvals and votes.
      organization: 86,
      own: 101,
      parent: 36,
      self: 1,
    });
  });

  it('gives every space-parented table a real, space-scoped parent', () => {
    // The mirror of 'gives every parent-scoped table a real, org-scoped parent'. A parent that is
    // not itself space-scoped cannot answer which space its children are in, and the child would be
    // filtered against a column that does not exist.
    for (const entry of COMPONENT_REGISTRY) {
      if (entry.spaceScope.kind !== 'parent') {
        continue;
      }

      const parent = byTable.get(entry.spaceScope.scope.parentTable);

      expect(parent).toBeDefined();
      expect(parent!.spaceScope.kind).toBe('own');

      // The parent's column is restated on the child so it can be checked rather than trusted.
      expect(
        parent!.spaceScope.kind === 'own' ? parent!.spaceScope.column : null,
      ).toBe(entry.spaceScope.scope.parentSpaceColumn);
    }
  });

  it('resolves every space parent in exactly one hop', () => {
    // Production has no two-hop chain. The resolver recurses anyway, but a chain appearing here is
    // a deliberate change that should fail this test first rather than surprise the writer.
    for (const entry of COMPONENT_REGISTRY) {
      if (entry.spaceScope.kind !== 'parent') {
        continue;
      }

      const parent = byTable.get(entry.spaceScope.scope.parentTable)!;

      expect(parent.spaceScope.kind).not.toBe('parent');
    }
  });

  it('scopes `spaces` to itself', () => {
    // Restoring "only space X" must mean the one row whose id is X. Treating `spaces` as a table
    // with no space column is what recreated every archived space of the organization.
    expect(byTable.get('spaces')!.spaceScope.kind).toBe('self');
  });

  it('never marks a table organization-level when it carries its own space column', () => {
    // How `automation_versions` was missed: it has space_id NOT NULL but declared no space column,
    // so a per-space restore wrote every space's automation versions.
    const ownScoped = COMPONENT_REGISTRY.filter(
      (entry) => entry.spaceScope.kind === 'own',
    ).map((entry) => entry.table);

    expect(ownScoped).toContain('automation_versions');
  });

  it('inherits tenancy and space from the same parent, or from different tables entirely', () => {
    // Preflight emits ONE embed per parent, selecting both columns. Two scopes naming two different
    // parents would need two embeds of two tables, which the count query does not build — so this
    // asserts the property that lets the merge stay a merge.
    for (const entry of COMPONENT_REGISTRY) {
      if (entry.spaceScope.kind !== 'parent' || !entry.parentScope) {
        continue;
      }

      expect(entry.spaceScope.scope.parentTable).toBe(
        entry.parentScope.parentTable,
      );
      expect(entry.spaceScope.scope.column).toBe(entry.parentScope.column);
    }
  });
});

/**
 * Which tables the engine refuses to move, and which it reissues a key for instead.
 *
 * These three lists look interchangeable and are not. Conflating them is what kept
 * `automation_event_outbox` refused on every space-move restore — 44 rows a run, reported as
 * belonging to another space when the destination held none — on the strength of a mechanical claim
 * that was never true of it.
 */
describe('keys the engine cannot preserve', () => {
  it('reissues the outbox key rather than refusing the table', () => {
    const rule = sequenceRekeyFor('automation_event_outbox');

    expect(rule?.key).toBe('id');

    // The condition that makes reissuing safe rather than merely possible. Without it a restored
    // row still matching `relayed_at IS NULL` would be picked up by the relay drain within ~2s and
    // fire the DESTINATION space's automations for real.
    expect(rule?.neutraliseWhenNull).toEqual(['relayed_at']);
  });

  it('leaves every other table alone', () => {
    expect(sequenceRekeyFor('tasks')).toBeUndefined();
    expect(sequenceRekeyFor('migration_logs')).toBeUndefined();
    expect(sequenceRekeyFor('partner_document_sequences')).toBeUndefined();
  });

  it('still refuses the one that genuinely cannot be moved', () => {
    // `partner_document_sequences` has no id column at all; its key IS
    // (organization_id, doc_type, year), so there is nothing to reissue.
    expect([...UNMOVABLE_PRIMARY_KEY_TABLES]).toEqual([
      'partner_document_sequences',
    ]);
  });

  it('keeps the identity-column refusal wired with no members', () => {
    // `support_requests.ticket_number` and `migration_logs.id` were the only two members.
    // `20260813140000_restore_identity_columns.sql` moved both to GENERATED BY DEFAULT, so their
    // archived values write back and neither needs refusing any more.
    //
    // Emptied rather than deleted, for the same reason SEQUENCE_PRIMARY_KEY_TABLES below is: a
    // column added as GENERATED ALWAYS later is then refused by a guard that already exists.
    //
    // The separate guarantee that these two are never RE-KEYED did not move with them — it lives in
    // NEVER_REKEYED_TABLES in restore-id-remapper.ts and is asserted by restore-rescoping.spec.ts,
    // because it is a fact about moving a row rather than about writing one.
    expect([...IDENTITY_COLUMN_TABLES]).toEqual([]);
  });

  it('keeps the sequence-refusal list empty, and keeps the list', () => {
    // Emptied rather than deleted: the guard that reads it stays wired, so a future table that
    // genuinely must not move is refused without anyone having to remember to re-add the check.
    expect([...SEQUENCE_PRIMARY_KEY_TABLES]).toEqual([]);
  });
});

/**
 * `REISSUED_COLUMNS` deletes a column before insert. That is the right answer only when the column is
 * a machine-minted value the application reissues; for anything else it silently destroys data on
 * every restore, including a same-space one where nothing could have collided.
 *
 * Both halves are pinned. The additions matter, but the REJECTIONS matter more: each rejected column
 * looks like an obvious omission to anyone reading the audit note, and adding one back would clear a
 * live site's address or orphan a Stripe order with no test failing to say so.
 */
describe('REISSUED_COLUMNS', () => {
  it('strips exactly the two columns the application mints itself', () => {
    expect(REISSUED_COLUMNS).toEqual({
      automations: ['webhook_token'],
      fe_shares: ['token'],
    });
  });

  it.each([
    // Author-supplied, and middleware routes live public traffic by it.
    ['site_studio_funnels', 'sub_domain_name'],
    // Generated only at create; a restore cannot call the generator, so stripping leaves the funnel
    // with no address at all and the editor hides the symptom.
    ['site_studio_funnels', 'preview_subdomain'],
    // Issued by Stripe and used as the payment webhook's lookup key.
    ['form_builder_orders', 'stripe_checkout_session_id'],
    // The four below are NOT NULL with no default: stripping turns a skip into a hard failure.
    ['automation_oauth_states', 'state_token'],
    ['invitations', 'token'],
    ['partner_onprem_installations', 'activation_code'],
    // Genuinely globally unique in the real world — refusing the second copy is correct.
    ['site_studio_domains', 'domain'],
  ])('refuses to strip %s.%s — see the audit note for why', (table, column) => {
    expect(reissuedColumnsFor(table)).not.toContain(column);
  });

  it('leaves every other table untouched', () => {
    expect(reissuedColumnsFor('tasks')).toEqual([]);
    expect(reissuedColumnsFor('not_a_table')).toEqual([]);
  });
});

/**
 * User references that cannot simply be nulled, because a CHECK depends on them.
 *
 * Almost every user FK is `set_null`: losing who created something is not losing the thing. These
 * are the exceptions, and getting one wrong is not a cosmetic error — it cost a real restore all 6
 * `form_builder_assignments` rows at once.
 */
describe('user references a CHECK constraint depends on', () => {
  it('keeps an assignment whose assignee is gone, rather than nulling it', () => {
    // `form_builder_assignments_target_check` is
    // `(assignee_user_id IS NOT NULL) <> (assignee_role IS NOT NULL)` — exactly one must be set.
    // Nulling the assignee leaves NEITHER set, so the insert answers 23514 and the row is lost
    // anyway; there is no honest `assignee_role` to invent in its place. That has not changed, and
    // `set_null` here would still be wrong.
    //
    // What changed is the alternative to nulling. Dropping the row lost the assignment outright;
    // keeping the archived id satisfies the constraint, because the column stays populated. The FK
    // points at `users`, which is global, so the id resolves from any organization.
    const entry = tableEntry('form_builder_assignments');

    expect(entry?.userFkPolicy.assignee_user_id).toBe('keep_required');

    // Provenance only — no constraint reads it, so it still nulls rather than costing the row.
    expect(entry?.userFkPolicy.assigned_by).toBe('set_null');
  });

  it('keeps the reviewer on partner_leads, so accepted leads restore too', () => {
    // Supersedes an earlier decision, and the reasoning behind that one still holds as far as it
    // went: `partner_leads_review_integrity` only bites on accepted/rejected leads, so `skip_row`
    // would drop every draft as well, and those restore perfectly. `set_null` was chosen as the
    // lesser evil, leaving accepted leads to fail one at a time once 23514 was row-level.
    //
    // They did fail — four of them on a real cross-organization restore, and six partner_customers
    // behind them, because `partner_can_sell_to` needs an accepted lead and none had landed.
    //
    // `keep` is the option neither branch of that trade offered. The FK is to `users`, which is
    // global, while `knownUsers` is the destination's member list — so the reviewer being absent
    // from the organization never meant the reference was unsatisfiable. Drafts are untouched,
    // because nothing was nulled for them either way.
    expect(tableEntry('partner_leads')?.userFkPolicy.reviewed_by).toBe('keep');

    // Provenance only — no constraint reads these, so they still null.
    expect(tableEntry('partner_leads')?.userFkPolicy.submitted_by).toBe(
      'set_null',
    );
    expect(tableEntry('partner_leads')?.userFkPolicy.created_by).toBe(
      'set_null',
    );
  });
});

/**
 * `fe_shares`, the second table where nulling a user breaks a CHECK.
 *
 * `fe_shares_user_needs_target` is `CHECK (share_type = 'link' OR shared_with_id IS NOT NULL)`. A
 * share aimed at a person who is not in the destination organization has that column nulled, and a
 * non-link share then satisfies neither half — ten rows failed exactly this way on a real
 * cross-organization restore, before 23514 was row-level enough to report them individually.
 */
describe('a file share whose recipient must not simply be nulled', () => {
  it('drops the row instead, like form_builder_assignments', () => {
    const entry = tableEntry('fe_shares');

    expect(entry?.userFkPolicy.shared_with_id).toBe('skip_row');

    // Provenance only — no constraint reads it, so it still nulls rather than costing the row.
    expect(entry?.userFkPolicy.shared_by).toBe('set_null');
  });
});

/**
 * Columns unique across the whole installation, stripped only when the tenant changes.
 *
 * Kept apart from `REISSUED_COLUMNS` because the trigger differs: those collide with themselves
 * whatever the destination, these only with ANOTHER organization's rows. Stripping them on a
 * same-organization space move would take a working funnel off the air.
 */
describe('globally-unique columns across an organization boundary', () => {
  it('reissues the subdomains and the Stripe session', () => {
    expect(crossOrgReissuedColumnsFor('site_studio_funnels')).toEqual([
      'preview_subdomain',
      'sub_domain_name',
    ]);
    expect(crossOrgReissuedColumnsFor('form_builder_orders')).toEqual([
      'stripe_checkout_session_id',
    ]);
  });

  it('keeps the unconditional list unconditional', () => {
    // `automations.webhook_token` must stay in the always-stripped list and out of this one, or a
    // same-organization restore would start carrying a token that collides with its own source row.
    expect(REISSUED_COLUMNS.automations).toEqual(['webhook_token']);
    expect(crossOrgReissuedColumnsFor('automations')).toEqual([]);
  });

  it('names no table that is not restorable', () => {
    for (const table of Object.keys(CROSS_ORG_REISSUED_COLUMNS)) {
      expect(tableEntry(table)).toBeDefined();
    }
  });
});

/**
 * One table holds both kinds of invitation, and a NULL space IS the organization kind.
 *
 * `space_id` is nullable because an invitation to the ORGANIZATION has no space to name, while a
 * space invitation carries one alongside `space_role` and `space_permissions`. Under
 * `whenNull: 'refuse'` the organization-level rows were counted as belonging to some other space and
 * dropped — 2 of the 4 invitations in a real archive, refused for the one thing that identifies them.
 */
describe('invitations, which are organization-level and space-level at once', () => {
  it('treats a missing space as organization-wide rather than as another space', () => {
    const entry = tableEntry('invitations');

    expect(entry?.spaceScope).toEqual({
      kind: 'own',
      column: 'space_id',
      whenNull: 'organization',
    });
  });

  /**
   * Widening the space rule must not widen the tenant rule.
   *
   * An invitation carries an email, a name, a role, `space_permissions` and a live `token` that
   * grants access the moment it is accepted. The tier is what keeps it inside one organization and
   * behind an operator who may restore identity data.
   */
  it('stays identity-tier, so it never crosses a tenant boundary', () => {
    expect(tableEntry('invitations')?.tier).toBe('identity');

    // `tableRestorable` reports the whole tier unrestorable because it is built without a session to
    // ask about permission; the wizard re-adds it for an operator who has it. Asserted so the space
    // change above cannot quietly make identity data offerable.
    expect(tableRestorable(tableEntry('invitations') as never)).toBe(false);
  });
});

describe('Test Management', () => {
  it('forces encryption only when its credentials are selected', () => {
    expect(selectionHasSecrets(['test_management_access'])).toBe(true);
    expect(selectionHasSecrets(['test_management'])).toBe(false);
  });

  it.each([
    'test_automation_configs',
    'test_automation_runs',
    'test_automation_user_images',
    'test_automation_user_image_approvals',
    'test_automation_user_image_approval_votes',
  ])('backs up the automation table %s', (table) => {
    expect(isHardExcluded(table)).toBe(false);
    expect(tableEntry(table)?.component).toBe('test_automation');
  });

  it('forces encryption when automation settings are selected', () => {
    expect(selectionHasSecrets(['test_automation'])).toBe(true);
  });
});
