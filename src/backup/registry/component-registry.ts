/**
 * @fileoverview The authoritative list of what can be backed up.
 * @module src/backup/registry/component-registry
 *
 * This is a checked-in list, never a runtime column scan. A scan gets it wrong twice and silently:
 * seven org-scoped tables spell the column `organizationid` with no underscore, and the view
 * task_history_with_users carries organization_id but must never be exported or inserted into.
 *
 * COMPONENT_REGISTRY is populated from the live catalog and locked by component-registry.spec.ts,
 * which fails the build when the database and this list disagree — so a table added by another team
 * stops the build until someone classifies it, instead of silently never being backed up.
 */

export type BackupTier =
  | 'content'
  | 'configuration'
  | 'binary_files'
  | 'identity';

/**
 * What to do with a row whose user FK points at a user who is not in the destination organization.
 *
 * `keep` is the odd one out and is deliberately narrow. The other two answer "this reference cannot
 * stand", which is true when the column is only provenance. It is false when a CHECK constraint
 * READS the column: nulling it then produces a row the destination refuses outright, and dropping it
 * loses a row that was perfectly restorable. `keep` sends the archived id and lets the database
 * decide — the FK is to `users`, which is global, so a user who still exists satisfies it whatever
 * organization they belong to, and one who is genuinely gone answers 23503, which is row-level and
 * costs only that row.
 *
 * Use it only where a constraint depends on the column. Everywhere else `set_null` is right, because
 * carrying a non-member's id into a tenant that cannot see them buys nothing.
 */
/**
 * `keep_required` is `keep` for a column that cannot be nulled.
 *
 * `keep` falls back to nulling when the archived value is not a usable id, which is right where the
 * column is nullable — `partner_leads.reviewed_by` loses a reviewer and keeps the lead. On a NOT
 * NULL column that same fallback answers `23502`, which `classifyInsertError` reports as
 * `missing_required_column` with `rowLevel: false` — so ONE corrupt value would abandon the whole
 * table. `notifications` is 84 rows; `form_builder_approval_steps` is 45.
 *
 * This variant keeps the id exactly as `keep` does and skips the row when it cannot, so the cost of
 * a bad value stays at one row instead of the table.
 */
export type OnMissingUser = 'skip_row' | 'set_null' | 'keep' | 'keep_required';

/**
 * How a table without its own tenant column is narrowed to one organization.
 *
 * A handful of tables carry no `organization_id` and are scoped through their parent instead —
 * `fe_versions` belongs to a `fe_nodes` row, which is org-scoped. Because the registry was built
 * from "every table with an organization_id", these were invisible to it: not excluded, simply
 * never considered. Their absence is worse than it sounds, because they hold the payload —
 * `fe_versions.file_path` is the only record of which stored object a file actually is, so an
 * archive without it restores a file name pointing at nothing.
 */
export interface ParentScope {
  /** FK column on this table. */
  column: string;
  /** The org-scoped table it points at. */
  parentTable: string;
  /** The parent's own tenant column, used to filter through the embed. */
  parentTenantColumn: 'organization_id' | 'organizationid';
}

/**
 * What a NULL means in the column a table is narrowed to one space by.
 *
 * Stated per table rather than defaulted, because the two answers are opposite and each is right
 * somewhere. Fifteen of the space-scoped tables have a NULLABLE space column, and a NULL there is an
 * organization-wide row living in a space-scoped table — an org default task status, an org-wide
 * custom field — not a row that happens to be in some other space.
 */
export type SpaceNullPolicy =
  /** Not in the chosen space. Counted as `other_space`. */
  | 'refuse'
  /** Organization-wide. Restored under any space filter, and under none. */
  | 'organization';

/**
 * A space inherited from the row this one points at.
 *
 * Deliberately the same shape as `ParentScope` above, which already answers "my ORGANIZATION comes
 * from my parent" for seven tables. This is the same question on the other axis, and the reason it
 * did not exist is the reason a space-scoped restore wrote into every space of the tenant:
 * `task_comments` has no `space_id`, only a `task_id`, and nothing in the engine could turn one into
 * the other.
 */
export interface SpaceParentScope {
  /** FK column on THIS table. */
  column: string;
  /** The table it points at. Must itself declare `spaceScope.kind === 'own'`. */
  parentTable: string;
  /**
   * The parent's own space column, restated so the pair can be CHECKED rather than trusted —
   * exactly as `ParentScope.parentTenantColumn` is checked against the live catalog.
   */
  parentSpaceColumn: 'space_id' | 'spaceid';
  /** What a NULL in `column` means. Never defaulted. */
  whenNull: SpaceNullPolicy;
}

/**
 * How a table is narrowed to ONE space.
 *
 * REQUIRED on every entry, and a union rather than a set of optional fields, because the absence of
 * the old `spaceColumn?` meant three different things at once and the engine could not tell them
 * apart: genuinely organization-level (correct by accident), space-scoped through a parent (silently
 * broken for 37 tables, which is how a restore scoped to one space wrote 99 task_history rows
 * belonging to another), and `spaces` itself (which recreated every archived space of the tenant
 * when the operator asked for one).
 *
 * Making the classification required means a table added by another team does not compile until
 * someone has said which of the four it is — the same guarantee the tier/component fields already
 * give, on the axis that was missing it.
 */
export type SpaceScope =
  /**
   * Genuinely organization-level. The space filter must NOT apply.
   * site_studio_*, organization_*, custom_roles, portfolios, partner_*, mcp_*, migration_*,
   * gdpr_* (whose chain terminates at the org-scoped gdpr_spreadsheets), notifications, audit_logs.
   */
  | { kind: 'organization' }
  /** Carries its own space column. */
  | { kind: 'own'; column: 'space_id' | 'spaceid'; whenNull: SpaceNullPolicy }
  /**
   * IS a space. `spaces` alone.
   *
   * "Restore only space X" means the ONE row whose id is X. Treating `spaces` as a table with no
   * space column is what made selecting it recreate every archived space of the organization.
   */
  | { kind: 'self' }
  /** Space comes from the row this one points at. */
  | { kind: 'parent'; scope: SpaceParentScope };

export interface ComponentTable {
  /** Live relation name. Must be a real table, never a view. */
  table: string;
  /**
   * Seven tables spell it without the underscore. Null when the table has no tenant column at all
   * and is scoped through `parentScope` instead.
   */
  tenantColumn: 'organization_id' | 'organizationid' | null;
  /** Set exactly when `tenantColumn` is null. */
  parentScope?: ParentScope;

  /**
   * Columns the exporter orders and pages by. Defaults to `['id']`.
   *
   * Six tables have no `id` column at all — settings and key-sequence tables keyed by
   * `organization_id`, `schema_id`, or a composite. The exporter used to order on a hard-coded
   * `id`, so every one of them failed the run with PostgREST 42703 the moment it was reached.
   *
   * Must be unique for the rows this export sees, because it is the paging cursor: a non-unique
   * key silently skips or duplicates rows across a page boundary.
   */
  orderBy?: string[];
  /**
   * REQUIRED. How this table is narrowed to one space. See `SpaceScope`.
   *
   * Replaces the optional `spaceColumn`, whose absence was overloaded three ways and silently meant
   * "restore this into every space" for 117 of the 185 tables.
   */
  spaceScope: SpaceScope;
  /** Exactly one tier per table — duplicate membership would export twice and 23505 on re-insert. */
  tier: BackupTier;
  /** UI grouping key, e.g. 'tasks', 'wiki', 'custom_fields'. */
  component: string;
  /** 1..9, from a topological sort of the FK graph. Insert order is load-bearing on restore. */
  insertLevel: number;
  /** Component keys that must be restored before this one. */
  requires: string[];
  /** False for legacy/shadow tables: archive them, but do not restore them by default. */
  restoreByDefault: boolean;
  conflictPolicy: 'skip' | 'abort';
  /** Per user-FK column, derived from live nullability rather than hand-typed. */
  userFkPolicy: Record<string, OnMissingUser>;
  notes?: string;
}

/**
 * Never exported, asserted by name so an edit cannot quietly reintroduce them.
 *
 * users / organizations — a tenant archive containing them is a platform-wide escalation path, and
 *   inserting an organization fires seven bootstrap triggers.
 * task_history_with_users — a view; a column scan would include it and the importer would try to
 *   INSERT into it.
 * organization_licenses* — restoring them would grant paid features or reset metered usage.
 * impersonation_sessions — a security-audit surface with NOT NULL user FKs.
 * backup_* / restore_* — this module's own tables; backup_targets holds the credentials the archive
 *   would be uploaded with. restore_run_records additionally carries redacted copies of tenant rows,
 *   so archiving it would put skipped-row content into a second archive that no retention rule
 *   covers, and restoring it would resurrect the audit trail of a different restore.
 */
export const HARD_EXCLUDED_RELATIONS = [
  'users',
  'organizations',
  'task_history_with_users',
  'organization_licenses',
  'organization_license_usage_counters',
  'impersonation_sessions',
  'backup_targets',
  'backup_schemes',
  'backup_schedule_state',
  'backup_runs',
  'backup_run_items',
  'backup_artifacts',
  'backup_trigger_credentials',
  'restore_runs',
  'restore_run_items',
  'restore_conflicts',
  'restore_entity_map',
  'restore_run_records',
  // restore_archive_cache — its only FK parent is backup_artifacts, itself hard-excluded above,
  // so a registered entry would always conflict as missing_parent. Never in an archive by
  // construction, same as its siblings.
  'restore_archive_cache',
  // restore_destinations — holds secret_encrypted/secret_iv/secret_tag connection credentials,
  // same reason backup_targets is excluded above: an archive must never carry another
  // environment's connection secrets.
  'restore_destinations',
  // SSO / SCIM — IdP trust material, SCIM bearer-token hashes, session bindings and identity links.
  // Restoring any of them into another instance would let a foreign IdP or token sign in or
  // provision accounts there, so like backup_targets they never enter an archive.
  'sso_connections',
  'sso_domains',
  'saml_requests',
  'sso_session_bindings',
  'sso_organization_settings',
  'scim_tokens',
  'scim_links',
  // Git integrations (migration 20261016120000_git_integrations.sql). A connection is a binding to a
  // GitHub installation / GitLab group that was only granted after the provider proved the connecting
  // admin can access it; restoring it (above all into another organization) would recreate that
  // binding without the proof, and would copy GitLab tokens and webhook secrets. After a restore the
  // admin reconnects, which reuses the same rows. The settings are three toggles, excluded with them.
  'git_credentials',
  'git_connections',
  'git_repositories',
  'git_integration_settings',
  // Branch naming convention (ticket 3, migration 20261016160000_git_branch_settings.sql); two choices,
  // cheap to set again, excluded with the rest of the Git integration.
  'git_branch_settings',
  // Pull requests linked to tasks (ticket 4, migration 20261019120000_git_pull_requests.sql). They hang
  // off git_repositories, which is excluded above, and are re-imported from the provider after the
  // admin reconnects. task_key_aliases are a task's keys before a move; a restore issues new keys, so
  // the old ones would point nowhere.
  'git_pull_requests',
  'git_pull_request_tasks',
  'task_key_aliases',
  // Development panel (ticket 5, migration 20261020120000_git_development_panel.sql): reviewer verdicts and
  // branches hang off the excluded pull requests / repositories and come back with the next events.
  'git_pull_request_reviews',
  'git_branches',
  'git_branch_tasks',
  // Commits linked to tasks (ticket 6, migration 20261021120000_git_commits.sql): they hang off the excluded
  // repositories and arrive again with the next pushes.
  'git_commits',
  'git_commit_tasks',
  // Build status (ticket 7, migration 20261022120000_git_builds.sql): hangs off the excluded repositories; the
  // next run or pipeline event brings it back.
  'git_builds',
  // Organizations' own Git servers (ticket 11, migration 20261026120000_git_servers.sql): each row holds an
  // app's client secret, private key and webhook secret. Never archived; the admin registers the server
  // again after a restore (same address = same key, so the reconnected rows are reused).
  'git_servers',
  // Azure DevOps service hook subscriptions (migration 20261102120000_git_azure_devops.sql): each row holds a
  // webhook password and hangs off the excluded connections; the health check recreates them after a reconnect.
  'git_azure_project_hooks',
  // Development module, repositories per space (migration 20261030130000_git_space_repositories.sql): hangs
  // off the excluded repositories; an admin assigns them again in the space's Development settings.
  'git_space_repositories',
] as const;

/**
 * Every org-scoped base table, one entry per relation. 171 entries: 173 org-scoped base tables in
 * the live catalog, minus organization_licenses and organization_license_usage_counters, which are
 * hard-excluded.
 *
 * tenantColumn, spaceColumn, userFkPolicy, insertLevel and requires are DERIVED from the catalog
 * (information_schema plus pg_constraint), not hand-typed. Only tier and component are judgement.
 *
 * insertLevel is a longest-path depth over the FK graph, clamped to 9. The graph genuinely contains
 * cycles — wiki_pages <-> ai_generated_content, and the partner quote/invoice/licence triangle — so
 * the levels inside a cycle are an ordering hint, not a guarantee; the restore engine must still
 * tolerate a cycle rather than assume levels alone resolve it.
 */
export const COMPONENT_REGISTRY: ComponentTable[] = [
  {
    table: 'active_timers',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'time_tracking',
    insertLevel: 6,
    requires: ['tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'ai_generated_content',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'ai_content',
    insertLevel: 9,
    requires: ['spaces', 'tasks', 'wiki'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { generated_by: 'skip_row' },
  },
  {
    table: 'ai_module_config',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'ai_config',
    insertLevel: 9,
    requires: ['spaces', 'wiki'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'ai_provider_configs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'ai_config',
    insertLevel: 1,
    requires: ['spaces', 'wiki'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { configured_by: 'set_null' },
  },
  {
    table: 'ai_usage_logs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'ai_content',
    insertLevel: 1,
    requires: ['spaces', 'tasks', 'wiki'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'ai_wiki_generations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'ai_content',
    insertLevel: 9,
    requires: ['spaces', 'tasks', 'wiki'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'asset_item_attachments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'item_id',
        parentTable: 'asset_items',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 5,
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'tasks',
    ],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
  },
  {
    table: 'asset_item_changes',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'item_id',
        parentTable: 'asset_items',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'assets',
    insertLevel: 5,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { changed_by: 'set_null' },
  },
  {
    table: 'asset_item_comments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'item_id',
        parentTable: 'asset_items',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'assets',
    insertLevel: 5,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'asset_item_links',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'assets',
    insertLevel: 1,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'asset_item_relations',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'source_item_id',
        parentTable: 'asset_items',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'assets',
    insertLevel: 5,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'asset_items',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'assets',
    insertLevel: 4,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'asset_object_attachments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 6,
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'tasks',
    ],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
  },
  {
    table: 'asset_object_changes',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'asset_objects',
    insertLevel: 6,
    requires: ['asset_object_config', 'relation_types', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { changed_by: 'set_null' },
  },
  {
    table: 'asset_object_comments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'asset_objects',
    insertLevel: 6,
    requires: ['asset_object_config', 'relation_types', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'asset_object_key_sequences',
    // No `id` column; primary key is 'schema_id'.
    orderBy: ['schema_id'],
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'key_sequences',
    insertLevel: 4,
    requires: ['asset_object_config'],
    // Restorable now, and safe because the primary key IS the natural key — `organization_id` for
    // three of these, `schema_id` for the asset one. There is no surrogate id to mint, so a
    // cross-organization restore rewrites the tenant column and the row either lands on a counter
    // the destination does not have yet, or collides on that key and is SKIPPED. A live counter is
    // therefore never moved BACKWARDS, which is the only way replaying one causes duplicate keys.
    //
    // `notes` below still describes the resync: this makes the counter restorable, it does not stop
    // the destination correcting it afterwards.
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes: 'Key counters are resynced after restore, never replayed.',
  },
  {
    table: 'asset_object_references',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'asset_objects',
    insertLevel: 6,
    requires: ['asset_object_config', 'relation_types', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'asset_object_schemas',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'asset_object_config',
    insertLevel: 3,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'asset_object_task_links',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'asset_objects',
    insertLevel: 6,
    requires: ['asset_object_config', 'relation_types', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'asset_object_type_attributes',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'asset_object_config',
    insertLevel: 5,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'asset_object_types',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'asset_object_config',
    insertLevel: 4,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'asset_objects',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'asset_objects',
    insertLevel: 5,
    requires: ['asset_object_config', 'relation_types', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      archived_by: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'asset_schema_custom_fields',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'schema_id',
        parentTable: 'asset_schemas',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'configuration',
    component: 'custom_fields',
    insertLevel: 4,
    requires: ['assets', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'asset_schemas',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'assets',
    insertLevel: 3,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'audit_logs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'audit',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { impersonated_by_user_id: 'set_null', user_id: 'set_null' },
  },
  {
    table: 'automation_connections',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'automations',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'automation_event_outbox',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'automation_runs',
    insertLevel: 3,

    // NOT `automations`. Verified against `pg_constraint`: this table's only foreign keys are
    // `organization_id -> organizations` and `space_id -> spaces`. It carries no `automation_id` —
    // an outbox row names its event by `kind` and `payload`, not by a relation. Declaring the
    // dependency put a spurious "automations" chip in the restore dialog's "these areas are not part
    // of this restore" panel and filed a `missing_parent_component` conflict for a parent that was
    // never a parent.
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'automation_event_subscriptions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'automation_runs',
    insertLevel: 4,
    requires: ['automations', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'automation_oauth_states',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'automation_runs',
    insertLevel: 3,
    requires: ['automations', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'automation_runs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'automation_runs',
    insertLevel: 4,
    requires: ['automations', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'automations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'automations',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'base_role_permission_overrides',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'roles',
    insertLevel: 1,
    requires: ['groups'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'boards',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'boards',
    insertLevel: 3,
    requires: ['filters', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'business_processes',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'content',
    component: 'processes',
    insertLevel: 3,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      assigned_to: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'calculation_results',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'business_process_id',
        parentTable: 'business_processes',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'processes',
    insertLevel: 4,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'ci_servers',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'test_management_access',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
    notes:
      'Jenkins connections for Test Management CI jobs. Holds encrypted_secret/encryption_iv/encryption_tag, why `test_management_access` is secret-bearing.',
  },
  {
    table: 'custom_fields',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'custom_fields',
    insertLevel: 3,
    requires: ['assets', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'custom_roles',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'roles',
    insertLevel: 1,
    requires: ['groups'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { deleted_by: 'set_null' },
  },
  {
    table: 'dashboard_activity_log',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'dashboard_id',
        parentTable: 'dashboards',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'dashboards',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'set_null' },
  },
  {
    table: 'dashboard_permissions',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'dashboard_id',
        parentTable: 'dashboards',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'configuration',
    component: 'dashboards',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { granted_by: 'set_null' },
  },
  {
    table: 'dashboards',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'dashboards',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'document_templates',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'documents',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'document_exports',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'document_exports',
    insertLevel: 2,
    requires: ['documents'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { requested_by: 'set_null' },
  },
  {
    table: 'employee_capacity',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'resource_planning',
    insertLevel: 1,
    requires: ['tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      updated_by: 'set_null',
      user_id: 'skip_row',
    },
  },
  {
    table: 'entity_file_links',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 4,

    // Polymorphic, same as `file_attachments` above — see the note there for why `support` and `wiki`
    // appear on these two tables and on none of their siblings.
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'support',
      'tasks',
      'test_management',
      'wiki',
    ],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'fe_labels',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'binary_files',
    component: 'file_explorer',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'fe_nodes',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'binary_files',
    component: 'file_explorer',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'fe_reminders',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'node_id',
        parentTable: 'fe_nodes',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'file_explorer',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'fe_shares',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'node_id',
        parentTable: 'fe_nodes',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'file_explorer',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    /**
     * `shared_with_id` drops the row rather than nulling it, like `form_builder_assignments`.
     *
     * `fe_shares_user_needs_target` is `CHECK (share_type = 'link' OR shared_with_id IS NOT NULL)`.
     * A share aimed at a PERSON who is not in the destination organization has that column nulled by
     * the policy, and a non-link share with no recipient then satisfies neither half of the check —
     * ten rows failed exactly this way on a real cross-organization restore.
     *
     * Nulling cannot be rescued by inventing a recipient, and turning it into a link share would
     * publish something that was deliberately addressed to one person. So the row goes, and the
     * report names the person who is missing.
     *
     * Link shares are unaffected: `share_type = 'link'` satisfies the check on its own, and those
     * rows carry no `shared_with_id` to lose. `shared_by` stays `set_null` — provenance, and no
     * constraint reads it.
     */
    userFkPolicy: { shared_by: 'set_null', shared_with_id: 'skip_row' },
  },
  {
    table: 'field_groups',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'custom_fields',
    insertLevel: 3,
    requires: ['assets', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { deleted_by: 'set_null' },
  },
  {
    table: 'file_attachments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 3,

    // `support` and `wiki` are here and not on the other attachment tables because this one is
    // POLYMORPHIC: `entity_id` has no foreign key, and which table it points at is decided per row by
    // `entity_type`. `POLYMORPHIC_REFERENCES` in restore-id-remapper.ts maps `wiki_page` and
    // `support_request` among its types, so rows of those types were being refused with no component
    // named anywhere — neither here nor in the FK graph, which cannot see a reference with no key.
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'support',
      'tasks',
      'test_management',
      'wiki',
    ],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { checked_out_by: 'set_null', created_by: 'set_null' },
  },
  {
    table: 'form_builder',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'forms',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'form_builder_approval_steps',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'form_submissions',
    insertLevel: 8,
    requires: ['forms', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    // NOT NULL, and the same bargain as `notifications`: the step keeps naming its archived
    // approver rather than being dropped, even where that person is not a member here.
    userFkPolicy: { approver_user_id: 'keep_required' },
  },
  {
    table: 'form_builder_approvals',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'form_submissions',
    insertLevel: 7,
    requires: ['forms', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'form_builder_assignments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'form_submissions',
    insertLevel: 7,
    requires: ['forms', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    /**
     * `assignee_user_id` keeps the archived id rather than being nulled or dropped.
     *
     * `form_builder_assignments_target_check` is
     * `(assignee_user_id IS NOT NULL) <> (assignee_role IS NOT NULL)` — exactly one of the two must
     * be set. Nulling an assignee who is not in the destination organization leaves NEITHER set, so
     * the insert answers `23514` and the row is lost anyway. That is why `set_null` is wrong here
     * and it has not changed.
     *
     * What changed is the alternative. Dropping the row lost the assignment outright; keeping the
     * id satisfies the constraint, because the column stays populated. The FK points at `users`,
     * which is global, so the id resolves from any organization — and an assignment naming somebody
     * who cannot currently act on it is still a record of who was assigned.
     *
     * Inventing an `assignee_role` remains off the table: that would hand somebody's work to a
     * group nobody chose.
     */
    userFkPolicy: {
      assigned_by: 'set_null',
      assignee_user_id: 'keep_required',
    },
  },
  {
    table: 'form_builder_fields',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'forms',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'form_builder_integration_deliveries',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'form_submissions',
    insertLevel: 7,
    requires: ['forms', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'form_builder_integrations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'forms',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'form_builder_orders',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'form_submissions',
    insertLevel: 1,
    requires: ['forms', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'form_builder_payment_configs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'forms',
    insertLevel: 1,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'form_builder_submissions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'form_submissions',
    insertLevel: 6,
    requires: ['forms', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { submitted_by: 'set_null' },
  },
  {
    table: 'form_builder_versions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'form_submissions',
    insertLevel: 4,
    requires: ['forms', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'form_builder_webhook_deliveries',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'form_submissions',
    insertLevel: 7,
    requires: ['forms', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'form_builder_webhooks',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'forms',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'gdpr_record_attachments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 3,
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'tasks',
    ],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
  },
  {
    table: 'gdpr_record_changes',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'gdpr',
    insertLevel: 4,
    requires: ['attachments'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { changed_by: 'set_null' },
  },
  {
    table: 'gdpr_record_comments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'gdpr',
    insertLevel: 3,
    requires: ['attachments'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'gdpr_records',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'gdpr',
    insertLevel: 2,
    requires: ['attachments'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      assignee_id: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'gdpr_spreadsheets',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'gdpr',
    insertLevel: 1,
    requires: ['attachments'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'heatmap_configurations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'risk_config',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'hierarchy_configurations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'hierarchy',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'invitations',
    tenantColumn: 'organization_id',

    /**
     * One table holds both kinds of invitation, and a NULL space is the ORGANIZATION kind.
     *
     * `space_id` is nullable here precisely because an invitation to the organization has no space
     * to name, while a space invitation carries one alongside `space_role` and `space_permissions`.
     * Under `whenNull: 'refuse'` the organization-level rows were counted as belonging to some other
     * space and dropped — on a real archive that is 2 of the 4 invitations, refused for the one
     * thing that identifies them.
     *
     * `'organization'` is the policy written for exactly this shape — "restored under any space
     * filter, and under none". This is its first use; the docblock on `SpaceNullPolicy` already
     * noted that fifteen space-scoped tables have a nullable space column and that a NULL there is
     * an organization-wide row rather than a foreign one.
     *
     * Restore-only: nothing in the export path reads `whenNull`, so what a space-filtered BACKUP
     * captures is unchanged.
     */
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },

    /**
     * Still identity, and deliberately so.
     *
     * An invitation carries an email, a name, a role, `space_permissions` and a live `token` that
     * grants access the moment it is accepted. It restores only on a same-organization run by an
     * operator who may restore identity data, and the tier is never offered across a tenant
     * boundary. Widening the space rule above does not widen that, and must not.
     */
    tier: 'identity',
    component: 'invitations',
    insertLevel: 3,
    requires: ['roles', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { invited_by: 'skip_row' },
  },
  {
    table: 'level_field_assignments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'custom_field_id',
        parentTable: 'custom_fields',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'configuration',
    component: 'custom_fields',
    insertLevel: 4,
    requires: ['assets', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'level_field_group_assignments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'field_group_id',
        parentTable: 'field_groups',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'configuration',
    component: 'custom_fields',
    insertLevel: 4,
    requires: ['assets', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'level_permissions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'roles',
    insertLevel: 3,
    requires: ['groups'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'set_null' },
  },
  {
    table: 'license_audit_events',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'audit',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { actor_user_id: 'set_null' },
  },
  {
    table: 'mcp_idempotency_keys',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'mcp',
    insertLevel: 2,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'mcp_oauth_grants',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'mcp',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { revoked_by: 'set_null', user_id: 'skip_row' },
  },
  {
    table: 'mcp_organization_settings',
    // No `id` column; primary key is 'organization_id'.
    orderBy: ['organization_id'],
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'mcp',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { updated_by: 'set_null' },
  },
  {
    table: 'mcp_tool_invocations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'mcp',
    insertLevel: 2,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'set_null' },
  },
  {
    table: 'menu_permissions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'roles',
    insertLevel: 3,
    requires: ['groups'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'set_null' },
  },
  {
    table: 'migration_connections',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'migration',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
    notes:
      'Holds encrypted_secret/encryption_iv/encryption_tag — the Jira and Confluence credentials. Why `migration` is secret-bearing.',
  },
  {
    table: 'migration_entity_map',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'migration_runs',
    insertLevel: 5,
    // No `spaces`: verified against pg_constraint 2026-08-13, no table in this component references
    // `spaces` at all — their edges go to `migration_jobs`, `migration_runs` and
    // `migration_connections`. The only real link to a space is `migration_jobs.target_space_id`,
    // which belongs to the `migration` component and is pulled in transitively by the entry below.
    requires: ['migration'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes:
      'Maps source ids to the rows they became. Without it a re-run re-imports everything as duplicates.',
  },
  {
    table: 'migration_jobs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'migration',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'migration_logs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'migration_runs',
    insertLevel: 5,
    // No `spaces`: verified against pg_constraint 2026-08-13, no table in this component references
    // `spaces` at all — their edges go to `migration_jobs`, `migration_runs` and
    // `migration_connections`. The only real link to a space is `migration_jobs.target_space_id`,
    // which belongs to the `migration` component and is pulled in transitively by the entry below.
    requires: ['migration'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'migration_rate_state',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'migration_runs',
    insertLevel: 2,
    requires: ['migration'],
    // Live throttle state: cooldown_until is a wall-clock instant that is meaningless by the time
    // an archive is restored. Archived for completeness, not put back by default.
    restoreByDefault: false,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'migration_run_items',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'migration_runs',
    insertLevel: 5,
    // No `spaces`: verified against pg_constraint 2026-08-13, no table in this component references
    // `spaces` at all — their edges go to `migration_jobs`, `migration_runs` and
    // `migration_connections`. The only real link to a space is `migration_jobs.target_space_id`,
    // which belongs to the `migration` component and is pulled in transitively by the entry below.
    requires: ['migration'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'migration_runs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'migration_runs',
    insertLevel: 4,
    // No `spaces`: verified against pg_constraint 2026-08-13, no table in this component references
    // `spaces` at all — their edges go to `migration_jobs`, `migration_runs` and
    // `migration_connections`. The only real link to a space is `migration_jobs.target_space_id`,
    // which belongs to the `migration` component and is pulled in transitively by the entry below.
    requires: ['migration'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'notification_preferences',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'user_preferences',
    insertLevel: 1,
    requires: ['portfolios', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'notifications',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'notifications',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    /**
     * The archived id stands even where the person is not a member here.
     *
     * NOT NULL, so it cannot be nulled, and dropping the row lost the notification entirely — 29 of
     * 84 on a real cross-organization restore. The FK points at `users`, which is global, so the id
     * satisfies it from any organization.
     *
     * The consequence is deliberate: a notification can name somebody who is not a member of the
     * organization holding it. They cannot see it while that is true, and they inherit it if they
     * are ever invited.
     */
    userFkPolicy: { user_id: 'keep_required' },
  },
  {
    table: 'organization_auth_providers',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'org_settings',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'organization_branding',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'org_settings',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { updated_by: 'set_null' },
  },
  {
    table: 'organization_license_change_requests',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'licensing',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { requested_by: 'set_null', reviewed_by: 'set_null' },
  },
  {
    table: 'organization_members',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'membership',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',

    // `keep_required`, NOT `set_null`. This row IS the grant: `user_id` plus `role` is what makes
    // someone a member. The column is nullable, so `set_null` does not fail loudly — it writes a
    // membership with a live `role` and nobody attached to it, which is an unreadable entry in the
    // authorisation model rather than a missing one.
    //
    // Worse, it defeats the table's own deduplication: Postgres treats NULLs as distinct, so
    // `organization_members_organization_id_user_id_key` does not collapse them and N source
    // members become N orphan rows, once per restore.
    //
    // `keep_required` sends the archived id and lets the foreign key decide: a user who exists is
    // kept, one who does not skips the ROW. That is the fail-closed answer and it is what
    // `space_permissions.user_id` already does for the same reason.
    userFkPolicy: { user_id: 'keep_required' },
  },
  {
    table: 'organization_modules',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'org_settings',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'organization_storage_config',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'org_settings',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { updated_by: 'set_null' },
  },
  {
    table: 'organization_time_settings',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'org_settings',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'partner_contacts',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 3,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'partner_customer_addresses',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 3,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'partner_customers',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 2,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'partner_document_sequences',
    // No `id` column; primary key is 'organization_id', 'doc_type', 'year'.
    orderBy: ['organization_id', 'doc_type', 'year'],
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'key_sequences',
    insertLevel: 1,
    // Empty, not `['asset_object_config']`: verified against pg_constraint 2026-08-13, this table has
    // no foreign key at all beyond `organization_id`. Only `asset_object_key_sequences` genuinely
    // has that dependency (`schema_id -> asset_object_schemas`); the other four copied its line.
    requires: [],
    restoreByDefault: false,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes: 'Key counters are resynced after restore, never replayed.',
  },
  {
    table: 'partner_invoice_items',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 9,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'partner_invoices',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 9,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'partner_kickback_entries',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 3,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'partner_lead_comments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 2,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { author_user_id: 'set_null' },
  },
  {
    table: 'partner_leads',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 1,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',

      // `partner_leads_review_integrity` READS this column:
      //   CHECK (status NOT IN ('accepted','rejected')
      //          OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
      //
      // Nulling it left four accepted leads violating that CHECK on a real cross-organization
      // restore, and their absence then failed six partner_customers behind them —
      // `partner_can_sell_to` needs an accepted lead, and there was none.
      //
      // `skip_row` was weighed and rejected before, correctly: it would drop every draft lead too,
      // and those restore fine. `keep` is the option that was missing. `reviewed_at` survives
      // already, being a timestamp rather than a user reference, so keeping this one column is all
      // the constraint needs.
      reviewed_by: 'keep',

      // Not `keep`: `partner_leads_submitted_integrity` tests `submitted_at`, the timestamp, and
      // nothing reads this column.
      submitted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'partner_license_package_items',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 2,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'partner_license_packages',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 1,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'partner_offerings',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 4,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'partner_onprem_installations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 3,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'partner_profiles',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 2,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'partner_public_listings',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 3,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'partner_quote_items',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 9,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'partner_quotes',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'partner',
    insertLevel: 9,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      accepted_by: 'set_null',
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'plan_ai_generations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'plans',
    insertLevel: 4,
    requires: ['filters', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'set_null' },
  },
  {
    table: 'plan_comments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'plan_id',
        parentTable: 'plans',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'plans',
    insertLevel: 4,
    requires: ['filters', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'skip_row', updated_by: 'set_null' },
  },
  {
    table: 'plan_items_deprecated',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'plan_id',
        parentTable: 'plans',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'plans',
    insertLevel: 6,
    requires: ['filters', 'spaces', 'tasks'],
    restoreByDefault: false,
    conflictPolicy: 'skip',
    userFkPolicy: { assigned_to: 'set_null', created_by: 'set_null' },
    notes: 'Legacy WBS table superseded by plan_tasks.',
  },
  {
    table: 'plan_resource_allocations',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'plan_id',
        parentTable: 'plans',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'plans',
    insertLevel: 4,
    requires: ['filters', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      updated_by: 'set_null',
      user_id: 'skip_row',
    },
  },
  {
    table: 'plan_risks',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'plan_id',
        parentTable: 'plans',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'plans',
    insertLevel: 6,
    requires: ['filters', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', owner_id: 'set_null' },
  },
  {
    table: 'plans',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'plans',
    insertLevel: 3,
    requires: ['filters', 'spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      owner_id: 'set_null',
      rag_set_by: 'set_null',
    },
  },
  {
    table: 'portfolio_gantt_saved_views',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'user_preferences',
    insertLevel: 2,
    requires: ['portfolios', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'portfolio_key_sequences',
    // No `id` column; primary key is organization_id.
    orderBy: ['organization_id'],
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'key_sequences',
    insertLevel: 1,
    // Empty, not `['asset_object_config']`: verified against pg_constraint 2026-08-13, this table has
    // no foreign key at all beyond `organization_id`. Only `asset_object_key_sequences` genuinely
    // has that dependency (`schema_id -> asset_object_schemas`); the other four copied its line.
    requires: [],
    // Restorable now, and safe because the primary key IS the natural key — `organization_id` for
    // three of these, `schema_id` for the asset one. There is no surrogate id to mint, so a
    // cross-organization restore rewrites the tenant column and the row either lands on a counter
    // the destination does not have yet, or collides on that key and is SKIPPED. A live counter is
    // therefore never moved BACKWARDS, which is the only way replaying one causes duplicate keys.
    //
    // `notes` below still describes the resync: this makes the counter restorable, it does not stop
    // the destination correcting it afterwards.
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes: 'Key counters are resynced after restore, never replayed.',
  },
  {
    table: 'portfolio_management_letters',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'portfolios',
    insertLevel: 6,
    requires: ['plans', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      approved_by: 'set_null',
      assigned_to_user_id: 'set_null',
      created_by: 'set_null',
      rejected_by: 'set_null',
      submitted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'portfolios',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'portfolios',
    insertLevel: 1,
    requires: ['plans', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      owner_id: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'process_attachments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'process_id',
        parentTable: 'business_processes',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 4,
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'tasks',
    ],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
  },
  {
    table: 'process_comments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'process_id',
        parentTable: 'business_processes',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'processes',
    insertLevel: 4,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'process_diagrams',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'process_id',
        parentTable: 'business_processes',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'processes',
    insertLevel: 4,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'process_relationships',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'parent_process_id',
        parentTable: 'business_processes',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'processes',
    insertLevel: 4,
    requires: ['relation_types', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'relation_types',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'relation_types',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      deleted_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'resolutions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'statuses',
    insertLevel: 1,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'risk_configurations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'risk_config',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'saved_filters',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'filters',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { owner_id: 'skip_row' },
  },
  {
    table: 'service_principals',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'service_principals',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', user_id: 'skip_row' },
  },
  {
    table: 'site_studio_analytics',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'site_studio_leads',
    insertLevel: 3,
    requires: ['site_studio'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'site_studio_contacts',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'site_studio_leads',
    insertLevel: 3,
    requires: ['site_studio'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'site_studio_domains',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'site_studio',
    insertLevel: 2,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'site_studio_form_fields',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'site_studio',
    insertLevel: 2,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'site_studio_funnels',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'site_studio',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'site_studio_key_sequences',
    // No `id` column; primary key is organization_id.
    orderBy: ['organization_id'],
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'key_sequences',
    insertLevel: 1,
    // Empty, not `['asset_object_config']`: verified against pg_constraint 2026-08-13, this table has
    // no foreign key at all beyond `organization_id`. Only `asset_object_key_sequences` genuinely
    // has that dependency (`schema_id -> asset_object_schemas`); the other four copied its line.
    requires: [],
    // Restorable now, and safe because the primary key IS the natural key — `organization_id` for
    // three of these, `schema_id` for the asset one. There is no surrogate id to mint, so a
    // cross-organization restore rewrites the tenant column and the row either lands on a counter
    // the destination does not have yet, or collides on that key and is SKIPPED. A live counter is
    // therefore never moved BACKWARDS, which is the only way replaying one causes duplicate keys.
    //
    // `notes` below still describes the resync: this makes the counter restorable, it does not stop
    // the destination correcting it afterwards.
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes: 'Key counters are resynced after restore, never replayed.',
  },
  {
    table: 'site_studio_pages',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'site_studio',
    insertLevel: 2,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'space_categories',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'wiki',
    insertLevel: 3,
    requires: ['ai_content', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'space_custom_field_overrides',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'custom_fields',
    insertLevel: 4,
    requires: ['assets', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'space_gdpr_record_attachments',
    tenantColumn: 'organizationid',
    spaceScope: { kind: 'own', column: 'spaceid', whenNull: 'refuse' },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 5,
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'tasks',
    ],
    restoreByDefault: false,
    conflictPolicy: 'skip',
    userFkPolicy: { uploadedby: 'set_null' },
  },
  {
    table: 'space_gdpr_record_changes',
    tenantColumn: 'organizationid',
    spaceScope: { kind: 'own', column: 'spaceid', whenNull: 'refuse' },
    tier: 'content',
    component: 'space_gdpr_legacy',
    insertLevel: 5,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { changedby: 'set_null' },
  },
  {
    table: 'space_gdpr_record_comments',
    tenantColumn: 'organizationid',
    spaceScope: { kind: 'own', column: 'spaceid', whenNull: 'refuse' },
    tier: 'content',
    component: 'space_gdpr_legacy',
    insertLevel: 5,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { createdby: 'set_null' },
  },
  {
    table: 'space_gdpr_records',
    tenantColumn: 'organizationid',
    spaceScope: { kind: 'own', column: 'spaceid', whenNull: 'refuse' },
    tier: 'content',
    component: 'space_gdpr_legacy',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      assigneeid: 'set_null',
      createdby: 'set_null',
      updatedby: 'set_null',
    },
    notes:
      'Legacy space-scoped GDPR family; spells the tenant column organizationid. Restorable on ' +
      'request: legacy here means no backend reads it, not that the rows are unwritable.',
  },
  {
    table: 'space_gdpr_spreadsheets',
    tenantColumn: 'organizationid',
    spaceScope: { kind: 'own', column: 'spaceid', whenNull: 'refuse' },
    tier: 'content',
    component: 'space_gdpr_legacy',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { createdby: 'set_null', updatedby: 'set_null' },
  },
  {
    table: 'space_lists',
    tenantColumn: 'organizationid',
    spaceScope: { kind: 'own', column: 'spaceid', whenNull: 'refuse' },
    tier: 'content',
    component: 'space_lists_legacy',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { createdby: 'set_null', updatedby: 'set_null' },
    notes:
      'Legacy list storage; no backend references. Restorable on request — nothing reads it, but ' +
      "the rows are the operator's data and were being archived and then silently dropped.",
  },
  {
    table: 'space_priority_overrides',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'statuses',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'space_robots',
    tenantColumn: 'organizationid',
    spaceScope: { kind: 'own', column: 'spaceid', whenNull: 'refuse' },
    tier: 'content',
    component: 'space_robots_legacy',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { createdby: 'set_null', updatedby: 'set_null' },
    notes:
      'Legacy; no backend references. Restorable on request, same reasoning as space_lists.',
  },
  {
    table: 'space_status_overrides',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'statuses',
    insertLevel: 5,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'space_templates',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'space_config',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'space_types',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'space_config',
    insertLevel: 1,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'spaces',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'self' },
    tier: 'content',
    component: 'spaces',
    insertLevel: 2,
    requires: ['space_config'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      archived_by: 'set_null',
      created_by: 'set_null',
      lead_id: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'sprints',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'board_id',
        parentTable: 'boards',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'boards',
    insertLevel: 4,
    requires: ['filters', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'starred_spaces',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'identity',
    component: 'user_preferences',
    insertLevel: 3,
    requires: ['portfolios', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'status_categories',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'statuses',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'support_requests',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'content',
    component: 'support',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'skip_row' },
    notes:
      'ticket_number is GENERATED ALWAYS AS IDENTITY and cannot be inserted through PostgREST.',
  },
  {
    table: 'task_attachments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 6,
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'tasks',
    ],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
  },
  {
    table: 'task_comments',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'tasks',
    insertLevel: 6,
    requires: ['processes', 'relation_types', 'spaces', 'statuses'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', edited_by: 'set_null' },
  },
  {
    table: 'task_hierarchy_configurations',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'hierarchy',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'task_history',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'tasks',
    insertLevel: 6,
    requires: ['processes', 'relation_types', 'spaces', 'statuses'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { changed_by: 'set_null' },
  },
  {
    table: 'task_key_sequences',
    // No `id` column; primary key is organization_id.
    orderBy: ['organization_id'],
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'key_sequences',
    insertLevel: 1,
    // Empty, not `['asset_object_config']`: verified against pg_constraint 2026-08-13, this table has
    // no foreign key at all beyond `organization_id`. Only `asset_object_key_sequences` genuinely
    // has that dependency (`schema_id -> asset_object_schemas`); the other four copied its line.
    requires: [],
    // Restorable now, and safe because the primary key IS the natural key — `organization_id` for
    // three of these, `schema_id` for the asset one. There is no surrogate id to mint, so a
    // cross-organization restore rewrites the tenant column and the row either lands on a counter
    // the destination does not have yet, or collides on that key and is SKIPPED. A live counter is
    // therefore never moved BACKWARDS, which is the only way replaying one causes duplicate keys.
    //
    // `notes` below still describes the resync: this makes the counter restorable, it does not stop
    // the destination correcting it afterwards.
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes: 'Key counters are resynced after restore, never replayed.',
  },
  {
    table: 'task_priorities',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'statuses',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'task_relationships',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'tasks',
    insertLevel: 2,
    requires: ['processes', 'relation_types', 'spaces', 'statuses'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'task_resource_allocations',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'resource_planning',
    insertLevel: 6,
    requires: ['tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      updated_by: 'set_null',
      user_id: 'skip_row',
    },
  },
  {
    table: 'task_status_transitions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'statuses',
    insertLevel: 5,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'task_statuses',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'statuses',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'tasks',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'content',
    component: 'tasks',
    insertLevel: 5,
    requires: ['processes', 'relation_types', 'spaces', 'statuses'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      assigned_to: 'set_null',
      created_by: 'set_null',
      reporter: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'test_automation_configs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'test_automation',
    // After the custom image it may use.
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
    notes:
      'Holds secrets_enc/ci_headers_enc (CI secrets). Why `test_automation` is secret-bearing; cleared across organizations.',
  },
  {
    table: 'test_automation_runs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_automation',
    // After its setting, plan and execution.
    insertLevel: 7,
    requires: ['spaces', 'test_management'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { started_by: 'set_null' },
  },
  {
    table: 'test_automation_user_image_approval_votes',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'test_automation',
    // After the approval it belongs to.
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    // NOT NULL voter: kept, and a missing person costs only that vote.
    userFkPolicy: { user_id: 'keep_required' },
  },
  {
    table: 'test_automation_user_image_approvals',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'test_automation',
    // After the image it decides on.
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { decided_by: 'set_null', requested_by: 'set_null' },
  },
  {
    table: 'test_automation_user_images',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'test_automation',
    insertLevel: 2,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      approved_by: 'set_null',
      blocked_by: 'set_null',
      created_by: 'set_null',
    },
  },
  {
    table: 'test_case_history',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    // One past `test_cases`: the composite FK (case_id, space_id, organization_id) needs the case.
    insertLevel: 5,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { changed_by: 'set_null' },
  },
  {
    table: 'test_cases',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    // One past `test_folders`, which `folder_id` points at.
    insertLevel: 4,
    requires: ['spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      archived_by: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'test_executions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    // After `test_plans`, an optional parent.
    insertLevel: 4,
    requires: ['spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      archived_by: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'test_folders',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'test_management_api_keys',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'test_management_access',
    insertLevel: 2,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    // NOT NULL owner, checked against organization_members: kept, and a missing owner costs only that key.
    userFkPolicy: { user_id: 'keep_required' },
    notes: 'Holds token_hash. Why `test_management_access` is secret-bearing.',
  },
  {
    table: 'test_management_api_tokens',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'configuration',
    component: 'test_management_access',
    // After the key it was minted from.
    insertLevel: 3,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes:
      'Short-lived access tokens minted from an API key; holds token_hash.',
  },
  {
    table: 'test_management_space_settings',
    tenantColumn: 'organization_id',
    // Keyed by its space: the primary key is `space_id`, there is no `id` column.
    orderBy: ['space_id'],
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'test_management',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { updated_by: 'set_null' },
  },
  {
    table: 'test_plan_tests',
    tenantColumn: 'organization_id',
    // No `id` column; primary key is (plan_id, case_id).
    orderBy: ['plan_id', 'case_id'],
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    insertLevel: 5,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { added_by: 'set_null', planned_tester_id: 'set_null' },
  },
  {
    table: 'test_plans',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    insertLevel: 3,
    requires: ['spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      archived_by: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'test_preconditions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    insertLevel: 3,
    requires: ['spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      archived_by: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'test_run_attempts',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    insertLevel: 6,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'test_runs',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    // After both `test_executions` and `test_cases`.
    insertLevel: 5,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      assignee_id: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'test_set_members',
    tenantColumn: 'organization_id',
    // No `id` column; primary key is (set_id, case_id).
    orderBy: ['set_id', 'case_id'],
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    insertLevel: 5,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { added_by: 'set_null' },
  },
  {
    table: 'test_sets',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    insertLevel: 3,
    requires: ['spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      archived_by: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'test_ticket_links',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'test_management',
    // After the linked case, set, plan or run, and the linked task.
    insertLevel: 6,
    requires: ['spaces', 'tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'time_entries',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'time_tracking',
    insertLevel: 6,
    requires: ['tasks'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'user_column_preferences',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'user_preferences',
    insertLevel: 1,
    requires: ['portfolios', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'user_groups',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'groups',
    insertLevel: 2,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { deleted_by: 'set_null' },
  },
  {
    // The rows that make a group a group. Absent from this registry until now — it carries no
    // `organization_id`, so the sweep that built the org-scoped entries never saw it and nobody
    // wrote a parentScope by hand. The effect was silent rather than loud: `user_groups` restored,
    // reported success, and produced EMPTY groups, which reads as "restored" everywhere.
    //
    // Tenancy comes through the parent, exactly as `fe_versions` takes it from `fe_nodes`.
    table: 'user_group_members',
    tenantColumn: null,
    parentScope: {
      column: 'group_id',
      parentTable: 'user_groups',
      parentTenantColumn: 'organization_id',
    },

    // `organization`, not `parent`: the parent is org-scoped, so these rows are not in a space and
    // no space filter can exclude them.
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'groups',

    // After `user_groups` at 2, so the group exists before anyone is put in it.
    insertLevel: 3,
    requires: ['roles'],
    restoreByDefault: true,
    conflictPolicy: 'skip',

    // `user_id` is NOT NULL, so `set_null` would answer 23502 — which is classed rowLevel:false and
    // abandons the whole table. `keep_required` skips the row instead, which is what a membership
    // for somebody the destination has never seen should do.
    userFkPolicy: { user_id: 'keep_required' },
  },
  {
    table: 'user_recent_items',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'user_preferences',
    insertLevel: 1,
    requires: ['portfolios', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'user_role_assignments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'roles',
    insertLevel: 2,
    requires: ['groups'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'user_sidebar_preferences',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'user_preferences',
    insertLevel: 1,
    requires: ['portfolios', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { user_id: 'skip_row' },
  },
  {
    table: 'user_storage_overrides',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'organization' },
    tier: 'identity',
    component: 'user_preferences',
    insertLevel: 1,
    requires: ['portfolios', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { granted_by: 'set_null', user_id: 'skip_row' },
  },
  {
    table: 'whiteboard_files',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'binary_files',
    component: 'whiteboards',
    // One past `whiteboards`: the composite FK (whiteboard_id, space_id, organization_id) needs the
    // parent row first.
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
    notes:
      'Holds storage_path for an embedded image. Without it the bytes in files/whiteboard-files are unrestorable.',
  },
  {
    table: 'whiteboard_private_sessions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'whiteboards',
    // Same composite FK to `whiteboards` as whiteboard_files, so one level past it too.
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { ended_by: 'set_null', started_by: 'set_null' },
    notes:
      "A board's private-mode sessions. An open one (ended_at null) restores as open, so the board is in private mode again until someone ends it.",
  },
  {
    table: 'whiteboard_timers',
    tenantColumn: 'organization_id',
    // Keyed by its board: the primary key is `whiteboard_id`, there is no `id` column.
    orderBy: ['whiteboard_id'],
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'whiteboards',
    // Same composite FK to `whiteboards` as whiteboard_files, so one level past it too.
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { updated_by: 'set_null' },
    notes:
      "A board's shared timer. A running one whose end has passed reads as ended, so restoring it starts nothing.",
  },
  {
    table: 'whiteboard_versions',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'whiteboards',
    // Same composite FK to `whiteboards` as whiteboard_files, so one level past it too.
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { changed_by: 'set_null' },
    notes:
      "A board's version history (scene + name per version). Its images are the board's whiteboard_files.",
  },
  {
    table: 'whiteboards',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'whiteboards',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      archived_by: 'set_null',
      created_by: 'set_null',
      updated_by: 'set_null',
    },
  },
  {
    table: 'wiki_field_assignments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'custom_fields',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'wiki_page_collab_snapshots',
    tenantColumn: 'organization_id',
    orderBy: ['wiki_page_id'],
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'wiki',
    insertLevel: 9,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { updated_by: 'set_null' },
  },
  {
    table: 'wiki_pages',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'wiki',
    insertLevel: 9,
    requires: ['ai_content', 'spaces', 'whiteboards'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null', updated_by: 'set_null' },
  },
  {
    table: 'wiki_space_settings',
    tenantColumn: 'organization_id',
    orderBy: ['space_id'],
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'wiki',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { updated_by: 'set_null' },
  },
  {
    table: 'workflow_assignments',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'workflows',
    insertLevel: 6,
    requires: ['spaces', 'statuses'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'workflow_github_connections',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'workflow_github',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'workflow_github_trigger_events',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'workflow_github',
    insertLevel: 3,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'workflow_github_webhooks',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'workflow_github',
    insertLevel: 4,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
  },
  {
    table: 'workflow_health_issues',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'workflow_id',
        parentTable: 'workflows',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'workflow_runtime',
    insertLevel: 6,
    requires: ['tasks', 'workflows'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'workflow_outbox',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'workflow_runtime',
    insertLevel: 6,
    requires: ['tasks', 'workflows'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'workflow_publish_jobs',
    tenantColumn: 'organization_id',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'draft_id',
        parentTable: 'workflows',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'content',
    component: 'workflow_runtime',
    insertLevel: 6,
    requires: ['tasks', 'workflows'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { initiated_by: 'set_null' },
  },
  {
    table: 'workflow_trigger_events',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'content',
    component: 'workflow_runtime',
    insertLevel: 6,
    requires: ['tasks', 'workflows'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
  },
  {
    table: 'workflows',
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'organization' },
    tier: 'configuration',
    component: 'workflows',
    insertLevel: 5,
    requires: ['spaces', 'statuses'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {
      created_by: 'set_null',
      lock_user_id: 'set_null',
      updated_by: 'set_null',
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Parent-scoped tables.
  //
  // These carry no organization_id, so the "every table with a tenant column" sweep that produced
  // the entries above could never see them. They are not edge cases: they hold the content their
  // org-scoped parent merely points at. Backing up `fe_nodes` without `fe_versions` yields a file
  // name whose `current_version_id` references nothing, and backing up `automations` without
  // `automation_versions` yields an automation with no definition.
  //
  // Each is filtered through its parent's tenant column at export time. Insert level is one past
  // the parent's, because the FK requires the parent row first.
  // ---------------------------------------------------------------------------------------------

  {
    table: 'fe_versions',
    tenantColumn: null,
    parentScope: {
      column: 'node_id',
      parentTable: 'fe_nodes',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'node_id',
        parentTable: 'fe_nodes',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'file_explorer',
    insertLevel: 9,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
    notes:
      'Holds file_path — the only record of which stored object a File Explorer node is.',
  },
  {
    table: 'file_versions',
    tenantColumn: null,
    parentScope: {
      column: 'attachment_id',
      parentTable: 'file_attachments',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'attachment_id',
        parentTable: 'file_attachments',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'attachments',
    insertLevel: 9,
    requires: [
      'asset_object_config',
      'asset_objects',
      'assets',
      'file_explorer',
      'gdpr',
      'processes',
      'space_gdpr_legacy',
      'spaces',
      'tasks',
    ],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
    notes: 'Holds file_path for an attachment. Same role as fe_versions.',
  },
  {
    table: 'automation_versions',
    tenantColumn: null,
    parentScope: {
      column: 'automation_id',
      parentTable: 'automations',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'configuration',
    component: 'automations',
    insertLevel: 9,
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { created_by: 'set_null' },
    notes:
      'Holds `definition` — the automation itself. Without it an automation restores as an empty shell.',
  },
  {
    table: 'workflow_nodes',
    tenantColumn: null,
    parentScope: {
      column: 'workflow_id',
      parentTable: 'workflows',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'workflow_id',
        parentTable: 'workflows',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'configuration',
    component: 'workflows',
    insertLevel: 9,
    requires: ['spaces', 'statuses'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes: 'The workflow graph. workflow_health_issues references it.',
  },
  {
    table: 'workflow_transitions',
    tenantColumn: null,
    parentScope: {
      column: 'workflow_id',
      parentTable: 'workflows',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'workflow_id',
        parentTable: 'workflows',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'configuration',
    component: 'workflows',
    // After workflow_nodes: to_node_id references it.
    insertLevel: 9,
    requires: ['spaces', 'statuses'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes: 'Edges of the workflow graph. Referenced by workflow_outbox.',
  },
  {
    table: 'wiki_attachments',
    tenantColumn: null,
    parentScope: {
      column: 'wiki_page_id',
      parentTable: 'wiki_pages',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'wiki_page_id',
        parentTable: 'wiki_pages',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'wiki',
    insertLevel: 9,
    requires: ['ai_content', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
    notes:
      'Holds file_path for a wiki attachment. Without it the bytes in files/wiki-attachments are unrestorable.',
  },
  {
    table: 'wiki_page_attachments',
    tenantColumn: null,
    parentScope: {
      column: 'wiki_page_id',
      parentTable: 'wiki_pages',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'wiki_page_id',
        parentTable: 'wiki_pages',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
    tier: 'binary_files',
    component: 'wiki',
    insertLevel: 9,
    requires: ['ai_content', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: { uploaded_by: 'set_null' },
    notes:
      'The second wiki attachment table; both are live and both point at wiki-attachments.',
  },

  // ---------------------------------------------------------------------------------------------
  // The space access model.
  //
  // Neither table carries organization_id — both hang off `spaces` — so the "every table with a
  // tenant column" sweep that produced the entries above never saw them, exactly as it never saw
  // the five parent-scoped tables. The consequence is larger here than for a missing file path:
  // space_permissions IS who may do what inside a space, and space_module_permissions IS which
  // modules that space shows. An archive without them restores a space nobody can act in and
  // reports success, because every table it was told about exported cleanly.
  //
  // `identity`, not `configuration`, because a row grants a capability to a user, a group or a
  // custom role — the same thing level_permissions and menu_permissions are one level up, and both
  // of those are already identity. The tier is also what makes the entry SAFE: target_type +
  // target_id is an untyped polymorphic reference into users / user_groups / custom_roles, none of
  // which exist under a different tenant. Identity is never offered cross-organization, so that
  // question is refused before it can be asked; same-organization the ids stay valid untouched and
  // need no remapping at all. Moving either table to another tier without first teaching the
  // remapper about target_id would silently write grants pointing at another tenant's principals.
  // ---------------------------------------------------------------------------------------------

  {
    table: 'space_permissions',
    tenantColumn: null,
    parentScope: {
      column: 'space_id',
      parentTable: 'spaces',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'identity',
    component: 'space_access',
    // After spaces (2), user_groups (2) and custom_roles (1) — all three are referenced.
    insertLevel: 3,
    requires: ['groups', 'roles', 'spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    // Nullable, so the derived default would be `set_null`. Deliberately not: a grant whose user is
    // gone is not a grant with an unknown owner, it is a row still claiming target_type 'user' with
    // a target_id nobody can resolve — an unreadable entry in the authorisation model. Dropping it
    // is the fail-closed answer, and matches fe_shares.shared_with_id.
    userFkPolicy: { user_id: 'skip_row' },
    notes:
      'The ~120 can_* columns of a space. Referenced by nothing, references spaces/users/user_groups/custom_roles.',
  },
  {
    table: 'space_module_permissions',
    tenantColumn: null,
    parentScope: {
      column: 'space_id',
      parentTable: 'spaces',
      parentTenantColumn: 'organization_id',
    },
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    tier: 'identity',
    component: 'space_access',
    insertLevel: 3,
    // Its only foreign key is space_id; target_id is untyped text, not an FK.
    requires: ['spaces'],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    notes:
      'Which modules a space shows, per target. UNIQUE (space_id, target_type, target_id), so restoring twice into the same space is a 23505 the writer reports as a duplicate rather than a failed run.',
  },
];

/**
 * Components whose tables hold encrypted credentials or tokens. Selecting any of them forces
 * archive encryption on: an unencrypted archive of these is a credential dump.
 *
 *   automations   automation_connections (OAuth tokens, webhook secrets)
 *   forms         form_builder_integrations / _webhooks / _payment_configs
 *   ai_config     ai_provider_configs (provider API keys)
 *   mcp           mcp_oauth_grants
 *   org_settings  organization_auth_providers
 *   migration     migration_connections (Jira and Confluence credentials)
 *   test_management_access  test_management_api_keys / _api_tokens (token hashes), ci_servers (Jenkins secrets)
 *   test_automation  test_automation_configs (CI secrets)
 */
export const SECRET_BEARING_COMPONENTS = [
  'automations',
  'forms',
  'ai_config',
  'mcp',
  'org_settings',
  'migration',
  'test_management_access',
  'test_automation',
] as const;

/** True when a selection includes any component that stores credentials. */
export function selectionHasSecrets(components: string[]): boolean {
  return components.some((component) =>
    (SECRET_BEARING_COMPONENTS as readonly string[]).includes(component),
  );
}

/** Distinct component keys, in registry order. */
export function listComponentKeys(): string[] {
  const seen = new Set<string>();

  for (const entry of COMPONENT_REGISTRY) {
    seen.add(entry.component);
  }

  return [...seen];
}

/** Tables belonging to one component key. */
export function tablesForComponent(component: string): ComponentTable[] {
  return COMPONENT_REGISTRY.filter((entry) => entry.component === component);
}

export function isKnownComponent(component: string): boolean {
  return COMPONENT_REGISTRY.some((entry) => entry.component === component);
}

/**
 * A selection closed over the components its tables depend on.
 *
 * `requires` is declared per table and names components: form submissions
 * require the forms they belong to, site studio leads require the pages that
 * captured them. A scheme that omits the parents produces an archive whose rows
 * reference ids that are in no archive at all, so restoring them into ANOTHER
 * organization cannot rebuild those references. (Restoring back into their own
 * organization is unaffected -- the parent rows are still sitting there.)
 *
 * DELIBERATELY NOT APPLIED WHEN A SCHEME IS SAVED. Do not reinstate that.
 *
 * It used to be, and the cost was worse than the problem it solved: ticking
 * `tasks` silently stored six components and backed up twenty tables, the
 * widened list was what got written, and so reopening the scheme showed six
 * ticked with the operator's real choice gone. Unticking a required component
 * put it straight back, which meant a selection could only ever grow.
 *
 * The restore half settled this the other way and is the precedent to follow:
 * `buildRestorePlan` sets `addedAsDependency: false` for everything and REPORTS
 * absent parents as `missingParentComponents` instead of quietly adding them --
 * "a restore that silently grew from one table to forty is not one the operator
 * agreed to". Capture now behaves the same. A narrow archive is a choice the
 * operator made and can see.
 *
 * Still exported because naming the parents is exactly what a "these components
 * are missing" hint needs. Use it to TELL someone, never to decide for them.
 *
 * Transitive, and terminates on the registry rather than on names: a `requires`
 * entry naming a component no table declares is ignored rather than looped on.
 * Input components are returned untouched, including unrecognised ones, so a
 * caller's own validation still sees what it was given.
 */
export function componentsWithParents(components: string[]): string[] {
  const closed = new Set(components);
  const queue = [...components];

  while (queue.length) {
    const component = queue.shift() as string;

    for (const entry of tablesForComponent(component)) {
      for (const parent of entry.requires) {
        if (isKnownComponent(parent) && !closed.has(parent)) {
          closed.add(parent);
          queue.push(parent);
        }
      }
    }
  }

  return [...closed];
}

/**
 * Table name -> registry entry. Built once; the registry is a module-level constant.
 *
 * The engine needs this because a run item carries only `table_name`, while the tenant column is a
 * property of the table: seven tables are scoped by `organizationid`, not `organization_id`.
 */
const BY_TABLE: ReadonlyMap<string, ComponentTable> = new Map(
  COMPONENT_REGISTRY.map((entry) => [entry.table, entry]),
);

/**
 * The registry entry for one table, or null when it is not a table we back up.
 *
 * Callers must handle null rather than assuming `organization_id`. Defaulting the tenant column is
 * what made the seven `organizationid` tables unexportable — every read of them would have failed
 * with PostgREST 42703 the moment a run got far enough to reach them.
 */
export function tableEntry(table: string): ComponentTable | null {
  return BY_TABLE.get(table) ?? null;
}

/**
 * The table's OWN space column, or null when it has none.
 *
 * Exactly what the old optional `spaceColumn` was, so the callers that only want the simple answer
 * do not have to switch on the union. Returns null for `organization`, `self` and `parent` alike —
 * none of them carry a space column of their own, though they mean very different things, which is
 * why anything deciding whether to FILTER must read `spaceScope` rather than this.
 */
export function ownSpaceColumn(
  entry: ComponentTable,
): 'space_id' | 'spaceid' | null {
  return entry.spaceScope.kind === 'own' ? entry.spaceScope.column : null;
}

/** The parent a table inherits its space from, or null when it does not inherit one. */
export function spaceParentOf(entry: ComponentTable): SpaceParentScope | null {
  return entry.spaceScope.kind === 'parent' ? entry.spaceScope.scope : null;
}

export function isHardExcluded(table: string): boolean {
  return (HARD_EXCLUDED_RELATIONS as readonly string[]).includes(table);
}

/**
 * How a table behaves when a restore is narrowed to one space, as the UI needs to say it.
 *
 * Three values rather than the union's four because `self` is an implementation detail of one
 * table: `spaces` restores the chosen space, which from the operator's side is simply "this lands
 * in your space". What they must be able to tell apart is the pair that looks identical in the
 * picker and behaves oppositely — a table with no space column because it belongs to the whole
 * organization, and one with no space column because its space is on its parent.
 */
export type TableScopeLabel = 'org' | 'space' | 'space_via_parent';

export function tableScopeLabel(entry: ComponentTable): TableScopeLabel {
  switch (entry.spaceScope.kind) {
    case 'organization':
      return 'org';
    case 'parent':
      return 'space_via_parent';
    default:
      return 'space';
  }
}

/**
 * Tables Postgres numbers itself, which a restore cannot put back as they were. Currently EMPTY.
 *
 * It held `support_requests` and `migration_logs`. Both were GENERATED ALWAYS AS IDENTITY, and
 * PostgREST cannot emit `OVERRIDING SYSTEM VALUE`, so an archived value made Postgres answer
 * `428C9` — which `classifyInsertError` files as table-wide, failing the WHOLE table. Refusing them
 * here was the honest answer to that, but it meant two tables were archived on every backup and
 * restorable from none.
 *
 * `20260813140000_restore_identity_columns.sql` moves both columns to GENERATED BY DEFAULT, which
 * accepts an explicit value while leaving the sequence as the default for ordinary inserts. The
 * archived numbers now write back, so neither table belongs here any more.
 *
 * EMPTY, AND STILL CHECKED — deliberately, exactly as `SEQUENCE_PRIMARY_KEY_TABLES` below is. A
 * future column added as GENERATED ALWAYS is then refused by a guard that already exists, instead
 * of failing an entire table at insert time until somebody remembers this list.
 *
 * Note this list was never about crossing organizations — it happened to double as that guard
 * because it sits in `remapSpecFor`'s early returns. Emptying it therefore had to be paired with
 * `CROSS_ORG_EXCLUDED_TABLES` in `restore-id-remapper.ts`, which states that reason on its own
 * terms. See its docblock.
 *
 * Lives here rather than in the planner because it is a fact ABOUT A TABLE, and the registry is
 * where table facts belong — it is also the bottom of this module's dependency graph, so the planner
 * and this projection can both read it without either importing the other. `restore-planner.ts`
 * re-exports it, so its existing importers are unaffected.
 */
export const IDENTITY_COLUMN_TABLES = [] as const;

/**
 * Restorable tables the engine will not carry into a different space. Currently EMPTY.
 *
 * It held `automation_event_outbox` and no longer does — see `SEQUENCE_REKEYED_TABLES` below, which
 * carries it instead and moves it rather than refusing it. What that refusal cost is the reason this
 * constant is kept rather than deleted: every space-move restore reported 44 rows as "Belongs to
 * another space" against destinations that held none, on ten consecutive runs.
 *
 * The bar for adding a table here is now explicit, because the old entry cleared only half of it:
 *
 *  - A sequence-numbered key is NOT sufficient. `id bigint DEFAULT nextval(...)` with
 *    `attidentity = ''` is a plain default, so omitting the column lets the destination assign one.
 *    (`GENERATED ALWAYS` is the genuinely unwritable case — PostgREST cannot emit
 *    `OVERRIDING SYSTEM VALUE` and the insert answers `428C9`. That is `IDENTITY_COLUMN_TABLES`.)
 *  - A table belongs here only when re-scoping it would be UNSAFE and the hazard cannot be
 *    neutralised on the row itself. The outbox's hazard could be: the relay drain
 *    (`automations/automation-tick.service.ts`) selects `relayed_at IS NULL` with no organization or
 *    space filter, so guaranteeing `relayed_at` non-null puts a restored row permanently outside
 *    what the drain can see. That closes both the re-fire and the `occurred_at`-ordering hazards at
 *    once, because the row is never selected at all.
 *
 * `partner_document_sequences` is a different case entirely and stays in
 * `UNMOVABLE_PRIMARY_KEY_TABLES`: no `id` column at all, key is `(organization_id, doc_type, year)`.
 * Verified against `pg_index`; every other restorable table has a single uuid primary key.
 */
export const SEQUENCE_PRIMARY_KEY_TABLES = [] as const;

/**
 * Tables whose primary key the DESTINATION assigns, and what must be neutralised for that to be safe.
 *
 * `key` is stripped from the insert payload so the destination's own sequence issues a fresh value.
 * Stripped LATE — in the insert payload only, never on the row object — because two things upstream
 * still need the archived id: the repeat-restore guard in `restore-table-writer.service.ts`, which
 * looks the row up in `restore_entity_map` by its SOURCE id, and the entity-map capture that records
 * the pair afterwards. Stripping it earlier (in `REISSUED_COLUMNS`, say, which `prepareRow` deletes)
 * nulls that lookup and turns every repeat restore into a duplicating one.
 *
 * `neutraliseWhenNull` names columns that must not arrive null, and is what makes the move safe
 * rather than merely possible. An outbox row with `relayed_at IS NULL` is PENDING WORK: the drain
 * polls every 2 seconds, selects on exactly that predicate with no tenant filter, and matches
 * subscriptions against the row's own `space_id` — which re-scoping has just rewritten. Restoring one
 * untouched would fire the destination space's automations for real: email, Slack, Teams, SMS,
 * webhooks, task mutations. Stamping the column makes the row history instead of work.
 *
 * Only ever applied when the run is genuinely re-keying. A restore back into the SAME space must keep
 * its archived id and collide on `23505` as it always has — reissuing there would insert a second
 * copy of every row instead of recognising it.
 */
export const SEQUENCE_REKEYED_TABLES: Readonly<
  Record<string, { key: string; neutraliseWhenNull: readonly string[] }>
> = {
  automation_event_outbox: { key: 'id', neutraliseWhenNull: ['relayed_at'] },
};

/** The re-key rule for this table, or undefined when the destination does not assign its key. */
export function sequenceRekeyFor(
  table: string,
): { key: string; neutraliseWhenNull: readonly string[] } | undefined {
  return SEQUENCE_REKEYED_TABLES[table];
}

/** No surrogate key to reissue — the key IS `(organization_id, doc_type, year)`. */
export const UNMOVABLE_PRIMARY_KEY_TABLES = [
  'partner_document_sequences',
] as const;

/**
 * Columns the destination must reissue, because their uniqueness is GLOBAL.
 *
 *     CREATE UNIQUE INDEX automations_webhook_token_key
 *       ON public.automations USING btree (webhook_token);   -- no organization_id, no space_id
 *
 * Re-scoping mints a fresh uuid per row, so a PRIMARY KEY collision is impossible — which leaves
 * exactly one unique index that a restored automation can hit, and it is not scoped to a tenant.
 * The archived token still belongs to the row it was backed up from, Postgres answers `23505`, and
 * `classifyInsertError` files that under `duplicate`: a row reported "already present" when the
 * destination space is empty and nothing of the sort is present.
 *
 * The automation is then never written, and everything keyed to its minted id fails `23503`. On run
 * d462c3a9 that was 13 `automation_versions`, 95 `automation_runs` and 8
 * `automation_event_subscriptions` — 116 rows from one column, recurring on every retry because the
 * token is copied verbatim each time.
 *
 * Stripped rather than nulled, exactly as generated columns are, so the destination applies any
 * default it has. `webhook_token` has none and is nullable, so a restored automation arrives without
 * a webhook until one is configured. Minting a token here instead would invent a credential the
 * application owns.
 *
 * ## The audit the note above asked for, now done
 *
 * Two questions decide each candidate, and BOTH must be yes: is clearing the column legal, and does
 * the application reissue it? Nullability only answers the first, and answering only the first is how
 * a wrong skip becomes silent data loss. One of the eight passed.
 *
 * ADDED — `fe_shares.token`. Nullable, and genuinely reissued: `file-explorer.service.ts` mints it as
 * `randomBytes(32).toString('base64url')` whenever a share is created. It is also the one case where
 * clearing is the MORE correct answer — carrying the archived token into another space would let the
 * link handed out for the original row open the restored one.
 *
 * REJECTED, and why, so nobody "finishes the job" and takes a published site down:
 *
 *   - `site_studio_funnels.sub_domain_name` — nullable, but AUTHOR-SUPPLIED, never generated
 *     (`funnels.service.ts` reads it straight off the DTO). It is the funnel's public address and
 *     `middleware.ts` routes live visitor traffic by it. Clearing it unpublishes a working site.
 *   - `site_studio_funnels.preview_subdomain` — generated, but only by `generatePreviewSubdomain()` at
 *     CREATE. A restore cannot call it, so stripping leaves null rather than a fresh value, and
 *     `funnels.service.ts` is explicit that with both subdomains null the funnel "has NO address at
 *     all": `getProductionUrl()` returns '' and the editor then silently hides its "visit site" link.
 *     A restore that produces an unreachable funnel AND hides the symptom is worse than the skip.
 *   - `form_builder_orders.stripe_checkout_session_id` — nullable, but issued by STRIPE and used as
 *     the webhook's lookup key (`form-builder-payments.service.ts` selects `.eq()` on it). Clearing it
 *     orphans the order from payment reconciliation permanently.
 *   - `automation_oauth_states.state_token`, `invitations.token`,
 *     `partner_onprem_installations.activation_code`, `site_studio_domains.domain` — all NOT NULL with
 *     no default, so stripping converts a `duplicate` skip into a `missing_required_column` failure:
 *     strictly worse. Two of them are not defects at all — a DNS domain and an activation code are
 *     GENUINELY globally unique, so refusing the second copy is correct, not a bug to fix.
 *
 * Uniques scoped by a parent id (board_id, form_id, plan_id) are safe — the parent moves with the row.
 *
 * ## Known limitation, inherited rather than introduced
 *
 * This strip is UNCONDITIONAL — `prepareRow` applies it on every restore, re-keying or not. Restoring
 * a deleted row back into its OWN space therefore clears a column that had nothing to collide with,
 * because the row that held the value is gone. That is a real if minor loss (a share link, a webhook
 * token) and it applies to `automations.webhook_token` today exactly as it will to `fe_shares.token`.
 * Making it conditional on re-keying — the way `SEQUENCE_REKEYED_TABLES` already is — would fix both,
 * but it changes established behaviour for automations and belongs in its own change.
 */
export const REISSUED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  automations: ['webhook_token'],
  fe_shares: ['token'],
};

/**
 * Globally-unique columns stripped ONLY when the rows cross into a different organization.
 *
 * Separate from `REISSUED_COLUMNS` because the trigger is different, and conflating the two would
 * break a working row. The columns above collide with themselves whatever the destination, so they
 * are always stripped. These collide only with ANOTHER TENANT: the index carries no
 * `organization_id`, so the archived value is unique across the whole installation and a copy of it
 * can never be written a second time.
 *
 *     site_studio_funnels_preview_subdomain_key           (preview_subdomain)
 *     site_studio_funnels_sub_domain_name_key             (sub_domain_name)
 *     form_builder_orders_stripe_checkout_session_id_key  (stripe_checkout_session_id)
 *
 * That cost eleven funnels on a real cross-organization restore, reported as duplicates against rows
 * the destination organization had never seen — and eleven `site_studio_pages` behind them, since
 * `(funnel_id, path_name)` collides once the funnel it belongs to has not moved.
 *
 * Stripping them within ONE organization would be the opposite of a fix. A space move rewrites the
 * row's id but the subdomain is still that funnel's own address, so removing it would take a working
 * site off the air to avoid a collision that only exists because the row is being copied on purpose.
 *
 * Every column here is NULLABLE with no default — verified against `information_schema`, and the
 * property that makes stripping legal at all: `reissuedColumnsFor` DELETES rather than nulls, so a
 * NOT NULL column with no default would turn a `23505` into a `23502`. A subdomain absent is a
 * funnel that has not been published yet, which is the correct state for one that has just arrived
 * in a tenant that never owned its address.
 */
export const CROSS_ORG_REISSUED_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  site_studio_funnels: ['preview_subdomain', 'sub_domain_name'],
  form_builder_orders: ['stripe_checkout_session_id'],

  // `invitations_token_key` is a global unique index with no `organization_id`, so the archived
  // token can never be written a second time — but the collision is not the important half.
  //
  // The token is a LIVE CREDENTIAL: accepting the link it appears in grants access immediately.
  // Carried into another tenant it would mean a link one organization issued now opens a different
  // one. Stripped, the destination mints its own from the column default — the same 32 random
  // bytes as hex the application already generates.
  //
  // Cross-organization ONLY, like its neighbours here and unlike `REISSUED_COLUMNS` above. Within
  // one organization the archived token is still this invitation's own address, and regenerating it
  // would silently invalidate a link somebody is holding.
  invitations: ['token'],
};

/** @see CROSS_ORG_REISSUED_COLUMNS */
export function crossOrgReissuedColumnsFor(table: string): readonly string[] {
  return CROSS_ORG_REISSUED_COLUMNS[table] ?? [];
}

/** Columns this table must not carry into a restore. Empty for almost every table. */
export function reissuedColumnsFor(table: string): readonly string[] {
  return REISSUED_COLUMNS[table] ?? [];
}

/**
 * Whether the restore engine will accept this table at all.
 *
 * Mirrors `refuseTable()` in `engine/restore-planner.ts` exactly, and exists so the picker can
 * disable what the server is going to refuse rather than let an operator tick it and discover the
 * refusal at Preview — after choosing an archive, a destination and, cross-organization, somebody
 * else's approval.
 *
 * `identity` is reported as refusable here because this projection has no session to ask about
 * approval. A run that HAS identity approval is the rarer path and is still authorised server-side;
 * showing those tables as unavailable is the safe direction to be wrong in.
 *
 * Deliberately duplicated rather than imported: the registry is the bottom of the dependency graph
 * and importing the planner into it would invert that. The pairing is asserted in
 * `engine/restore-planner.spec.ts` ("tableRestorable mirrors refuseTable") — over there rather than
 * in the registry spec, for the same dependency reason — so the two cannot drift silently.
 *
 * That test was claimed here long before it existed. It does now.
 */
/**
 * Why a table is not restorable, or `null` when it is.
 *
 * The same three tests `tableRestorable` has always made, returning WHICH one failed instead of a
 * bare boolean. The picker needs the distinction: `identity_tier` is a permission the operator may
 * hold, `identity_column` can never be satisfied by anyone, and telling an operator to go find a
 * permission that would not help is worse than saying nothing.
 *
 * Codes match `refuseTable()` in `engine/restore-planner.ts`, which states the same three verdicts
 * for the engine. That function is session-aware and this one cannot be — it is built once, with no
 * request to ask — so `identity_tier` here means "needs the permission", not "was denied".
 */
export type RestoreRefusalCode =
  | 'identity_column'
  | 'identity_tier'
  | 'not_restorable_by_default';

export function tableRestoreRefusal(
  entry: ComponentTable,
): RestoreRefusalCode | null {
  if ((IDENTITY_COLUMN_TABLES as readonly string[]).includes(entry.table)) {
    return 'identity_column';
  }

  if (entry.tier === 'identity') {
    return 'identity_tier';
  }

  return entry.restoreByDefault ? null : 'not_restorable_by_default';
}

/**
 * Delegates to {@link tableRestoreRefusal} rather than repeating its three tests.
 *
 * Behaviour is unchanged. The registry already carries three hand-synchronised predicates over
 * these same fields — `tableRestorable`, `refuseTable` and `remapSpecFor` — and a fourth copy is
 * how the next one drifts.
 */
export function tableRestorable(entry: ComponentTable): boolean {
  return tableRestoreRefusal(entry) === null;
}

/** The registry projected as tier -> component -> tables, for the UI's selection tree. */
export function buildComponentTree(): {
  tiers: {
    tier: BackupTier;
    components: {
      component: string;
      tables: string[];
      /**
       * Scope per table name.
       *
       * Keyed by table rather than parallel to `tables` so a reordering cannot shift every
       * classification by one. Sent per TABLE and never rolled up per component because 17 of the
       * 52 components hold both kinds at once — `statuses` carries space-scoped `task_statuses`
       * beside organization-level `resolutions` — and a single verdict would be wrong about them.
       */
      tableScopes: Record<string, TableScopeLabel>;
      /**
       * Whether each table can be restored at all, keyed by table for the same reason `tableScopes`
       * is: a per-component verdict would be wrong about the components that hold both kinds.
       * `attachments` is exactly that case — eight restorable tables beside
       * `space_gdpr_record_attachments`, which is not.
       *
       * Sent so the picker can DISABLE what the engine is going to refuse. Without it the operator
       * ticks the component, and the refusal arrives at Preview — after the archive, the destination
       * and, cross-organization, somebody else's approval.
       */
      tableRestorable: Record<string, boolean>;
      /**
       * Why each unrestorable table is unrestorable. Absent for tables that ARE restorable, so this
       * is a strictly sparser map than `tableRestorable`, not a parallel one.
       *
       * Sent because the picker has to word the refusal. `tableRestorable: false` alone cannot tell
       * "you need a permission" apart from "the database generates this column and nobody can write
       * it", and those two want opposite things from the operator.
       */
      tableRestoreRefusal: Partial<Record<string, RestoreRefusalCode>>;
      /**
       * Other components this one's tables cannot be fully restored without, unioned across every
       * table the component holds and stripped of self-references.
       *
       * Exists so the picker can offer the same fix `restore-planner.ts`'s `requiredComponents()`
       * already computes server-side, but BEFORE the operator runs a preview and loses every row to
       * `unmapped_reference` instead of after. Selecting `form_submissions` without `forms` refused
       * every row in five tables; the picker now knows to pull `forms` in with it.
       */
      requires: string[];
    }[];
  }[];
} {
  const tiers: BackupTier[] = [
    'content',
    'configuration',
    'binary_files',
    'identity',
  ];

  return {
    tiers: tiers.map((tier) => {
      const byComponent = new Map<string, string[]>();
      const scopes = new Map<string, Record<string, TableScopeLabel>>();
      const restorable = new Map<string, Record<string, boolean>>();
      const refusals = new Map<
        string,
        Partial<Record<string, RestoreRefusalCode>>
      >();
      const requires = new Map<string, Set<string>>();

      for (const entry of COMPONENT_REGISTRY) {
        if (entry.tier !== tier) continue;

        const tables = byComponent.get(entry.component) ?? [];

        tables.push(entry.table);
        byComponent.set(entry.component, tables);

        const forComponent = scopes.get(entry.component) ?? {};

        forComponent[entry.table] = tableScopeLabel(entry);
        scopes.set(entry.component, forComponent);

        const restorableFor = restorable.get(entry.component) ?? {};

        const refusal = tableRestoreRefusal(entry);

        restorableFor[entry.table] = refusal === null;
        restorable.set(entry.component, restorableFor);

        // Only unrestorable tables get a key. A restorable one carrying `undefined` would make the
        // map look parallel to `tableRestorable` and invite `Object.keys()` as a refusal count.
        if (refusal !== null) {
          const refusalFor = refusals.get(entry.component) ?? {};

          refusalFor[entry.table] = refusal;
          refusals.set(entry.component, refusalFor);
        }

        const requiresFor = requires.get(entry.component) ?? new Set<string>();

        for (const required of entry.requires) {
          if (required !== entry.component) {
            requiresFor.add(required);
          }
        }
        requires.set(entry.component, requiresFor);
      }

      return {
        tier,
        components: [...byComponent.entries()].map(([component, tables]) => ({
          component,
          tables,
          tableScopes: scopes.get(component) ?? {},
          tableRestorable: restorable.get(component) ?? {},
          tableRestoreRefusal: refusals.get(component) ?? {},
          requires: [...(requires.get(component) ?? [])],
        })),
      };
    }),
  };
}
