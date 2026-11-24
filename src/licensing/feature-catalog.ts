// =============================================================================
// FEATURE CATALOG — SOURCE OF TRUTH
//
// SYNC RULE: src/lib/licensing/feature-catalog.ts and
//            xisuite-backend/src/licensing/feature-catalog.ts MUST be identical
//            for FEATURE_CATALOG + types + helpers.
//            When you change one, copy the change to the other.
//            A pre-build sync script will automate this in a later phase.
// =============================================================================

export type FeatureCategory =
  | 'modules' // top-level dashboard modules (Portfolios, Wiki, Site Studio, etc.)
  | 'workspace' // workspace-level features (spaces, users, storage)
  | 'collaboration' // collaboration-layer features (custom roles, groups, audit)
  | 'integrations' // external integrations
  | 'limits' // numeric quotas
  | 'advanced'; // power features (AI, branding, impersonation toggle)

export type FeatureType = 'boolean' | 'limit' | 'text' | 'json';

export interface FeatureCatalogEntry {
  /** snake_case, must match /^[a-z][a-z0-9_]*$/ — same regex the DB enforces. */
  key: string;

  /** Display name shown to super-admins in the plan editor. */
  name: string;

  /** One-sentence description shown next to the name. */
  description: string;

  /** UI grouping in the plan editor. */
  category: FeatureCategory;

  /** How the entitlement_value is interpreted. */
  type: FeatureType;

  /**
   * Catalog default — applied when the tenant is on a plan that doesn't
   * declare this feature. NOT applied when the tenant is grandfathered
   * (grandfathered tenants get unlimited access regardless of catalog default).
   *
   * - For type='boolean': the default boolean value.
   * - For type='limit': the default numeric ceiling. `null` means unlimited.
   * - For type='text' or 'json': the default value.
   */
  defaultValue: boolean | number | string | Record<string, unknown> | null;

  /**
   * Route patterns under (dashboard) that this feature gates.
   * Used by FeatureRouteGuard (Phase 3) to know which routes to check.
   * Regex-style, anchored. Empty array = no route enforcement at this layer.
   */
  guardedRoutes: string[];

  /**
   * The sidebar section ID this feature controls. Used by the sidebar
   * gate in Phase 3. `null` if this feature doesn't correspond to a
   * sidebar section (e.g. limits, advanced features).
   *
   * Values must match `SidebarSectionIdEnum` from
   * src/models/sidebar-preferences.model.ts.
   */
  guardedSidebarSection: string | null;

  /**
   * Whether this feature should be turned on by default in a new plan
   * when the super-admin opens the catalog picker. Lets us suggest
   * sensible "free tier" defaults vs. "must explicitly enable" features.
   */
  suggestedForFreePlan: boolean;
}

// Mirrors SidebarSectionIdEnum in src/models/sidebar-preferences.model.ts.
// Hard-coded (NOT imported) so the backend copy of this file stays byte-identical
// with the frontend copy — the backend cannot import frontend zod models. If you
// change SidebarSectionIdEnum, update this list in BOTH catalog files.
const VALID_SIDEBAR_SECTION_IDS = [
  'for_you',
  'recent',
  'starred',
  'apps',
  'plans',
  'spaces',
  'filters',
  'dashboards',
  'site_studio',
  'portfolios',
  'document_designer',
  'calendar',
  'test_management',
  'help_center',
  'operations',
  'external_links',
  'settings',
];

export const FEATURE_CATALOG: readonly FeatureCatalogEntry[] = [
  // ---------------------------------------------------------------------------
  // Modules — top-level (dashboard) sections. All boolean, default OFF.
  // ---------------------------------------------------------------------------
  {
    key: 'module_spaces',
    name: 'Spaces',
    description: 'The core workspace containers for all organization content.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces(/.*)?$'],
    guardedSidebarSection: 'spaces',
    suggestedForFreePlan: true,
  },
  {
    key: 'module_portfolios',
    name: 'Portfolios',
    description: 'Aggregate multiple plans into executive roll-up views.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/portfolios(/.*)?$'],
    guardedSidebarSection: 'portfolios',
    suggestedForFreePlan: false,
  },
  {
    key: 'module_chat',
    name: 'Chat',
    description:
      'Team chat: direct messages, groups and space channels with object cards.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/chat(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'module_help_center',
    name: 'Help Center',
    description: 'End-user documentation, support form, and ticket tracking.',
    category: 'modules',
    type: 'boolean',
    defaultValue: true,
    guardedRoutes: ['^/help-center(/.*)?$'],
    guardedSidebarSection: 'help_center',
    suggestedForFreePlan: true,
  },
  {
    key: 'module_partners',
    name: 'Partner Portal',
    description:
      'Partner workspace: leads, customer licenses, quotes, invoices.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/partner(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_plans',
    name: 'Plans',
    description: 'Project plans with Gantt timelines and scheduling.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/plans(/.*)?$'],
    guardedSidebarSection: 'plans',
    suggestedForFreePlan: true,
  },
  {
    key: 'module_tasks',
    name: 'Tasks',
    description: 'Create and track work items across spaces.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/tasks(/.*)?$', '^/spaces/[^/]+/tasks(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'module_risk',
    name: 'Risk Management',
    description: 'Risk registers, scoring, and risk configuration.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: [
      '^/risk-configurations(/.*)?$',
      '^/spaces/[^/]+/risk(/.*)?$',
    ],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_wiki',
    name: 'Wiki',
    description: 'Rich-text knowledge pages within a space.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/wiki(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'module_robot',
    name: 'Robot (Automations)',
    description: 'No-code automations and triggered actions.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/robot(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_processes',
    name: 'Process Editor',
    description: 'Model and document business processes.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/processes(/.*)?$', '^/spaces/[^/]+/processes(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_gdpr',
    name: 'GDPR',
    description: 'Data subject records and compliance tracking.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/gdpr(/.*)?$', '^/spaces/[^/]+/gdpr(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_site_studio',
    name: 'Site Studio',
    description: 'Visual page builder and marketing funnels.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/site-studio(/.*)?$'],
    guardedSidebarSection: 'site_studio',
    suggestedForFreePlan: false,
  },
  {
    key: 'module_dashboards',
    name: 'Dashboards',
    description: 'Configurable analytics widgets and KPI views.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/dashboard(/.*)?$', '^/spaces/[^/]+/dashboards(/.*)?$'],
    guardedSidebarSection: 'dashboards',
    suggestedForFreePlan: true,
  },
  {
    key: 'module_lists',
    name: 'Lists',
    description: 'Structured custom list and schema data within a space.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/lists(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'module_assets',
    name: 'Assets',
    description: 'Hierarchical CMDB (Asset Management) within a space.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/assets(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_form_builder',
    name: 'Form Builder',
    description:
      'Internal form builder: drag-and-drop forms, fields, and submissions within a space.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/form-builder(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_boards',
    name: 'Boards',
    description: 'Kanban boards for visual task management.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/boards(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'module_heatmap',
    name: 'Heatmap',
    description: 'Risk heatmap visualization and configuration.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/heatmap-config(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_filters',
    name: 'Saved Filters',
    description: 'Reusable cross-space saved filter queries.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/filters(/.*)?$'],
    guardedSidebarSection: 'filters',
    suggestedForFreePlan: true,
  },
  {
    // Distinct from `module_robot`. Robot is the space-level module; Automations
    // is the workflow engine behind /spaces/:key/automations and 10 backend
    // controllers. They were previously competing for the single `module_robot`
    // key, so neither could be licensed independently.
    key: 'module_automations',
    name: 'Automations',
    description: 'Rule-based automation engine: triggers, actions and runs.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/automations(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    // Excalidraw canvases per space. Defaults ON (unlike the other modules): it shipped to
    // every tenant, and a false default would hide it from each licensed tenant until its
    // plan was edited. A plan or override can still switch it off.
    key: 'module_whiteboards',
    name: 'Whiteboards',
    description:
      'Excalidraw whiteboards for sketching and diagrams within a space.',
    category: 'modules',
    type: 'boolean',
    defaultValue: true,
    guardedRoutes: ['^/spaces/[^/]+/whiteboards(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    // Off by default; licence a tenant through its plan or an override.
    key: 'module_test_management',
    name: 'Test Management',
    description:
      'Test cases, test plans, test runs and results within a space.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: [],
    guardedSidebarSection: 'test_management',
    suggestedForFreePlan: false,
  },
  {
    key: 'module_file_explorer',
    name: 'File Explorer',
    description: 'Per-space file storage, folders, versions and sharing.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/spaces/[^/]+/file-explorer(/.*)?$'],
    guardedSidebarSection: null,
    // Premium by decision. NOTE: a locked tenant loses File Explorer, and it
    // holds user files, so the lock must stay read-preserving (content visible,
    // creation blocked) rather than hiding it.
    suggestedForFreePlan: false,
  },
  {
    key: 'module_migration',
    name: 'Migration',
    description: 'Jira and Confluence import tooling.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    // No dashboard route: migration is driven from settings, and is
    // additionally gated by `can_manage_migrations` plus an org toggle that
    // defaults OFF.
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_backup',
    name: 'Backup & Restore',
    description:
      'Tenant-wide scheduled backups to a customer-owned SFTP server or SharePoint Online library, with in-place restore.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,

    // No guarded route: the UI is a tab inside Tenant Config, not a route of its own. The route
    // guard also fails open, so this guard is the real boundary.
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'module_resource_planning',
    name: 'Resource Planning',
    description: 'Capacity and allocation planning across spaces.',
    category: 'modules',
    type: 'boolean',
    // Free tier by decision: this key already existed in the frontend's
    // ModulesTab as `requiresLicense: true` while existing in NEITHER catalog,
    // so Resource Planning was locked for every non-grandfathered tenant behind
    // a licence that could not be bought. Defaulting it true keeps today's
    // behaviour (the org toggle governs it) instead of locking it on rollout.
    defaultValue: true,
    guardedRoutes: ['^/resource-planning(/.*)?$'],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'module_apps',
    name: 'Apps',
    description: 'Installable applications and extensions.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/apps(/.*)?$'],
    guardedSidebarSection: 'apps',
    suggestedForFreePlan: false,
  },
  {
    key: 'module_calendar',
    name: 'Calendar',
    description: 'Organization calendars.',
    category: 'modules',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: ['^/calendar(/.*)?$'],
    guardedSidebarSection: 'calendar',
    suggestedForFreePlan: false,
  },
  {
    key: 'module_document_designer',
    name: 'Document Designer',
    description: 'Design document templates and export them as PDF or Word.',
    category: 'modules',
    type: 'boolean',
    // Premium by decision, matching the other recently-added modules
    // (automations, file_explorer, migration). A licensed tenant therefore
    // needs the key named on its plan (or an override); only never-licensed
    // (grandfathered) tenants get it for free.
    defaultValue: false,
    // No dashboard route yet, so guardedRoutes stays empty and @RequireFeature on the controllers is the
    // route-level gate. The sidebar section DOES exist, though — without naming it here it would render
    // for every tenant regardless of entitlement, because DynamicSidebarSections only hides a section
    // whose guardedSidebarSection maps to a feature the tenant lacks.
    guardedRoutes: [],
    guardedSidebarSection: 'document_designer',
    suggestedForFreePlan: false,
  },

  // ---------------------------------------------------------------------------
  // Limits — numeric quotas. `null` defaultValue means unlimited.
  // ---------------------------------------------------------------------------
  {
    key: 'limit_spaces',
    name: 'Max Spaces',
    description: 'Maximum number of spaces the organization can create.',
    category: 'limits',
    type: 'limit',
    defaultValue: 3,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'limit_users',
    name: 'Max Users',
    description: 'Maximum number of active users in the organization.',
    category: 'limits',
    type: 'limit',
    defaultValue: 5,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'limit_storage_mb',
    name: 'Storage (MB)',
    description: 'Total attachment storage available, in megabytes.',
    category: 'limits',
    type: 'limit',
    defaultValue: 1024,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'limit_custom_fields_per_space',
    name: 'Custom Fields per Space',
    description: 'Maximum custom fields definable per space.',
    category: 'limits',
    type: 'limit',
    defaultValue: 10,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'limit_automations',
    name: 'Max Automations',
    description: 'Maximum number of active automations.',
    category: 'limits',
    type: 'limit',
    defaultValue: 3,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },

  // ---------------------------------------------------------------------------
  // Collaboration — boolean power features for teams.
  // ---------------------------------------------------------------------------
  {
    key: 'feature_custom_roles',
    name: 'Custom Roles',
    description: 'Create roles beyond owner/admin/member/viewer.',
    category: 'collaboration',
    type: 'boolean',
    defaultValue: true,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'feature_user_groups',
    name: 'User Groups',
    description: 'Group users together for permission assignment.',
    category: 'collaboration',
    type: 'boolean',
    defaultValue: true,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'feature_advanced_permissions',
    name: 'Advanced Permissions',
    description: 'Fine-grained per-space permission overrides.',
    category: 'collaboration',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'feature_audit_logs',
    name: 'Audit Logs',
    description: 'View the organization audit log.',
    category: 'collaboration',
    type: 'boolean',
    defaultValue: true,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },

  // ---------------------------------------------------------------------------
  // Advanced — power features.
  // ---------------------------------------------------------------------------
  {
    key: 'feature_ai_assist',
    name: 'AI Assist',
    description: 'AI-powered features inside editors.',
    category: 'advanced',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'feature_custom_branding',
    name: 'Custom Branding',
    description: 'Custom logo, colors, and domain.',
    category: 'advanced',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
  {
    key: 'feature_impersonation_target',
    name: 'Support Impersonation',
    description: 'Whether this tenant can be impersonated by support.',
    category: 'advanced',
    type: 'boolean',
    defaultValue: true,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: true,
  },
  {
    key: 'feature_sso',
    name: 'Single Sign-On & SCIM',
    description:
      'SAML single sign-on, SCIM user and group provisioning, and Require SSO.',
    category: 'advanced',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },

  // ---------------------------------------------------------------------------
  // Integrations.
  // ---------------------------------------------------------------------------
  {
    key: 'feature_external_integrations',
    name: 'External Integrations',
    description: 'External API and webhook integrations.',
    category: 'integrations',
    type: 'boolean',
    defaultValue: false,
    guardedRoutes: [],
    guardedSidebarSection: null,
    suggestedForFreePlan: false,
  },
];

// Stable lookup map, built once at module load.
const FEATURE_BY_KEY: ReadonlyMap<string, FeatureCatalogEntry> = new Map(
  FEATURE_CATALOG.map((entry) => [entry.key, entry]),
);

// Compiled-regex cache so each guardedRoutes pattern is only compiled once.
const ROUTE_REGEX_CACHE = new Map<string, RegExp | null>();

function compileRoutePattern(pattern: string): RegExp | null {
  if (ROUTE_REGEX_CACHE.has(pattern)) {
    return ROUTE_REGEX_CACHE.get(pattern) ?? null;
  }

  let compiled: RegExp | null;

  try {
    compiled = new RegExp(pattern);
  } catch {
    compiled = null;
  }

  ROUTE_REGEX_CACHE.set(pattern, compiled);

  return compiled;
}

/** Stable lookup by key. Returns undefined if key is not in the catalog. */
export function getFeatureByKey(key: string): FeatureCatalogEntry | undefined {
  return FEATURE_BY_KEY.get(key);
}

/** All entries for a given category, preserving catalog order. */
export function getFeaturesByCategory(
  category: FeatureCategory,
): FeatureCatalogEntry[] {
  return FEATURE_CATALOG.filter((entry) => entry.category === category);
}

/** Just the keys of entries with `category: 'modules'`. */
export const MODULE_FEATURE_KEYS: readonly string[] = FEATURE_CATALOG.filter(
  (entry) => entry.category === 'modules',
).map((entry) => entry.key);

/** Just the keys of entries that have a non-null guardedSidebarSection. */
export const SIDEBAR_GATED_FEATURE_KEYS: readonly string[] =
  FEATURE_CATALOG.filter((entry) => entry.guardedSidebarSection !== null).map(
    (entry) => entry.key,
  );

/**
 * Given a Next.js pathname, return all catalog entries whose `guardedRoutes`
 * match. Used by FeatureRouteGuard (Phase 3) but also a useful general helper.
 *
 * Each guardedRoutes pattern is compiled into a RegExp once and cached at the
 * module level, then matched against the pathname.
 */
export function getFeaturesForRoute(pathname: string): FeatureCatalogEntry[] {
  return FEATURE_CATALOG.filter((entry) =>
    entry.guardedRoutes.some((pattern) => {
      const regex = compileRoutePattern(pattern);

      return regex ? regex.test(pathname) : false;
    }),
  );
}

/**
 * Compile-time check that catalog is consistent. Called by the runtime
 * validator in the resolver service on app boot. Returns array of error
 * strings; empty array means the catalog is valid.
 */
export function validateCatalog(): string[] {
  const errors: string[] = [];
  const keyRegex = /^[a-z][a-z0-9_]*$/;
  const seenKeys = new Set<string>();
  const validSections = new Set<string>(VALID_SIDEBAR_SECTION_IDS);

  for (const entry of FEATURE_CATALOG) {
    if (!keyRegex.test(entry.key)) {
      errors.push(
        `Feature key "${entry.key}" does not match /^[a-z][a-z0-9_]*$/`,
      );
    }

    if (seenKeys.has(entry.key)) {
      errors.push(`Duplicate feature key "${entry.key}"`);
    }

    seenKeys.add(entry.key);

    if (
      entry.guardedSidebarSection !== null &&
      !validSections.has(entry.guardedSidebarSection)
    ) {
      errors.push(
        `Feature "${entry.key}" has unknown guardedSidebarSection "${entry.guardedSidebarSection}"`,
      );
    }

    for (const pattern of entry.guardedRoutes) {
      try {
        new RegExp(pattern);
      } catch {
        errors.push(
          `Feature "${entry.key}" has an invalid route pattern "${pattern}"`,
        );
      }
    }

    switch (entry.type) {
      case 'boolean':
        if (typeof entry.defaultValue !== 'boolean') {
          errors.push(
            `Feature "${entry.key}" is type 'boolean' but defaultValue is not a boolean`,
          );
        }

        break;
      case 'limit':
        if (
          entry.defaultValue !== null &&
          typeof entry.defaultValue !== 'number'
        ) {
          errors.push(
            `Feature "${entry.key}" is type 'limit' but defaultValue is not a number or null`,
          );
        }

        break;
      case 'text':
        if (typeof entry.defaultValue !== 'string') {
          errors.push(
            `Feature "${entry.key}" is type 'text' but defaultValue is not a string`,
          );
        }

        break;
      case 'json':
        if (
          entry.defaultValue !== null &&
          (typeof entry.defaultValue !== 'object' ||
            Array.isArray(entry.defaultValue))
        ) {
          errors.push(
            `Feature "${entry.key}" is type 'json' but defaultValue is not an object or null`,
          );
        }

        break;
    }
  }

  return errors;
}
