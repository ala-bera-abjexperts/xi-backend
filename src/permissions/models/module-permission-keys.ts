/**
 * @fileoverview The whitelist of module permission keys that may be stored in
 * the `space_module_permissions.permissions` JSONB column. The set is the
 * subset of all permission keys that legitimately vary per-space (the rest
 * are space-management/config and live on `space_permissions`).
 *
 * Mirrors `src/models/space-module-permission.model.ts` on the Next.js side
 * — keep both in sync, or drift will cause the backend to silently drop keys.
 *
 * @module src/permissions/models/module-permission-keys
 */

export const MODULE_PERMISSION_KEYS = [
  // Processes
  'can_view_processes',
  'can_create_processes',
  'can_edit_processes',
  'can_delete_processes',
  'can_add_comments_processes',
  'can_delete_comments_processes',
  'can_add_attachments_processes',
  'can_delete_attachments_processes',
  'can_export_data_processes',
  'can_view_custom_fields_processes',
  'can_edit_custom_fields_processes',

  // Tasks
  'can_view_tasks',
  'can_create_tasks',
  'can_edit_tasks',
  'can_delete_tasks',
  'can_assign_tasks',
  'can_add_comments_tasks',
  'can_delete_comments_tasks',
  'can_edit_others_comments_tasks',
  'can_delete_others_comments_tasks',
  'can_add_attachments_tasks',
  'can_delete_attachments_tasks',
  'can_export_data_tasks',
  'can_view_sla',
  'can_manage_sla',
  'can_publish_customer_replies',
  'can_view_custom_fields_tasks',
  'can_edit_custom_fields_tasks',

  // Wiki
  'can_view_wiki_pages',
  'can_create_wiki_pages',
  'can_edit_wiki_pages',
  'can_delete_wiki_pages',
  'can_add_comments_wiki',
  'can_delete_comments_wiki',
  'can_add_attachments_wiki',
  'can_delete_attachments_wiki',
  'can_export_data_wiki',

  // Lists
  'can_view_lists',
  'can_create_lists',
  'can_edit_lists',
  'can_delete_lists',
  'can_add_comments_lists',
  'can_delete_comments_lists',
  'can_add_attachments_lists',
  'can_delete_attachments_lists',
  'can_export_data_lists',
  'can_view_custom_fields_lists',
  'can_edit_custom_fields_lists',

  // Dashboards
  'can_view_dashboards',
  'can_create_dashboards',
  'can_edit_dashboards',
  'can_delete_dashboards',
  'can_add_comments_dashboards',
  'can_delete_comments_dashboards',
  'can_add_attachments_dashboards',
  'can_delete_attachments_dashboards',
  'can_export_data_dashboards',

  // Robot
  'can_view_robot',
  'can_create_robot',
  'can_edit_robot',
  'can_delete_robot',
  'can_add_comments_robot',
  'can_delete_comments_robot',
  'can_add_attachments_robot',
  'can_delete_attachments_robot',
  'can_export_data_robot',

  // GDPR
  'can_view_gdpr',
  'can_edit_gdpr',
  'can_add_comments_gdpr',
  'can_delete_comments_gdpr',
  'can_add_attachments_gdpr',
  'can_delete_attachments_gdpr',
  'can_export_data_gdpr',

  // Risk
  'can_view_risk',
  'can_edit_risk',

  // Boards
  'can_view_boards',
  'can_create_boards',
  'can_edit_boards',
  'can_delete_boards',
  'can_add_comments_boards',
  'can_delete_comments_boards',
  'can_add_attachments_boards',
  'can_delete_attachments_boards',
  'can_export_data_boards',

  // Plans
  'can_view_plans',
  'can_create_plans',
  'can_edit_plans',
  'can_delete_plans',
  'can_add_comments_plans',
  'can_delete_comments_plans',
  'can_add_attachments_plans',
  'can_delete_attachments_plans',
  'can_export_data_plans',

  // Portfolios
  'can_view_portfolios',
  'can_create_portfolios',
  'can_edit_portfolios',
  'can_delete_portfolios',
  'can_manage_portfolio_letters',

  // Resource Planning
  'can_view_resource_planning',
  'can_manage_resource_planning',

  // Heatmap
  'can_view_heatmap',
  'can_edit_heatmap',

  // History
  'can_view_history',

  // Notifications
  'can_view_notifications',
  'can_create_notifications',
  'can_edit_notifications',
  'can_delete_notifications',

  // Custom fields (cross-module)
  'can_view_custom_fields',
  'can_create_custom_fields',
  'can_edit_custom_fields',
  'can_delete_custom_fields',

  // Priorities / Statuses
  'can_view_priorities',
  'can_create_priorities',
  'can_edit_priorities',
  'can_delete_priorities',
  'can_view_statuses',
  'can_create_statuses',
  'can_edit_statuses',
  'can_delete_statuses',

  // Hierarchy
  'can_view_hierarchy',
  'can_create_hierarchy',
  'can_edit_hierarchy',
  'can_delete_hierarchy',

  // Automations
  'can_view_automations',
  'can_create_automations',
  'can_edit_automations',
  'can_delete_automations',
  'can_manage_automation_connections',

  // Workflow builder
  'can_view_status_categories',
  'can_manage_status_categories',
  'can_view_resolutions',
  'can_manage_resolutions',
  'can_view_workflows',
  'can_create_workflows',
  'can_edit_workflows',
  'can_delete_workflows',
  'can_publish_workflows',
  'can_assign_workflows',
  'can_export_workflow',
  'can_import_workflow',

  // Asset management
  'can_view_assets',
  'can_create_assets',
  'can_edit_assets',
  'can_delete_assets',
  'can_manage_assets',

  // File Explorer
  //
  // These were defined on the Next.js side but NOT here, and
  // SpacesService.setModulePermissionOverrides drops any key missing from
  // MODULE_PERMISSION_KEYS_SET without erroring. So an admin configuring
  // per-space File Explorer permissions had the change silently discarded.
  // Same permission family as the production 404 incident that
  // resolveSpaceBaseGrant was introduced to fix.
  'can_view_file_explorer',
  'can_create_file_explorer',
  'can_edit_file_explorer',
  'can_delete_file_explorer',
  'can_share_file_explorer',

  // Form Builder
  'can_view_forms',
  'can_submit_forms',
  'can_create_forms',
  'can_edit_forms',
  'can_delete_forms',
  'can_manage_forms',
  'can_view_form_responses',

  // Whiteboards
  'can_view_whiteboards',
  'can_create_whiteboards',
  'can_edit_whiteboards',
  'can_delete_whiteboards',

  // Test Management
  'can_view_tests',
  'can_create_tests',
  'can_edit_tests',
  'can_delete_tests',
  'can_manage_test_runs',
  'can_execute_tests',
] as const;

export type ModulePermissionKey = (typeof MODULE_PERMISSION_KEYS)[number];

export const MODULE_PERMISSION_KEYS_SET = new Set<string>(
  MODULE_PERMISSION_KEYS,
);

/** Allowed `target_type` values for `space_module_permissions` rows. */
export const ALLOWED_TARGET_TYPES = [
  'base_role',
  'role',
  'group',
  'user',
] as const;

export type AllowedTargetType = (typeof ALLOWED_TARGET_TYPES)[number];

export const ALLOWED_TARGET_TYPES_SET = new Set<string>(ALLOWED_TARGET_TYPES);
