import { Injectable, Logger, Optional } from '@nestjs/common';

import { TasksService } from '../tasks/tasks.service';
import { TaskHierarchyConfigService } from '../task-hierarchy-config/task-hierarchy-config.service';
import { CreateTaskDto } from '../tasks/dto/create-task.dto';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetObjectTaskLinksService } from '../assets-objects/asset-object-task-links.service';
import { validateFieldValue } from '../custom-fields/utils/custom-field-validation';
import { ATTRIBUTE_FIELD_KEY_PATTERN } from '../assets-objects/filtering/asset-filter-fields';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import { expandLayoutFields } from './logic/expand-layout-fields';
import { toTaskCustomFieldValue } from './task-custom-field-values';
import type { ITaskCustomFieldTarget } from './task-custom-field-values';
import {
  applyInheritedAssetConfigs,
  loadInheritableAssetCustomFields,
} from './asset-config-inheritance';
import { toSupportRequestPriorityBucket } from '../help-center/priority.util';

const FORMS_TABLE = 'form_builder';
const FIELDS_TABLE = 'form_builder_fields';
const SUBMISSIONS_TABLE = 'form_builder_submissions';
const CUSTOM_FIELDS_TABLE = 'custom_fields';
const SUPPORT_REQUESTS_TABLE = 'support_requests';

// support_requests.category is CHECK-constrained; these task types read as technical tickets.
const TECHNICAL_TASK_TYPES = new Set(['incident', 'bug', 'problem']);

// 'custom:<field_key>' targets tasks.custom_field_values instead of a built-in column
const CUSTOM_PREFIX = 'custom:';

// Answers collected for the custom fields the selected task type defines. Not form fields, so they
// travel in the submission data under this namespace. Keep in lockstep with the frontend's
// `src/views/form-builder/task-type-custom-fields.ts` and the submissions service.
const TASK_TYPE_CF_PREFIX = '__cf__';
const SAFE_CF_KEY_RE = /^[A-Za-z0-9_-]+$/;

function taskTypeCfFieldKey(key: string): string | null {
  if (!key.startsWith(TASK_TYPE_CF_PREFIX)) return null;

  const fieldKey = key.slice(TASK_TYPE_CF_PREFIX.length);

  return SAFE_CF_KEY_RE.test(fieldKey) ? fieldKey : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DTO keys backed by uuid columns — a mapped dropdown *label* must never land in one of these
const UUID_DTO_KEYS = new Set<string>([
  'priority_id',
  'status_id',
  'parent_task_id',
  'assigned_to',
  'reporter',
]);

function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Maps role.task_field → the matching CreateTaskDto property name
const TASK_FIELD_TO_DTO_KEY: Partial<Record<string, keyof CreateTaskDto>> = {
  task_type: 'task_type_id',
  priority: 'priority_id',
  status: 'status_id',
  parent_task: 'parent_task_id',
  summary: 'summary',
  description: 'description',
  assigned_to: 'assigned_to',
  reporter: 'reporter',
  start_date: 'start_date',
  due_date: 'due_date',
  progress: 'progress',
};

// Kept in lockstep with the roles-table writer's CHECK — mirrors
// `FormBuilderTaskFieldRolesService` VALID_TASK_FIELDS / isValidTaskField so live derivation
// drops exactly the same malformed mappings the sync() path would.
const VALID_TASK_FIELDS = new Set<string>([
  'task_type',
  'priority',
  'status',
  'parent_task',
  'summary',
  'description',
  'assigned_to',
  'reporter',
  'start_date',
  'due_date',
  'progress',
]);
const CUSTOM_TASK_FIELD_RE = /^custom:[A-Za-z0-9_-]+$/;

function isValidTaskField(taskField: string): boolean {
  return (
    VALID_TASK_FIELDS.has(taskField) || CUSTOM_TASK_FIELD_RE.test(taskField)
  );
}

// Shape used only by maybeCreateTask's mapping loop. Kept minimal (no id/space_id/form_id) because
// the loop reads only these fields.
interface ITaskFieldRole {
  field_key: string;
  task_field: string;

  // The answer's form type and options, so a custom-field target can convert it
  answer_type: string;
  answer_options: unknown;
}

// The form's fields as read from `form_builder_fields`.
interface ITaskMappableFieldRow {
  field_key: string;
  field_type: string;
  validation_rules: Record<string, unknown> | null;
}

// A form field row with its options (choice labels, matrix rows) — what role derivation reads.
type IFormFieldRow = ITaskMappableFieldRow & { options: unknown };

// An explicitly mapped `custom:<key>` answer, kept with what its conversion needs.
interface IExplicitCfAnswer {
  value: unknown;
  answerType: string;
  answerOptions: unknown;
}

// A `custom_fields` row as filterCustomFieldValues reads it.
interface ICustomFieldDefinition extends ITaskCustomFieldTarget {
  field_key: string;
  contexts?: unknown;
  is_active?: boolean | null;
  is_deleted?: boolean | null;
  space_id?: string | null;
}

// A custom field reached through a task-type assignment — the exact row the fill picker rendered.
interface IAssignedCfRow {
  id?: string;
  field_key?: string;
  field_type?: string;
  validation_rules?: Record<string, unknown> | null;
  space_id?: string | null;
  is_active?: boolean | null;
  is_deleted?: boolean | null;
}

// Everything the asset-link pass needs, fetched in the assignment join already being made.
const ASSIGNED_CF_EMBED =
  'is_hidden, custom_field:custom_fields!custom_field_id(id, field_key, field_type, validation_rules, space_id, is_active, is_deleted)';

// The builder shows only options.rows × options.columns cells; leftovers beyond that must not map.
function trimLayoutCells<T extends { field_type: string; options: unknown }>(
  rows: T[],
): T[] {
  return rows.map((row) => {
    const options = row.options as {
      rows?: unknown;
      columns?: unknown;
      cells?: unknown;
    } | null;

    if (row.field_type !== 'layout' || !Array.isArray(options?.cells)) {
      return row;
    }

    const rowCount =
      typeof options.rows === 'number' ? options.rows : options.cells.length;
    const columnCount =
      typeof options.columns === 'number' ? options.columns : Infinity;
    const cells = (options.cells as unknown[])
      .slice(0, rowCount)
      .map((cellRow) =>
        Array.isArray(cellRow) ? cellRow.slice(0, columnCount) : cellRow,
      );

    return { ...row, options: { ...options, cells } };
  });
}

// Live derivation of task-field roles from the form's fields — the SOURCE OF TRUTH
// (`validation_rules.task_field`). Kept in lockstep with the frontend
// `src/views/form-builder/task-field-mappings.ts::buildTaskFieldMappings`, which also feeds the
// derived `form_builder_task_field_roles` table via the sync endpoint. Reading fields directly here
// removes the dependency on that table being freshly synced (the root cause of tasks silently not
// being created after a mapping edit).
function deriveTaskFieldRoles(fields: IFormFieldRow[]): ITaskFieldRole[] {
  // Keyed by task_field so two fields mapping the same task_field resolve last-wins, matching the
  // frontend which builds the same object over sort_order-ordered fields. The caller MUST order the
  // query by sort_order so the winner is identical to what the roles table would have recorded.
  const mappings: Record<string, ITaskFieldRole> = {};

  for (const field of fields ?? []) {
    const rules = field.validation_rules ?? {};

    if (field.field_type === 'date_range') {
      // date_range maps its start and end halves separately via task_field_start / task_field_end
      const taskFieldStart = rules.task_field_start as string | undefined;
      const taskFieldEnd = rules.task_field_end as string | undefined;
      const half = (task_field: string, suffix: string): ITaskFieldRole => ({
        field_key: `${field.field_key}${suffix}`,
        task_field,
        answer_type: 'date',
        answer_options: null,
      });

      if (taskFieldStart)
        mappings[taskFieldStart] = half(taskFieldStart, '__start');
      if (taskFieldEnd) mappings[taskFieldEnd] = half(taskFieldEnd, '__end');

      continue;
    }

    const taskField = rules.task_field as string | undefined;

    if (taskField)
      mappings[taskField] = {
        field_key: field.field_key,
        task_field: taskField,
        answer_type: field.field_type,
        answer_options: field.options ?? null,
      };
  }

  return Object.values(mappings).filter(
    (role) => !!role.field_key && isValidTaskField(role.task_field),
  );
}

// A plain object, or an empty one — never a string or array spread into invented keys.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Link rows for task-type (`__cf__`) asset answers, shaped like form field rows so the existing
 * validated link pass handles them unchanged. Pure — no I/O — so it can never abort regular links.
 */
function taskTypeAssetLinkRows(
  winners: Set<string>,
  accepted: Record<string, unknown> | undefined,
  assigned: Map<string, IAssignedCfRow[]>,
  targetSpaceId: string,
  warn: (message: string) => void,
): ITaskMappableFieldRow[] {
  const out: ITaskMappableFieldRow[] = [];

  for (const key of winners) {
    // Filtering may have dropped the value; a link no displayed value explains is worse than none.
    if (!accepted || !(key in accepted)) continue;

    const live = (assigned.get(key) ?? []).filter(
      (row) => row.is_active !== false && row.is_deleted !== true,
    );
    const inSpace = live.filter((row) => row.space_id === targetSpaceId);
    const orgLevel = live.filter((row) => !row.space_id);
    const candidates = inSpace.length
      ? inSpace
      : orgLevel.length
        ? orgLevel
        : live;

    if (candidates.length > 1) {
      warn(
        `${key} matches ${candidates.length} assigned custom fields — not linked`,
      );
    }

    if (candidates.length !== 1) continue;

    const row = candidates[0];

    if (row.field_type !== 'asset' && row.field_type !== 'asset_multi')
      continue;

    const rules = asRecord(row.validation_rules);
    const asset = asRecord(rules.asset);

    // Pin the space the picker queried, so the link pass never falls back to the form's space.
    const spaceId =
      typeof asset.space_id === 'string' && asset.space_id
        ? asset.space_id
        : targetSpaceId;

    out.push({
      field_key: `${TASK_TYPE_CF_PREFIX}${key}`,
      field_type: row.field_type,
      validation_rules: { ...rules, asset: { ...asset, space_id: spaceId } },
    });
  }

  return out;
}

@Injectable()
export class FormBuilderTaskCreatorService {
  private readonly logger = new Logger(FormBuilderTaskCreatorService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly tasks: TasksService,
    private readonly assetTaskLinks: AssetObjectTaskLinksService,

    // Optional so a missing provider keeps the configured type, exactly as before.
    @Optional() private readonly taskHierarchy?: TaskHierarchyConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Unknown, inactive or unresolvable → false, so the configured type is kept.
  private async isActiveTaskType(
    orgId: string,
    spaceId: string,
    typeId: unknown,
  ): Promise<boolean> {
    if (!this.taskHierarchy || typeof typeId !== 'string' || !typeId)
      return false;

    try {
      const types = await this.taskHierarchy.getActiveTypes(orgId, spaceId);

      return types.some((type) => type.id === typeId);
    } catch (error) {
      this.logger.warn(
        `could not resolve task types for space ${spaceId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );

      return false;
    }
  }

  /**
   * Best-effort task creation triggered after a form submission finalises.
   * Reads the form's task_integration settings, maps submission data through
   * form_builder_task_field_roles, and calls TasksService.create().
   * Never throws — any error is logged and silently discarded so the submission
   * response is never blocked.
   */
  async maybeCreateTask(
    formId: string,
    orgId: string,
    submittedBy: string | null,
    submissionData: Record<string, unknown>,
    submissionId?: string,

    // A fill ON a task: its task_id is the host task, so it must stay and cannot be the guard.
    opts: { hostTaskLinked?: boolean } = {},
  ): Promise<void> {
    try {
      // Idempotency: a submission maps to at most one task. If a task_id is already linked (e.g. the
      // paid path can fire BOTH the status-poll finalize and the Stripe webhook for one order), stop
      // before creating a duplicate. Mirrors the guard in handleApprovalCompleted.
      if (submissionId && opts.hostTaskLinked) {
        const { data: existing } = await this.client
          .from(SUBMISSIONS_TABLE)
          .select('task_creation_status')
          .eq('id', submissionId)
          .maybeSingle();

        if (
          (existing as { task_creation_status?: string | null } | null)
            ?.task_creation_status === 'created'
        )
          return;
      } else if (submissionId) {
        const { data: existing } = await this.client
          .from(SUBMISSIONS_TABLE)
          .select('task_id')
          .eq('id', submissionId)
          .maybeSingle();

        if ((existing as { task_id?: string | null } | null)?.task_id) return;
      }

      // created_by doubles as the fallback author for anonymous submissions (public Site Studio
      // pages), which carry no user identity but must still be able to create a task.
      const { data: form } = await this.client
        .from(FORMS_TABLE)
        .select('settings, created_by, space_id')
        .eq('id', formId)
        .maybeSingle();

      if (!form) {
        await this.recordOutcome(submissionId, 'skipped', 'Form not found');

        return;
      }

      const integration = (
        (form as Record<string, unknown>).settings as Record<
          string,
          unknown
        > | null
      )?.task_integration as Record<string, unknown> | undefined;

      if (!integration?.enabled || !integration.target_space_id) {
        await this.recordOutcome(
          submissionId,
          'skipped',
          'Task integration is disabled or has no target space',
        );

        return;
      }

      const targetSpaceId = integration.target_space_id as string;
      const formSpaceId = (form as { space_id?: string | null }).space_id;

      // TasksService.create() requires an author. Anonymous submissions fall back to an explicitly
      // configured user, then to the form's owner; only then do we give up.
      const author =
        submittedBy ??
        (integration.anonymous_author_user_id as string | undefined) ??
        ((form as Record<string, unknown>).created_by as string | null) ??
        null;

      if (!author) {
        this.logger.debug(
          `form ${formId}: skip task creation — anonymous submission and no fallback author`,
        );
        await this.recordOutcome(
          submissionId,
          'skipped',
          'No author could be determined for this submission',
        );

        return;
      }

      // Derive field-to-task role mappings LIVE from the form's fields (the source of truth:
      // validation_rules.task_field). Ordered by sort_order so last-wins for a duplicated task_field
      // matches the frontend; filtered by form_id ONLY (the form's own space, never the task's target
      // space). Reading fields directly removes the dependency on the derived
      // form_builder_task_field_roles table being freshly synced — the root cause of tasks silently
      // not being created after a mapping edit.
      const { data: fieldRows, error: fieldsError } = await this.client
        .from(FIELDS_TABLE)
        .select('field_key, field_type, validation_rules, options')
        .eq('form_id', formId)
        .order('sort_order', { ascending: true });

      if (fieldsError) {
        this.logger.warn(
          `form ${formId}: skip task creation — fields lookup failed: ${fieldsError.message}`,
        );
        await this.recordOutcome(
          submissionId,
          'failed',
          `Could not load form fields: ${fieldsError.message}`,
        );

        return;
      }

      // Layout cells are not rows of their own; expanding them lets a mapped cell count, appended
      // after the top-level rows exactly as the frontend orders them.
      const formFields = expandLayoutFields(
        trimLayoutCells((fieldRows ?? []) as IFormFieldRow[]),
      );
      const roleRows = deriveTaskFieldRoles(formFields);

      if (roleRows.length === 0) {
        this.logger.debug(
          `form ${formId}: skip task creation — no field mappings`,
        );
        await this.recordOutcome(
          submissionId,
          'skipped',
          'No form field is mapped to a task field',
        );

        return;
      }

      // The type chosen on the Ticket Integration tab: the default, used unless a 'task_type' role
      // answers with an active type (see the check after the role loop).
      const configuredTaskTypeId =
        (typeof integration.task_type_id === 'string' &&
          integration.task_type_id.trim()) ||
        '';

      // Build the DTO from mapped roles
      const dto: Partial<CreateTaskDto> = {
        space_id: targetSpaceId,

        // No configured type — keep the historical default, still overridable by a 'task_type' role
        // so forms built before the selector existed behave exactly as they did.
        task_type_id: configuredTaskTypeId || 'task',
      };

      // Collected separately: these land in tasks.custom_field_values, not on a DTO column, once
      // converted to each custom field's type
      const explicit = new Map<string, IExplicitCfAnswer>();
      const cfAnswers = new Map<string, unknown>();

      // Task-type answers that won their key — only these may produce asset links below.
      const taskTypeCfKeys = new Set<string>();
      let assignedCfRows = new Map<string, IAssignedCfRow[]>();

      for (const role of roleRows) {
        let value: unknown;

        // date_range sub-mappings are stored as 'fieldkey__start' / 'fieldkey__end'
        if (
          role.field_key.endsWith('__start') ||
          role.field_key.endsWith('__end')
        ) {
          const sep = role.field_key.lastIndexOf('__');
          const baseKey = role.field_key.slice(0, sep);
          const subKey = role.field_key.slice(sep + 2); // 'start' or 'end'
          const base = submissionData[baseKey];

          if (base && typeof base === 'object' && !Array.isArray(base)) {
            value = (base as Record<string, unknown>)[subKey];
          }
        } else {
          value = submissionData[role.field_key];
        }

        if (value === undefined || value === null || value === '') continue;

        // 'custom:<field_key>' → tasks.custom_field_values (validated below before use)
        if (role.task_field.startsWith(CUSTOM_PREFIX)) {
          explicit.set(role.task_field.slice(CUSTOM_PREFIX.length), {
            value,
            answerType: role.answer_type,
            answerOptions: role.answer_options,
          });

          continue;
        }

        const dtoKey = TASK_FIELD_TO_DTO_KEY[role.task_field];

        if (!dtoKey) continue;

        // Never write a submitted label into a uuid column — skip and log rather than corrupt
        // the row. (Resolving a label back to its id is a separate, larger concern.)
        if (UUID_DTO_KEYS.has(dtoKey) && !isUuid(value)) {
          this.logger.warn(
            `form ${formId}: skipped ${role.task_field} — mapped value is not a uuid`,
          );

          continue;
        }

        (dto as Record<string, unknown>)[dtoKey] = value;
      }

      // The respondent's Task Type pick wins when it is an active type in the target space — the form
      // showed that type's custom fields — else the configured type stands. Placed before
      // assignedCustomFieldKeys() so the __cf__ gate uses the type the task is created with.
      if (
        configuredTaskTypeId &&
        dto.task_type_id !== configuredTaskTypeId &&
        !(await this.isActiveTaskType(orgId, targetSpaceId, dto.task_type_id))
      ) {
        this.logger.debug(
          `form ${formId}: task_type answer ${String(dto.task_type_id)} is not an active type — using ${configuredTaskTypeId}`,
        );

        dto.task_type_id = configuredTaskTypeId;
      }

      // Task-type custom fields: answers collected dynamically for the selected task type, stored
      // under the `__cf__` namespace because they are not form fields. An explicit
      // `custom:<field_key>` role mapping for the same key wins — otherwise the two paths would
      // race to write the same custom_field_values entry.
      const offeredCfKeys = Object.entries(submissionData)
        .filter(
          ([, value]) => value !== undefined && value !== null && value !== '',
        )
        .map(([key]) => taskTypeCfFieldKey(key))
        .filter((key): key is string => !!key);

      if (offeredCfKeys.length > 0) {
        // Accept a namespaced answer only for a field the SELECTED task type actually defines. The
        // browser never sends anything else, but this endpoint's data arrives from a submission row
        // that a client controls, so trusting the namespace alone would let any active task custom
        // field in the org be written — including on a form whose toggle is off.
        assignedCfRows = await this.assignedCustomFieldKeys(
          orgId,
          dto.task_type_id,
        );

        for (const fieldKey of offeredCfKeys) {
          if (!assignedCfRows.has(fieldKey)) {
            this.logger.warn(
              `form ${formId}: ${fieldKey} is not assigned to task type ${dto.task_type_id} — dropped`,
            );

            continue;
          }

          // Kept even for an explicitly mapped key: it fills in when the mapped answer can't convert.
          cfAnswers.set(
            fieldKey,
            submissionData[`${TASK_TYPE_CF_PREFIX}${fieldKey}`],
          );
        }
      }

      // Auto-extract date_range fields ({ start, end }) → start_date + due_date.
      // Explicit role mappings for start_date/due_date set above take priority.
      for (const value of Object.values(submissionData)) {
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          'start' in value &&
          'end' in value
        ) {
          const range = value as { start?: string; end?: string };

          if (range.start && !dto.start_date) dto.start_date = range.start;
          if (range.end && !dto.due_date) dto.due_date = range.end;
        }
      }

      // Validate custom-field targets before use: a field deleted, deactivated, or moved out of
      // the task context since the mapping was authored is dropped rather than written blindly.
      if (explicit.size > 0 || cfAnswers.size > 0) {
        const accepted = await this.filterCustomFieldValues(
          formId,
          orgId,
          targetSpaceId,
          explicit,
          cfAnswers,
          submittedBy,
        );

        if (Object.keys(accepted.values).length > 0) {
          dto.custom_field_values = accepted.values;
        }

        for (const key of accepted.taskTypeKeys) taskTypeCfKeys.add(key);
      }

      // summary is required by CreateTaskDto — skip (visibly) if unmapped, empty, or the mapped
      // field produced a non-string value. A full_name answer is an OBJECT, so calling .trim() on it
      // would throw and be swallowed by the outer catch; the typeof guard turns that into a clear
      // skip reason instead of a silent failure.
      const summaryValue: unknown = dto.summary;

      if (typeof summaryValue !== 'string' || !summaryValue.trim()) {
        const detail =
          summaryValue === undefined || summaryValue === null
            ? 'No form field is mapped to the task summary'
            : typeof summaryValue !== 'string'
              ? 'The field mapped to the summary is not a text value'
              : 'The summary field was left empty';

        this.logger.debug(`form ${formId}: skip task creation — ${detail}`);
        await this.recordOutcome(submissionId, 'skipped', detail);

        return;
      }

      // The respondent's parent is kept even when the task hierarchy forbids the pair.
      const created = (await this.tasks.create(
        orgId,
        author,
        dto as CreateTaskDto,
        { skipHierarchyCheck: true },
      )) as { id?: string; key?: string | null } | null;

      if (!created?.id) {
        await this.recordOutcome(
          submissionId,
          'failed',
          'Task creation returned no result',
        );

        return;
      }

      // Link the submission to the task it produced (so the task can display the submitted form) and
      // record the outcome in the SAME update, so task_id and task_creation_status can never diverge
      // under the idempotency guard above. Persist task_id before asset-link side effects.
      let assetLinkResult: {
        linked: number;
        failed: number;
        detail: string | null;
      } = { linked: 0, failed: 0, detail: null };

      // The host task link stays; the detail names the ticket instead.
      const hostLinkedDetail = opts.hostTaskLinked
        ? `Created ticket ${created.key ?? created.id}`
        : null;

      if (submissionId) {
        const { error: linkError } = await this.client
          .from(SUBMISSIONS_TABLE)
          .update(
            opts.hostTaskLinked
              ? {
                  task_creation_status: 'created',
                  task_creation_detail: hostLinkedDetail,
                }
              : {
                  task_id: created.id,
                  task_creation_status: 'created',
                  task_creation_detail: null,
                },
          )
          .eq('id', submissionId);

        if (linkError) {
          this.logger.warn(
            `form ${formId}: task created but submission link failed: ${linkError.message}`,
          );
          return;
        }
      }

      try {
        // Task-type asset answers keep their config on the custom field, not on a form field row.
        const cfAssetRows = taskTypeAssetLinkRows(
          taskTypeCfKeys,
          dto.custom_field_values,
          assignedCfRows,
          targetSpaceId,
          (message) => this.logger.warn(`form ${formId}: ${message}`),
        );

        // A form asset mapped to an asset custom field links under that field's config.
        const customFields =
          integration.link_assets === true
            ? await loadInheritableAssetCustomFields(
                this.client,
                orgId,
                targetSpaceId,
                formFields,
                true,
              )
            : [];

        // Fail closed: the element's own config is not authoritative for a mapped field.
        if (!customFields)
          throw new Error('could not load mapped asset custom fields');

        const formAssetRows = applyInheritedAssetConfigs(
          (fieldRows ?? []) as ITaskMappableFieldRow[],
          {
            customFields,
            integrationEnabled: true,
            targetSpaceId,
            lookupFields: formFields,
          },
        );

        assetLinkResult = await this.linkSubmittedAssets(
          formId,
          orgId,
          targetSpaceId,
          author,
          created.id,
          submissionData,
          [...formAssetRows, ...cfAssetRows],
          integration,
          formSpaceId,
          submittedBy,
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        this.logger.warn(`form ${formId}: asset linking failed: ${message}`);
        assetLinkResult = {
          linked: 0,
          failed: 1,
          detail: `Asset links failed: ${message}`,
        };
      }
      if (submissionId && assetLinkResult.detail) {
        try {
          const { error } = await this.client
            .from(SUBMISSIONS_TABLE)
            .update({
              task_creation_detail: hostLinkedDetail
                ? `${hostLinkedDetail}. ${assetLinkResult.detail}`
                : assetLinkResult.detail,
            })
            .eq('id', submissionId);
          if (error)
            this.logger.warn(
              `Could not record asset-link warning: ${error.message}`,
            );
        } catch {
          // The task already exists: a warning-write failure must not relabel it as failed.
          this.logger.warn('Could not record asset-link warning');
        }
      }

      // Opt-in per form ("Show in customer portal" on the Ticket Integration tab), so internal forms
      // never leak into anyone's portal list. Only a logged-in respondent has an identity to own a
      // portal ticket; an anonymous submission's author is the form-owner fallback, which would put
      // the ticket in the wrong person's list.
      if (integration.create_support_request === true && submittedBy) {
        try {
          await this.openSupportRequest(orgId, submittedBy, {
            ...dto,
            ...created,
          });
        } catch (err) {
          // The task already exists: a portal-ticket failure must not relabel it as failed.
          this.logger.warn(
            `form ${formId}: task ${created.id} created but its support request failed: ${
              (err as Error)?.message ?? String(err)
            }`,
          );
        }
      }

      this.logger.log(
        `Task created in space ${targetSpaceId} for form ${formId}`,
      );
    } catch (err) {
      // Best-effort: never block the submission response. Record the failure so the form owner can
      // see WHY no task appeared — this catch is where a thrown TasksService.create lands (e.g. an
      // invalid task type, or an assignee/reporter that is a real uuid but not an org member).
      const message = (err as Error)?.message ?? String(err);

      this.logger.warn(`Task creation failed for form ${formId}: ${message}`);
      await this.recordOutcome(submissionId, 'failed', message);
    }
  }

  /** Link submitted asset answers only when the form explicitly opts in. */
  private async linkSubmittedAssets(
    formId: string,
    orgId: string,
    taskSpaceId: string,
    userId: string,
    taskId: string,
    submissionData: Record<string, unknown>,
    fields: ITaskMappableFieldRow[],
    integration: Record<string, unknown>,
    formSpaceId?: string | null,
    // The real submitter — NOT `userId`, which falls back to the form owner for anonymous submissions.
    submittedBy?: string | null,
  ): Promise<{ linked: number; failed: number; detail: string | null }> {
    if (integration.link_assets !== true) {
      return { linked: 0, failed: 0, detail: null };
    }

    const failures: string[] = [];
    let linked = 0;
    const seen = new Set<string>();

    for (const field of fields) {
      if (field.field_type !== 'asset' && field.field_type !== 'asset_multi')
        continue;
      const cfg = (field.validation_rules?.asset ?? {}) as Record<
        string,
        unknown
      >;
      const schemaId = typeof cfg.schema_id === 'string' ? cfg.schema_id : '';
      const configuredTypes = Array.isArray(cfg.object_type_ids)
        ? cfg.object_type_ids.filter(
            (id): id is string => typeof id === 'string' && isUuid(id),
          )
        : [];
      const assetSpace =
        typeof cfg.space_id === 'string' && cfg.space_id
          ? cfg.space_id
          : formSpaceId;
      const raw = submissionData[field.field_key];
      if (
        raw === undefined ||
        raw === null ||
        raw === '' ||
        (Array.isArray(raw) && raw.length === 0)
      )
        continue;
      const candidates =
        field.field_type === 'asset_multi'
          ? Array.isArray(raw)
            ? raw
            : []
          : [raw];
      if (
        raw !== undefined &&
        raw !== null &&
        raw !== '' &&
        field.field_type === 'asset_multi' &&
        !Array.isArray(raw)
      ) {
        failures.push(`${field.field_key}: asset_multi answer is not an array`);
      }
      if (candidates.length > 200) {
        failures.push(`${field.field_key}: too many asset ids`);
        continue;
      }
      const ids = candidates.filter(
        (id): id is string => typeof id === 'string' && isUuid(id),
      );

      if (!schemaId || !configuredTypes.length) {
        if (candidates.length > 0) {
          failures.push(
            `${field.field_key}: asset field configuration is incomplete`,
          );
        }
        continue;
      }
      const invalidCount = candidates.filter(
        (id) =>
          id !== undefined &&
          id !== null &&
          id !== '' &&
          (typeof id !== 'string' || !isUuid(id)),
      ).length;
      if (invalidCount)
        failures.push(
          `${field.field_key}: ${invalidCount} invalid asset id(s)`,
        );
      if (!ids.length) continue;
      if (assetSpace !== taskSpaceId) {
        failures.push(
          `${field.field_key}: configured asset space differs from task space`,
        );
        continue;
      }
      if (cfg.depends_on) {
        failures.push(
          `${field.field_key}: dependent asset filters are not linkable server-side`,
        );
        continue;
      }

      const assigneeKey =
        typeof cfg.assignee_attribute_key === 'string'
          ? cfg.assignee_attribute_key
          : '';

      // Provable only for a known submitter: the asset must be assigned to them.
      if (
        cfg.assigned_only === true &&
        (!submittedBy || !ATTRIBUTE_FIELD_KEY_PATTERN.test(assigneeKey))
      ) {
        failures.push(
          `${field.field_key}: assigned-only answers need a signed-in submitter and an assignment attribute`,
        );
        continue;
      }

      // Assets not assigned to the submitter drop out and are reported as "not allowed" below.
      const allowed = await this.allowedAssetIds(
        orgId,
        assetSpace,
        cfg,
        schemaId,
        configuredTypes,
        ids,
        submittedBy,
      );
      if (allowed.failed) {
        failures.push(
          `${field.field_key}: could not validate ${allowed.failed}`,
        );
        continue;
      }

      const allowedIds = allowed.ids;
      for (const id of ids) {
        if (seen.has(id)) continue;
        if (!allowedIds.has(id)) {
          failures.push(`${field.field_key}: asset ${id} is not allowed`);
          continue;
        }
        try {
          await this.assetTaskLinks.create(assetSpace, orgId, userId, id, {
            task_id: taskId,
          });
          seen.add(id);
          linked++;
        } catch (err) {
          // A duplicate is safe on an idempotent retry; every other failure remains visible.
          if ((err as { status?: number }).status !== 409) {
            failures.push(
              `${field.field_key}: asset ${id} could not be linked`,
            );
          } else {
            seen.add(id);
          }
        }
      }
    }

    if (!failures.length) return { linked, failed: 0, detail: null };
    const detail = `Asset links: linked ${linked}, failed ${failures.length} (${failures.slice(0, 3).join('; ')})`;
    this.logger.warn(`form ${formId}: ${detail}`);
    return { linked, failed: failures.length, detail };
  }

  /**
   * The ids among `ids` an asset config admits: same org, space and schema, not archived, an
   * allowed (optionally child-expanded) type and, for assigned_only with a submitter, theirs.
   * Shared by the link pass and the custom-field value check so both apply one rule.
   */
  private async allowedAssetIds(
    orgId: string,
    spaceId: string,
    cfg: Record<string, unknown>,
    schemaId: string,
    configuredTypes: string[],
    ids: string[],
    submittedBy?: string | null,
  ): Promise<{
    ids: Set<string>;
    failed?: 'child asset types' | 'asset objects';
  }> {
    let allowedTypes = [...new Set(configuredTypes)];
    if (cfg.include_child_types === true) {
      const { data, error } = await this.client
        .from('asset_object_types')
        .select('id')
        .eq('organization_id', orgId)
        .eq('space_id', spaceId)
        .eq('schema_id', schemaId)
        .overlaps('parent_ids', allowedTypes);
      if (error) return { ids: new Set(), failed: 'child asset types' };
      allowedTypes = [
        ...new Set([
          ...allowedTypes,
          ...(data ?? []).map((row: { id: string }) => row.id),
        ]),
      ];
    }

    const assigneeKey =
      typeof cfg.assignee_attribute_key === 'string'
        ? cfg.assignee_attribute_key
        : '';
    let objectsQuery = this.client
      .from('asset_objects')
      .select('id')
      .eq('organization_id', orgId)
      .eq('space_id', spaceId)
      .eq('schema_id', schemaId)
      .eq('is_archived', false)
      .in('object_type_id', allowedTypes)
      .in('id', ids);

    if (cfg.assigned_only === true && submittedBy) {
      objectsQuery =
        cfg.assignee_attribute_kind === 'user_multi'
          ? objectsQuery.contains('attribute_values', {
              [assigneeKey]: [submittedBy],
            })
          : objectsQuery.eq(`attribute_values->>${assigneeKey}`, submittedBy);
    }

    const { data: objects, error } = await objectsQuery;
    if (error) return { ids: new Set(), failed: 'asset objects' };

    return {
      ids: new Set((objects ?? []).map((row: { id: string }) => row.id)),
    };
  }

  /**
   * Keeps only asset ids an asset custom field's config admits; `asset` drops the key, `asset_multi`
   * keeps the valid subset. An unconfigured field passes through as before. depends_on is not
   * verified server-side (the parent's links are not resolved here). Never rejects the submission.
   */
  private async keepAllowedAssetValues(
    formId: string,
    orgId: string,
    targetSpaceId: string,
    submittedBy: string | null,
    values: Record<string, unknown>,
    definitions: Map<string, ICustomFieldDefinition>,
  ): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      const type = definitions.get(key)?.field_type;

      if (type !== 'asset' && type !== 'asset_multi') continue;

      const cfg = asRecord(
        asRecord(definitions.get(key)?.validation_rules).asset,
      );
      const schemaId = typeof cfg.schema_id === 'string' ? cfg.schema_id : '';
      const types = Array.isArray(cfg.object_type_ids)
        ? cfg.object_type_ids.filter((id): id is string => isUuid(id))
        : [];

      if (!schemaId || !types.length) continue;

      const candidates =
        type === 'asset_multi' && Array.isArray(value) ? value : [value];
      const ids = [
        ...new Set(candidates.filter((id): id is string => isUuid(id))),
      ];
      const assigneeKey =
        typeof cfg.assignee_attribute_key === 'string'
          ? cfg.assignee_attribute_key
          : '';

      // Same bounds as the link pass: an unprovable assigned_only or an oversized list admits nothing.
      const checkable =
        ids.length > 0 &&
        ids.length <= 200 &&
        !(
          cfg.assigned_only === true &&
          (!submittedBy || !ATTRIBUTE_FIELD_KEY_PATTERN.test(assigneeKey))
        );
      const allowed = checkable
        ? await this.allowedAssetIds(
            orgId,
            typeof cfg.space_id === 'string' && cfg.space_id
              ? cfg.space_id
              : targetSpaceId,
            cfg,
            schemaId,
            types,
            ids,
            submittedBy,
          )
        : { ids: new Set<string>(), failed: undefined };
      const kept = candidates.filter(
        (id): id is string => typeof id === 'string' && allowed.ids.has(id),
      );
      const dropped = candidates.length - kept.length;

      if (dropped === 0 && (type === 'asset' || Array.isArray(value))) continue;

      if (dropped > 0) {
        this.logger.warn(
          `form ${formId}: ${key} — dropped ${dropped} asset id(s) its custom field does not allow${
            allowed.failed ? ` (could not validate ${allowed.failed})` : ''
          }`,
        );
      }

      if (type === 'asset_multi' && kept.length > 0) values[key] = kept;
      else delete values[key];
    }
  }

  /**
   * Persist the task-creation outcome onto the submission row so the form owner can see whether a
   * task was created and, if not, why. Best-effort: its own failure is logged, never thrown, so it
   * can never affect the submission. A no-op when submissionId is absent.
   *
   * @param submissionId The submission to stamp; when undefined nothing is written
   * @param status Coarse outcome shown as a chip in the responses view
   * @param detail Human-readable reason (null clears any prior reason on success)
   */
  private async recordOutcome(
    submissionId: string | undefined,
    status: 'created' | 'skipped' | 'failed' | 'pending_approval',
    detail: string | null,
  ): Promise<void> {
    if (!submissionId) return;

    const { error } = await this.client
      .from(SUBMISSIONS_TABLE)
      .update({ task_creation_status: status, task_creation_detail: detail })
      .eq('id', submissionId);

    if (error) {
      this.logger.warn(
        `failed to record task-creation outcome for submission ${submissionId}: ${error.message}`,
      );
    }
  }

  /**
   * Opens the customer-portal ticket for a form-created task. The portal's "My tickets" list reads
   * `support_requests` (creator or shared-with), not `tasks`, so without this row the respondent
   * never sees what they submitted. Linked through `sla_link_request_task` — the same RPC the Help
   * Center uses — so the SLA ledger records the association. Throws; the caller logs.
   *
   * @param orgId Organization that owns the task
   * @param submittedBy The real, logged-in respondent (never the anonymous-author fallback)
   * @param task The created task row, layered over the DTO it was built from
   */
  private async openSupportRequest(
    orgId: string,
    submittedBy: string,
    task: Record<string, unknown>,
  ): Promise<void> {
    const status = typeof task.status === 'string' ? task.status : 'open';
    const taskType =
      typeof task.task_type_id === 'string' ? task.task_type_id : 'task';

    const { data: request, error } = await this.client
      .from(SUPPORT_REQUESTS_TABLE)
      .insert({
        organization_id: orgId,
        created_by: submittedBy,
        space_id: task.space_id,
        subject: (typeof task.summary === 'string' ? task.summary : '').slice(
          0,
          255,
        ),
        description:
          typeof task.description === 'string' ? task.description : '',
        category: TECHNICAL_TASK_TYPES.has(taskType) ? 'technical' : 'general',
        request_type: taskType,
        priority: toSupportRequestPriorityBucket(
          typeof task.priority === 'string' ? task.priority : 'medium',
        ),
        priority_id: task.priority_id ?? null,
        status:
          status === 'done' || status === 'closed'
            ? 'resolved'
            : status === 'open'
              ? 'open'
              : 'in_progress',
      })
      .select('id')
      .single();

    if (error || !request) {
      throw new Error(
        error?.message ?? 'support request insert returned no row',
      );
    }

    const requestId = (request as { id: string }).id;
    const { error: linkError } = await this.client.rpc(
      'sla_link_request_task',
      {
        p_request_id: requestId,
        p_task_id: task.id,
        p_organization_id: orgId,
      },
    );

    if (linkError) {
      // An unlinked request would show in the portal with no task behind it — remove it.
      await this.client
        .from(SUPPORT_REQUESTS_TABLE)
        .delete()
        .eq('id', requestId);
      throw new Error(linkError.message);
    }
  }

  /**
   * Keep only custom-field values whose definition still exists for this org, is active, not
   * deleted, and applies to tasks. Anything else is dropped with a warning instead of being
   * written blindly into tasks.custom_field_values.
   */
  /**
   * The `custom_fields.field_key`s a given task type actually defines.
   *
   * A task type's fields come from two places — standalone rows in `level_field_assignments` and the
   * fields of every group in `level_field_group_assignments` — so both are unioned here. `is_hidden`
   * assignments are excluded: they are never rendered, so an answer for one can only be forged.
   *
   * @param orgId Organization owning the assignments
   * @param taskTypeId The selected task type; this is the hierarchy level id
   * @returns Set of accepted field keys — empty when nothing is assigned (⇒ every answer is dropped)
   */
  private async assignedCustomFieldKeys(
    orgId: string,
    taskTypeId: string | undefined,
  ): Promise<Map<string, IAssignedCfRow[]>> {
    const accepted = new Map<string, IAssignedCfRow[]>();

    if (!taskTypeId) return accepted;

    const [standalone, groups] = await Promise.all([
      this.client
        .from('level_field_assignments')
        .select(ASSIGNED_CF_EMBED)
        .eq('organization_id', orgId)
        .eq('entity_type', 'task')
        .eq('hierarchy_level_id', taskTypeId),
      this.client
        .from('level_field_group_assignments')
        .select('field_group_id')
        .eq('organization_id', orgId)
        .eq('entity_type', 'task')
        .eq('hierarchy_level_id', taskTypeId),
    ]);

    // A failed lookup still yields no keys, as before — but no longer silently.
    const lookupError = standalone.error ?? groups.error;

    if (lookupError) {
      this.logger.warn(
        `task-type field assignment lookup failed: ${lookupError.message}`,
      );
    }

    // A field assigned both standalone and through a group arrives twice; keep one copy.
    const seenIds = new Set<string>();

    const collect = (row: unknown) => {
      const r = row as {
        is_hidden?: boolean;
        custom_field?: IAssignedCfRow | IAssignedCfRow[] | null;
      };

      if (r.is_hidden === true) return;

      const cf = Array.isArray(r.custom_field)
        ? r.custom_field[0]
        : r.custom_field;

      if (!cf?.field_key) return;

      if (cf.id) {
        if (seenIds.has(cf.id)) return;

        seenIds.add(cf.id);
      }

      accepted.set(cf.field_key, [...(accepted.get(cf.field_key) ?? []), cf]);
    };

    for (const row of standalone.data ?? []) collect(row);

    const groupIds = (groups.data ?? [])
      .map((row) => (row as { field_group_id?: string }).field_group_id)
      .filter((id): id is string => !!id);

    if (groupIds.length > 0) {
      const { data: groupFields, error: groupFieldsError } = await this.client
        .from('field_group_fields')
        .select(ASSIGNED_CF_EMBED)
        .in('field_group_id', groupIds);

      if (groupFieldsError) {
        this.logger.warn(
          `task-type field group lookup failed: ${groupFieldsError.message}`,
        );
      }

      for (const row of groupFields ?? []) collect(row);
    }

    return accepted;
  }

  // Explicit answers are converted to the definition's type; a `__cf__` answer fills in when the
  // explicit one can't be. `taskTypeKeys` are the keys a `__cf__` answer won.
  private async filterCustomFieldValues(
    formId: string,
    orgId: string,
    targetSpaceId: string,
    explicit: Map<string, IExplicitCfAnswer>,
    cfAnswers: Map<string, unknown>,
    submittedBy: string | null,
  ): Promise<{ values: Record<string, unknown>; taskTypeKeys: Set<string> }> {
    const keys = [...new Set([...explicit.keys(), ...cfAnswers.keys()])];
    const values: Record<string, unknown> = {};
    const taskTypeKeys = new Set<string>();

    const { data, error } = await this.client
      .from(CUSTOM_FIELDS_TABLE)
      .select(
        'field_key, field_type, options, validation_rules, contexts, is_active, is_deleted, space_id',
      )
      .eq('organization_id', orgId)
      .in('field_key', keys);

    if (error) {
      this.logger.warn(`custom field lookup failed: ${error.message}`);

      return { values, taskTypeKeys };
    }

    // Per key the live task definition the task can show: its space's own before the org-wide one.
    const definitions = new Map<string, ICustomFieldDefinition>();

    for (const row of (data ?? []) as ICustomFieldDefinition[]) {
      if (row.is_active === false || row.is_deleted === true) continue;

      // contexts defaults to ["process","task"]; a missing value is treated as applying to tasks
      if (Array.isArray(row.contexts) && !row.contexts.includes('task'))
        continue;

      if (row.space_id != null && row.space_id !== targetSpaceId) continue;

      const current = definitions.get(row.field_key);

      if (!current || (current.space_id == null && row.space_id != null))
        definitions.set(row.field_key, row);
    }

    for (const key of keys) {
      const definition = definitions.get(key);

      if (!definition) continue;

      const mapped = explicit.get(key);

      if (mapped) {
        const converted = toTaskCustomFieldValue({
          answerType: mapped.answerType,
          answerOptions: mapped.answerOptions,
          target: definition,
          answer: mapped.value,
        });

        if (converted.ok) {
          values[key] = converted.value;

          if (cfAnswers.has(key)) {
            this.logger.debug(
              `form ${formId}: ${key} is explicitly mapped — ignoring the task-type custom field answer`,
            );
          }

          continue;
        }

        this.logger.warn(
          `form ${formId}: skipped mapped custom field ${key} — ${converted.reason}`,
        );
      }

      if (!cfAnswers.has(key)) continue;

      const answer = cfAnswers.get(key);

      // Task-type answers arrive as client HTML for an editor field; everything else as submitted.
      values[key] =
        definition.field_type === 'editor' && typeof answer === 'string'
          ? sanitizeRichText(answer, { allowTables: true })
          : answer;
      taskTypeKeys.add(key);
    }

    await this.keepAllowedAssetValues(
      formId,
      orgId,
      targetSpaceId,
      submittedBy,
      values,
      definitions,
    );

    // The final value must still fit its field, as before conversion existed: a wrong shape would
    // otherwise reach the renderer. Validated without coercing, so a date stays a string.
    for (const key of Object.keys(values)) {
      const definition = definitions.get(key) as unknown as Parameters<
        typeof validateFieldValue
      >[0];

      try {
        validateFieldValue(definition, values[key]);
      } catch {
        this.logger.warn(
          `form ${formId}: dropped custom field ${key} — value does not fit the field`,
        );
        delete values[key];
        taskTypeKeys.delete(key);
      }
    }

    const dropped = keys.filter((k) => !definitions.has(k));

    if (dropped.length > 0) {
      this.logger.warn(
        `form ${formId}: dropped unknown/inactive/non-task custom fields: ${dropped.join(', ')}`,
      );
    }

    return { values, taskTypeKeys };
  }
}
