/**
 * @fileoverview Organization-level access control model defining base roles, permission objects,
 * custom roles, user groups, and the permission calculation engine. This is the core RBAC
 * (Role-Based Access Control) implementation that powers all permission checks in the application.
 * Contains 70+ granular permission keys spanning 9 feature modules.
 * @module src/permissions/models/access-control.model
 * @author Prince Jadiya
 */

// ============================================================================
// Base Role Types
// ============================================================================

/**
 * The four base organization roles, ordered by privilege level (owner > admin > member > viewer).
 */
export type IBaseRole = 'owner' | 'admin' | 'member' | 'viewer';

/**
 * Target types for permission assignments (used in the `space_permissions` table).
 */
export type IPermissionTargetType = 'user' | 'role' | 'group' | 'base_role';

// ============================================================================
// Permissions Object - 70+ permission keys
// ============================================================================

/**
 * Comprehensive permissions object containing 70+ boolean permission flags across
 * all feature modules. Each key follows the pattern `can_<action>_<module>`.
 *
 * Modules covered: processes, tasks, wiki, lists, dashboards, robot, gdpr, boards, plans.
 * Cross-cutting concerns: heatmap, settings, user management, roles/groups, spaces,
 * history, notifications, custom fields, priorities, statuses, hierarchy.
 *
 * Supports arbitrary keys via index signature for extensibility.
 */
export interface IPermissionsObject {
  // Processes module
  /** Whether the user can view processes */
  can_view_processes?: boolean;
  /** Whether the user can create new processes */
  can_create_processes?: boolean;
  /** Whether the user can edit existing processes */
  can_edit_processes?: boolean;
  /** Whether the user can delete processes */
  can_delete_processes?: boolean;
  /** Whether the user can add comments on processes */
  can_add_comments_processes?: boolean;
  /** Whether the user can delete comments on processes */
  can_delete_comments_processes?: boolean;
  /** Whether the user can add attachments to processes */
  can_add_attachments_processes?: boolean;
  /** Whether the user can delete attachments from processes */
  can_delete_attachments_processes?: boolean;
  /** Whether the user can export process data */
  can_export_data_processes?: boolean;
  /** Whether the user can view custom fields on processes */
  can_view_custom_fields_processes?: boolean;
  /** Whether the user can edit custom fields on processes */
  can_edit_custom_fields_processes?: boolean;

  // Tasks module
  /** Whether the user can view tasks */
  can_view_tasks?: boolean;
  /** Whether the user can create new tasks */
  can_create_tasks?: boolean;
  /** Whether the user can edit existing tasks */
  can_edit_tasks?: boolean;
  /** Whether the user can delete tasks */
  can_delete_tasks?: boolean;
  /** Whether the user can assign tasks to other users */
  can_assign_tasks?: boolean;
  /** Whether the user can add comments on tasks */
  can_add_comments_tasks?: boolean;
  /** Whether the user can delete comments on tasks */
  can_delete_comments_tasks?: boolean;
  /** Whether the user can edit comments written by other users on tasks */
  can_edit_others_comments_tasks?: boolean;
  /** Whether the user can delete comments written by other users on tasks */
  can_delete_others_comments_tasks?: boolean;
  /** Whether the user can add attachments to tasks */
  can_add_attachments_tasks?: boolean;
  /** Whether the user can delete attachments from tasks */
  can_delete_attachments_tasks?: boolean;
  /** Whether the user can export task data */
  can_export_data_tasks?: boolean;
  /** Whether the user can view custom fields on tasks */
  can_view_sla?: boolean;
  can_manage_sla?: boolean;
  can_publish_customer_replies?: boolean;
  can_view_custom_fields_tasks?: boolean;
  /** Whether the user can edit custom fields on tasks */
  can_edit_custom_fields_tasks?: boolean;

  // Wiki module
  /** Whether the user can view wiki pages */
  can_view_wiki_pages?: boolean;
  /** Whether the user can create new wiki pages */
  can_create_wiki_pages?: boolean;
  /** Whether the user can edit existing wiki pages */
  can_edit_wiki_pages?: boolean;
  /** Whether the user can delete wiki pages */
  can_delete_wiki_pages?: boolean;
  /** Whether the user can add comments on wiki pages */
  can_add_comments_wiki?: boolean;
  /** Whether the user can delete comments on wiki pages */
  can_delete_comments_wiki?: boolean;
  /** Whether the user can add attachments to wiki pages */
  can_add_attachments_wiki?: boolean;
  /** Whether the user can delete attachments from wiki pages */
  can_delete_attachments_wiki?: boolean;
  /** Whether the user can export wiki data */
  can_export_data_wiki?: boolean;

  // Lists module
  /** Whether the user can view lists */
  can_view_lists?: boolean;
  /** Whether the user can create new lists */
  can_create_lists?: boolean;
  /** Whether the user can edit existing lists */
  can_edit_lists?: boolean;
  /** Whether the user can delete lists */
  can_delete_lists?: boolean;
  /** Whether the user can add comments on lists */
  can_add_comments_lists?: boolean;
  /** Whether the user can delete comments on lists */
  can_delete_comments_lists?: boolean;
  /** Whether the user can add attachments to lists */
  can_add_attachments_lists?: boolean;
  /** Whether the user can delete attachments from lists */
  can_delete_attachments_lists?: boolean;
  /** Whether the user can export list data */
  can_export_data_lists?: boolean;
  /** Whether the user can view custom fields on lists */
  can_view_custom_fields_lists?: boolean;
  /** Whether the user can edit custom fields on lists */
  can_edit_custom_fields_lists?: boolean;

  // Dashboards module
  /** Whether the user can view dashboards */
  can_view_dashboards?: boolean;
  /** Whether the user can create new dashboards */
  can_create_dashboards?: boolean;
  /** Whether the user can edit existing dashboards */
  can_edit_dashboards?: boolean;
  /** Whether the user can delete dashboards */
  can_delete_dashboards?: boolean;
  /** Whether the user can add comments on dashboards */
  can_add_comments_dashboards?: boolean;
  /** Whether the user can delete comments on dashboards */
  can_delete_comments_dashboards?: boolean;
  /** Whether the user can add attachments to dashboards */
  can_add_attachments_dashboards?: boolean;
  /** Whether the user can delete attachments from dashboards */
  can_delete_attachments_dashboards?: boolean;
  /** Whether the user can export dashboard data */
  can_export_data_dashboards?: boolean;

  // Robot module
  /** Whether the user can view robot configurations */
  can_view_robot?: boolean;
  /** Whether the user can create new robot configurations */
  can_create_robot?: boolean;
  /** Whether the user can edit existing robot configurations */
  can_edit_robot?: boolean;
  /** Whether the user can delete robot configurations */
  can_delete_robot?: boolean;
  /** Whether the user can add comments on robot configurations */
  can_add_comments_robot?: boolean;
  /** Whether the user can delete comments on robot configurations */
  can_delete_comments_robot?: boolean;
  /** Whether the user can add attachments to robot configurations */
  can_add_attachments_robot?: boolean;
  /** Whether the user can delete attachments from robot configurations */
  can_delete_attachments_robot?: boolean;
  /** Whether the user can export robot data */
  can_export_data_robot?: boolean;

  // GDPR module
  /** Whether the user can view GDPR records */
  can_view_gdpr?: boolean;
  /** Whether the user can edit GDPR records */
  can_edit_gdpr?: boolean;
  /** Whether the user can add comments on GDPR records */
  can_add_comments_gdpr?: boolean;
  /** Whether the user can delete comments on GDPR records */
  can_delete_comments_gdpr?: boolean;
  /** Whether the user can add attachments to GDPR records */
  can_add_attachments_gdpr?: boolean;
  /** Whether the user can delete attachments from GDPR records */
  can_delete_attachments_gdpr?: boolean;
  /** Whether the user can export GDPR data */
  can_export_data_gdpr?: boolean;

  // Boards module
  /** Whether the user can view boards */
  can_view_boards?: boolean;
  /** Whether the user can create new boards */
  can_create_boards?: boolean;
  /** Whether the user can edit existing boards */
  can_edit_boards?: boolean;
  /** Whether the user can delete boards */
  can_delete_boards?: boolean;
  /** Whether the user can add comments on boards */
  can_add_comments_boards?: boolean;
  /** Whether the user can delete comments on boards */
  can_delete_comments_boards?: boolean;
  /** Whether the user can add attachments to boards */
  can_add_attachments_boards?: boolean;
  /** Whether the user can delete attachments from boards */
  can_delete_attachments_boards?: boolean;
  /** Whether the user can export board data */
  can_export_data_boards?: boolean;

  // Plans module
  /** Whether the user can view plans */
  can_view_plans?: boolean;
  /** Whether the user can create new plans */
  can_create_plans?: boolean;
  /** Whether the user can edit existing plans */
  can_edit_plans?: boolean;
  /** Whether the user can delete plans */
  can_delete_plans?: boolean;
  /** Whether the user can add comments on plans */
  can_add_comments_plans?: boolean;
  /** Whether the user can delete comments on plans */
  can_delete_comments_plans?: boolean;
  /** Whether the user can add attachments to plans */
  can_add_attachments_plans?: boolean;
  /** Whether the user can delete attachments from plans */
  can_delete_attachments_plans?: boolean;
  /** Whether the user can export plan data */
  can_export_data_plans?: boolean;

  // ──────────────────────────────────────────────────────────────────────────
  // Risk / Assets / Automations / File Explorer / Forms
  //
  // These five modules shipped with SPACE-tier keys only (MODULE_PERMISSION_KEYS
  // + space_permissions columns) and no org-tier counterpart. That broke the
  // convention every older module follows: 128 of the 152 space keys are also
  // declared here, because the org tier supplies the DEFAULT that a space-level
  // row overrides. Without an org entry a custom role could not express them at
  // all, and `calculateEffectivePermissions` resolved them to `undefined`.
  //
  // Values in DEFAULT_PERMISSIONS_BY_ROLE mirror SPACE_ROLE_BASE_PERMISSIONS
  // key-for-key, so the two tiers agree instead of contradicting each other.
  // ──────────────────────────────────────────────────────────────────────────

  // Risk module
  /**
   * Whether the user can view risk registers and scoring.
   *
   * NOTE: unlike its four siblings below, `can_view_risk`/`can_edit_risk` have
   * no space_permissions column and no SPACE_ROLE_BASE_PERMISSIONS entry, so
   * today nothing enforces them anywhere. They are declared here to complete
   * the registry; the posture mirrors can_view_heatmap/can_edit_heatmap, the
   * org-level risk surface that does exist.
   */
  can_view_risk?: boolean;
  /** Whether the user can edit risk registers and risk configuration */
  can_edit_risk?: boolean;

  // Automations module (the workflow engine; distinct from `robot`)
  /** Whether the user can view automation rules and runs */
  can_view_automations?: boolean;
  /** Whether the user can create automation rules */
  can_create_automations?: boolean;
  /** Whether the user can edit automation rules */
  can_edit_automations?: boolean;
  /** Whether the user can delete automation rules */
  can_delete_automations?: boolean;
  /** Whether the user can manage automation connections (credentials) */
  can_manage_automation_connections?: boolean;

  // Assets module (hierarchical CMDB)
  /** Whether the user can view assets */
  can_view_assets?: boolean;
  /** Whether the user can create assets */
  can_create_assets?: boolean;
  /** Whether the user can edit assets */
  can_edit_assets?: boolean;
  /** Whether the user can delete assets */
  can_delete_assets?: boolean;
  /** Whether the user can manage asset types and schemas */
  can_manage_assets?: boolean;

  // File Explorer module
  /** Whether the user can view files and folders */
  can_view_file_explorer?: boolean;
  /** Whether the user can upload files and create folders */
  can_create_file_explorer?: boolean;
  /** Whether the user can rename/move files and folders */
  can_edit_file_explorer?: boolean;
  /** Whether the user can delete files and folders */
  can_delete_file_explorer?: boolean;
  /** Whether the user can create share links for files */
  can_share_file_explorer?: boolean;

  // Form Builder module
  /** Whether the user can view forms */
  can_view_forms?: boolean;
  /** Whether the user can submit a form */
  can_submit_forms?: boolean;
  /** Whether the user can create forms */
  can_create_forms?: boolean;
  /** Whether the user can edit forms */
  can_edit_forms?: boolean;
  /** Whether the user can delete forms */
  can_delete_forms?: boolean;
  /** Whether the user can manage form settings and publication */
  can_manage_forms?: boolean;
  /** Whether the user can view form responses */
  can_view_form_responses?: boolean;

  // Whiteboards module
  /** Whether the user can view whiteboards */
  can_view_whiteboards?: boolean;
  /** Whether the user can create whiteboards */
  can_create_whiteboards?: boolean;
  /** Whether the user can edit, archive and restore whiteboards */
  can_edit_whiteboards?: boolean;
  /** Whether the user can delete whiteboards */
  can_delete_whiteboards?: boolean;

  // Test Management module
  /** Whether the user can view test cases, plans, executions and reports */
  can_view_tests?: boolean;
  /** Whether the user can create test cases, folders and sets */
  can_create_tests?: boolean;
  /** Whether the user can edit, archive and restore test cases, folders and sets */
  can_edit_tests?: boolean;
  /** Whether the user can delete test cases, folders and sets */
  can_delete_tests?: boolean;
  /** Whether the user can manage test plans, executions and assignments */
  can_manage_test_runs?: boolean;
  /** Whether the user can record test results */
  can_execute_tests?: boolean;

  // Portfolios module
  /** Whether the user can view portfolios */
  can_view_portfolios?: boolean;
  /** Whether the user can create portfolios */
  can_create_portfolios?: boolean;
  /** Whether the user can edit portfolios */
  can_edit_portfolios?: boolean;
  /** Whether the user can delete portfolios */
  can_delete_portfolios?: boolean;
  /** Whether the user can manage portfolio management letters */
  can_manage_portfolio_letters?: boolean;

  // Resource Planning module
  /** Whether the user can view resource planning data */
  can_view_resource_planning?: boolean;
  /** Whether the user can manage resource planning (capacity, allocations) */
  can_manage_resource_planning?: boolean;

  // Migration module
  /** Whether the user can manage Atlassian → XISUITE migrations (Tenant Config ▸ Migration) */
  can_manage_migrations?: boolean;

  // Backup & Restore module
  /** Create, edit and delete backup schemes; read runs and the component registry */
  can_manage_backups?: boolean;
  /** Start a backup run manually, and cancel one */
  can_run_backups?: boolean;
  /** Start a restore dry-run and a content or configuration restore */
  can_restore_backups?: boolean;
  /** Additionally required to restore the identity tier. can_restore_backups is not enough. */
  can_restore_identity?: boolean;
  /** Create, rotate and revoke backup targets and trigger credentials */
  can_manage_backup_credentials?: boolean;
  /**
   * Decide a restore another organization has asked to write into this one.
   *
   * Held in the organization being written INTO, not the one that asked, and it
   * is the only permission whose holder is not the actor. Owner-only by default,
   * the same bar as can_restore_identity: accepting means another tenant's rows
   * land in yours, and no restore can be undone.
   */
  can_approve_incoming_restores?: boolean;

  // Site Studio module
  /** Whether the user can view site studio funnels */
  can_view_site_studio?: boolean;
  /** Whether the user can create site studio funnels */
  can_create_site_studio?: boolean;
  /** Whether the user can edit site studio funnels and pages */
  can_edit_site_studio?: boolean;
  /** Whether the user can delete site studio funnels */
  can_delete_site_studio?: boolean;
  /** Whether the user can publish site studio pages */
  can_publish_site_studio?: boolean;
  /** Whether the user can view document templates */
  can_view_document_templates?: boolean;
  /** Whether the user can create, edit and delete document templates */
  can_manage_document_templates?: boolean;
  /** Whether the user can render and download document exports */
  can_export_documents?: boolean;

  // Heatmap
  /** Whether the user can view the risk heatmap */
  can_view_heatmap?: boolean;
  /** Whether the user can edit the risk heatmap */
  can_edit_heatmap?: boolean;

  // Settings
  /** Whether the user can view organization settings */
  can_view_settings?: boolean;
  /** Whether the user can edit organization settings */
  can_edit_settings?: boolean;

  // User management
  /** Whether the user can view the user list */
  can_view_users?: boolean;
  /** Whether the user can invite new users to the organization */
  can_invite_users?: boolean;
  /** Whether the user can edit other users' profiles */
  can_edit_users?: boolean;
  /** Whether the user can remove users from the organization */
  can_remove_users?: boolean;

  // Role/Group management
  /** Whether the user can manage custom roles */
  can_manage_roles?: boolean;
  /** Whether the user can manage user groups */
  can_manage_groups?: boolean;
  /** Whether the user can view space-level permissions */
  can_view_space_permissions?: boolean;
  /** Whether the user can manage space-level permissions */
  can_manage_space_permissions?: boolean;

  // Configuration
  /** Whether the user can manage custom field definitions */
  can_manage_custom_fields?: boolean;
  /** Whether the user can manage relation type definitions */
  can_manage_relation_types?: boolean;
  /** Whether the user can manage hierarchy configuration */
  can_manage_hierarchy?: boolean;

  // Space management
  /**
   * Whether the user can see spaces at all.
   *
   * Read by `spaces.service.ts` (`can_view_space` overrides per base role) but
   * previously declared only in the frontend model, so the backend read an
   * untyped key. Declared here to close that drift.
   */
  can_view_space?: boolean;
  /** Whether the user can create new spaces */
  can_create_spaces?: boolean;
  /** Whether the user can edit space settings */
  can_edit_space_settings?: boolean;
  /** Whether the user can manage space members */
  can_manage_space_members?: boolean;
  /** Whether the user can archive spaces */
  can_archive_spaces?: boolean;
  /** Whether the user can delete spaces */
  can_delete_spaces?: boolean;
  /** Whether the user can view module-level permissions */
  can_view_module_permissions?: boolean;
  /** Whether the user can manage module-level permissions */
  can_manage_module_permissions?: boolean;
  /** Space Settings tab View: true shows the tab read-only, an explicit false hides it */
  can_view_space_settings_general?: boolean;
  can_view_space_settings_modules?: boolean;
  can_view_space_settings_permissions?: boolean;
  can_view_space_settings_processes?: boolean;
  can_view_space_settings_tasks?: boolean;
  can_view_space_settings_priorities?: boolean;
  can_view_space_settings_status_categories?: boolean;
  can_view_space_settings_resolutions?: boolean;
  can_view_space_settings_statuses?: boolean;
  can_view_space_settings_custom_fields?: boolean;
  can_view_space_settings_field_groups?: boolean;
  can_view_space_settings_wiki_labels?: boolean;
  can_view_space_settings_workflows?: boolean;
  can_view_space_settings_risk_config?: boolean;
  /** Save/reset the org risk configuration from Space Settings → Risk Config */
  can_edit_risk_config?: boolean;
  /** Turn space modules on/off from Space Settings → Modules */
  can_edit_space_modules?: boolean;
  /** Whether the user can create space task types */
  can_create_task_types?: boolean;
  /** Whether the user can edit space task types */
  can_edit_task_types?: boolean;
  /** Whether the user can delete space task types */
  can_delete_task_types?: boolean;
  /** Whether the user can create space status categories */
  can_create_status_categories?: boolean;
  /** Whether the user can edit space status categories */
  can_edit_status_categories?: boolean;
  /** Whether the user can delete space status categories */
  can_delete_status_categories?: boolean;
  /** Whether the user can create space resolutions */
  can_create_resolutions?: boolean;
  /** Whether the user can edit space resolutions */
  can_edit_resolutions?: boolean;
  /** Whether the user can delete space resolutions */
  can_delete_resolutions?: boolean;
  /** Whether the user can create space field groups */
  can_create_field_groups?: boolean;
  /** Whether the user can edit space field groups */
  can_edit_field_groups?: boolean;
  /** Whether the user can delete space field groups */
  can_delete_field_groups?: boolean;
  /** Whether the user can create space wiki labels */
  can_create_wiki_labels?: boolean;
  /** Whether the user can edit space wiki labels */
  can_edit_wiki_labels?: boolean;
  /** Whether the user can delete space wiki labels */
  can_delete_wiki_labels?: boolean;

  // History
  /** Whether the user can view audit history */
  can_view_history?: boolean;

  // Notifications
  /** Whether the user can view notifications */
  can_view_notifications?: boolean;
  /** Whether the user can create notifications */
  can_create_notifications?: boolean;
  /** Whether the user can edit notifications */
  can_edit_notifications?: boolean;
  /** Whether the user can delete notifications */
  can_delete_notifications?: boolean;

  // Custom Fields
  /** Whether the user can view custom field definitions */
  can_view_custom_fields?: boolean;
  /** Whether the user can create custom field definitions */
  can_create_custom_fields?: boolean;
  /** Whether the user can edit custom field definitions */
  can_edit_custom_fields?: boolean;
  /** Whether the user can delete custom field definitions */
  can_delete_custom_fields?: boolean;

  // Priorities
  /** Whether the user can view priority definitions */
  can_view_priorities?: boolean;
  /** Whether the user can create priority definitions */
  can_create_priorities?: boolean;
  /** Whether the user can edit priority definitions */
  can_edit_priorities?: boolean;
  /** Whether the user can delete priority definitions */
  can_delete_priorities?: boolean;

  // Statuses
  /** Whether the user can view status definitions */
  can_view_statuses?: boolean;
  /** Whether the user can create status definitions */
  can_create_statuses?: boolean;
  /** Whether the user can edit status definitions */
  can_edit_statuses?: boolean;
  /** Whether the user can delete status definitions */
  can_delete_statuses?: boolean;

  // Hierarchy
  /** Whether the user can view hierarchy levels */
  can_view_hierarchy?: boolean;
  /** Whether the user can create hierarchy levels */
  can_create_hierarchy?: boolean;
  /** Whether the user can edit hierarchy levels */
  can_edit_hierarchy?: boolean;
  /** Whether the user can delete hierarchy levels */
  can_delete_hierarchy?: boolean;

  // Workflow builder (migration 20260512100800_workflow_09_permissions)
  /** Whether the user can view status categories */
  can_view_status_categories?: boolean;
  /** Whether the user can manage status categories */
  can_manage_status_categories?: boolean;
  /** Whether the user can view resolutions */
  can_view_resolutions?: boolean;
  /** Whether the user can manage resolutions */
  can_manage_resolutions?: boolean;
  /** Whether the user can view workflows */
  can_view_workflows?: boolean;
  /** Whether the user can create workflows */
  can_create_workflows?: boolean;
  /** Whether the user can edit workflows (incl. canvas save) */
  can_edit_workflows?: boolean;
  /** Whether the user can delete/archive workflows */
  can_delete_workflows?: boolean;
  /** Whether the user can publish a draft workflow */
  can_publish_workflows?: boolean;
  /** Whether the user can assign workflows to task types */
  can_assign_workflows?: boolean;
  /** Whether the user can export a workflow definition */
  can_export_workflow?: boolean;
  /** Whether the user can import a workflow definition */
  can_import_workflow?: boolean;

  // Chat and Robert (XE-T353). Organization-level only: enforced by
  // ChatPermissionGuard, never by a space-level grant.
  /** Whether the user can use chat at all (read, send, react) */
  can_use_chat?: boolean;
  /** Whether the user can create group chats */
  can_create_chat_groups?: boolean;
  /** Whether the user can delete other people's chat messages and files */
  can_delete_any_chat_message?: boolean;
  /** Whether the user can ask Robert, the AI assistant in chat */
  can_use_robert?: boolean;
  /** Whether the user can configure Robert (provider, budgets, switches) */
  can_manage_robert?: boolean;
  /** Whether the user can view Robert's audit trail */
  can_view_ai_audit?: boolean;

  // Partner Portal (org-level; enforced only on @RequirePartner routes).
  // NEVER placed in space_permissions — partner is an org-scoped module.
  //
  // Deliberately ABSENT from DEFAULT_PERMISSIONS_BY_ROLE. These are granted
  // exclusively via the system "Backoffice" custom role that partner
  // provisioning mints. Putting them in the base-role presets would hand
  // partner permissions to every owner/admin in every tenant, partner or not.
  /** View the partner company profile + contacts */
  can_view_partner_profile?: boolean;
  /** Edit the partner company profile + contacts + public listing */
  can_manage_partner_profile?: boolean;
  /** View partner leads */
  can_view_partner_leads?: boolean;
  /** Create/submit/resubmit partner leads */
  can_manage_partner_leads?: boolean;
  /** View partner customers */
  can_view_partner_customers?: boolean;
  /** Manage partner customers */
  can_manage_partner_customers?: boolean;
  /** View licenses of partner customers */
  can_view_partner_licenses?: boolean;
  /** Manage licenses/packages of partner customers (incl. on-prem) */
  can_manage_partner_licenses?: boolean;
  /** View partner quotes */
  can_view_partner_quotes?: boolean;
  /** Create/edit/convert partner quotes */
  can_manage_partner_quotes?: boolean;
  /** View partner invoices */
  can_view_partner_invoices?: boolean;
  /** Manage partner invoices */
  can_manage_partner_invoices?: boolean;
  /** Invite/manage Backoffice users inside the partner org */
  can_manage_partner_office_users?: boolean;

  /** Allow arbitrary keys for extensibility */
  [key: string]: boolean | undefined;
}

/**
 * Represents a custom role that can be assigned to users within an organization.
 * Custom roles extend a base role with additional permission overrides.
 */
export interface ICustomRole {
  /** Custom role UUID */
  id: string;
  /** Organization this role belongs to */
  organization_id: string;
  /** Display name of the custom role */
  name: string;
  /** Optional description of the role's purpose */
  description?: string | null;
  /** Color code for UI display (hex format) */
  color: string;
  /** Optional icon identifier for UI display */
  icon?: string | null;
  /** The base role this custom role extends */
  base_role: IBaseRole;
  /** Permission overrides applied on top of the base role defaults */
  permissions: IPermissionsObject;
  /** Whether this is a system-defined role that cannot be deleted */
  is_system: boolean;
  /** Whether this role is currently active */
  is_active: boolean;
  /** Whether this role has been soft-deleted */
  is_deleted: boolean;
}

/**
 * Represents a user group within an organization, used for batch permission assignment.
 */
export interface IUserGroup {
  /** Group UUID */
  id: string;
  /** Organization this group belongs to */
  organization_id: string;
  /** Display name of the group */
  name: string;
  /** Optional description of the group's purpose */
  description?: string | null;
  /** Color code for UI display (hex format) */
  color: string;
}

/**
 * Complete result of resolving a user's effective permissions, including
 * their base role, custom roles, groups, and the final merged permissions.
 */
export interface IUserEffectivePermissions {
  /** The user ID these permissions were resolved for */
  user_id: string;
  /** The user's base organization role */
  base_role: IBaseRole;
  /** Custom roles assigned to the user */
  custom_roles: ICustomRole[];
  /** Groups the user belongs to */
  groups: IUserGroup[];
  /** The final computed permissions after all merges */
  effective_permissions: IPermissionsObject;
  /** Space Settings tab keys explicitly set false by the base role, a custom role or a group */
  hidden_space_settings_tabs?: string[];
}

/** Keys that hide individual Space Settings tabs when explicitly false. */
export const SPACE_SETTINGS_TAB_KEYS = [
  'can_view_space_settings_general',
  'can_view_space_settings_modules',
  'can_view_space_settings_permissions',
  'can_view_space_settings_processes',
  'can_view_space_settings_tasks',
  'can_view_space_settings_priorities',
  'can_view_space_settings_status_categories',
  'can_view_space_settings_resolutions',
  'can_view_space_settings_statuses',
  'can_view_space_settings_custom_fields',
  'can_view_space_settings_field_groups',
  'can_view_space_settings_wiki_labels',
  'can_view_space_settings_workflows',
  'can_view_space_settings_risk_config',
] as const;

/**
 * Chat keys every base role holds by default. Once an organization removed one from
 * a base role, a custom role gives it back only by holding it explicitly: the
 * defaults of the custom role's own base role do not (ADM-08).
 */
export const DEFAULT_ON_CHAT_KEYS = [
  'can_use_chat',
  'can_create_chat_groups',
  'can_use_robert',
] as const;

/**
 * The nine feature modules that have per-module sub-permissions (comments, attachments, export).
 * @private
 */
const MODULES = [
  'processes',
  'tasks',
  'wiki',
  'lists',
  'dashboards',
  'robot',
  'gdpr',
  'boards',
  'plans',
] as const;

/**
 * Generates per-module sub-permission entries (comments, attachments, export) for all 9 modules.
 *
 * @private
 * @param {boolean} add - Whether add (comments/attachments) is allowed
 * @param {boolean} del - Whether delete (comments/attachments) is allowed
 * @param {boolean} exp - Whether data export is allowed
 * @returns {Record<string, boolean>} Flat permission map for all module sub-permissions
 */
function flatSubPerms(
  add: boolean,
  del: boolean,
  exp: boolean,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const m of MODULES) {
    result[`can_add_comments_${m}`] = add;
    result[`can_delete_comments_${m}`] = del;
    result[`can_add_attachments_${m}`] = add;
    result[`can_delete_attachments_${m}`] = del;
    result[`can_export_data_${m}`] = exp;
  }
  return result;
}

// ============================================================================
// Default permissions by base role
// ============================================================================

/**
 * Complete default permission sets for each base role.
 *
 * - `owner`: Full access to everything
 * - `admin`: Full access except `can_remove_users` and `can_delete_spaces`
 * - `member`: View + create + edit for content; no admin or delete permissions
 * - `viewer`: Read-only access to content modules; can add comments but cannot modify
 *
 * These defaults are used as the starting point for permission calculation and can be
 * overridden per-organization via the `base_role_permission_overrides` table.
 */
export const DEFAULT_PERMISSIONS_BY_ROLE: Record<
  IBaseRole,
  IPermissionsObject
> = {
  owner: {
    can_view_processes: true,
    can_create_processes: true,
    can_edit_processes: true,
    can_delete_processes: true,
    can_view_custom_fields_processes: true,
    can_edit_custom_fields_processes: true,
    can_view_tasks: true,
    can_create_tasks: true,
    can_edit_tasks: true,
    can_delete_tasks: true,
    can_assign_tasks: true,
    can_edit_others_comments_tasks: true,
    can_delete_others_comments_tasks: true,
    can_view_sla: true,
    can_manage_sla: true,
    can_publish_customer_replies: true,
    can_view_custom_fields_tasks: true,
    can_edit_custom_fields_tasks: true,
    can_view_wiki_pages: true,
    can_create_wiki_pages: true,
    can_edit_wiki_pages: true,
    can_delete_wiki_pages: true,
    can_view_lists: true,
    can_create_lists: true,
    can_edit_lists: true,
    can_delete_lists: true,
    can_view_custom_fields_lists: true,
    can_edit_custom_fields_lists: true,
    can_view_dashboards: true,
    can_create_dashboards: true,
    can_edit_dashboards: true,
    can_delete_dashboards: true,
    can_view_robot: true,
    can_create_robot: true,
    can_edit_robot: true,
    can_delete_robot: true,
    can_view_gdpr: true,
    can_edit_gdpr: true,
    can_view_boards: true,
    can_create_boards: true,
    can_edit_boards: true,
    can_delete_boards: true,
    can_view_plans: true,
    can_create_plans: true,
    can_edit_plans: true,
    can_delete_plans: true,

    // Risk / Assets / Automations / File Explorer / Forms.
    // Mirrors SPACE_ROLE_BASE_PERMISSIONS key-for-key so the org default and
    // the space grant agree. `can_view_risk`/`can_edit_risk` have no space
    // counterpart, so they follow can_view_heatmap/can_edit_heatmap instead.
    can_view_risk: true,
    can_edit_risk: true,
    can_view_automations: true,
    can_create_automations: true,
    can_edit_automations: true,
    can_delete_automations: true,
    can_manage_automation_connections: true,
    can_view_assets: true,
    can_create_assets: true,
    can_edit_assets: true,
    can_delete_assets: true,
    can_manage_assets: true,
    can_view_file_explorer: true,
    can_create_file_explorer: true,
    can_edit_file_explorer: true,
    can_delete_file_explorer: true,
    can_share_file_explorer: true,
    can_view_forms: true,
    can_submit_forms: true,
    can_create_forms: true,
    can_edit_forms: true,
    can_delete_forms: true,
    can_manage_forms: true,
    can_view_form_responses: true,
    can_view_whiteboards: true,
    can_create_whiteboards: true,
    can_edit_whiteboards: true,
    can_delete_whiteboards: true,
    can_view_tests: true,
    can_create_tests: true,
    can_edit_tests: true,
    can_delete_tests: true,
    can_manage_test_runs: true,
    can_execute_tests: true,
    can_view_portfolios: true,
    can_create_portfolios: true,
    can_edit_portfolios: true,
    can_delete_portfolios: true,
    can_manage_portfolio_letters: true,
    can_view_resource_planning: true,
    can_manage_resource_planning: true,
    can_manage_migrations: true,

    // Backup & Restore module.
    can_manage_backups: true,
    can_run_backups: true,
    can_restore_backups: true,
    can_restore_identity: true,
    can_manage_backup_credentials: true,
    can_approve_incoming_restores: true,
    can_view_site_studio: true,
    can_create_site_studio: true,
    can_edit_site_studio: true,
    can_delete_site_studio: true,
    can_publish_site_studio: true,
    can_view_document_templates: true,
    can_manage_document_templates: true,
    can_export_documents: true,
    can_view_heatmap: true,
    can_edit_heatmap: true,
    can_view_settings: true,
    can_edit_settings: true,
    can_view_users: true,
    can_invite_users: true,
    can_edit_users: true,
    can_remove_users: true,
    can_manage_roles: true,
    can_manage_groups: true,
    can_view_space_permissions: true,
    can_manage_space_permissions: true,
    can_manage_custom_fields: true,
    can_manage_relation_types: true,
    can_manage_hierarchy: true,
    can_create_spaces: true,
    can_edit_space_settings: true,
    can_manage_space_members: true,
    can_archive_spaces: true,
    can_delete_spaces: true,
    can_view_module_permissions: true,
    can_manage_module_permissions: true,
    can_view_space_settings_general: true,
    can_view_space_settings_modules: true,
    can_view_space_settings_permissions: true,
    can_view_space_settings_processes: true,
    can_view_space_settings_tasks: true,
    can_view_space_settings_priorities: true,
    can_view_space_settings_status_categories: true,
    can_view_space_settings_resolutions: true,
    can_view_space_settings_statuses: true,
    can_view_space_settings_custom_fields: true,
    can_view_space_settings_field_groups: true,
    can_view_space_settings_wiki_labels: true,
    can_view_space_settings_workflows: true,
    can_view_space_settings_risk_config: true,
    can_edit_risk_config: true,
    can_edit_space_modules: true,
    can_create_task_types: true,
    can_edit_task_types: true,
    can_delete_task_types: true,
    can_create_status_categories: true,
    can_edit_status_categories: true,
    can_delete_status_categories: true,
    can_create_resolutions: true,
    can_edit_resolutions: true,
    can_delete_resolutions: true,
    can_create_field_groups: true,
    can_edit_field_groups: true,
    can_delete_field_groups: true,
    can_create_wiki_labels: true,
    can_edit_wiki_labels: true,
    can_delete_wiki_labels: true,
    can_view_history: true,
    can_view_notifications: true,
    can_create_notifications: true,
    can_edit_notifications: true,
    can_delete_notifications: true,
    can_view_custom_fields: true,
    can_create_custom_fields: true,
    can_edit_custom_fields: true,
    can_delete_custom_fields: true,
    can_view_priorities: true,
    can_create_priorities: true,
    can_edit_priorities: true,
    can_delete_priorities: true,
    can_view_statuses: true,
    can_create_statuses: true,
    can_edit_statuses: true,
    can_delete_statuses: true,
    can_view_hierarchy: true,
    can_create_hierarchy: true,
    can_edit_hierarchy: true,
    can_delete_hierarchy: true,

    // Workflow builder — owner gets full access
    can_view_status_categories: true,
    can_manage_status_categories: true,
    can_view_resolutions: true,
    can_manage_resolutions: true,
    can_view_workflows: true,
    can_create_workflows: true,
    can_edit_workflows: true,
    can_delete_workflows: true,
    can_publish_workflows: true,
    can_assign_workflows: true,
    can_export_workflow: true,
    can_import_workflow: true,

    // Chat and Robert
    can_use_chat: true,
    can_create_chat_groups: true,
    can_delete_any_chat_message: true,
    can_use_robert: true,
    can_manage_robert: true,
    can_view_ai_audit: true,
    ...flatSubPerms(true, true, true),
  },
  admin: {
    can_view_processes: true,
    can_create_processes: true,
    can_edit_processes: true,
    can_delete_processes: true,
    can_view_custom_fields_processes: true,
    can_edit_custom_fields_processes: true,
    can_view_tasks: true,
    can_create_tasks: true,
    can_edit_tasks: true,
    can_delete_tasks: true,
    can_assign_tasks: true,
    can_edit_others_comments_tasks: true,
    can_delete_others_comments_tasks: true,
    can_view_sla: true,
    can_manage_sla: true,
    can_publish_customer_replies: true,
    can_view_custom_fields_tasks: true,
    can_edit_custom_fields_tasks: true,
    can_view_wiki_pages: true,
    can_create_wiki_pages: true,
    can_edit_wiki_pages: true,
    can_delete_wiki_pages: true,
    can_view_lists: true,
    can_create_lists: true,
    can_edit_lists: true,
    can_delete_lists: true,
    can_view_custom_fields_lists: true,
    can_edit_custom_fields_lists: true,
    can_view_dashboards: true,
    can_create_dashboards: true,
    can_edit_dashboards: true,
    can_delete_dashboards: true,
    can_view_robot: true,
    can_create_robot: true,
    can_edit_robot: true,
    can_delete_robot: true,
    can_view_gdpr: true,
    can_edit_gdpr: true,
    can_view_boards: true,
    can_create_boards: true,
    can_edit_boards: true,
    can_delete_boards: true,
    can_view_plans: true,
    can_create_plans: true,
    can_edit_plans: true,
    can_delete_plans: true,

    // Risk / Assets / Automations / File Explorer / Forms.
    // Mirrors SPACE_ROLE_BASE_PERMISSIONS key-for-key so the org default and
    // the space grant agree. `can_view_risk`/`can_edit_risk` have no space
    // counterpart, so they follow can_view_heatmap/can_edit_heatmap instead.
    can_view_risk: true,
    can_edit_risk: true,
    can_view_automations: true,
    can_create_automations: true,
    can_edit_automations: true,
    can_delete_automations: true,
    can_manage_automation_connections: true,
    can_view_assets: true,
    can_create_assets: true,
    can_edit_assets: true,
    can_delete_assets: true,
    can_manage_assets: true,
    can_view_file_explorer: true,
    can_create_file_explorer: true,
    can_edit_file_explorer: true,
    can_delete_file_explorer: true,
    can_share_file_explorer: true,
    can_view_forms: true,
    can_submit_forms: true,
    can_create_forms: true,
    can_edit_forms: true,
    can_delete_forms: true,
    can_manage_forms: true,
    can_view_form_responses: true,
    can_view_whiteboards: true,
    can_create_whiteboards: true,
    can_edit_whiteboards: true,
    can_delete_whiteboards: true,
    can_view_tests: true,
    can_create_tests: true,
    can_edit_tests: true,
    can_delete_tests: true,
    can_manage_test_runs: true,
    can_execute_tests: true,
    can_view_portfolios: true,
    can_create_portfolios: true,
    can_edit_portfolios: true,
    can_delete_portfolios: true,
    can_manage_portfolio_letters: true,
    can_view_resource_planning: true,
    can_manage_resource_planning: true,
    can_manage_migrations: true,

    // Backup & Restore module.
    can_manage_backups: true,
    can_run_backups: true,
    can_restore_backups: false,
    can_restore_identity: false,
    can_manage_backup_credentials: true,
    can_approve_incoming_restores: false,
    can_view_site_studio: true,
    can_create_site_studio: true,
    can_edit_site_studio: true,
    can_delete_site_studio: true,
    can_publish_site_studio: true,
    can_view_document_templates: true,
    can_manage_document_templates: true,
    can_export_documents: true,
    can_view_heatmap: true,
    can_edit_heatmap: true,
    can_view_settings: true,
    can_edit_settings: true,
    can_view_users: true,
    can_invite_users: true,
    can_edit_users: true,
    can_remove_users: false,
    can_manage_roles: true,
    can_manage_groups: true,
    can_view_space_permissions: true,
    can_manage_space_permissions: true,
    can_manage_custom_fields: true,
    can_manage_relation_types: true,
    can_manage_hierarchy: true,
    can_create_spaces: true,
    can_edit_space_settings: true,
    can_manage_space_members: true,
    can_archive_spaces: true,
    can_delete_spaces: false,
    can_view_module_permissions: true,
    can_manage_module_permissions: true,
    can_view_space_settings_general: true,
    can_view_space_settings_modules: true,
    can_view_space_settings_permissions: true,
    can_view_space_settings_processes: true,
    can_view_space_settings_tasks: true,
    can_view_space_settings_priorities: true,
    can_view_space_settings_status_categories: true,
    can_view_space_settings_resolutions: true,
    can_view_space_settings_statuses: true,
    can_view_space_settings_custom_fields: true,
    can_view_space_settings_field_groups: true,
    can_view_space_settings_wiki_labels: true,
    can_view_space_settings_workflows: true,
    can_view_space_settings_risk_config: true,
    can_edit_risk_config: true,
    can_edit_space_modules: true,
    can_create_task_types: true,
    can_edit_task_types: true,
    can_delete_task_types: true,
    can_create_status_categories: true,
    can_edit_status_categories: true,
    can_delete_status_categories: true,
    can_create_resolutions: true,
    can_edit_resolutions: true,
    can_delete_resolutions: true,
    can_create_field_groups: true,
    can_edit_field_groups: true,
    can_delete_field_groups: true,
    can_create_wiki_labels: true,
    can_edit_wiki_labels: true,
    can_delete_wiki_labels: true,
    can_view_history: true,
    can_view_notifications: true,
    can_create_notifications: true,
    can_edit_notifications: true,
    can_delete_notifications: true,
    can_view_custom_fields: true,
    can_create_custom_fields: true,
    can_edit_custom_fields: true,
    can_delete_custom_fields: true,
    can_view_priorities: true,
    can_create_priorities: true,
    can_edit_priorities: true,
    can_delete_priorities: true,
    can_view_statuses: true,
    can_create_statuses: true,
    can_edit_statuses: true,
    can_delete_statuses: true,
    can_view_hierarchy: true,
    can_create_hierarchy: true,
    can_edit_hierarchy: true,
    can_delete_hierarchy: true,

    // Workflow builder — admin gets full access
    can_view_status_categories: true,
    can_manage_status_categories: true,
    can_view_resolutions: true,
    can_manage_resolutions: true,
    can_view_workflows: true,
    can_create_workflows: true,
    can_edit_workflows: true,
    can_delete_workflows: true,
    can_publish_workflows: true,
    can_assign_workflows: true,
    can_export_workflow: true,
    can_import_workflow: true,

    // Chat and Robert
    can_use_chat: true,
    can_create_chat_groups: true,
    can_delete_any_chat_message: true,
    can_use_robert: true,
    can_manage_robert: true,
    can_view_ai_audit: true,
    ...flatSubPerms(true, true, true),
  },
  member: {
    can_view_processes: true,
    can_create_processes: true,
    can_edit_processes: true,
    can_delete_processes: false,
    can_view_custom_fields_processes: true,
    can_edit_custom_fields_processes: true,
    can_view_tasks: true,
    can_create_tasks: true,
    can_edit_tasks: true,
    can_delete_tasks: false,
    can_assign_tasks: true,
    can_edit_others_comments_tasks: false,
    can_delete_others_comments_tasks: false,
    can_view_sla: true,
    can_manage_sla: false,
    can_publish_customer_replies: true,
    can_view_custom_fields_tasks: true,
    can_edit_custom_fields_tasks: true,
    can_view_wiki_pages: true,
    can_create_wiki_pages: true,
    can_edit_wiki_pages: true,
    can_delete_wiki_pages: false,
    can_view_lists: true,
    can_create_lists: true,
    can_edit_lists: true,
    can_delete_lists: false,
    can_view_custom_fields_lists: true,
    can_edit_custom_fields_lists: true,
    can_view_dashboards: true,
    can_create_dashboards: true,
    can_edit_dashboards: true,
    can_delete_dashboards: false,
    can_view_robot: true,
    can_create_robot: true,
    can_edit_robot: true,
    can_delete_robot: false,
    can_view_gdpr: true,
    can_edit_gdpr: true,
    can_view_boards: true,
    can_create_boards: true,
    can_edit_boards: true,
    can_delete_boards: false,
    can_view_plans: true,
    can_create_plans: true,
    can_edit_plans: true,
    can_delete_plans: false,

    // Risk / Assets / Automations / File Explorer / Forms.
    // Mirrors SPACE_ROLE_BASE_PERMISSIONS key-for-key so the org default and
    // the space grant agree. `can_view_risk`/`can_edit_risk` have no space
    // counterpart, so they follow can_view_heatmap/can_edit_heatmap instead.
    can_view_risk: true,
    can_edit_risk: false,
    can_view_automations: true,
    can_create_automations: true,
    can_edit_automations: true,
    can_delete_automations: false,
    can_manage_automation_connections: false,
    can_view_assets: true,
    can_create_assets: true,
    can_edit_assets: true,
    can_delete_assets: false,
    can_manage_assets: false,
    can_view_file_explorer: true,
    can_create_file_explorer: true,
    can_edit_file_explorer: true,
    can_delete_file_explorer: false,
    can_share_file_explorer: false,
    can_view_forms: true,
    can_submit_forms: true,
    can_create_forms: true,
    can_edit_forms: true,
    can_delete_forms: false,
    can_manage_forms: false,
    can_view_form_responses: true,
    can_view_whiteboards: true,
    can_create_whiteboards: true,
    can_edit_whiteboards: true,
    can_delete_whiteboards: false,
    can_view_tests: true,
    can_create_tests: true,
    can_edit_tests: true,
    can_delete_tests: false,
    can_manage_test_runs: true,
    can_execute_tests: true,
    can_view_portfolios: true,
    can_create_portfolios: false,
    can_edit_portfolios: false,
    can_delete_portfolios: false,
    can_manage_portfolio_letters: false,
    can_view_resource_planning: true,
    can_manage_resource_planning: false,
    can_manage_migrations: false,

    // Backup & Restore module.
    can_manage_backups: false,
    can_run_backups: false,
    can_restore_backups: false,
    can_restore_identity: false,
    can_manage_backup_credentials: false,
    can_approve_incoming_restores: false,
    can_view_site_studio: true,
    can_create_site_studio: true,
    can_edit_site_studio: true,
    can_delete_site_studio: false,
    can_publish_site_studio: false,
    can_view_document_templates: true,
    can_manage_document_templates: false,
    can_export_documents: true,
    can_view_heatmap: true,
    can_edit_heatmap: false,
    can_view_settings: true,
    can_edit_settings: false,
    can_view_users: true,
    can_invite_users: false,
    can_edit_users: false,
    can_remove_users: false,
    can_manage_roles: false,
    can_manage_groups: false,
    can_view_space_permissions: false,
    can_manage_space_permissions: false,
    can_manage_custom_fields: false,
    can_manage_relation_types: false,
    can_manage_hierarchy: false,
    can_create_spaces: true,
    can_edit_space_settings: false,
    can_manage_space_members: false,
    can_archive_spaces: false,
    can_delete_spaces: false,
    can_view_module_permissions: false,
    can_manage_module_permissions: false,
    can_view_space_settings_general: false,
    can_view_space_settings_modules: false,
    can_view_space_settings_permissions: false,
    can_view_space_settings_processes: false,
    can_view_space_settings_tasks: false,
    can_view_space_settings_priorities: false,
    can_view_space_settings_status_categories: false,
    can_view_space_settings_resolutions: false,
    can_view_space_settings_statuses: false,
    can_view_space_settings_custom_fields: false,
    can_view_space_settings_field_groups: false,
    can_view_space_settings_wiki_labels: false,
    can_view_space_settings_workflows: false,
    can_view_space_settings_risk_config: false,
    can_edit_risk_config: false,
    can_edit_space_modules: false,
    can_create_task_types: false,
    can_edit_task_types: false,
    can_delete_task_types: false,
    can_create_status_categories: false,
    can_edit_status_categories: false,
    can_delete_status_categories: false,
    can_create_resolutions: false,
    can_edit_resolutions: false,
    can_delete_resolutions: false,
    can_create_field_groups: false,
    can_edit_field_groups: false,
    can_delete_field_groups: false,
    can_create_wiki_labels: false,
    can_edit_wiki_labels: false,
    can_delete_wiki_labels: false,
    can_view_history: true,
    can_view_notifications: true,
    can_create_notifications: false,
    can_edit_notifications: false,
    can_delete_notifications: false,
    can_view_custom_fields: true,
    can_create_custom_fields: false,
    can_edit_custom_fields: false,
    can_delete_custom_fields: false,
    can_view_priorities: true,
    can_create_priorities: false,
    can_edit_priorities: false,
    can_delete_priorities: false,
    can_view_statuses: true,
    can_create_statuses: false,
    can_edit_statuses: false,
    can_delete_statuses: false,
    can_view_hierarchy: true,
    can_create_hierarchy: false,
    can_edit_hierarchy: false,
    can_delete_hierarchy: false,

    // Workflow builder — member: view-only
    can_view_status_categories: true,
    can_manage_status_categories: false,
    can_view_resolutions: true,
    can_manage_resolutions: false,
    can_view_workflows: true,
    can_create_workflows: false,
    can_edit_workflows: false,
    can_delete_workflows: false,
    can_publish_workflows: false,
    can_assign_workflows: false,
    can_export_workflow: false,
    can_import_workflow: false,

    // Chat and Robert — member: use, no moderation or administration
    can_use_chat: true,
    can_create_chat_groups: true,
    can_delete_any_chat_message: false,
    can_use_robert: true,
    can_manage_robert: false,
    can_view_ai_audit: false,
    ...flatSubPerms(true, false, false),
  },
  viewer: {
    can_view_processes: true,
    can_create_processes: false,
    can_edit_processes: false,
    can_delete_processes: false,
    can_view_custom_fields_processes: true,
    can_edit_custom_fields_processes: false,
    can_view_tasks: true,
    can_create_tasks: false,
    can_edit_tasks: false,
    can_delete_tasks: false,
    can_assign_tasks: false,
    can_edit_others_comments_tasks: false,
    can_delete_others_comments_tasks: false,
    can_view_sla: true,
    can_manage_sla: false,
    can_publish_customer_replies: false,
    can_view_custom_fields_tasks: true,
    can_edit_custom_fields_tasks: false,
    can_view_wiki_pages: true,
    can_create_wiki_pages: false,
    can_edit_wiki_pages: false,
    can_delete_wiki_pages: false,
    can_view_lists: true,
    can_create_lists: false,
    can_edit_lists: false,
    can_delete_lists: false,
    can_view_custom_fields_lists: true,
    can_edit_custom_fields_lists: false,
    can_view_dashboards: true,
    can_create_dashboards: false,
    can_edit_dashboards: false,
    can_delete_dashboards: false,
    can_view_robot: true,
    can_create_robot: false,
    can_edit_robot: false,
    can_delete_robot: false,
    can_view_gdpr: true,
    can_edit_gdpr: false,
    can_view_boards: true,
    can_create_boards: false,
    can_edit_boards: false,
    can_delete_boards: false,
    can_view_plans: true,
    can_create_plans: false,
    can_edit_plans: false,
    can_delete_plans: false,

    // Risk / Assets / Automations / File Explorer / Forms.
    // Mirrors SPACE_ROLE_BASE_PERMISSIONS key-for-key so the org default and
    // the space grant agree. `can_view_risk`/`can_edit_risk` have no space
    // counterpart, so they follow can_view_heatmap/can_edit_heatmap instead.
    can_view_risk: true,
    can_edit_risk: false,
    can_view_automations: true,
    can_create_automations: false,
    can_edit_automations: false,
    can_delete_automations: false,
    can_manage_automation_connections: false,
    can_view_assets: true,
    can_create_assets: false,
    can_edit_assets: false,
    can_delete_assets: false,
    can_manage_assets: false,
    can_view_file_explorer: true,
    can_create_file_explorer: false,
    can_edit_file_explorer: false,
    can_delete_file_explorer: false,
    can_share_file_explorer: false,
    can_view_forms: true,
    can_submit_forms: true,
    can_create_forms: false,
    can_edit_forms: false,
    can_delete_forms: false,
    can_manage_forms: false,
    can_view_form_responses: false,
    can_view_whiteboards: true,
    can_create_whiteboards: false,
    can_edit_whiteboards: false,
    can_delete_whiteboards: false,
    can_view_tests: true,
    can_create_tests: false,
    can_edit_tests: false,
    can_delete_tests: false,
    can_manage_test_runs: false,
    can_execute_tests: false,
    can_view_portfolios: true,
    can_create_portfolios: false,
    can_edit_portfolios: false,
    can_delete_portfolios: false,
    can_manage_portfolio_letters: false,
    can_view_resource_planning: false,
    can_manage_resource_planning: false,
    can_manage_migrations: false,

    // Backup & Restore module.
    can_manage_backups: false,
    can_run_backups: false,
    can_restore_backups: false,
    can_restore_identity: false,
    can_manage_backup_credentials: false,
    can_approve_incoming_restores: false,
    can_view_site_studio: true,
    can_create_site_studio: false,
    can_edit_site_studio: false,
    can_delete_site_studio: false,
    can_publish_site_studio: false,
    can_view_document_templates: true,
    can_manage_document_templates: false,
    can_export_documents: false,
    can_view_heatmap: true,
    can_edit_heatmap: false,
    can_view_settings: false,
    can_edit_settings: false,
    can_view_users: true,
    can_invite_users: false,
    can_edit_users: false,
    can_remove_users: false,
    can_manage_roles: false,
    can_manage_groups: false,
    can_view_space_permissions: false,
    can_manage_space_permissions: false,
    can_manage_custom_fields: false,
    can_manage_relation_types: false,
    can_manage_hierarchy: false,
    can_create_spaces: false,
    can_edit_space_settings: false,
    can_manage_space_members: false,
    can_archive_spaces: false,
    can_delete_spaces: false,
    can_view_module_permissions: false,
    can_manage_module_permissions: false,
    can_view_space_settings_general: false,
    can_view_space_settings_modules: false,
    can_view_space_settings_permissions: false,
    can_view_space_settings_processes: false,
    can_view_space_settings_tasks: false,
    can_view_space_settings_priorities: false,
    can_view_space_settings_status_categories: false,
    can_view_space_settings_resolutions: false,
    can_view_space_settings_statuses: false,
    can_view_space_settings_custom_fields: false,
    can_view_space_settings_field_groups: false,
    can_view_space_settings_wiki_labels: false,
    can_view_space_settings_workflows: false,
    can_view_space_settings_risk_config: false,
    can_edit_risk_config: false,
    can_edit_space_modules: false,
    can_create_task_types: false,
    can_edit_task_types: false,
    can_delete_task_types: false,
    can_create_status_categories: false,
    can_edit_status_categories: false,
    can_delete_status_categories: false,
    can_create_resolutions: false,
    can_edit_resolutions: false,
    can_delete_resolutions: false,
    can_create_field_groups: false,
    can_edit_field_groups: false,
    can_delete_field_groups: false,
    can_create_wiki_labels: false,
    can_edit_wiki_labels: false,
    can_delete_wiki_labels: false,
    can_view_history: true,
    can_view_notifications: true,
    can_create_notifications: false,
    can_edit_notifications: false,
    can_delete_notifications: false,
    can_view_custom_fields: true,
    can_create_custom_fields: false,
    can_edit_custom_fields: false,
    can_delete_custom_fields: false,
    can_view_priorities: true,
    can_create_priorities: false,
    can_edit_priorities: false,
    can_delete_priorities: false,
    can_view_statuses: true,
    can_create_statuses: false,
    can_edit_statuses: false,
    can_delete_statuses: false,
    can_view_hierarchy: true,
    can_create_hierarchy: false,
    can_edit_hierarchy: false,
    can_delete_hierarchy: false,

    // Workflow builder — viewer: view-only
    can_view_status_categories: true,
    can_manage_status_categories: false,
    can_view_resolutions: true,
    can_manage_resolutions: false,
    can_view_workflows: true,
    can_create_workflows: false,
    can_edit_workflows: false,
    can_delete_workflows: false,
    can_publish_workflows: false,
    can_assign_workflows: false,
    can_export_workflow: false,
    can_import_workflow: false,

    // Chat and Robert — viewer: use, no moderation or administration
    can_use_chat: true,
    can_create_chat_groups: true,
    can_delete_any_chat_message: false,
    can_use_robert: true,
    can_manage_robert: false,
    can_view_ai_audit: false,
    ...flatSubPerms(false, false, false),
  },
};

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Merges custom permission overrides on top of a base permissions object.
 * Only defined (non-undefined) values in the custom object override the base.
 *
 * @param {IPermissionsObject} base - The base permissions to start from
 * @param {IPermissionsObject} custom - The custom overrides to apply
 * @returns {IPermissionsObject} The merged permissions object
 */
export function mergePermissions(
  base: IPermissionsObject,
  custom: IPermissionsObject,
): IPermissionsObject {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(custom).filter(([, v]) => v !== undefined),
    ),
  };
}

/**
 * Merges two permission objects using permissive (OR) logic: if either object
 * grants a permission (`true`), the result grants it.
 *
 * @private
 * @param {IPermissionsObject} a - First permissions object
 * @param {IPermissionsObject} b - Second permissions object
 * @returns {IPermissionsObject} The permissively merged result
 */
function mergePermissively(
  a: IPermissionsObject,
  b: IPermissionsObject,
): IPermissionsObject {
  const result: IPermissionsObject = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === true) {
      result[key] = true;
    } else if (result[key] === undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Calculates the effective permissions for a user by combining:
 * 1. Base role defaults
 * 2. Organization-level base role overrides (if any)
 * 3. Custom role permissions (permissive merge -- `true` wins)
 * 4. {@link DEFAULT_ON_CHAT_KEYS}: an override `false` stays `false` unless an
 *    active custom role holds the key explicitly
 *
 * Falls back to `viewer` defaults if the base role is not recognized.
 *
 * @param {IBaseRole} baseRole - The user's base organization role
 * @param {ICustomRole[]} customRoles - Custom roles assigned to the user
 * @param {IPermissionsObject} [baseRoleOverrides] - Organization-level overrides for the base role
 * @returns {IPermissionsObject} The final effective permissions
 */
export function calculateEffectivePermissions(
  baseRole: IBaseRole,
  customRoles: ICustomRole[],
  baseRoleOverrides?: IPermissionsObject,
): IPermissionsObject {
  const safeBaseRole = DEFAULT_PERMISSIONS_BY_ROLE[baseRole]
    ? baseRole
    : 'viewer';
  let effective: IPermissionsObject = {
    ...DEFAULT_PERMISSIONS_BY_ROLE[safeBaseRole],
  };

  if (baseRoleOverrides) {
    effective = mergePermissions(effective, baseRoleOverrides);
  }

  for (const role of customRoles ?? []) {
    if (role.is_active && !role.is_deleted) {
      const safeRoleBase = DEFAULT_PERMISSIONS_BY_ROLE[role.base_role]
        ? role.base_role
        : 'viewer';
      const roleBase = DEFAULT_PERMISSIONS_BY_ROLE[safeRoleBase];
      effective = mergePermissively(effective, roleBase);
      effective = mergePermissively(effective, role.permissions);
    }
  }

  // The merge above also applies each custom role's base-role DEFAULTS, which would
  // hand these keys back to anyone holding any custom role.
  for (const key of DEFAULT_ON_CHAT_KEYS) {
    if (
      baseRoleOverrides?.[key] === false &&
      !(customRoles ?? []).some(
        (role) =>
          role.is_active && !role.is_deleted && role.permissions[key] === true,
      )
    ) {
      effective[key] = false;
    }
  }

  return effective;
}

/**
 * Checks whether a specific permission is granted in a permissions object.
 *
 * @param {IPermissionsObject} permissions - The permissions object to check
 * @param {string} permission - The permission key to look up (e.g., `'can_invite_users'`)
 * @returns {boolean} `true` if the permission is explicitly set to `true`
 */
export function hasPermission(
  permissions: IPermissionsObject,
  permission: string,
): boolean {
  return permissions[permission] === true;
}
