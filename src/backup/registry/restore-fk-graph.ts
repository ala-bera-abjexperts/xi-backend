/**
 * @fileoverview Which column of which restorable table points at which other restorable table.
 * @module src/backup/registry/restore-fk-graph
 *
 * GENERATED from `pg_constraint`. Do not hand-edit — regenerate it (see below) when the schema
 * changes, or a column added to the database will silently keep pointing at the source tenant's row
 * after a restore.
 *
 * ## Why this exists
 *
 * Restoring into a space or an organization the rows did not come from cannot preserve ids: the
 * originals are still in use where they were archived from, so every row is written under a new one.
 * Every column that referred to an old id has to be rewritten to the new one, and until this file
 * existed the only description of those columns was a hand-written list of thirteen tables in
 * `CROSS_ORG_REMAP_SPECS`. A table missing from it was not partially restored — it was refused
 * outright, one row at a time, as `other_space`. That is why a form could be restored into another
 * space while its own fields, webhooks and integrations could not.
 *
 * ## What is in here, and what is deliberately not
 *
 * Only edges where BOTH ends are tables the backup registry knows how to restore — 251 of them.
 * Those are the only references that can ever be re-pointed, because a new id exists only for a row
 * this run actually wrote.
 *
 * The other 414 foreign keys out of these tables land on just five tables, none of which a restore
 * writes, and each already has an older answer that this file must not second-guess:
 *
 *  - `users` (236 edges) — `userFkPolicy` decides per column whether a missing user nulls the column
 *    or skips the row. A restore never creates a user.
 *  - `organizations` (171) — the tenant column, set from the destination and checked before that.
 *  - `organization_licenses` (4), `mcp_oauth_clients` (2), `license_plans` (1) — organization-level
 *    records that are not part of any restore.
 *
 * ## `spaces` is in here, and must never be treated as remappable
 *
 * `spaces` IS a restorable table, so 60-odd `space_id -> spaces` edges appear below. They are
 * correct as a description of the schema and dangerous as an instruction: a destination space is
 * CHOSEN by the operator, not minted by the run. The consumer is responsible for setting the space
 * column from the destination and never looking it up here. The edges are kept rather than filtered
 * out so that this file stays a faithful account of the database and the policy stays visible in
 * code, where it can be read and tested.
 *
 * ## Regenerating
 *
 * Run against the database and replace the array below:
 *
 * ```sql
 * select src.relname, srccol.attname, tgt.relname, a.attnotnull
 * from pg_constraint c
 * join pg_class src on src.oid = c.conrelid
 * join pg_class tgt on tgt.oid = c.confrelid
 * join pg_namespace n on n.oid = src.relnamespace
 * join unnest(c.conkey) with ordinality as k(attnum, ord) on true
 * join pg_attribute srccol on srccol.attrelid = src.oid and srccol.attnum = k.attnum
 * join pg_attribute a on a.attrelid = src.oid and a.attnum = k.attnum
 * where c.contype = 'f' and n.nspname = 'public'
 *   and src.relname = any($registryTables) and tgt.relname = any($registryTables);
 * ```
 */

export interface RestoreFkEdge {
  /** The table carrying the column. */
  table: string;

  /** The column holding the reference. */
  column: string;

  /** The table it points at. Always another restorable table. */
  references: string;

  /**
   * Whether the column is NOT NULL.
   *
   * Decides what happens when the target was not re-keyed: a nullable column can be cleared, a
   * required one cannot, so the row is refused instead of written with a reference into the tenant
   * it came from.
   */
  required: boolean;
}

export const RESTORE_FK_GRAPH: RestoreFkEdge[] = [
  {
    table: 'active_timers',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'ai_generated_content',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'ai_generated_content',
    column: 'wiki_page_id',
    references: 'wiki_pages',
    required: false,
  },
  {
    table: 'ai_module_config',
    column: 'default_wiki_parent_id',
    references: 'wiki_pages',
    required: false,
  },
  {
    table: 'ai_module_config',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'ai_wiki_generations',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'ai_wiki_generations',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'ai_wiki_generations',
    column: 'wiki_page_id',
    references: 'wiki_pages',
    required: false,
  },
  {
    table: 'asset_item_attachments',
    column: 'item_id',
    references: 'asset_items',
    required: true,
  },
  {
    table: 'asset_item_changes',
    column: 'item_id',
    references: 'asset_items',
    required: true,
  },
  {
    table: 'asset_item_changes',
    column: 'schema_id',
    references: 'asset_schemas',
    required: true,
  },
  {
    table: 'asset_item_comments',
    column: 'item_id',
    references: 'asset_items',
    required: true,
  },
  {
    table: 'asset_item_relations',
    column: 'relation_type_id',
    references: 'relation_types',
    required: true,
  },
  {
    table: 'asset_item_relations',
    column: 'source_item_id',
    references: 'asset_items',
    required: true,
  },
  {
    table: 'asset_item_relations',
    column: 'target_item_id',
    references: 'asset_items',
    required: true,
  },
  {
    table: 'asset_items',
    column: 'schema_id',
    references: 'asset_schemas',
    required: true,
  },
  {
    table: 'asset_items',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_object_attachments',
    column: 'object_id',
    references: 'asset_objects',
    required: true,
  },
  {
    table: 'asset_object_attachments',
    column: 'schema_id',
    references: 'asset_object_schemas',
    required: true,
  },
  {
    table: 'asset_object_attachments',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_object_changes',
    column: 'object_id',
    references: 'asset_objects',
    required: false,
  },
  {
    table: 'asset_object_changes',
    column: 'schema_id',
    references: 'asset_object_schemas',
    required: true,
  },
  {
    table: 'asset_object_changes',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_object_comments',
    column: 'object_id',
    references: 'asset_objects',
    required: true,
  },
  {
    table: 'asset_object_comments',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_object_key_sequences',
    column: 'schema_id',
    references: 'asset_object_schemas',
    required: true,
  },
  {
    table: 'asset_object_references',
    column: 'attribute_id',
    references: 'asset_object_type_attributes',
    required: false,
  },
  {
    table: 'asset_object_references',
    column: 'relation_type_id',
    references: 'relation_types',
    required: false,
  },
  {
    table: 'asset_object_references',
    column: 'source_object_id',
    references: 'asset_objects',
    required: true,
  },
  {
    table: 'asset_object_references',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_object_references',
    column: 'target_object_id',
    references: 'asset_objects',
    required: true,
  },
  {
    table: 'asset_object_schemas',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_object_task_links',
    column: 'object_id',
    references: 'asset_objects',
    required: true,
  },
  {
    table: 'asset_object_task_links',
    column: 'relation_type_id',
    references: 'relation_types',
    required: false,
  },
  {
    table: 'asset_object_task_links',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_object_task_links',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'asset_object_type_attributes',
    column: 'object_type_id',
    references: 'asset_object_types',
    required: true,
  },
  {
    table: 'asset_object_type_attributes',
    column: 'reference_object_type_id',
    references: 'asset_object_types',
    required: false,
  },
  {
    table: 'asset_object_type_attributes',
    column: 'reference_type_id',
    references: 'relation_types',
    required: false,
  },
  {
    table: 'asset_object_type_attributes',
    column: 'schema_id',
    references: 'asset_object_schemas',
    required: true,
  },
  {
    table: 'asset_object_type_attributes',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_object_types',
    column: 'parent_object_type_id',
    references: 'asset_object_types',
    required: false,
  },
  {
    table: 'asset_object_types',
    column: 'schema_id',
    references: 'asset_object_schemas',
    required: true,
  },
  {
    table: 'asset_object_types',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_objects',
    column: 'object_type_id',
    references: 'asset_object_types',
    required: true,
  },
  {
    table: 'asset_objects',
    column: 'schema_id',
    references: 'asset_object_schemas',
    required: true,
  },
  {
    table: 'asset_objects',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'asset_schema_custom_fields',
    column: 'custom_field_id',
    references: 'custom_fields',
    required: true,
  },
  {
    table: 'asset_schema_custom_fields',
    column: 'schema_id',
    references: 'asset_schemas',
    required: true,
  },
  {
    table: 'asset_schemas',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'automation_connections',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'automation_event_outbox',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'automation_event_subscriptions',
    column: 'automation_id',
    references: 'automations',
    required: true,
  },
  {
    table: 'automation_event_subscriptions',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'automation_oauth_states',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'automation_runs',
    column: 'automation_id',
    references: 'automations',
    required: true,
  },
  {
    table: 'automation_runs',
    column: 'automation_version_id',
    references: 'automation_versions',
    required: true,
  },
  {
    table: 'automation_runs',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'automation_versions',
    column: 'automation_id',
    references: 'automations',
    required: true,
  },
  {
    table: 'automation_versions',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'automations',
    column: 'current_version_id',
    references: 'automation_versions',
    required: false,
  },
  {
    table: 'automations',
    column: 'published_version_id',
    references: 'automation_versions',
    required: false,
  },
  {
    table: 'automations',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'boards',
    column: 'filter_id',
    references: 'saved_filters',
    required: false,
  },
  { table: 'boards', column: 'space_id', references: 'spaces', required: true },
  {
    table: 'business_processes',
    column: 'parent_id',
    references: 'business_processes',
    required: false,
  },
  {
    table: 'business_processes',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'calculation_results',
    column: 'business_process_id',
    references: 'business_processes',
    required: false,
  },
  {
    table: 'custom_fields',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'dashboard_activity_log',
    column: 'dashboard_id',
    references: 'dashboards',
    required: true,
  },
  {
    table: 'dashboard_permissions',
    column: 'dashboard_id',
    references: 'dashboards',
    required: true,
  },
  {
    table: 'dashboards',
    column: 'cloned_from_dashboard_id',
    references: 'dashboards',
    required: false,
  },
  {
    table: 'dashboards',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'entity_file_links',
    column: 'node_id',
    references: 'fe_nodes',
    required: true,
  },
  {
    table: 'entity_file_links',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'fe_labels',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'fe_nodes',
    column: 'current_version_id',
    references: 'fe_versions',
    required: false,
  },
  {
    table: 'fe_nodes',
    column: 'parent_id',
    references: 'fe_nodes',
    required: false,
  },
  {
    table: 'fe_nodes',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'fe_reminders',
    column: 'node_id',
    references: 'fe_nodes',
    required: true,
  },
  {
    table: 'fe_shares',
    column: 'node_id',
    references: 'fe_nodes',
    required: true,
  },
  {
    table: 'fe_versions',
    column: 'node_id',
    references: 'fe_nodes',
    required: true,
  },
  {
    table: 'field_groups',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'file_attachments',
    column: 'current_version_id',
    references: 'file_versions',
    required: false,
  },
  {
    table: 'file_attachments',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'file_versions',
    column: 'attachment_id',
    references: 'file_attachments',
    required: true,
  },
  {
    table: 'form_builder',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_approval_steps',
    column: 'approval_id',
    references: 'form_builder_approvals',
    required: true,
  },
  {
    table: 'form_builder_approval_steps',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_approvals',
    column: 'form_id',
    references: 'form_builder',
    required: true,
  },
  {
    table: 'form_builder_approvals',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_approvals',
    column: 'submission_id',
    references: 'form_builder_submissions',
    required: true,
  },
  {
    table: 'form_builder_assignments',
    column: 'completed_submission_id',
    references: 'form_builder_submissions',
    required: false,
  },
  {
    table: 'form_builder_assignments',
    column: 'form_id',
    references: 'form_builder',
    required: true,
  },
  {
    table: 'form_builder_assignments',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_fields',
    column: 'form_id',
    references: 'form_builder',
    required: true,
  },
  {
    table: 'form_builder_fields',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_integration_deliveries',
    column: 'integration_id',
    references: 'form_builder_integrations',
    required: true,
  },
  {
    table: 'form_builder_integration_deliveries',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_integration_deliveries',
    column: 'submission_id',
    references: 'form_builder_submissions',
    required: false,
  },
  {
    table: 'form_builder_integrations',
    column: 'form_id',
    references: 'form_builder',
    required: true,
  },
  {
    table: 'form_builder_integrations',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },

  // `form_builder_orders` was ABSENT from this file entirely, and `restore-planner.ts` still cites
  // "pg_constraint returns not one foreign key for form_builder_orders" as the reason for the
  // hand-written LOGICAL_DEPENDENCIES entry that stands in for it. That was true when this file was
  // generated and is not true now — re-verified against pg_constraint on 2026-08-13, which returns
  // all three edges below. The hand-written spec in `restore-id-remapper.ts` declared these
  // references separately, which is the only reason the omission was not losing rows.
  //
  // A whole-file regeneration was checked at the same time: of the 42 registry tables with no entry
  // here, this is the ONLY one that has foreign keys it should have carried. The other 41 point at
  // `organizations`/`users` alone, which this file excludes by design.
  {
    table: 'form_builder_orders',
    column: 'form_id',
    references: 'form_builder',
    required: true,
  },
  {
    table: 'form_builder_orders',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_orders',
    column: 'submission_id',
    references: 'form_builder_submissions',
    required: false,
  },
  {
    table: 'form_builder_submissions',
    column: 'form_id',
    references: 'form_builder',
    required: true,
  },
  {
    table: 'form_builder_submissions',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_submissions',
    column: 'task_id',
    references: 'tasks',
    required: false,
  },

  // Present in the live schema (`form_builder_versions_form_id_fkey`) but absent from the
  // generated snapshot this file carried. Without it, a space move re-keyed the version row but
  // kept `form_id` pointed at the source-space form, so `(form_id, version_number)` collided with
  // the original version outside the selected target space.
  {
    table: 'form_builder_versions',
    column: 'form_id',
    references: 'form_builder',
    required: true,
  },
  {
    table: 'form_builder_webhook_deliveries',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'form_builder_webhook_deliveries',
    column: 'submission_id',
    references: 'form_builder_submissions',
    required: false,
  },
  {
    table: 'form_builder_webhook_deliveries',
    column: 'webhook_id',
    references: 'form_builder_webhooks',
    required: true,
  },
  {
    table: 'form_builder_webhooks',
    column: 'form_id',
    references: 'form_builder',
    required: true,
  },
  {
    table: 'form_builder_webhooks',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'gdpr_record_attachments',
    column: 'record_id',
    references: 'gdpr_records',
    required: true,
  },
  {
    table: 'gdpr_record_changes',
    column: 'attachment_id',
    references: 'gdpr_record_attachments',
    required: false,
  },
  {
    table: 'gdpr_record_changes',
    column: 'comment_id',
    references: 'gdpr_record_comments',
    required: false,
  },
  {
    table: 'gdpr_record_changes',
    column: 'record_id',
    references: 'gdpr_records',
    required: true,
  },
  {
    table: 'gdpr_record_changes',
    column: 'spreadsheet_id',
    references: 'gdpr_spreadsheets',
    required: true,
  },
  {
    table: 'gdpr_record_comments',
    column: 'record_id',
    references: 'gdpr_records',
    required: true,
  },
  {
    table: 'gdpr_records',
    column: 'spreadsheet_id',
    references: 'gdpr_spreadsheets',
    required: true,
  },
  {
    table: 'hierarchy_configurations',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'invitations',
    column: 'custom_role_id',
    references: 'custom_roles',
    required: false,
  },
  {
    table: 'invitations',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'level_field_assignments',
    column: 'custom_field_id',
    references: 'custom_fields',
    required: true,
  },
  {
    table: 'level_field_group_assignments',
    column: 'field_group_id',
    references: 'field_groups',
    required: true,
  },
  {
    table: 'level_permissions',
    column: 'group_id',
    references: 'user_groups',
    required: false,
  },
  {
    table: 'level_permissions',
    column: 'role_id',
    references: 'custom_roles',
    required: false,
  },
  {
    table: 'mcp_idempotency_keys',
    column: 'grant_id',
    references: 'mcp_oauth_grants',
    required: true,
  },
  {
    table: 'mcp_tool_invocations',
    column: 'grant_id',
    references: 'mcp_oauth_grants',
    required: false,
  },
  {
    table: 'menu_permissions',
    column: 'group_id',
    references: 'user_groups',
    required: false,
  },
  {
    table: 'menu_permissions',
    column: 'role_id',
    references: 'custom_roles',
    required: false,
  },
  {
    table: 'migration_entity_map',
    column: 'job_id',
    references: 'migration_jobs',
    required: false,
  },
  {
    table: 'migration_entity_map',
    column: 'run_id',
    references: 'migration_runs',
    required: false,
  },
  {
    table: 'migration_entity_map',
    column: 'source_connection_id',
    references: 'migration_connections',
    required: true,
  },
  {
    table: 'migration_jobs',
    column: 'connection_id',
    references: 'migration_connections',
    required: true,
  },
  {
    table: 'migration_jobs',
    column: 'target_space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'migration_logs',
    column: 'run_id',
    references: 'migration_runs',
    required: true,
  },
  {
    table: 'migration_rate_state',
    column: 'connection_id',
    references: 'migration_connections',
    required: true,
  },
  {
    table: 'migration_run_items',
    column: 'run_id',
    references: 'migration_runs',
    required: true,
  },
  {
    table: 'migration_runs',
    column: 'connection_id',
    references: 'migration_connections',
    required: true,
  },
  {
    table: 'migration_runs',
    column: 'job_id',
    references: 'migration_jobs',
    required: true,
  },
  {
    table: 'partner_contacts',
    column: 'partner_profile_id',
    references: 'partner_profiles',
    required: true,
  },
  {
    table: 'partner_customer_addresses',
    column: 'customer_id',
    references: 'partner_customers',
    required: true,
  },
  {
    table: 'partner_customers',
    column: 'source_lead_id',
    references: 'partner_leads',
    required: false,
  },
  {
    table: 'partner_invoice_items',
    column: 'invoice_id',
    references: 'partner_invoices',
    required: true,
  },
  {
    table: 'partner_invoices',
    column: 'customer_id',
    references: 'partner_customers',
    required: true,
  },
  {
    table: 'partner_invoices',
    column: 'quote_id',
    references: 'partner_quotes',
    required: false,
  },
  {
    table: 'partner_kickback_entries',
    column: 'customer_id',
    references: 'partner_customers',
    required: false,
  },
  {
    table: 'partner_lead_comments',
    column: 'lead_id',
    references: 'partner_leads',
    required: true,
  },
  {
    table: 'partner_license_package_items',
    column: 'package_id',
    references: 'partner_license_packages',
    required: true,
  },
  {
    table: 'partner_offerings',
    column: 'listing_id',
    references: 'partner_public_listings',
    required: true,
  },
  {
    table: 'partner_onprem_installations',
    column: 'customer_id',
    references: 'partner_customers',
    required: false,
  },
  {
    table: 'partner_profiles',
    column: 'backoffice_role_id',
    references: 'custom_roles',
    required: false,
  },
  {
    table: 'partner_public_listings',
    column: 'partner_profile_id',
    references: 'partner_profiles',
    required: true,
  },
  {
    table: 'partner_quote_items',
    column: 'quote_id',
    references: 'partner_quotes',
    required: true,
  },
  {
    table: 'partner_quotes',
    column: 'converted_invoice_id',
    references: 'partner_invoices',
    required: false,
  },
  {
    table: 'partner_quotes',
    column: 'customer_id',
    references: 'partner_customers',
    required: true,
  },
  {
    table: 'partner_quotes',
    column: 'package_id',
    references: 'partner_license_packages',
    required: false,
  },
  {
    table: 'plan_ai_generations',
    column: 'plan_id',
    references: 'plans',
    required: true,
  },
  {
    table: 'plan_ai_generations',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'plan_comments',
    column: 'plan_id',
    references: 'plans',
    required: true,
  },
  {
    table: 'plan_items_deprecated',
    column: 'linked_task_id',
    references: 'tasks',
    required: false,
  },
  {
    table: 'plan_items_deprecated',
    column: 'parent_id',
    references: 'plan_items_deprecated',
    required: false,
  },
  {
    table: 'plan_items_deprecated',
    column: 'plan_id',
    references: 'plans',
    required: true,
  },
  {
    table: 'plan_resource_allocations',
    column: 'plan_id',
    references: 'plans',
    required: true,
  },
  {
    table: 'plan_risks',
    column: 'plan_id',
    references: 'plans',
    required: true,
  },
  {
    table: 'plan_risks',
    column: 'task_id',
    references: 'tasks',
    required: false,
  },
  {
    table: 'plans',
    column: 'filter_id',
    references: 'saved_filters',
    required: false,
  },
  { table: 'plans', column: 'space_id', references: 'spaces', required: true },
  {
    table: 'portfolio_gantt_saved_views',
    column: 'portfolio_id',
    references: 'portfolios',
    required: false,
  },
  {
    table: 'portfolio_management_letters',
    column: 'linked_task_id',
    references: 'tasks',
    required: false,
  },
  {
    table: 'portfolio_management_letters',
    column: 'plan_id',
    references: 'plans',
    required: true,
  },
  {
    table: 'portfolio_management_letters',
    column: 'portfolio_id',
    references: 'portfolios',
    required: true,
  },
  {
    table: 'process_attachments',
    column: 'process_id',
    references: 'business_processes',
    required: true,
  },
  {
    table: 'process_comments',
    column: 'process_id',
    references: 'business_processes',
    required: true,
  },
  {
    table: 'process_diagrams',
    column: 'process_id',
    references: 'business_processes',
    required: true,
  },
  {
    table: 'process_relationships',
    column: 'child_process_id',
    references: 'business_processes',
    required: false,
  },
  {
    table: 'process_relationships',
    column: 'parent_process_id',
    references: 'business_processes',
    required: false,
  },
  {
    table: 'process_relationships',
    column: 'relation_type_id',
    references: 'relation_types',
    required: false,
  },
  {
    table: 'saved_filters',
    column: 'source_filter_id',
    references: 'saved_filters',
    required: false,
  },
  {
    table: 'site_studio_analytics',
    column: 'page_id',
    references: 'site_studio_pages',
    required: true,
  },
  {
    table: 'site_studio_contacts',
    column: 'funnel_id',
    references: 'site_studio_funnels',
    required: true,
  },
  {
    table: 'site_studio_contacts',
    column: 'source_page_id',
    references: 'site_studio_pages',
    required: false,
  },
  {
    table: 'site_studio_domains',
    column: 'funnel_id',
    references: 'site_studio_funnels',
    required: true,
  },
  {
    table: 'site_studio_form_fields',
    column: 'funnel_id',
    references: 'site_studio_funnels',
    required: true,
  },
  {
    table: 'site_studio_pages',
    column: 'funnel_id',
    references: 'site_studio_funnels',
    required: true,
  },
  {
    table: 'space_categories',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_custom_field_overrides',
    column: 'custom_field_id',
    references: 'custom_fields',
    required: true,
  },
  {
    table: 'space_custom_field_overrides',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_gdpr_record_attachments',
    column: 'recordid',
    references: 'space_gdpr_records',
    required: true,
  },
  {
    table: 'space_gdpr_record_attachments',
    column: 'spaceid',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_gdpr_record_changes',
    column: 'recordid',
    references: 'space_gdpr_records',
    required: true,
  },
  {
    table: 'space_gdpr_record_changes',
    column: 'spaceid',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_gdpr_record_changes',
    column: 'spreadsheetid',
    references: 'space_gdpr_spreadsheets',
    required: true,
  },
  {
    table: 'space_gdpr_record_comments',
    column: 'recordid',
    references: 'space_gdpr_records',
    required: true,
  },
  {
    table: 'space_gdpr_record_comments',
    column: 'spaceid',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_gdpr_records',
    column: 'spaceid',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_gdpr_records',
    column: 'spreadsheetid',
    references: 'space_gdpr_spreadsheets',
    required: true,
  },
  {
    table: 'space_gdpr_spreadsheets',
    column: 'spaceid',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_lists',
    column: 'spaceid',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_module_permissions',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_permissions',
    column: 'group_id',
    references: 'user_groups',
    required: false,
  },
  {
    table: 'space_permissions',
    column: 'role_id',
    references: 'custom_roles',
    required: false,
  },
  {
    table: 'space_permissions',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_priority_overrides',
    column: 'priority_id',
    references: 'task_priorities',
    required: true,
  },
  {
    table: 'space_priority_overrides',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_robots',
    column: 'spaceid',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_status_overrides',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'space_status_overrides',
    column: 'status_id',
    references: 'task_statuses',
    required: true,
  },
  {
    table: 'spaces',
    column: 'space_type_id',
    references: 'space_types',
    required: false,
  },
  {
    table: 'sprints',
    column: 'board_id',
    references: 'boards',
    required: true,
  },
  {
    table: 'starred_spaces',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'status_categories',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'support_requests',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'task_attachments',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'task_comments',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'task_hierarchy_configurations',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'task_history',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'task_priorities',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'task_relationships',
    column: 'relation_type_id',
    references: 'relation_types',
    required: true,
  },
  {
    table: 'task_resource_allocations',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'task_status_transitions',
    column: 'from_status_id',
    references: 'task_statuses',
    required: true,
  },
  {
    table: 'task_status_transitions',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'task_status_transitions',
    column: 'to_status_id',
    references: 'task_statuses',
    required: true,
  },
  {
    table: 'task_statuses',
    column: 'category_id',
    references: 'status_categories',
    required: false,
  },
  {
    table: 'task_statuses',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
  {
    table: 'tasks',
    column: 'parent_task_id',
    references: 'tasks',
    required: false,
  },
  {
    table: 'tasks',
    column: 'priority_id',
    references: 'task_priorities',
    required: false,
  },
  {
    table: 'tasks',
    column: 'process_id',
    references: 'business_processes',
    required: false,
  },
  {
    table: 'tasks',
    column: 'resolution_id',
    references: 'resolutions',
    required: false,
  },
  { table: 'tasks', column: 'space_id', references: 'spaces', required: false },
  {
    table: 'tasks',
    column: 'status_id',
    references: 'task_statuses',
    required: false,
  },
  // Test Management. Composite FKs (x_id, space_id, organization_id) list only the id column, like
  // `whiteboard_files` below, and are kept by hand for the same reason.
  {
    table: 'test_automation_configs',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_automation_configs',
    column: 'user_image_id',
    references: 'test_automation_user_images',
    required: false,
  },
  {
    table: 'test_automation_runs',
    column: 'config_id',
    references: 'test_automation_configs',
    required: false,
  },
  {
    table: 'test_automation_runs',
    column: 'execution_id',
    references: 'test_executions',
    required: false,
  },
  {
    table: 'test_automation_runs',
    column: 'plan_id',
    references: 'test_plans',
    required: false,
  },
  {
    table: 'test_automation_runs',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_automation_user_image_approval_votes',
    column: 'approval_id',
    references: 'test_automation_user_image_approvals',
    required: true,
  },
  {
    table: 'test_automation_user_image_approval_votes',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_automation_user_image_approvals',
    column: 'image_id',
    references: 'test_automation_user_images',
    required: true,
  },
  {
    table: 'test_automation_user_image_approvals',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_case_history',
    column: 'case_id',
    references: 'test_cases',
    required: true,
  },
  {
    table: 'test_cases',
    column: 'folder_id',
    references: 'test_folders',
    required: false,
  },
  {
    table: 'test_cases',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_cases',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'test_executions',
    column: 'folder_id',
    references: 'test_folders',
    required: false,
  },
  {
    table: 'test_executions',
    column: 'plan_id',
    references: 'test_plans',
    required: false,
  },
  {
    table: 'test_executions',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_executions',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'test_folders',
    column: 'parent_id',
    references: 'test_folders',
    required: false,
  },
  {
    table: 'test_folders',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_management_api_tokens',
    column: 'key_id',
    references: 'test_management_api_keys',
    required: true,
  },
  {
    table: 'test_management_space_settings',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_plan_tests',
    column: 'case_id',
    references: 'test_cases',
    required: true,
  },
  {
    table: 'test_plan_tests',
    column: 'plan_id',
    references: 'test_plans',
    required: true,
  },
  {
    table: 'test_plans',
    column: 'folder_id',
    references: 'test_folders',
    required: false,
  },
  {
    table: 'test_plans',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_plans',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'test_preconditions',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_preconditions',
    column: 'task_id',
    references: 'tasks',
    required: false,
  },
  {
    table: 'test_run_attempts',
    column: 'run_id',
    references: 'test_runs',
    required: true,
  },
  {
    table: 'test_runs',
    column: 'case_id',
    references: 'test_cases',
    required: true,
  },
  {
    table: 'test_runs',
    column: 'execution_id',
    references: 'test_executions',
    required: true,
  },
  {
    table: 'test_runs',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_set_members',
    column: 'case_id',
    references: 'test_cases',
    required: true,
  },
  {
    table: 'test_set_members',
    column: 'set_id',
    references: 'test_sets',
    required: true,
  },
  {
    table: 'test_sets',
    column: 'folder_id',
    references: 'test_folders',
    required: false,
  },
  {
    table: 'test_sets',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'test_sets',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'test_ticket_links',
    column: 'case_id',
    references: 'test_cases',
    required: false,
  },
  {
    table: 'test_ticket_links',
    column: 'plan_id',
    references: 'test_plans',
    required: false,
  },
  {
    table: 'test_ticket_links',
    column: 'run_id',
    references: 'test_runs',
    required: false,
  },
  {
    table: 'test_ticket_links',
    column: 'set_id',
    references: 'test_sets',
    required: false,
  },
  {
    table: 'test_ticket_links',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'time_entries',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'user_groups',
    column: 'default_role_id',
    references: 'custom_roles',
    required: false,
  },
  {
    table: 'user_role_assignments',
    column: 'role_id',
    references: 'custom_roles',
    required: true,
  },
  // The one composite FK: (whiteboard_id, space_id, organization_id) -> whiteboards(id, space_id,
  // organization_id). Only `whiteboard_id` is an id to remap. The other two are this table's own
  // space and tenant columns, which the restore assigns from the destination (as it does for the
  // parent), so listing them as references into `whiteboards` would describe a lookup that must
  // never happen. Kept by hand: `restore_foreign_key_graph()` skips multi-column keys entirely.
  {
    table: 'whiteboard_files',
    column: 'whiteboard_id',
    references: 'whiteboards',
    required: true,
  },
  // Same composite FK shape as whiteboard_files, kept by hand for the same reason.
  {
    table: 'whiteboard_private_sessions',
    column: 'whiteboard_id',
    references: 'whiteboards',
    required: true,
  },
  // Same composite FK shape as whiteboard_files, kept by hand for the same reason.
  {
    table: 'whiteboard_timers',
    column: 'whiteboard_id',
    references: 'whiteboards',
    required: true,
  },
  // Same composite FK shape as whiteboard_files, kept by hand for the same reason.
  {
    table: 'whiteboard_versions',
    column: 'whiteboard_id',
    references: 'whiteboards',
    required: true,
  },
  {
    table: 'whiteboards',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'wiki_attachments',
    column: 'wiki_page_id',
    references: 'wiki_pages',
    required: true,
  },
  {
    table: 'wiki_page_attachments',
    column: 'wiki_page_id',
    references: 'wiki_pages',
    required: true,
  },
  {
    table: 'wiki_pages',
    column: 'ai_generation_id',
    references: 'ai_generated_content',
    required: false,
  },
  {
    table: 'wiki_pages',
    column: 'category_id',
    references: 'space_categories',
    required: false,
  },
  {
    table: 'wiki_pages',
    column: 'parent_id',
    references: 'wiki_pages',
    required: false,
  },
  {
    table: 'wiki_pages',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  // Composite, like `whiteboard_files` above: (whiteboard_id, space_id, organization_id) ->
  // whiteboards(id, space_id, organization_id). Only `whiteboard_id` is remapped; the other two are
  // this row's own space and tenant. Kept by hand for the same reason. Nullable: set only on the
  // wiki tree's link row for a board.
  {
    table: 'wiki_pages',
    column: 'whiteboard_id',
    references: 'whiteboards',
    required: false,
  },
  {
    table: 'workflow_assignments',
    column: 'space_id',
    references: 'spaces',
    required: true,
  },
  {
    table: 'workflow_assignments',
    column: 'workflow_id',
    references: 'workflows',
    required: true,
  },
  {
    table: 'workflow_health_issues',
    column: 'node_id',
    references: 'workflow_nodes',
    required: false,
  },
  {
    table: 'workflow_health_issues',
    column: 'transition_id',
    references: 'workflow_transitions',
    required: false,
  },
  {
    table: 'workflow_health_issues',
    column: 'workflow_id',
    references: 'workflows',
    required: true,
  },
  {
    table: 'workflow_nodes',
    column: 'status_id',
    references: 'task_statuses',
    required: false,
  },
  {
    table: 'workflow_nodes',
    column: 'workflow_id',
    references: 'workflows',
    required: true,
  },
  {
    table: 'workflow_outbox',
    column: 'task_id',
    references: 'tasks',
    required: true,
  },
  {
    table: 'workflow_outbox',
    column: 'transition_id',
    references: 'workflow_transitions',
    required: false,
  },
  {
    table: 'workflow_publish_jobs',
    column: 'draft_id',
    references: 'workflows',
    required: false,
  },
  {
    table: 'workflow_publish_jobs',
    column: 'target_id',
    references: 'workflows',
    required: true,
  },
  {
    table: 'workflow_transitions',
    column: 'screen_field_group_id',
    references: 'field_groups',
    required: false,
  },
  {
    table: 'workflow_transitions',
    column: 'to_node_id',
    references: 'workflow_nodes',
    required: true,
  },
  {
    table: 'workflow_transitions',
    column: 'workflow_id',
    references: 'workflows',
    required: true,
  },
  {
    table: 'workflows',
    column: 'initial_status_id',
    references: 'task_statuses',
    required: false,
  },
  {
    table: 'workflows',
    column: 'parent_workflow_id',
    references: 'workflows',
    required: false,
  },
  {
    table: 'workflows',
    column: 'space_id',
    references: 'spaces',
    required: false,
  },
];

/**
 * Edges by the table that carries them.
 *
 * Built once at module load. The writer asks per row, and a linear scan of 251 edges per row would
 * be the most expensive thing in a restore of any size.
 */
const BY_TABLE = new Map<string, RestoreFkEdge[]>();

for (const edge of RESTORE_FK_GRAPH) {
  const edges = BY_TABLE.get(edge.table);

  if (edges) {
    edges.push(edge);
  } else {
    BY_TABLE.set(edge.table, [edge]);
  }
}

/** Every reference this table carries into another restorable table. Empty when it carries none. */
export function fkEdgesFor(table: string): RestoreFkEdge[] {
  return BY_TABLE.get(table) ?? [];
}

/** Whether any restorable table points at this one — i.e. re-keying it can orphan something. */
export function isReferencedTable(table: string): boolean {
  return RESTORE_FK_GRAPH.some((edge) => edge.references === table);
}
