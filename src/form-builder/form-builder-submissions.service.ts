import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { FormBuilderAssignmentsService } from './form-builder-assignments.service';
import { FormBuilderSubmissionEventsService } from './form-builder-submission-events.service';
import type { CreateFormBuilderSubmissionDto } from './dto/create-form-builder-submission.dto';
import { surfaceTicketOutcome } from './submission-surface.util';
import {
  computeFieldStates,
  ConditionalLogic,
  FieldLogicState,
  LogicField,
} from './logic/condition-evaluator';
import { topoSortCalcs } from './logic/calc-graph';
import { compileExpression, extractRefs } from './logic/expression-engine';
import { expandLayoutFields } from './logic/expand-layout-fields';

const TABLE = 'form_builder_submissions';
const FORMS_TABLE = 'form_builder';
const FIELDS_TABLE = 'form_builder_fields';
const TASKS_TABLE = 'tasks';
const SPACE_MEMBERS_TABLE = 'space_members';
const CUSTOM_FIELDS_TABLE = 'custom_fields';

// Answers for the custom fields defined by the task type a respondent selected. They are NOT form
// fields, so `validateAndClean` (which walks the form's field rows) would otherwise drop them and
// `field_snapshot` would not describe them. Keep this prefix in lockstep with the frontend's
// `src/views/form-builder/task-type-custom-fields.ts`.
const TASK_TYPE_CF_PREFIX = '__cf__';
const SAFE_CF_KEY_RE = /^[A-Za-z0-9_-]+$/;

// Bounds an untrusted client from bloating a row via the namespace: a count cap and, because these
// answers never pass through `validateValue`, a per-value size cap as well.
const MAX_TASK_TYPE_CF_ANSWERS = 100;
const MAX_TASK_TYPE_CF_VALUE_CHARS = 10_000;

function taskTypeCfFieldKey(key: string): string | null {
  if (!key.startsWith(TASK_TYPE_CF_PREFIX)) return null;

  const fieldKey = key.slice(TASK_TYPE_CF_PREFIX.length);

  return SAFE_CF_KEY_RE.test(fieldKey) ? fieldKey : null;
}

// these types don't hold a value
const NON_INPUT_TYPES = new Set([
  'heading',
  'paragraph',
  'divider',
  'page_break',
  'image',
  'calculated',
  'hidden',
]);

// no longer deferred — file_upload and signature are validated normally
const DEFERRED_INPUT_TYPES = new Set<string>();

// Task-mapped dropdown/radio/checkboxes fields submit live task-system IDs
// (priority UUIDs, status UUIDs, task-type IDs, parent task IDs) that are never
// present in the static field.options list stored in the DB. Skip static option
// validation for these; task-system validity is enforced when the task is created.
const DYNAMIC_TASK_FIELDS = new Set([
  'task_type',
  'priority',
  'status',
  'parent_task',
]);

interface SubmissionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Embedded `users!submitted_by` shape on a submission row. */
interface SubmissionSubmitter {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

/** Raw row shape returned by the task-scoped submissions query. */
interface TaskSubmissionRow {
  id: string;
  form_id: string;
  space_id: string;
  created_at: string;
  status: string;
  data: Record<string, unknown> | null;
  field_snapshot: unknown;
  // PostgREST returns an object for a to-one embed, but the untyped client can
  // widen it to an array — normalise both.
  form: { name: string | null } | { name: string | null }[] | null;
  submitter: SubmissionSubmitter | SubmissionSubmitter[] | null;
}

/** One submitted form response attached to a task. */
export interface TaskFormSubmission {
  id: string;
  form_id: string;
  form_name: string | null;
  space_id: string;
  created_at: string;
  status: string;
  data: Record<string, unknown>;
  field_snapshot: unknown;
  submitter: SubmissionSubmitter | null;
}

/** Unwrap a PostgREST to-one embed that may arrive as a single object or a 1-element array. */
function firstEmbed<T>(embed: T | T[] | null | undefined): T | null {
  if (Array.isArray(embed)) return embed[0] ?? null;

  return embed ?? null;
}

interface SubmissionFieldRow extends LogicField {
  field_key: string;
  field_type: string;
  label: string | null;
  required: boolean | null;
  is_hidden: boolean | null;
  read_only: boolean | null;
  options: unknown;
  validation_rules: Record<string, unknown> | null;
  conditional_logic: ConditionalLogic | null;
  calculation: { expression?: string; format?: string } | null;
}

@Injectable()
export class FormBuilderSubmissionsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly assignments: FormBuilderAssignmentsService,
    private readonly events: FormBuilderSubmissionEventsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(
    formId: string,
    spaceId: string,
    organizationId: string,
    page = 1,
    limit = 50,
  ) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, error, count } = await this.client
      .from(TABLE)
      .select(
        '*, submitter:users!submitted_by(id, first_name, last_name, email), task:tasks!task_id(id, key, summary)',
        {
          count: 'exact',
        },
      )
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      // exclude draft rows — those are unpaid / abandoned-payment holds, not responses
      .eq('status', 'submitted')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw new BadRequestException(error.message);

    return { data: data ?? [], count: count ?? 0, page, limit };
  }

  /**
   * Lists the submitted form responses that produced a given task, so the task view can
   * render "the submitted form appended to this task".
   *
   * Security notes (this runs on the service-role client — RLS is bypassed, so every
   * boundary below is enforced here in TypeScript):
   *  - the task must exist in BOTH `spaceId` (already authorised by the guard) and
   *    `organizationId`, otherwise 404;
   *  - submissions are filtered by `organization_id` so a task id can never pull rows
   *    from another tenant;
   *  - only `status = 'submitted'` rows are returned — `draft` rows are unpaid /
   *    abandoned-payment holds, not real responses;
   *  - a submission's `space_id` is the FORM's space, which may differ from the task's
   *    space. Rows from a different space are only returned when the caller is an active
   *    member of that space (one batched membership query, not one per row).
   *
   * @param {string} taskId - The task whose submissions are requested
   * @param {string} spaceId - The task's space (the space the caller was authorised against)
   * @param {string} organizationId - Caller's effective organization
   * @param {string} userId - Caller's `public.users.id` (matches `space_members.user_id`)
   * @returns {Promise<{ data: TaskFormSubmission[] }>} Submissions, newest first
   * @throws {NotFoundException} When the task does not exist in this space and org
   * @throws {BadRequestException} When any underlying query fails
   */
  async listByTask(
    taskId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: TaskFormSubmission[] }> {
    const { data: task, error: taskError } = await this.client
      .from(TASKS_TABLE)
      .select('id, space_id, organization_id')
      .eq('id', taskId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (taskError) throw new BadRequestException(taskError.message);
    if (!task) throw new NotFoundException('Task not found');

    const { data, error } = await this.client
      .from(TABLE)
      .select(
        'id, form_id, space_id, created_at, status, data, field_snapshot, form:form_builder!form_id(name), submitter:users!submitted_by(id, first_name, last_name, email)',
      )
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      // exclude draft rows — those are unpaid / abandoned-payment holds, not responses
      .eq('status', 'submitted')
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as TaskSubmissionRow[];

    // The task's own space is already authorised by SpacePermissionsGuard; every other
    // space a submission may live in has to be proven by an active membership row.
    const allowedSpaceIds = new Set<string>([spaceId]);
    const foreignSpaceIds = [
      ...new Set(
        rows
          .map((row) => row.space_id)
          .filter((id): id is string => !!id && id !== spaceId),
      ),
    ];

    if (foreignSpaceIds.length > 0) {
      const { data: memberships, error: membershipError } = await this.client
        .from(SPACE_MEMBERS_TABLE)
        .select('space_id')
        .eq('user_id', userId)
        .eq('member_type', 'user')
        .eq('is_active', true)
        .in('space_id', foreignSpaceIds);

      if (membershipError)
        throw new BadRequestException(membershipError.message);

      for (const row of (memberships ?? []) as Array<{ space_id: string }>) {
        allowedSpaceIds.add(row.space_id);
      }
    }

    return {
      data: rows
        .filter((row) => allowedSpaceIds.has(row.space_id))
        .map((row) => ({
          id: row.id,
          form_id: row.form_id,
          // soft-deleted forms still resolve — the answers are historical task data
          form_name: firstEmbed(row.form)?.name ?? null,
          space_id: row.space_id,
          created_at: row.created_at,
          status: row.status,
          data: row.data ?? {},
          field_snapshot: row.field_snapshot ?? null,
          submitter: firstEmbed(row.submitter),
        })),
    };
  }

  // save a form response
  // asDraft=true inserts status:'draft' instead of 'submitted' (used by the
  // payments flow to run publish-gate + allow_multiple + max_responses +
  // validateAndClean + field_snapshot BEFORE charging); the draft is flipped to
  // 'submitted' once payment succeeds. userId is null for anonymous fillers.
  async create(
    formId: string,
    dto: CreateFormBuilderSubmissionDto,
    spaceId: string,
    organizationId: string,
    userId: string | null,
    meta: SubmissionMeta,
    asDraft = false,
  ) {
    // get the form
    const { data: form, error: formErr } = await this.client
      .from(FORMS_TABLE)
      .select('id, status, settings')
      .eq('id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (formErr) throw new BadRequestException(formErr.message);
    if (!form) throw new NotFoundException('Form not found');

    const isTest = dto.is_test === true;

    // only published forms accept responses (previews skip this)
    if (!isTest && form.status !== 'published')
      throw new BadRequestException('This form is not accepting responses');

    // load fields so we can validate answers and snapshot them
    const { data: fields, error: fieldsErr } = await this.client
      .from(FIELDS_TABLE)
      .select('*')
      .eq('form_id', formId)
      .order('sort_order', { ascending: true });

    if (fieldsErr) throw new BadRequestException(fieldsErr.message);

    const fieldList = (fields ?? []) as SubmissionFieldRow[];

    const serverValues = this.recomputeCalcs(fieldList, dto.data ?? {});
    const states = computeFieldStates(fieldList, serverValues);

    // validate answers and drop anything that isn't a real field
    const cleanData = this.validateAndClean(fieldList, dto.data ?? {}, states);

    this.applyCalculations(fieldList, cleanData);

    const settings = (form.settings ?? {}) as Record<string, any>;

    // check the one-per-user / max-responses limits (previews skip this)
    if (!isTest) {
      const allowMultiple = settings.allow_multiple_submissions !== false;

      if (!allowMultiple && userId) {
        const { count, error } = await this.client
          .from(TABLE)
          .select('id', { count: 'exact', head: true })
          .eq('form_id', formId)
          .eq('submitted_by', userId)
          .eq('status', 'submitted');

        if (error) throw new BadRequestException(error.message);
        if ((count ?? 0) > 0)
          throw new ConflictException('You have already submitted this form');
      }

      const maxResponses = Number(settings.max_responses);

      if (Number.isFinite(maxResponses) && maxResponses > 0) {
        const { count, error } = await this.client
          .from(TABLE)
          .select('id', { count: 'exact', head: true })
          .eq('form_id', formId)
          .eq('status', 'submitted');

        if (error) throw new BadRequestException(error.message);
        if ((count ?? 0) >= maxResponses)
          throw new BadRequestException(
            'This form has reached its response limit',
          );
      }
    }

    // Task-type custom fields are not form fields, so they must be described in the snapshot
    // explicitly or every results surface (which renders from the snapshot) would omit them.
    const cfSnapshot = await this.taskTypeCfSnapshot(
      organizationId,
      spaceId,
      cleanData,
      fieldList.length,
    );

    // the admin client bypasses RLS, so prove the task is in this tenant before linking to it
    let taskId: string | null = null;

    if (dto.task_id) {
      const { data: taskRow, error: taskErr } = await this.client
        .from(TASKS_TABLE)
        .select('id')
        .eq('id', dto.task_id)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (taskErr) throw new BadRequestException(taskErr.message);
      if (!taskRow) throw new NotFoundException('Task not found');

      taskId = dto.task_id;
    }

    // save it, joining the submitter so the responses list can show who sent it
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        form_id: formId,
        organization_id: organizationId,
        space_id: spaceId,
        submitted_by: userId,
        task_id: taskId,
        data: cleanData,
        field_snapshot: cfSnapshot.length
          ? [...fieldList, ...cfSnapshot]
          : fieldList,
        status: asDraft ? 'draft' : 'submitted',
        version: 1,
        ip_address: meta.ip ?? null,
        user_agent: meta.userAgent ?? null,
        is_test: isTest,

        // A verified host task makes this a task fill; previews never create tickets.
        ...(isTest
          ? {}
          : surfaceTicketOutcome(settings, taskId ? 'task' : dto.surface)),
      })
      .select(
        '*, submitter:users!submitted_by(id, first_name, last_name, email)',
      )
      .single();

    if (error) throw new BadRequestException(error.message);

    if (!asDraft && userId) {
      await this.client
        .from(TABLE)
        .delete()
        .eq('form_id', formId)
        .eq('submitted_by', userId)
        .eq('status', 'draft');
    }

    // mark any pending assignment for this submitter complete (best-effort — never
    // fails the submission). Skips drafts, previews (is_test), and anonymous fillers.
    if (!asDraft && userId && !isTest) {
      await this.assignments
        .markCompletedOnSubmit(
          formId,
          userId,
          (data as { id: string }).id,
          spaceId,
          organizationId,
        )
        .catch(() => undefined);
    }

    // fire the shared submission-events seam (approvals + outbound webhooks). Best-effort;
    // guarded !isTest here and again inside dispatch(). Fires for anonymous authenticated
    // fillers too (no userId requirement), unlike the assignment hook above.
    if (!asDraft && !isTest) {
      await this.events
        .dispatch(data as Record<string, unknown>)
        .catch(() => undefined);
    }

    return data;
  }

  async remove(
    submissionId: string,
    formId: string,
    spaceId: string,
    organizationId: string,
  ) {
    const { data, error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', submissionId)
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('id')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Submission not found');

    return { success: true as const };
  }

  // check required fields + values, keep only the real answers
  private validateAndClean(
    fields: SubmissionFieldRow[],
    data: Record<string, unknown>,
    states: Record<string, FieldLogicState>,
  ): Record<string, unknown> {
    const errors: string[] = [];
    const clean: Record<string, unknown> = {};

    // Layout cells are nested inside the layout field's options (not their own DB rows) — expand
    // them into synthetic per-cell rows so cell answers are kept instead of being silently dropped.
    const allFields = expandLayoutFields(fields);

    for (const field of allFields) {
      const type = field.field_type;
      const state = states[field.field_key];
      const raw = data[field.field_key];
      const isEmpty =
        raw === undefined ||
        raw === null ||
        raw === '' ||
        (Array.isArray(raw) && raw.length === 0);

      const alwaysDrop =
        NON_INPUT_TYPES.has(type) || !!field.is_hidden || !!field.read_only;

      if (!alwaysDrop && state && !state.visible) {
        if (!isEmpty)
          errors.push(
            `${field.label || field.field_key} cannot be submitted because it is hidden`,
          );

        continue;
      }

      if (alwaysDrop) {
        // Hidden fields: inject the configured default_value so it persists in the submission
        if (type === 'hidden') {
          const defaultVal = (field.validation_rules as any)?.default_value;

          if (defaultVal != null) clean[field.field_key] = defaultVal;
        }

        continue;
      }

      // DEFERRED_INPUT_TYPES is now empty — kept here as a safety guard
      if (DEFERRED_INPUT_TYPES.has(type)) {
        if (!isEmpty) clean[field.field_key] = raw;

        continue;
      }

      const required = state ? state.required : !!field.required;

      if (isEmpty) {
        if (required)
          errors.push(`${field.label || field.field_key} is required`);

        continue;
      }

      const err = this.validateValue(field, raw);

      if (err) {
        errors.push(`${field.label || field.field_key}: ${err}`);

        continue;
      }

      clean[field.field_key] = raw;
    }

    if (errors.length) throw new BadRequestException(errors.join('; '));

    // Carry over task-type custom-field answers. The loop above only knows the form's own fields, so
    // without this they are silently discarded. Existence/active/context is re-checked by the task
    // creator before anything is written to tasks.custom_field_values — this only guards the shape.
    let carried = 0;

    for (const [key, value] of Object.entries(data)) {
      if (!taskTypeCfFieldKey(key)) continue;
      if (value === undefined || value === null || value === '') continue;

      if (++carried > MAX_TASK_TYPE_CF_ANSWERS)
        throw new BadRequestException(
          'Too many task-type custom field answers',
        );

      // These answers bypass `validateValue` (which is driven by a form field's own rules), so they
      // would otherwise be completely unbounded in size. Cap the serialized value.
      if (JSON.stringify(value ?? null).length > MAX_TASK_TYPE_CF_VALUE_CHARS)
        throw new BadRequestException(
          `Task-type custom field answer is too large: ${key}`,
        );

      clean[key] = value;
    }

    return clean;
  }

  /**
   * Describes the task-type custom fields that were actually answered, so they can be appended to
   * `field_snapshot`.
   *
   * Every results surface renders from the snapshot rather than the live form, so an answer missing
   * from it is saved but invisible. Labels are resolved once here and frozen, exactly like the form's
   * own fields — renaming a custom field later must not rewrite a historical response.
   */
  private async taskTypeCfSnapshot(
    organizationId: string,
    spaceId: string,
    data: Record<string, unknown>,
    startSortOrder: number,
  ): Promise<Record<string, unknown>[]> {
    const fieldKeys = Object.keys(data)
      .map((key) => taskTypeCfFieldKey(key))
      .filter((key): key is string => !!key);

    if (fieldKeys.length === 0) return [];

    const { data: rows, error } = await this.client
      .from(CUSTOM_FIELDS_TABLE)
      .select('field_key, name, field_type, space_id')
      .eq('organization_id', organizationId)
      .neq('is_deleted', true)
      .in('field_key', fieldKeys);

    if (error) {
      // A snapshot lookup must never fail an otherwise valid submission; the answers are still
      // stored in `data` and the task still receives them.
      return [];
    }

    // `field_key` is unique per org for org-level fields AND per (org, space) for space-level ones —
    // see custom_fields_org_level_unique_key / custom_fields_space_level_unique_key. One key can
    // therefore match several rows. Collapse to one entry per key, preferring the row scoped to this
    // submission's own space over the org-level fallback; without this the results surfaces would
    // show duplicate columns, possibly labelled from an unrelated space.
    type CustomFieldMeta = {
      field_key: string;
      name?: string;
      field_type?: string;
      space_id?: string | null;
    };

    const byKey = new Map<string, CustomFieldMeta>();

    for (const row of rows ?? []) {
      const meta = row as CustomFieldMeta;
      const existing = byKey.get(meta.field_key);

      if (
        !existing ||
        (meta.space_id === spaceId && existing.space_id !== spaceId)
      ) {
        byKey.set(meta.field_key, meta);
      }
    }

    return [...byKey.values()].map((meta, index) => ({
      field_key: `${TASK_TYPE_CF_PREFIX}${meta.field_key}`,
      label: meta.name || meta.field_key,
      field_type: meta.field_type ?? 'text',
      sort_order: startSortOrder + index,

      // Marks the entry as synthetic so display surfaces can tell it apart from an authored field.
      is_task_type_custom_field: true,
    }));
  }

  private recomputeCalcs(
    fields: SubmissionFieldRow[],
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...values };
    const calcFields = fields.filter(
      (f) => f.field_type === 'calculated' && f.calculation?.expression,
    );

    if (!calcFields.length) return out;

    const nodes = calcFields.map((f) => ({
      fieldKey: f.field_key,
      refs: extractRefs(f.calculation!.expression!),
    }));
    let order: string[];

    try {
      order = topoSortCalcs(nodes);
    } catch {
      order = calcFields.map((f) => f.field_key);
    }

    const byKey = new Map(calcFields.map((f) => [f.field_key, f]));

    for (const key of order) {
      const f = byKey.get(key);

      if (!f?.calculation?.expression) continue;

      try {
        out[key] = compileExpression(f.calculation.expression)(out);
      } catch {
        out[key] = null;
      }
    }

    return out;
  }

  private applyCalculations(
    fields: SubmissionFieldRow[],
    clean: Record<string, unknown>,
  ): void {
    const computed = this.recomputeCalcs(fields, clean);

    for (const f of fields) {
      if (f.field_type === 'calculated' && f.calculation?.expression) {
        const v = computed[f.field_key];

        if (v !== null && v !== undefined) clean[f.field_key] = v;
      }
    }
  }

  async upsertDraft(
    formId: string,
    dto: CreateFormBuilderSubmissionDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const { data: form, error: formErr } = await this.client
      .from(FORMS_TABLE)
      .select('id')
      .eq('id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (formErr) throw new BadRequestException(formErr.message);
    if (!form) throw new NotFoundException('Form not found');

    const draftData = dto.data ?? {};

    const { data: existing, error: findErr } = await this.client
      .from(TABLE)
      .select('id')
      .eq('form_id', formId)
      .eq('submitted_by', userId)
      .eq('status', 'draft')
      .maybeSingle();

    if (findErr) throw new BadRequestException(findErr.message);

    if (existing) {
      const { data, error } = await this.client
        .from(TABLE)
        .update({ data: draftData })
        .eq('id', existing.id)
        .select('*')
        .single();

      if (error) throw new BadRequestException(error.message);

      return data;
    }

    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        form_id: formId,
        organization_id: organizationId,
        space_id: spaceId,
        submitted_by: userId,
        data: draftData,
        status: 'draft',
        version: 1,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        const { data: raced, error: racedErr } = await this.client
          .from(TABLE)
          .update({ data: draftData })
          .eq('form_id', formId)
          .eq('submitted_by', userId)
          .eq('status', 'draft')
          .select('*')
          .single();

        if (racedErr) throw new BadRequestException(racedErr.message);

        return raced;
      }

      throw new BadRequestException(error.message);
    }

    return data;
  }

  async getDraft(
    formId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('submitted_by', userId)
      .eq('status', 'draft')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    return data ?? null;
  }

  async deleteDraft(
    formId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('submitted_by', userId)
      .eq('status', 'draft');

    if (error) throw new BadRequestException(error.message);

    return { success: true as const };
  }

  private validateValue(
    field: SubmissionFieldRow,
    value: unknown,
  ): string | null {
    const type = field.field_type;
    const rules = (field.validation_rules ?? {}) as Record<string, any>;
    const optionValues = this.optionValues(field.options);

    switch (type) {
      case 'dropdown':
      case 'radio':
        // Dynamic task-field mapping: value is a live task-system ID, not a static option value.
        if (
          typeof rules.task_field === 'string' &&
          DYNAMIC_TASK_FIELDS.has(rules.task_field)
        )
          return typeof value === 'string' && value.length > 0
            ? null
            : 'invalid selection';

        if (typeof value !== 'string' || !optionValues.includes(value))
          return 'invalid option';

        return null;

      case 'checkboxes':
        if (!Array.isArray(value)) return 'invalid selection';

        // Dynamic task-field mapping: each element is a live task-system ID.
        if (
          typeof rules.task_field === 'string' &&
          DYNAMIC_TASK_FIELDS.has(rules.task_field)
        )
          return value.every((v) => typeof v === 'string' && v.length > 0)
            ? null
            : 'invalid selection';

        return value.some((v) => !optionValues.includes(String(v)))
          ? 'invalid option'
          : null;

      // Single asset-object UUID — a live entity id, never a static field.options value.
      // Emptiness is the `required` check's job.
      case 'asset':
        if (value == null || value === '') return null;

        return typeof value === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            value,
          )
          ? null
          : 'invalid selection';

      // Array of asset-object UUIDs. A bare string is still accepted: a field switched
      // from `asset` to `asset_multi` can submit the old single-value shape.
      case 'asset_multi': {
        if (value == null || value === '') return null;

        const assetIds = Array.isArray(value) ? value : [value];

        return assetIds.every(
          (entry) =>
            typeof entry === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              entry,
            ),
        )
          ? null
          : 'invalid selection';
      }

      case 'number':
      case 'rating':
      case 'linear_scale':
      case 'slider':
      case 'nps': {
        const n = Number(value);

        if (!Number.isFinite(n)) return 'must be a number';
        if (rules.min != null && n < Number(rules.min))
          return `must be at least ${rules.min}`;
        if (rules.max != null && n > Number(rules.max))
          return `must be at most ${rules.max}`;

        return null;
      }

      case 'short_text':
      case 'long_text':
      case 'phone': {
        const s = String(value);

        if (rules.minLength != null && s.length < Number(rules.minLength))
          return `must be at least ${rules.minLength} characters`;
        if (rules.maxLength != null && s.length > Number(rules.maxLength))
          return `must be at most ${rules.maxLength} characters`;

        return null;
      }

      case 'email':
        return typeof value === 'string' &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          ? null
          : 'invalid email';

      case 'url':
        return typeof value === 'string' && /^https?:\/\/.+/.test(value)
          ? null
          : 'invalid URL';

      case 'yes_no':
        return typeof value === 'boolean' || value === 'yes' || value === 'no'
          ? null
          : 'invalid value';

      case 'date':
        if (value != null && Number.isNaN(Date.parse(String(value))))
          return 'must be a valid date';

        return null;

      case 'time':
        if (value != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)))
          return 'must be HH:mm';

        return null;

      case 'datetime':
        if (value != null && Number.isNaN(Date.parse(String(value))))
          return 'must be a valid datetime';

        return null;

      case 'date_range': {
        const r = value as {
          start?: string | null;
          end?: string | null;
        } | null;

        if (!r?.start || !r?.end)
          return 'both start and end dates are required';
        if (r.start > r.end) return 'start must be ≤ end';

        return null;
      }

      case 'address':
      case 'full_name': {
        if (
          value != null &&
          (typeof value !== 'object' || Array.isArray(value))
        )
          return 'must be an object';

        for (const sub of (rules.requiredSubfields as string[] | undefined) ??
          []) {
          if (
            (value as Record<string, unknown>)?.[sub] == null ||
            (value as Record<string, unknown>)[sub] === ''
          )
            return `${sub} is required`;
        }

        return null;
      }

      case 'signature':
        if (typeof value === 'string' && value.length > 2_000_000)
          return 'signature is too large';

        return null;

      case 'file_upload': {
        const files = Array.isArray(value)
          ? (value as Array<{ size?: number }>)
          : [];
        const maxFiles = rules.maxFiles != null ? Number(rules.maxFiles) : null;
        const maxSizeMb =
          rules.maxSizeMb != null
            ? Number(rules.maxSizeMb)
            : UPLOAD_LIMITS.ATTACHMENT / (1024 * 1024);

        for (const f of files) {
          if (typeof f?.size === 'number' && f.size > maxSizeMb * 1024 * 1024)
            return `a file exceeds the ${maxSizeMb} MB limit`;
        }

        if (maxFiles !== null && files.length > maxFiles)
          return `max ${maxFiles} file(s) allowed`;

        return null;
      }

      case 'matrix': {
        const opts = (field.options as Record<string, unknown>) ?? {};
        const rows = (opts.rows as Array<{ value: string }>) ?? [];
        const colValues = new Set(
          ((opts.columns as Array<{ value: string }>) ?? []).map(
            (c) => c.value,
          ),
        );
        const mat = (value as Record<string, string>) ?? {};

        for (const row of rows) {
          const answer = mat[row.value];

          if (field.required && (answer == null || answer === ''))
            return `row "${row.value}" is required`;
          if (answer != null && answer !== '' && !colValues.has(answer))
            return `row "${row.value}" has an invalid selection`;
        }

        return null;
      }

      default:
        return null;
    }
  }

  private optionValues(options: unknown): string[] {
    if (!Array.isArray(options)) return [];

    const result: string[] = [];

    for (const o of options as unknown[]) {
      const v =
        o && typeof o === 'object' ? (o as { value?: unknown }).value : o;

      if (typeof v === 'string' || typeof v === 'number')
        result.push(String(v));
    }

    return result;
  }
}
