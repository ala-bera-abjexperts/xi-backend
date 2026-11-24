/**
 * The column(s) that give an archived row a name a human recognises.
 *
 * WHY THIS IS NOT A FIELD ON `ComponentTable`
 * -------------------------------------------
 * component-registry.ts draws a hard line: `tenantColumn`, `spaceScope`, `userFkPolicy`,
 * `insertLevel` and `requires` are DERIVED from the live catalog and lock-tested against it by
 * component-registry.spec.ts, which fails the build when the database and the list disagree. Only
 * `tier` and `component` are judgement.
 *
 * "Which column reads best to a person" is judgement, and it is judgement that cannot be checked
 * against the catalog — every candidate here is a real column, so a wrong CHOICE is invisible to a
 * lock test. Putting it on `ComponentTable` would either force the spec to assert on something it
 * cannot verify, or add an unasserted field to 185 spec-covered entries. It lives here instead, and
 * a missing entry degrades to the row's primary key rather than breaking anything.
 *
 * HOW THE CANDIDATES WERE CHOSEN
 * ------------------------------
 * Generated from information_schema against the live catalog — every column named below is a real
 * text/varchar column on that table, not a guess.
 *
 * Two columns are picked, not one, because they answer different questions:
 *   * an IDENTIFIER the user quotes to a colleague — `key`, or `code`;
 *   * a TITLE they recognise — `summary`, `title`, `name`, `label`, `subject`, `display_name`,
 *     `file_name`, `email`.
 *
 * `tasks` is why. It has `key` AND `summary`, and an earlier version of this file ranked them in
 * one list and took the winner — so every task in the report read `TASK-104` with no indication of
 * what TASK-104 actually is. The identifier alone is a lookup instruction, not an answer:
 * "TASK-104 · Migrate the reporting database" is what the reader needs, and both halves are on the
 * row already.
 *
 * `slug` is deliberately NOT used as an identifier even where one exists (wiki_pages,
 * organizations, partner_public_listings): it is derived from the title, so pairing the two just
 * prints the same words twice in two spellings.
 */

/**
 * Table name -> label columns, most identifying first.
 *
 * A table absent from this map is not an error. `buildRowLabel` returns null and the report shows
 * the row's primary key, which is always present.
 */
export const ROW_LABEL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // ---- tasks -------------------------------------------------------------
  // key AND summary. `TASK-104` alone tells the reader to go and look it up.
  tasks: ['key', 'summary'],
  task_priorities: ['key', 'name'],
  task_statuses: ['key', 'name'],
  task_attachments: ['file_name'],
  sprints: ['name'],
  boards: ['name'],
  board_columns: ['name'],
  board_swimlanes: ['name'],
  board_quick_filters: ['name'],

  // ---- processes ---------------------------------------------------------
  business_processes: ['key', 'title'],
  process_attachments: ['file_name'],

  // ---- wiki --------------------------------------------------------------
  // `slug` exists on wiki_pages but is derived from the title, so pairing them prints the same
  // words twice.
  wiki_pages: ['title'],
  wiki_page_versions: ['title'],
  wiki_labels: ['name'],
  wiki_attachments: ['file_name'],
  wiki_page_attachments: ['file_name'],

  // ---- whiteboards -------------------------------------------------------
  whiteboards: ['name'],

  // Test management
  test_folders: ['name'],
  test_preconditions: ['key', 'title'],
  test_management_api_keys: ['name'],
  ci_servers: ['name'],
  test_automation_configs: ['name'],
  test_automation_user_images: ['image_ref'],

  // ---- spaces & config ---------------------------------------------------
  spaces: ['key', 'name'],
  space_types: ['key', 'name'],
  space_categories: ['key', 'name'],
  space_templates: ['name'],
  space_robots: ['name'],
  space_lists: ['name'],
  space_list_items: ['title'],
  status_categories: ['key', 'name'],
  resolutions: ['key', 'name'],
  relation_types: ['name'],
  custom_fields: ['name'],
  custom_roles: ['name'],
  field_groups: ['name'],
  saved_filters: ['name'],
  user_groups: ['name'],
  invitations: ['email'],
  license_plans: ['name'],
  service_principals: ['name'],

  // ---- assets ------------------------------------------------------------
  asset_schemas: ['key', 'name'],
  asset_items: ['title'],
  asset_objects: ['name'],
  asset_object_types: ['name'],
  asset_object_schemas: ['name'],
  asset_object_type_attributes: ['name'],
  asset_item_attachments: ['file_name'],
  asset_object_attachments: ['file_name'],

  // ---- plans & portfolios ------------------------------------------------
  plans: ['name'],
  plan_baselines: ['name'],
  plan_risks: ['name'],
  plan_stakeholders: ['name'],
  plan_items_deprecated: ['name'],
  portfolios: ['name'],
  portfolio_gantt_saved_views: ['name'],

  // ---- workflows & automation --------------------------------------------
  workflows: ['name'],
  workflow_nodes: ['label'],
  workflow_transitions: ['name'],
  workflow_decision_branches: ['label'],
  workflow_health_issues: ['code'],
  automations: ['name'],
  automation_templates: ['name'],
  automation_connections: ['display_name'],

  // ---- dashboards & forms ------------------------------------------------
  dashboards: ['name'],
  dashboard_widgets: ['title'],
  // `form_key` first, for the same reason `tasks` carries its key: a form's NAME is not unique. This
  // installation has two forms both called `t1` (FORM-5 and FORM-6), so naming a field after its
  // form alone still produced two identical `t1 · Short Text` rows — the very ambiguity the parent
  // ref was added to remove. The key is what actually tells them apart.
  form_builder: ['form_key', 'name'],
  form_builder_fields: ['label'],
  form_builder_versions: ['name'],
  heatmap_configurations: ['title'],

  // ---- gdpr --------------------------------------------------------------
  gdpr_spreadsheets: ['title'],
  gdpr_record_attachments: ['file_name'],
  space_gdpr_spreadsheets: ['title'],
  space_gdpr_record_attachments: ['filename'],

  // ---- site studio -------------------------------------------------------
  site_studio_funnels: ['key', 'name'],
  site_studio_pages: ['name'],
  site_studio_form_fields: ['label'],
  site_studio_contacts: ['email'],

  // ---- partner -----------------------------------------------------------
  partner_profiles: ['email'],
  partner_contacts: ['email'],
  partner_offerings: ['title'],
  partner_public_listings: ['summary'],
  partner_license_packages: ['name'],
  partner_license_package_items: ['label'],
  partner_resellable_items: ['name'],
  partner_quote_items: ['label'],
  partner_invoice_items: ['label'],

  // ---- misc --------------------------------------------------------------
  file_attachments: ['file_name'],
  fe_nodes: ['name'],
  fe_labels: ['name'],
  notifications: ['title'],
  support_requests: ['subject'],
  migration_jobs: ['name'],
  migration_connections: ['name'],
  auth_login_attempts: ['email'],
} as const;

/**
 * Descriptive columns for rows that have no name of their own.
 *
 * Comments, history entries, memberships and links are the majority of what a restore moves, and
 * not one of them has a title — there is nothing to call a comment except what it says. Left
 * without an answer these rows showed `id=3116c309-169b-4c70-a065-cc209cd0b6c5`, which tells the
 * reader nothing at all and is the single worst thing on the report.
 *
 * So they are DESCRIBED instead of named: "Changed status", "Logged 90 minutes", the first line of
 * the comment. Not unique, and not meant to be — the reader is deciding whether they care about a
 * class of rows, not looking one up by primary key. The identifier is still there under the
 * technical toggle for anyone who needs it.
 */
const ROW_DESCRIBE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  task_history: ['action', 'field_name'],
  task_comments: ['content'],
  task_relationships: ['source_type', 'target_type'],
  process_comments: ['content'],
  wiki_comments: ['content'],
  wiki_page_comments: ['content'],
  space_members: ['space_role', 'member_type'],
  organization_members: ['role'],
  time_entries: ['note'],
  automation_runs: ['status'],
  automation_run_steps: ['status'],

  // The event's own name — `app.task.attachment_added` and the like. Not unique and not trying to
  // be, exactly as the two statuses above: 44 outbox rows now reach a real restore report, and
  // without this every one of them reads as a bare `id=…`.
  automation_event_outbox: ['kind'],

  // The form_builder family is the largest source of unnamed rows in a real restore — 1 090
  // records across six tables on this installation, none of which has a name column. A status and
  // a step name are not unique, and are not trying to be: the reader is deciding whether they care
  // about a class of rows, not looking one up.
  form_builder_submissions: ['status'],
  form_builder_approvals: ['status', 'mode'],
  form_builder_approval_steps: ['decision', 'comment'],
  form_builder_assignments: ['assignee_role', 'status'],
  form_builder_orders: ['customer_email', 'status'],

  // A webhook has no name of its own — `provider` and `url` are the only things that distinguish
  // one from another. The secret columns beside them are never reachable: the redactor strips them
  // from the payload, and the generic scan's denylist would refuse them anyway.
  form_builder_webhooks: ['provider', 'url'],
  form_builder_integrations: ['provider'],

  // Space-scoped, not form-scoped, so `provider` is all there is to say about one. `publishable_key`
  // is left out deliberately: it is not a secret, but the generic denylist blocks anything ending
  // `_key` and reading it here would only add noise to a row that already names its provider.
  form_builder_payment_configs: ['provider'],
  form_builder_task_field_roles: ['field_key', 'task_field'],
  form_builder_webhook_deliveries: ['event', 'status'],
  form_builder_integration_deliveries: ['event', 'status'],

  // task_status_transitions is deliberately absent: it has no text column at all, only the two
  // status ids it joins. There is nothing on the row to call it, and inventing a column name here
  // would produce a silent null rather than an error — which is the defect this file exists to fix.
  asset_item_comments: ['content'],
  asset_object_comments: ['content'],
  gdpr_record_comments: ['content'],
  space_gdpr_record_comments: ['content'],
  plan_comments: ['content'],
  // `body`, not `content` — this one table spells it differently, and a wrong name here fails
  // silently as "(no name)" rather than loudly as an error.
  partner_lead_comments: ['body'],

  // An embedded image has no name: `file_id` is a content hash and `storage_path` is ids. The
  // whiteboard it sits on (ROW_PARENT_REFS) is the identity; the type is the detail.
  whiteboard_files: ['mime_type'],
  whiteboard_versions: ['name'],
  // A timer has no name either: its board is the identity, its state the detail.
  whiteboard_timers: ['status'],

  // The ticket is the name. Sets and plans have no text of their own, and the generic scan
  // would print their archived flag as `false`.
  test_cases: ['test_type'],
  test_sets: ['created_at'],
  test_plans: ['created_at'],
  test_executions: ['environment', 'source'],
  // A token is named by its key; when it expires is the detail.
  test_management_api_tokens: ['expires_at'],
  // Automation records are named by their setting or image; number, status or decision is the detail.
  test_automation_runs: ['run_no', 'status'],
  test_automation_user_image_approvals: ['status'],
  test_automation_user_image_approval_votes: ['decision'],
} as const;

/**
 * The row a record is really "about", for the tables whose own fields explain nothing.
 *
 * A form submission's status is `submitted`. So is every other submission's. What the reader wants
 * is WHICH FORM it was submitted to — and that is not on the row, it is one foreign key away.
 * Same for a comment, a history entry, a logged hour: the parent is the identity, the row is the
 * detail.
 *
 * This works without an extra query because the planner inserts in dependency order: a parent's
 * level is strictly lower than its child's, so by the time a child is labelled its parent has
 * already been through this file and its name is in the run's index.
 *
 * Every column below was checked against the live catalog. `partner_lead_comments.body` was the
 * one that proved why: it does not spell it `content` like the other six comment tables, and a
 * wrong name here produces a silent "(no name)" rather than an error.
 */
export interface ParentRef {
  /** FK column on the child row. */
  column: string;
  /** The table it points at. */
  table: string;
}

/**
 * Child table -> its parents, in the order they should be read.
 *
 * A LIST, not a single ref, because `form_builder_submissions` has two parents and needs both:
 * `form_id` says what the record IS, `task_id` says what it BELONGS TO, and the rule this file
 * serves — anything related to a task shows the task key — is unsatisfiable if only one can be
 * named. 48 of the 304 submissions in this installation's report carry a task.
 *
 * Order is meaning: the record's own identity first, its link second, so a submission reads
 * `Onboarding Form · NEWSPACE-T88 · submitted` rather than leading with a task that merely
 * references it. A parent that cannot be resolved is skipped rather than leaving a gap, so a
 * submission with no task still reads exactly as it did before this became a list.
 */
export const ROW_PARENT_REFS: Readonly<Record<string, readonly ParentRef[]>> = {
  // ---- everything that hangs off a task ----------------------------------
  // Every table with a foreign key to `tasks`, from the live catalog. A record belonging to a task
  // is identified by that task first: `NEWSPACE-T88 · design.pdf` locates the attachment, whereas
  // `design.pdf` could belong to any of four hundred tasks.
  //
  // `tasks.parent_task_id` is deliberately absent — a task already carries its own key and summary,
  // and prefixing it with its parent's would say the same kind of thing twice.
  task_comments: [{ column: 'task_id', table: 'tasks' }],
  task_history: [{ column: 'task_id', table: 'tasks' }],
  task_attachments: [{ column: 'task_id', table: 'tasks' }],
  task_reminders: [{ column: 'task_id', table: 'tasks' }],
  task_resource_allocations: [{ column: 'task_id', table: 'tasks' }],
  time_entries: [{ column: 'task_id', table: 'tasks' }],
  active_timers: [{ column: 'task_id', table: 'tasks' }],
  board_issue_ranking: [{ column: 'task_id', table: 'tasks' }],
  asset_object_task_links: [{ column: 'task_id', table: 'tasks' }],
  ai_wiki_generations: [{ column: 'task_id', table: 'tasks' }],
  plan_tasks: [{ column: 'task_id', table: 'tasks' }],
  plan_risks: [{ column: 'task_id', table: 'tasks' }],
  workflow_outbox: [{ column: 'task_id', table: 'tasks' }],
  plan_items_deprecated: [{ column: 'linked_task_id', table: 'tasks' }],
  portfolio_management_letters: [{ column: 'linked_task_id', table: 'tasks' }],

  // ---- forms -------------------------------------------------------------
  // A submission's own fields say `submitted`, which is true of every submission ever made. The
  // form it was submitted to is the only thing that tells one from another.
  //
  // BOTH parents, form first. `form_builder_submissions` is the one table in this map with two
  // foreign keys worth naming, and dropping either one loses a real answer: without the form the
  // record is anonymous, and without the task it silently breaks the rule that anything related to
  // a task shows the task key. `task_id` is nullable — most submissions have none — and an
  // unresolved parent is skipped, so those read exactly as they did before.
  form_builder_submissions: [
    { column: 'form_id', table: 'form_builder' },
    { column: 'task_id', table: 'tasks' },
  ],
  form_builder_approvals: [{ column: 'form_id', table: 'form_builder' }],
  form_builder_assignments: [{ column: 'form_id', table: 'form_builder' }],

  // Everything else that belongs to a form, so a row says WHICH form it came from.
  //
  // `form_builder_fields` is why this was added. A field is named by its label, and the labels
  // repeat: a report of eighteen restored fields read "Short Text, Short Text, Yes / No, Phone,
  // Layout" with nothing to tell one form's Short Text from another's. The form name is the only
  // thing that makes those rows distinguishable, and it is one foreign key away.
  //
  // `form_builder_orders` is included even though the database declares no foreign key for its
  // `form_id` — the column is a bare uuid there. Labelling only reads the column, so the ref works
  // regardless; the missing constraint is a schema gap, not a reason to leave the row unnamed.
  form_builder_fields: [{ column: 'form_id', table: 'form_builder' }],
  form_builder_webhooks: [{ column: 'form_id', table: 'form_builder' }],
  form_builder_integrations: [{ column: 'form_id', table: 'form_builder' }],
  form_builder_versions: [{ column: 'form_id', table: 'form_builder' }],
  form_builder_task_field_roles: [{ column: 'form_id', table: 'form_builder' }],
  form_builder_orders: [{ column: 'form_id', table: 'form_builder' }],

  // Two hops from the form, and that is fine: the approval it belongs to has already been labelled
  // WITH its form by the time a step is reached, so the step inherits the whole chain — the form
  // name arrives through the approval rather than being read again.
  //
  // `form_builder_payment_configs` is deliberately NOT here. It has no `form_id` at all: it is
  // scoped to the organization and space, so it configures payments for a SPACE, not for a form.
  // There is no form to name, and inventing a ref would print a blank.
  form_builder_approval_steps: [
    { column: 'approval_id', table: 'form_builder_approvals' },
  ],
  form_builder_webhook_deliveries: [
    { column: 'submission_id', table: 'form_builder_submissions' },
  ],
  form_builder_integration_deliveries: [
    { column: 'submission_id', table: 'form_builder_submissions' },
  ],

  // ---- other parents worth naming ----------------------------------------
  process_comments: [{ column: 'process_id', table: 'business_processes' }],
  wiki_page_comments: [{ column: 'wiki_page_id', table: 'wiki_pages' }],
  // `whiteboard_id` alone, although the FK is composite (whiteboard_id, space_id, organization_id):
  // `whiteboards.id` is already unique, so it names the parent row by itself.
  whiteboard_files: [{ column: 'whiteboard_id', table: 'whiteboards' }],
  whiteboard_versions: [{ column: 'whiteboard_id', table: 'whiteboards' }],
  whiteboard_timers: [{ column: 'whiteboard_id', table: 'whiteboards' }],
  whiteboard_private_sessions: [
    { column: 'whiteboard_id', table: 'whiteboards' },
  ],
  // Test records take their key and name from their ticket.
  test_cases: [{ column: 'task_id', table: 'tasks' }],
  test_sets: [{ column: 'task_id', table: 'tasks' }],
  test_plans: [{ column: 'task_id', table: 'tasks' }],
  test_executions: [{ column: 'task_id', table: 'tasks' }],
  // Test management children, named after the row they hang off.
  test_case_history: [{ column: 'case_id', table: 'test_cases' }],
  test_set_members: [{ column: 'set_id', table: 'test_sets' }],
  test_plan_tests: [{ column: 'plan_id', table: 'test_plans' }],
  test_runs: [{ column: 'execution_id', table: 'test_executions' }],
  test_run_attempts: [{ column: 'run_id', table: 'test_runs' }],
  test_management_api_tokens: [
    { column: 'key_id', table: 'test_management_api_keys' },
  ],
  test_automation_runs: [
    { column: 'config_id', table: 'test_automation_configs' },
  ],
  test_automation_user_image_approvals: [
    { column: 'image_id', table: 'test_automation_user_images' },
  ],
  test_automation_user_image_approval_votes: [
    { column: 'approval_id', table: 'test_automation_user_image_approvals' },
  ],
  // Only one of case, set, plan or run is set per row; the empty ones are skipped.
  test_ticket_links: [
    { column: 'task_id', table: 'tasks' },
    { column: 'case_id', table: 'test_cases' },
    { column: 'set_id', table: 'test_sets' },
    { column: 'plan_id', table: 'test_plans' },
    { column: 'run_id', table: 'test_runs' },
  ],

  // ---- link tables, named by BOTH ends ------------------------------------
  // These carry nothing but foreign keys, so the generic scan finds no text and every row reported
  // "(no name)" — fifteen identical rows in a restore report, telling the reader nothing about which
  // transition or which relation was skipped.
  //
  // Their identity IS the pair they join, which is why both ends are listed: `resolveParents` joins
  // every ref that resolves, so a row reads "Open · In Progress" rather than being named after one
  // arbitrary side. A missing end is skipped rather than fatal, so a half-resolvable row still says
  // as much as it can.
  //
  // The ordering is source-then-target, matching the column order on the table, so the label reads
  // in the direction the relation points.
  task_status_transitions: [
    { column: 'from_status_id', table: 'task_statuses' },
    { column: 'to_status_id', table: 'task_statuses' },
  ],
  asset_item_relations: [
    { column: 'source_item_id', table: 'asset_items' },
    { column: 'target_item_id', table: 'asset_items' },
  ],
  asset_object_references: [
    { column: 'source_object_id', table: 'asset_objects' },
    { column: 'target_object_id', table: 'asset_objects' },
  ],
} as const;

/** Resolves a previously-labelled row. Returns null/undefined when the parent was not restored. */
export type ParentLabelLookup = (
  table: string,
  id: string,
) => string | null | undefined;

/**
 * Columns that describe nothing to a reader, whatever their name.
 *
 * Used by the generic scan below, which is deliberately conservative: it would rather return
 * nothing than print a uuid dressed up as a description.
 */
const NOT_DESCRIPTIVE = /^(id|.*_id|.*_at|.*_by|organizationid|spaceid)$/i;

/** A value long enough to be prose is truncated to a first impression rather than filling the cell. */
const MAX_DESCRIPTION_LENGTH = 60;

/** How long a label may get before it is clamped. Long enough for a wiki title, short enough for a table cell. */
const MAX_LABEL_LENGTH = 120;

/**
 * Builds the human handle for one archived row.
 *
 * Returns null rather than a placeholder when nothing usable is present, so the caller decides how
 * to render "we could not name this row" — the report shows the primary key, which always exists.
 *
 * Values are read from the ARCHIVED row, never from the live one: the point of the label is to say
 * what the backup contained, and for a skipped row there may be no live row at all.
 */
export function buildRowLabel(
  table: string,
  row: Record<string, unknown>,
  lookupParent?: ParentLabelLookup,
): string | null {
  // The row this one belongs to, FIRST. A record that hangs off a task is identified by that task
  // before anything else: `NEWSPACE-T88 · design.pdf` locates the attachment, `design.pdf` alone
  // could belong to any of four hundred tasks. This is why the parent is not merely a fallback for
  // rows that have no name of their own.
  const parent = resolveParents(table, row, lookupParent);

  // The row's own name, if the table has one; otherwise a description; otherwise a generic scan.
  //
  // The two are clamped differently on purpose. A NAME is worth 120 characters — a wiki title
  // earns the room. A DESCRIPTION is prose the row happened to contain, and sixty characters of
  // prose in a table cell is already at the limit of useful.
  const named = collect(row, ROW_LABEL_COLUMNS[table]);

  const own =
    named ??
    collect(row, ROW_DESCRIBE_COLUMNS[table]) ??
    scanForDescription(row);

  const ownLimit = named ? MAX_LABEL_LENGTH : MAX_DESCRIPTION_LENGTH;

  if (parent && own) {
    return `${parent} · ${clamp(own, ownLimit)}`;
  }

  if (parent) {
    return clamp(parent, MAX_LABEL_LENGTH);
  }

  return own ? clamp(own, ownLimit) : null;
}

/**
 * The parent rows' labels, for the parents this table has and that were restored too.
 *
 * Joins every parent that resolves and skips the ones that do not, rather than giving up on the
 * first miss. That matters for the one table with two parents: a form submission whose `task_id` is
 * null — most of them — must still be named after its form, and a submission whose form is absent
 * from the archive must still show its task key.
 */
function resolveParents(
  table: string,
  row: Record<string, unknown>,
  lookupParent: ParentLabelLookup | undefined,
): string | null {
  const refs = ROW_PARENT_REFS[table];

  if (!refs || !lookupParent) {
    return null;
  }

  const parts: string[] = [];

  for (const ref of refs) {
    const id = row[ref.column];

    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }

    const label = lookupParent(ref.table, id);

    if (label) {
      parts.push(label);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Joins the readable values of the named columns, or null when none of them holds one. */
function collect(
  row: Record<string, unknown>,
  columns: readonly string[] | undefined,
): string | null {
  if (!columns) {
    return null;
  }

  const parts: string[] = [];

  for (const column of columns) {
    const text = readable(row[column]);

    if (text) {
      parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Last resort: the first two short, non-technical text values on the row.
 *
 * Short on purpose. A long value is prose — a description, a body, a serialised blob — and the
 * first sixty characters of prose in a table cell reads as noise, whereas a status or a type reads
 * as an answer.
 */
function scanForDescription(row: Record<string, unknown>): string | null {
  const parts: string[] = [];

  for (const [column, value] of Object.entries(row)) {
    if (parts.length >= 2) {
      break;
    }

    if (NOT_DESCRIPTIVE.test(column) || isSecretishName(column)) {
      continue;
    }

    const text = readable(value);

    if (text && text.length <= MAX_DESCRIPTION_LENGTH) {
      parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Mirrors the redactor's denylist so a scan cannot surface a secret the payload would have hidden.
 *
 * `key` is exempt. The pattern is there to hide `api_key` and `encryption_key`, but it also matched
 * the bare `key` column — the human identifier on eleven tables in this catalog, `tasks` among them.
 * The curated lists above save the classified tables from that, but an unclassified table with a
 * `key` column would have had its one readable identifier skipped by the generic scan. Exact match
 * only, so `api_key` and `secret_key` stay hidden: they are not `key`.
 */
const SECRETISH_EXCEPTIONS = new Set(['key']);

function isSecretishName(name: string): boolean {
  if (SECRETISH_EXCEPTIONS.has(name.toLowerCase())) {
    return false;
  }

  return /secret|token|password|passphrase|credential|key|hash|signature|salt|nonce/i.test(
    name,
  );
}

/** A value a person can read: not null, not an object, not empty once trimmed. */
function readable(value: unknown): string | null {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean' &&
    typeof value !== 'bigint'
  ) {
    return null;
  }

  const text = String(value).trim();

  return text.length > 0 ? text : null;
}

function clamp(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
