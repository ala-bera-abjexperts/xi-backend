import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { FormBuilderSubmissionEventsService } from '../../form-builder/form-builder-submission-events.service';
import { surfaceTicketOutcome } from '../../form-builder/submission-surface.util';
import { FormBuilderAssignmentsService } from '../../form-builder/form-builder-assignments.service';
import {
  PUBLIC_INPUT_TYPES,
  findPubliclyUnsafeTypes,
  isPaymentConfigOnlyBlocker,
  isRecaptchaConfigured,
  sanitizeLayoutOptions,
  sanitizeOptions as sanitizePublicOptions,
  sanitizeProductOptions,
  sanitizeValidationRules as sanitizePublicValidationRules,
} from '../../form-builder/public/public-form-safety.util';
import type { PublicSafetyContext } from '../../form-builder/public/public-form-safety.util';
import {
  PublicFormBuilderService,
  PUBLIC_UPLOAD_FIELD_TYPES,
  PUBLIC_UPLOAD_MIME_TYPES,
} from '../../form-builder/public/public-form-builder.service';
import type { PublicAudienceForm } from '../../form-builder/public/public-form-builder.service';
import {
  dropUnlinkedAssetAnswers,
  withAssetDependsOnRule,
} from '../../form-builder/public/public-asset-dependency';
import type { PublicAssetOptions } from '../../form-builder/public/public-asset-dependency';
import { FormBuilderUploadsService } from '../../form-builder/form-builder-uploads.service';
import { computeFieldStates } from '../../form-builder/logic/condition-evaluator';
import type {
  FieldLogicState,
  LogicField,
} from '../../form-builder/logic/condition-evaluator';
import { RecaptchaVerifierService } from '../../form-builder/public/recaptcha-verifier.service';
import { FormBuilderPaymentConfigService } from '../../form-builder/form-builder-payment-config.service';
import { FieldGroupsService } from '../../custom-fields/field-groups.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TaskHierarchyConfigService } from '../../task-hierarchy-config/task-hierarchy-config.service';
import { TaskPrioritiesService } from '../../task-priorities/task-priorities.service';
import { TaskStatusesService } from '../../task-statuses/task-statuses.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PublicFormSubmitDto } from './dto/public-form.dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Task properties whose choices come from live records rather than the field's stored options.
 *
 * `parent_task` offers real root-task summaries, so it follows "Require login to submit"
 * (`settings.require_login`): an open form resolves them for every visitor, a login-required one only
 * for a verified signed-in viewer. Anyone else gets no options — never the stored placeholders.
 */
const RESOLVABLE_TASK_FIELDS = new Set([
  'task_type',
  'priority',
  'status',
  'parent_task',
]);

/** Bound on the root tasks served to one page. */
const PUBLIC_PARENT_TASK_LIMIT = 200;

/** Served on a parent-task field withheld until sign-in. Mirrors `PublishedFormBuilderForm.tsx`. */
const PARENT_TASK_SIGN_IN_RULE = 'parent_task_sign_in_required';

/** One `{ label, value }` catalogue per task property, keyed by `task_field`. */
type TaskOptionCatalogue = Map<string, Array<{ label: string; value: string }>>;

/**
 * Marks the Task Type input that reveals the selected type's custom fields.
 * Mirrors `SHOW_TASK_TYPE_CF_RULE` in `src/views/form-builder/task-type-custom-fields.ts`.
 */
const SHOW_TASK_TYPE_CF_RULE = 'show_task_type_custom_fields';

/**
 * Per-form hide list set via the builder's "Manage custom fields" dialog — a `string[]` of
 * `custom_fields.field_key`. Mirrors `HIDDEN_TASK_TYPE_CF_RULE` in
 * `src/views/form-builder/task-type-custom-fields.ts`.
 *
 * The published page must honour it, otherwise it asks for fields the author deliberately excluded.
 * It only ever narrows: the task type's own `is_hidden` assignment flag stays authoritative.
 */
const HIDDEN_TASK_TYPE_CF_RULE = 'hidden_task_type_custom_fields';

/** Answer namespace for those fields. Must match the frontend and the submissions service. */
const TASK_TYPE_CF_PREFIX = '__cf__';
const SAFE_CF_KEY_RE = /^[A-Za-z0-9_-]+$/;

// Bounds an untrusted client, mirroring the authenticated path.
const MAX_TASK_TYPE_CF_ANSWERS = 100;
const MAX_TASK_TYPE_CF_VALUE_CHARS = 10_000;

/**
 * Custom-field types safe to render to an anonymous visitor.
 *
 * A strict whitelist so a future field type fails closed rather than leaking by default. Excluded on
 * purpose: `user_select`/`user_multi` (expose the org user directory), `list_item`/`list_item_multi`
 * (expose list-schema contents), `wiki_page` (page titles), `task` (real task summaries — the same
 * reason `parent_task` is not resolved), `editor` and `cascading_select` (no plain-HTML equivalent in
 * the session-less renderer, and a broken control is worse than an omitted field), and `label`
 * (read-only, collects nothing).
 */
const PUBLIC_CUSTOM_FIELD_TYPES = new Set([
  'string',
  'number',
  'select',
  'multiselect',
  'radio',
  'checkbox',
  'date',
  'time',
  'datetime',
  'url',

  // User pickers, included by explicit product decision so the published form matches the in-app
  // one. This DOES expose people's display names to anyone holding the funnel URL — it cannot be
  // avoided, since a picker is unrenderable without them. Narrowed as far as possible: only ACTIVE
  // USER members of the task integration's target space (never the org-wide directory), and only
  // id + display name — no emails, no avatars. See `resolveSpaceMemberOptions`.
  'user_select',
  'user_multi',

  // Asset pickers, by explicit product decision: only the bounded server-resolved list of each field's
  // configured asset types (names), and a submitted id must be one of them.
  'asset',
  'asset_multi',
]);

/** Custom-field types whose choices are people rather than stored options. */
const USER_CUSTOM_FIELD_TYPES = new Set(['user_select', 'user_multi']);

/** Custom-field types whose choices are asset objects, resolved server-side. */
const ASSET_CUSTOM_FIELD_TYPES = new Set(['asset', 'asset_multi']);

/** A task-type custom field as served publicly — no ids, no internal config. */
export interface PublicCustomFieldDefinition {
  key: string;
  label: string;
  field_type: string;
  required: boolean;

  // `parents`: the served parent-field options an asset option is linked to (dependent assets only).
  options: Array<{ label: string; value: string; parents?: string[] }>;

  // Set on a dependent asset: its options narrow to the ones linked to this sibling's answer.
  depends_on?: { source_key: string };
}

function taskTypeCfFieldKey(key: string): string | null {
  if (!key.startsWith(TASK_TYPE_CF_PREFIX)) return null;

  const fieldKey = key.slice(TASK_TYPE_CF_PREFIX.length);

  return SAFE_CF_KEY_RE.test(fieldKey) ? fieldKey : null;
}

const FUNNELS_TABLE = 'site_studio_funnels';
const PAGES_TABLE = 'site_studio_pages';
const FORMS_TABLE = 'form_builder';
const FIELDS_TABLE = 'form_builder_fields';
const SUBMISSIONS_TABLE = 'form_builder_submissions';

/** How long the ticket read-back waits for the post-submit pipeline to stamp an outcome. */
const TICKET_SETTLE_TIMEOUT_MS = 2500;
const TICKET_SETTLE_INTERVAL_MS = 150;
/** Site Studio element type that embeds a form-builder form on a funnel page. */
const ELEMENT_TYPE = 'formBuilderForm';

// Field-type and validation-rule safety is shared with the standalone public-form path
// (public-form-safety.util.ts) so the two anonymous surfaces cannot drift apart again.

/** Payload guards for the anonymous submit path. */
// 2 MB: signature/camera/multi_photo/spreadsheet answers are inline data URIs, which never fit 64 KB.
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_ANSWER_KEYS = 200;
const MAX_STRING_LENGTH = 10_000;

/** Types whose answer is a single inline data URI, so the ordinary string cap would reject them. */
const MAX_DATA_URI_STRING_LENGTH = 300_000;
const DATA_URI_STRING_TYPES = new Set(['camera', 'signature']);

// multi_photo is bounded on the array TOTAL, not per entry: 200 entries x 300 KB would be ~60 MB.
const MAX_MULTI_PHOTO_TOTAL_BYTES = 2_000_000;
const MAX_ARRAY_LENGTH = 200;

/** IP throttling on top of the controller-level @Throttle. */
const IP_WINDOW_MS = 600_000;
const IP_MAX_SUBMISSIONS = 10;
const FORM_WINDOW_MS = 3_600_000;
const FORM_MAX_SUBMISSIONS = 500;

interface EditorElementLike {
  type?: string;
  content?: unknown;
}

interface FormRow {
  id: string;
  organization_id: string;
  space_id: string;
  name: string;
  description: string | null;
  status: string;
  settings: Record<string, unknown> | null;
  is_deleted: boolean;
}

interface FieldRow {
  id: string;
  field_key: string;
  field_type: string;
  label: string;
  placeholder: string | null;
  help_text: string | null;
  description: string | null;
  required: boolean;
  options: unknown;
  validation_rules: Record<string, unknown> | null;
  page_index: number;
  sort_order: number;
  is_hidden: boolean;
  read_only: boolean;
  conditional_logic: unknown;
}

/** Field definition as served to an anonymous visitor — no internal ids. */
export interface PublicFormFieldDefinition {
  field_key: string;
  field_type: string;
  label: string;
  placeholder: string | null;
  help_text: string | null;
  required: boolean;
  options: unknown;
  validation_rules: Record<string, unknown> | null;
  sort_order: number;
  conditional_logic: unknown;
}

/** Ticket outcome reported back to a published page's success screen. */
export type SubmissionTicketStatus =
  | 'created'
  | 'pending_approval'
  | 'skipped'
  | 'failed'
  | 'unknown';

export interface PublicFormDefinition {
  form: {
    name: string;
    description: string | null;
    submit_label: string | null;
    success_message: string | null;

    // Lets the page skip the ticket lookup entirely when the form creates no ticket
    creates_ticket: boolean;
  };
  fields: PublicFormFieldDefinition[];

  /**
   * Custom fields each task type defines, keyed by task type id. Populated only when a Task Type
   * input opts in via `show_task_type_custom_fields` AND task integration is enabled. Empty
   * otherwise, so a form that does not use the feature returns an identical payload to before.
   */
  task_type_custom_fields: Record<string, PublicCustomFieldDefinition[]>;

  /** `field_key` of the Task Type input that drives the block above, or null. */
  task_type_field_key: string | null;
}

/**
 * Anonymous (no session) access to a form-builder form embedded on a published
 * Site Studio funnel page.
 *
 * Every check below runs on BOTH the definition fetch and the submit — the
 * definition endpoint is not a permission boundary on its own, so the submit
 * path never trusts that the visitor went through it.
 */
@Injectable()
export class PublicFormService {
  private readonly logger = new Logger(PublicFormService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly taskHierarchyConfig: TaskHierarchyConfigService,
    private readonly taskPriorities: TaskPrioritiesService,
    private readonly taskStatuses: TaskStatusesService,
    private readonly events: FormBuilderSubmissionEventsService,
    private readonly fieldGroups: FieldGroupsService,
    private readonly assignments: FormBuilderAssignmentsService,
    private readonly publicFormBuilder: PublicFormBuilderService,
    private readonly uploads: FormBuilderUploadsService,
    private readonly recaptcha: RecaptchaVerifierService,
    private readonly paymentConfig: FormBuilderPaymentConfigService,
  ) {}

  /**
   * Accepts a file for a `file_upload`/`audio` field on a form embedded in a published funnel.
   *
   * Goes through the same embed proof as getDefinition/submit — without it this would be an open
   * upload proxy for any form id. The field and its type are resolved from the form's OWN field
   * list, never from the caller's claim.
   */
  async uploadFile(
    funnelId: string,
    formId: string,
    fieldKey: string,
    file: Express.Multer.File,
    pageId?: string,
    user?: RequestUser,
  ): Promise<{ publicUrl: string; path: string }> {
    const { form, fields } = await this.resolvePublicForm(
      funnelId,
      formId,
      pageId,
      user,
    );

    const field = fields.find((f) => f.field_key === fieldKey);

    if (!field || !PUBLIC_UPLOAD_FIELD_TYPES.has(field.field_type)) {
      throw new BadRequestException('Unknown or unsupported upload field');
    }

    const allowedMimeTypes = PUBLIC_UPLOAD_MIME_TYPES[field.field_type];

    if (allowedMimeTypes && !allowedMimeTypes.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type for this field: ${file.mimetype || 'unknown'}`,
      );
    }

    return this.uploads.upload(form.space_id, form.id, fieldKey, file);
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Space a submission's ticket would be created in, or null when this form creates none.
   *
   * Same two conditions the live-task-record substitution below applies: `target_space_id` outlives
   * the toggle being switched off, so the toggle alone is the signal and the id must still be a uuid.
   */
  private ticketTargetSpaceId(
    settings: Record<string, unknown>,
  ): string | null {
    const integration = settings.task_integration as
      | Record<string, unknown>
      | undefined;

    if (integration?.enabled !== true) return null;

    const spaceId = integration?.target_space_id;

    return typeof spaceId === 'string' && UUID_RE.test(spaceId)
      ? spaceId
      : null;
  }

  /**
   * Ticket a submission produced, for the published page's success screen.
   *
   * Read-only and deliberately narrow — status, key and space key, nothing else. `formId` is a
   * second factor so a leaked submission id alone cannot read a ticket key, and every failure
   * returns the same shape rather than a 404, so probing reveals nothing.
   *
   * `created` with no resolvable key is reported as `unknown`: the task FK is ON DELETE SET NULL,
   * so deleting a task leaves the status behind and the screen must not print an empty reference.
   */
  async getSubmissionTicket(
    submissionId: string,
    formId: string,
    viewerUserId: string | null,
  ): Promise<{
    status: SubmissionTicketStatus;
    taskKey: string | null;
    spaceKey: string | null;
    requestId: string | null;
  }> {
    const none = {
      status: 'unknown' as SubmissionTicketStatus,
      taskKey: null,
      spaceKey: null,
      requestId: null,
    };

    if (!UUID_RE.test(submissionId) || !UUID_RE.test(formId)) return none;

    // Task creation runs after the submit response, so the outcome is usually a few hundred ms
    // away. Waiting here rather than making the page guess a retry schedule: the answer is
    // returned the moment it settles, and one request replaces a client-side poll loop.
    // Strictly bounded, and it never blocks the submit itself — only this read.
    const deadline = Date.now() + TICKET_SETTLE_TIMEOUT_MS;
    let row: {
      task_creation_status?: string | null;
      task_id?: string | null;
    } | null = null;

    for (;;) {
      // Two plain reads rather than a `task:tasks!task_id(...)` embed: PostgREST types an embed as
      // an array and the to-one shape differs by version, which is a silent wrong-answer risk here.
      const { data, error } = await this.client
        .from(SUBMISSIONS_TABLE)
        .select('task_creation_status, task_id')
        .eq('id', submissionId)
        .eq('form_id', formId)
        .maybeSingle();

      if (error || !data) return none;

      row = data as {
        task_creation_status?: string | null;
        task_id?: string | null;
      };

      // Any stamped outcome is final; only an unstamped row is worth waiting on.
      if (row.task_creation_status) break;
      if (Date.now() >= deadline) break;

      await new Promise((resolve) =>
        setTimeout(resolve, TICKET_SETTLE_INTERVAL_MS),
      );
    }

    const status = row?.task_creation_status ?? 'unknown';

    if (status !== 'created') {
      const known: SubmissionTicketStatus[] = [
        'pending_approval',
        'skipped',
        'failed',
      ];

      return {
        status: known.includes(status as SubmissionTicketStatus)
          ? (status as SubmissionTicketStatus)
          : 'unknown',
        taskKey: null,
        spaceKey: null,
        requestId: null,
      };
    }

    // Status says created but the link is gone (task deleted — the FK is ON DELETE SET NULL).
    if (!row?.task_id) return none;

    const { data: taskData, error: taskError } = await this.client
      .from('tasks')
      .select('key, space_id')
      .eq('id', row.task_id)
      .maybeSingle();

    if (taskError || !taskData) return none;

    const task = taskData as { key?: string | null; space_id?: string | null };
    const taskKey = task.key ?? null;

    if (!taskKey) return none;

    // Only a signed-in caller can open the in-app task page, so only they are given the space key.
    const spaceKey =
      viewerUserId && task.space_id
        ? await this.spaceKeyById(task.space_id)
        : null;

    // The customer-portal row, so a Site Studio page can deep-link the visitor straight to their
    // ticket. Gated on the viewer for the same reason as spaceKey: the row only ever exists for an
    // attributed (signed-in) respondent, and an anonymous response has no business carrying an id.
    //
    // Returns null far more often than it returns a value, and that is expected, not a failure:
    // `task_creation_status` is stamped BEFORE openSupportRequest runs, and the form may simply not
    // have "Show in customer portal" enabled. The caller treats null as "keep waiting / no redirect".
    const requestId = viewerUserId
      ? await this.supportRequestIdByTask(row.task_id)
      : null;

    return { status: 'created', taskKey, spaceKey, requestId };
  }

  /**
   * The customer-portal ticket opened for a form-created task, if there is one.
   *
   * `.limit(1)` rather than `.maybeSingle()` on purpose: a duplicate link must degrade to "no
   * redirect", never to a 500 on a public endpoint.
   */
  private async supportRequestIdByTask(taskId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('support_requests')
      .select('id')
      .eq('task_id', taskId)
      .limit(1);

    if (error) return null;

    return (data?.[0] as { id?: string } | undefined)?.id ?? null;
  }

  private async spaceKeyById(spaceId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('spaces')
      .select('key')
      .eq('id', spaceId)
      .maybeSingle();

    if (error || !data) return null;

    return (data as { key?: string | null }).key ?? null;
  }

  /**
   * Sanitized definition for a form embedded on a published funnel page.
   * Throws if the embed cannot be proven, or if the form is not safe for the
   * anonymous path.
   */
  async getDefinition(
    funnelId: string,
    formId: string,
    pageId?: string,
    user?: RequestUser,
  ): Promise<PublicFormDefinition> {
    const { form, fields, submitterUserId } = await this.resolvePublicForm(
      funnelId,
      formId,
      pageId,
      user,
    );

    const settings: Record<string, unknown> = form.settings ?? {};

    // What the visitor SEES — broader than what is accepted back. `products` and `recaptcha` carry
    // no ordinary answer but must render, exactly as the standalone public path serves them.
    const answerable = this.servedFields(fields);

    // A field mapped to a task property stores placeholder options ("Option 1"/"Option 2") — the
    // authenticated fill view swaps in the live records at render time, and the published page has to
    // do the same or a visitor cannot pick a real task type.
    const taskOptions = await this.resolveTaskOptions(
      form.organization_id,
      settings,
      answerable,
      submitterUserId,
    );

    // The Task Type input that opts into showing its type's custom fields. Only the first counts —
    // two would render competing blocks for the same answers.
    const driver = answerable.find(
      (f) =>
        this.taskFieldOf(f) === 'task_type' &&
        f.validation_rules?.[SHOW_TASK_TYPE_CF_RULE] === true,
    );

    // Reuses the task-type ids already resolved above, so the two stay in lockstep: a type that is
    // not offered in the dropdown can never have a custom-field block.
    const taskTypeIds = (taskOptions.get('task_type') ?? []).map(
      (o) => o.value,
    );

    const taskTypeCustomFields =
      driver && taskTypeIds.length > 0
        ? await this.resolveTaskTypeCustomFields(
            form.organization_id,
            (settings.task_integration as Record<string, unknown>)
              ?.target_space_id as string,
            taskTypeIds,
            this.hiddenCustomFieldKeys(driver),
          )
        : {};

    // Bounded {label,value} list resolved server-side, so the page never calls the
    // membership-guarded asset endpoints.
    // Only ACTIVE user members of the form's own space, id + display name only — never the org
    // directory. Same narrow exposure the task-type custom-field path already makes.
    const memberOptions = answerable.some((f) => f.field_type === 'user_select')
      ? await this.resolveSpaceMemberOptions(form.space_id)
      : [];

    // Only a viewer the audience gate verified may narrow "assigned only" fields.
    const assetOptions = await this.publicFormBuilder.resolveAssetOptions(
      {
        organization_id: form.organization_id,
        space_id: form.space_id ?? null,
        settings: form.settings,
      },
      answerable,
      submitterUserId,
    );

    // Login required but no verified viewer: the parent-task field explains itself on the page.
    const parentTaskSignIn =
      settings.require_login === true &&
      !submitterUserId &&
      taskOptions.has('parent_task');

    return {
      form: {
        name: form.name,
        description: form.description ?? null,
        submit_label: this.asOptionalString(settings.submit_button_label),
        success_message: this.asOptionalString(settings.success_message),
        creates_ticket: this.ticketTargetSpaceId(settings) !== null,
      },
      fields: answerable.map((f) =>
        this.toPublicField(
          f,
          taskOptions,
          assetOptions,
          memberOptions,
          parentTaskSignIn,
        ),
      ),
      task_type_custom_fields: taskTypeCustomFields,
      task_type_field_key:
        Object.keys(taskTypeCustomFields).length > 0 && driver
          ? driver.field_key
          : null,
    };
  }

  /**
   * Live `{ label, value }` choices for every task property this form's fields map to.
   *
   * Reuses the same services the authenticated app uses rather than querying the tables directly.
   * That is deliberate — those services already encode two things that are easy to get wrong:
   * org-level rows (`space_id IS NULL`) are returned *alongside* space rows, and "active" means
   * `is_active !== false` for task types but an explicit `is_active = true` for statuses/priorities.
   *
   * Never throws: an unreachable catalogue leaves the field's stored options in place, which renders a
   * stale dropdown rather than taking down the whole public page.
   */
  private async resolveTaskOptions(
    organizationId: string,
    settings: Record<string, unknown>,
    fields: FieldRow[],
    viewerUserId: string | null,
  ): Promise<TaskOptionCatalogue> {
    const catalogue: TaskOptionCatalogue = new Map();

    const needed = new Set<string>();

    for (const field of fields) {
      const taskField = this.taskFieldOf(field);

      if (taskField && RESOLVABLE_TASK_FIELDS.has(taskField)) {
        needed.add(taskField);
      }
    }

    if (needed.size === 0) return catalogue;

    const integration = settings.task_integration as
      | Record<string, unknown>
      | undefined;

    // Only substitute live task records while the form actually creates tasks ("Create task on
    // submission" in the Ticket Integration tab). With the toggle off the answer goes nowhere, so the
    // author's own options are what the field really means — offering live task types would be a lie.
    // `target_space_id` survives the toggle being switched off, so it cannot be used as the signal.
    if (integration?.enabled !== true) return catalogue;

    const spaceId = integration?.target_space_id;

    // `getConfig()` asserts a uuid and throws on anything else, so a form whose integration was never
    // configured must not reach these lookups — that would turn a working page into a 500.
    if (typeof spaceId !== 'string' || !UUID_RE.test(spaceId)) return catalogue;

    const toOptions = (
      rows: Array<{ id?: unknown; name?: unknown }>,
    ): Array<{ label: string; value: string }> =>
      rows
        .filter(
          (row) => typeof row?.id === 'string' && typeof row?.name === 'string',
        )
        .map((row) => ({ label: row.name as string, value: row.id as string }));

    await Promise.all(
      [...needed].map(async (taskField) => {
        // Never the stored placeholders: withheld or unreachable root tasks serve no options.
        if (taskField === 'parent_task') catalogue.set(taskField, []);

        try {
          if (taskField === 'parent_task') {
            // Real work items: behind "Require login to submit" only a verified viewer sees them.
            if (settings.require_login !== true || viewerUserId) {
              catalogue.set(
                taskField,
                await this.loadRootTaskOptions(organizationId, spaceId),
              );
            }

            return;
          }

          if (taskField === 'task_type') {
            const levels = await this.taskHierarchyConfig.getActiveTypes(
              organizationId,
              spaceId,
            );

            catalogue.set(taskField, toOptions(levels));

            return;
          }

          const rows =
            taskField === 'priority'
              ? await this.taskPriorities.getAll(organizationId, spaceId, {
                  is_active: 'true',
                })
              : await this.taskStatuses.getAll(organizationId, spaceId, {
                  is_active: 'true',
                });

          catalogue.set(taskField, toOptions(rows));
        } catch (error) {
          this.logger.warn(
            `public form: could not resolve ${taskField} options for space ${spaceId}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        }
      }),
    );

    return catalogue;
  }

  /**
   * The custom fields each task type defines, straight from that type's Field Configuration
   * (Space Settings → Task Type → Custom Fields), keyed by task type id.
   *
   * Reuses `FieldGroupsService.getLevelFieldsConfiguration()` — the same resolver behind
   * `GET /field-groups/for-level` that the authenticated builder uses — so standalone assignments
   * *and* the fields of every assigned group are both covered, exactly as in-app.
   *
   * Never throws: a failed lookup yields no block rather than a broken public page.
   */
  /**
   * Active user members of a space as `{ label, value }`, for rendering a user-picker custom field.
   *
   * Scoped to the ONE space the form's task integration targets — never the organization directory —
   * and limited to id + display name. Groups and role rows carry a null `user_id` and are excluded.
   * Falls back to the email local-part only when a member has no name, so a full address is never
   * published.
   */
  private async resolveSpaceMemberOptions(
    spaceId: string,
  ): Promise<Array<{ label: string; value: string }>> {
    const { data, error } = await this.client
      .from('space_members')
      .select('user_id, user:users!user_id(first_name, last_name, email)')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .eq('member_type', 'user');

    if (error) {
      this.logger.warn(
        `public form: space member lookup failed: ${error.message}`,
      );

      return [];
    }

    const options: Array<{ label: string; value: string }> = [];

    for (const row of data ?? []) {
      const r = row as {
        user_id: string | null;
        user?:
          | { first_name?: string; last_name?: string; email?: string }
          | Array<{ first_name?: string; last_name?: string; email?: string }>
          | null;
      };

      if (!r.user_id) continue;

      const u = Array.isArray(r.user) ? r.user[0] : r.user;
      const name = [u?.first_name, u?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
      const label = name || u?.email?.split('@')[0] || '';

      if (label) options.push({ label, value: r.user_id });
    }

    return options;
  }

  private async resolveTaskTypeCustomFields(
    organizationId: string,
    spaceId: string,
    taskTypeIds: string[],
    hiddenKeys: Set<string> = new Set(),
  ): Promise<Record<string, PublicCustomFieldDefinition[]>> {
    const out: Record<string, PublicCustomFieldDefinition[]> = {};

    // Fetched once and shared by every user-picker field across every task type.
    const memberOptions = await this.resolveSpaceMemberOptions(spaceId);

    await Promise.all(
      taskTypeIds.map(async (taskTypeId) => {
        try {
          const config = (await this.fieldGroups.getLevelFieldsConfiguration(
            organizationId,
            taskTypeId,
            'task',
            false,
            spaceId,
          )) as {
            standalone_fields?: unknown[];
            groups?: Array<{ field_group?: { fields?: unknown[] } }>;
          };

          const seen = new Set<string>();
          const fields: PublicCustomFieldDefinition[] = [];
          const assetRows: Array<{
            field_key: string;
            field_type: string;
            validation_rules: unknown;
          }> = [];

          const push = (assignment: unknown) => {
            const a = assignment as {
              is_required?: boolean;
              is_hidden?: boolean;
              is_enabled_in_space?: boolean;
              custom_field?: {
                id?: string;
                name?: string;
                field_key?: string;
                field_type?: string;
                options?: unknown;
                validation_rules?: unknown;
                is_active?: boolean;
              };
            };

            // Configuration-only rows are never rendered in-app either.
            if (a.is_hidden === true || a.is_enabled_in_space === false) return;

            const cf = a.custom_field;

            if (!cf?.field_key || !cf.field_type) return;
            if (cf.is_active === false) return;
            if (!SAFE_CF_KEY_RE.test(cf.field_key)) return;

            // Excluded by this form's "Manage custom fields" selection.
            if (hiddenKeys.has(cf.field_key)) return;

            // Whitelist — anything not explicitly safe for an anonymous visitor is omitted.
            if (!PUBLIC_CUSTOM_FIELD_TYPES.has(cf.field_type)) return;
            if (seen.has(cf.field_key)) return;

            seen.add(cf.field_key);

            if (ASSET_CUSTOM_FIELD_TYPES.has(cf.field_type)) {
              assetRows.push({
                field_key: cf.field_key,
                field_type: cf.field_type,
                validation_rules: cf.validation_rules,
              });
            }

            fields.push({
              key: cf.field_key,
              label: cf.name || cf.field_key,
              field_type: cf.field_type,
              required: a.is_required === true,

              // A user picker's choices are people, not the field's stored options.
              options: USER_CUSTOM_FIELD_TYPES.has(cf.field_type)
                ? (memberOptions ?? [])
                : ((this.sanitizeOptions(cf.options) ?? []) as Array<{
                    label: string;
                    value: string;
                  }>),
            });
          };

          for (const row of config.standalone_fields ?? []) push(row);

          for (const group of config.groups ?? []) {
            for (const row of group.field_group?.fields ?? []) push(row);
          }

          // Same bounded, server-resolved list the public Asset form field serves.
          if (assetRows.length > 0) {
            const resolved = await this.publicFormBuilder.resolveAssetOptions(
              { organization_id: organizationId, space_id: spaceId },
              assetRows,
              null,
              { narrowDependents: false },
            );

            for (const field of fields) {
              if (ASSET_CUSTOM_FIELD_TYPES.has(field.field_type)) {
                field.options = resolved.get(field.key) ?? [];
              }
            }

            await this.attachAssetParents(organizationId, fields, assetRows);
          }

          if (fields.length > 0) out[taskTypeId] = fields;
        } catch (error) {
          this.logger.warn(
            `public form: could not resolve custom fields for task type ${taskTypeId}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        }
      }),
    );

    return out;
  }

  /**
   * Accepts the task-type custom-field answers into `clean` and returns synthetic snapshot entries
   * describing them.
   *
   * Everything is re-derived server-side from the submitted task type: a key is accepted only if that
   * type genuinely defines it and the field's type is publicly renderable. A forged `__cf__*` for any
   * other custom field in the org is dropped, so the namespace cannot be used to write arbitrary
   * `tasks.custom_field_values` entries.
   *
   * Mutates `clean` in place, mirroring how the authenticated path carries these answers.
   */
  private async applyTaskTypeCustomFields(
    form: FormRow,
    answerable: FieldRow[],
    raw: Record<string, unknown>,
    clean: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const offered = Object.keys(raw).filter((k) => taskTypeCfFieldKey(k));

    if (offered.length === 0) return [];

    const settings = form.settings ?? {};
    const integration = settings.task_integration as
      | Record<string, unknown>
      | undefined;

    // Same gate as the definition endpoint: no integration, no block, no answers.
    if (integration?.enabled !== true) return [];

    const spaceId = integration.target_space_id;

    if (typeof spaceId !== 'string' || !UUID_RE.test(spaceId)) return [];

    const driver = answerable.find(
      (f) =>
        this.taskFieldOf(f) === 'task_type' &&
        f.validation_rules?.[SHOW_TASK_TYPE_CF_RULE] === true,
    );

    if (!driver) return [];

    // The type the visitor actually chose — read from the cleaned answers, not the raw payload.
    const taskTypeId = clean[driver.field_key];

    if (typeof taskTypeId !== 'string' || !taskTypeId) return [];

    const byType = await this.resolveTaskTypeCustomFields(
      form.organization_id,
      spaceId,
      [taskTypeId],
      this.hiddenCustomFieldKeys(driver),
    );

    const allowed = new Map(
      (byType[taskTypeId] ?? []).map((f) => [f.key, f] as const),
    );

    if (allowed.size === 0) return [];

    const snapshot: Record<string, unknown>[] = [];
    let carried = 0;

    for (const [key, value] of Object.entries(raw)) {
      const fieldKey = taskTypeCfFieldKey(key);

      if (!fieldKey) continue;

      const definition = allowed.get(fieldKey);

      if (!definition) {
        this.logger.warn(
          `public form: ${fieldKey} is not defined by task type ${taskTypeId} — dropped`,
        );

        continue;
      }

      const sanitized = this.sanitizeValue(value);

      if (
        sanitized === undefined ||
        sanitized === null ||
        sanitized === '' ||
        (Array.isArray(sanitized) && sanitized.length === 0)
      ) {
        continue;
      }

      // An asset answer must be one of the ids served to the visitor — never an arbitrary object.
      if (ASSET_CUSTOM_FIELD_TYPES.has(definition.field_type)) {
        const served = new Set(definition.options.map((o) => o.value));
        const ids: unknown =
          definition.field_type === 'asset' ? [sanitized] : sanitized;

        if (
          !Array.isArray(ids) ||
          !ids.every((id) => typeof id === 'string' && served.has(id))
        ) {
          this.logger.warn(
            `public form: ${fieldKey} has an asset outside the served list — dropped`,
          );

          continue;
        }

        // A dependent asset must hang off the parent answered in this same submission.
        if (definition.depends_on) {
          const parentAnswer =
            raw[`${TASK_TYPE_CF_PREFIX}${definition.depends_on.source_key}`];
          const linked = ids.every(
            (id) =>
              typeof parentAnswer === 'string' &&
              (
                definition.options.find((o) => o.value === id)?.parents ?? []
              ).includes(parentAnswer),
          );

          if (!linked) {
            this.logger.warn(
              `public form: ${fieldKey} is not linked to the chosen ${definition.depends_on.source_key} — dropped`,
            );

            continue;
          }
        }
      }

      if (++carried > MAX_TASK_TYPE_CF_ANSWERS) {
        throw new BadRequestException(
          'Too many task-type custom field answers',
        );
      }

      if (
        JSON.stringify(sanitized ?? null).length > MAX_TASK_TYPE_CF_VALUE_CHARS
      ) {
        throw new BadRequestException(
          `Task-type custom field answer is too large: ${fieldKey}`,
        );
      }

      clean[key] = sanitized;
      snapshot.push({
        field_key: key,
        label: definition.label,
        field_type: definition.field_type,
        sort_order: answerable.length + snapshot.length,
        is_task_type_custom_field: true,
      });
    }

    return snapshot;
  }

  /**
   * Narrows `depends_on` asset fields the way the in-app picker does (`attr_<via>` / `refby_<via>`):
   * each option lists the served parent options it links to, so the page filters by the visitor's
   * parent answer and the submit path can verify it. Fails closed — an unresolvable dependency
   * serves no options, never the unfiltered list.
   */
  private async attachAssetParents(
    organizationId: string,
    fields: PublicCustomFieldDefinition[],
    assetRows: Array<{ field_key: string; validation_rules: unknown }>,
  ): Promise<void> {
    for (const row of assetRows) {
      const cfg = (row.validation_rules as Record<string, unknown> | null)
        ?.asset as Record<string, unknown> | undefined;
      const dep = cfg?.depends_on as Record<string, unknown> | undefined;
      const sourceKey =
        typeof dep?.source_field_key === 'string' ? dep.source_field_key : '';
      const via =
        typeof dep?.via_attribute_key === 'string' ? dep.via_attribute_key : '';
      const field = fields.find((f) => f.key === row.field_key);

      // Both halves are needed, exactly as buildAssetQuery requires — otherwise it is no dependency.
      if (!field || !sourceKey || !via) continue;

      field.depends_on = { source_key: sourceKey };

      const parent = fields.find(
        (f) =>
          f.key === sourceKey && ASSET_CUSTOM_FIELD_TYPES.has(f.field_type),
      );
      const childIds = field.options.map((o) => o.value);
      const parentIds = (parent?.options ?? []).map((o) => o.value);
      const links = new Map<string, string[]>();

      if (
        childIds.length > 0 &&
        parentIds.length > 0 &&
        typeof cfg?.schema_id === 'string'
      ) {
        try {
          const { data: attrs, error: attrError } = await this.client
            .from('asset_object_type_attributes')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('schema_id', cfg.schema_id)
            .eq('field_key', via)
            .eq('data_type', 'object_reference');

          if (attrError) throw new Error(attrError.message);

          const attributeIds = ((attrs ?? []) as Array<{ id: string }>).map(
            (a) => a.id,
          );

          if (attributeIds.length > 0) {
            // child_to_parent: the option holds the link (it is the source); parent_to_child: the parent does.
            const childIsSource = dep?.direction !== 'parent_to_child';
            const { data: refs, error: refError } = await this.client
              .from('asset_object_references')
              .select('source_object_id, target_object_id')
              .eq('organization_id', organizationId)
              .in('attribute_id', attributeIds)
              .in(
                childIsSource ? 'source_object_id' : 'target_object_id',
                childIds,
              )
              .in(
                childIsSource ? 'target_object_id' : 'source_object_id',
                parentIds,
              );

            if (refError) throw new Error(refError.message);

            for (const ref of (refs ?? []) as Array<{
              source_object_id: string;
              target_object_id: string;
            }>) {
              const child = childIsSource
                ? ref.source_object_id
                : ref.target_object_id;
              const parentId = childIsSource
                ? ref.target_object_id
                : ref.source_object_id;

              links.set(child, [...(links.get(child) ?? []), parentId]);
            }
          }
        } catch (error) {
          this.logger.warn(
            `public form: could not resolve asset links for ${row.field_key}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        }
      }

      // An option linked to no served parent can never be picked, so it is not served at all.
      field.options = field.options
        .filter((o) => links.has(o.value))
        .map((o) => ({ ...o, parents: links.get(o.value) }));
    }
  }

  /** Custom-field keys this form's "Manage custom fields" dialog excluded. */
  private hiddenCustomFieldKeys(field: FieldRow | undefined): Set<string> {
    const raw = field?.validation_rules?.[HIDDEN_TASK_TYPE_CF_RULE];

    if (!Array.isArray(raw)) return new Set();

    return new Set(
      raw.filter(
        (k): k is string => typeof k === 'string' && SAFE_CF_KEY_RE.test(k),
      ),
    );
  }

  /** The task property a field populates, or '' when it is not mapped. */
  private taskFieldOf(field: FieldRow): string {
    const rules = field.validation_rules;

    return typeof rules?.task_field === 'string' ? rules.task_field : '';
  }

  /** Newest root tasks of the target space, labelled like the in-app parent_task picker (summary). */
  private async loadRootTaskOptions(
    organizationId: string,
    spaceId: string,
  ): Promise<Array<{ label: string; value: string }>> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id, summary')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .is('parent_task_id', null)
      .order('created_at', { ascending: false })
      .limit(PUBLIC_PARENT_TASK_LIMIT);

    if (error) throw new Error(error.message);

    return ((data ?? []) as Array<{ id: string; summary: string }>).map(
      (task) => ({ label: task.summary, value: task.id }),
    );
  }

  /**
   * Drops a parent_task answer that is not a root task of the target space the visitor may see — the
   * same rule the served options follow. Mutates `clean`.
   */
  private async dropUnresolvableParentTasks(
    form: FormRow,
    fields: FieldRow[],
    clean: Record<string, unknown>,
    viewerUserId: string | null,
  ): Promise<void> {
    const settings = form.settings ?? {};
    const integration = settings.task_integration as
      | Record<string, unknown>
      | undefined;

    // With task creation off the page serves the stored options and the answer goes nowhere.
    if (integration?.enabled !== true) return;

    const spaceId =
      typeof integration.target_space_id === 'string'
        ? integration.target_space_id
        : '';
    const visible =
      UUID_RE.test(spaceId) &&
      (settings.require_login !== true || !!viewerUserId);

    for (const field of fields) {
      if (
        this.taskFieldOf(field) !== 'parent_task' ||
        !(field.field_key in clean)
      )
        continue;

      const value = clean[field.field_key];
      let rootTask = false;

      if (visible && typeof value === 'string' && UUID_RE.test(value)) {
        const { data, error } = await this.client
          .from('tasks')
          .select('id')
          .eq('id', value)
          .eq('organization_id', form.organization_id)
          .eq('space_id', spaceId)
          .is('parent_task_id', null)
          .maybeSingle();

        rootTask = !error && !!data;
      }

      if (rootTask) continue;

      delete clean[field.field_key];
      this.logger.warn(
        `public form ${form.id}: dropped a parent_task answer that is not a visible root task`,
      );
    }
  }

  /**
   * Insert a submission for a form embedded on a published funnel. `organization_id` /
   * `space_id` come from the form row — never from the request body. `submitted_by` is
   * set ONLY for a verified assignee or required-login organization member (see
   * `resolvePublicForm`); it stays null for the anonymous path (including approval-only forms), so cross-tenant attribution and the
   * form's own anonymous-author fallback are preserved.
   */
  async submit(
    dto: PublicFormSubmitDto,
    ipAddress: string | undefined,
    userAgent: string | undefined,
    user?: RequestUser,
  ): Promise<{ id: string; created_at: string }> {
    this.assertPayloadSize(dto.data);

    const { form, fields, submitterUserId } = await this.resolvePublicForm(
      dto.funnel_id,
      dto.form_id,
      dto.page_id,
      user,
    );

    // Single-response enforcement for an identified assignee. The anonymous path cannot
    // do this (no identity); now that a verified assignee is stamped, honour the same
    // `allow_multiple_submissions === false` rule the authenticated fill path applies.
    if (submitterUserId) {
      await this.assertSingleSubmission(form, submitterUserId);
    }

    await this.assertRateLimits(form.id, form.organization_id, ipAddress);

    // Before any row is written: an unverified reCAPTCHA is a decorative widget that waves bots
    // through. `fields` (not `answerable`) because recaptcha carries no answer of its own.
    await this.assertRecaptcha(fields, dto.data ?? {}, ipAddress ?? null);

    const answerable = this.answerableFields(fields);
    const states = computeFieldStates(
      answerable as LogicField[],
      dto.data ?? {},
    );
    const clean = this.validateAndClean(answerable, dto.data ?? {}, states);

    // Same served lists as getDefinition, so a forged or stale dependent answer cannot land.
    const dropped = dropUnlinkedAssetAnswers(
      clean,
      await this.publicFormBuilder.resolveAssetOptions(
        {
          organization_id: form.organization_id,
          space_id: form.space_id ?? null,
          settings: form.settings,
        },
        this.servedFields(fields),
        submitterUserId,
      ),
    );

    if (dropped) {
      this.logger.warn(
        `public form ${form.id}: dropped ${dropped} unlinked dependent asset answer(s)`,
      );
    }

    await this.dropUnresolvableParentTasks(
      form,
      answerable,
      clean,
      submitterUserId,
    );

    // Task-type custom fields. These are NOT form fields, so `validateAndClean` above cannot see them
    // and would silently drop the answers. Everything is re-derived server-side from the submitted
    // task type — the client's claim about which fields exist is never trusted.
    // A Task Type input hidden by logic never reaches `clean`, so no custom fields are accepted.
    const cfSnapshot = await this.applyTaskTypeCustomFields(
      form,
      answerable,
      dto.data ?? {},
      clean,
    );

    const { data, error } = (await this.client
      .from(SUBMISSIONS_TABLE)
      .insert({
        form_id: form.id,
        organization_id: form.organization_id,
        space_id: form.space_id,
        submitted_by: submitterUserId,
        data: clean,

        // Synthetic entries describe the task-type custom fields that were answered. Every results
        // surface renders from the snapshot, so without them the answers are stored but invisible.
        field_snapshot: cfSnapshot.length ? [...fields, ...cfSnapshot] : fields,
        status: 'submitted',
        version: 1,
        ip_address: ipAddress ?? null,
        user_agent: userAgent ?? null,
        is_test: false,

        // Surface is known server-side here, never claimed by the visitor.
        ...surfaceTicketOutcome(form.settings, 'site_studio'),
      })
      // Wide enough for `dispatch()`, which reads space_id / organization_id / id / form_id and
      // returns *silently* if any is missing — selecting only `id, created_at` would make every
      // anonymous submission skip task creation, webhooks and notifications with no error at all.
      // The method's return type is unchanged; the extra columns are only for the dispatch call.
      .select(
        'id, created_at, form_id, organization_id, space_id, submitted_by, data, is_test, task_creation_status',
      )
      .single()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new BadRequestException('Failed to save submission');

    // Same post-submission pipeline the authenticated path runs (form-builder-submissions.service.ts:429):
    // task creation, webhooks, integrations and notifications. Without this an anonymous submission is
    // stored and nothing else happens — "Create task on submission" silently does nothing on a
    // published page. Fire-and-forget with its own internal try/catch, so a failing webhook can never
    // fail the visitor's submission. Only reached after a confirmed insert.
    void this.events.dispatch(data);

    const saved = data as unknown as { id: string; created_at: string };

    // Flip the assignee's pending assignment to completed (best-effort — never fails the
    // submission). No-op for the anonymous path since `submitterUserId` is null there.
    // Org/space come from the FORM row, never from the (optional-auth) user.
    if (submitterUserId) {
      void this.assignments
        .markCompletedOnSubmit(
          form.id,
          submitterUserId,
          saved.id,
          form.space_id,
          form.organization_id,
        )
        .catch(() => undefined);
    }

    this.logger.log(
      `${submitterUserId ? 'Authenticated' : 'Anonymous'} form submission ${saved.id} for form ${form.id} via funnel ${dto.funnel_id}`,
    );

    return { id: saved.id, created_at: saved.created_at };
  }

  /**
   * Reject a second submission by the same identified assignee when the form is configured
   * single-response (`settings.allow_multiple_submissions === false`). Mirrors the
   * authenticated fill path; only reachable once `submitterUserId` is known.
   */
  private async assertSingleSubmission(
    form: FormRow,
    submitterUserId: string,
  ): Promise<void> {
    const settings: Record<string, unknown> = form.settings ?? {};

    if (settings.allow_multiple_submissions !== false) return;

    const { count, error } = await this.client
      .from(SUBMISSIONS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('form_id', form.id)
      .eq('submitted_by', submitterUserId)
      .eq('status', 'submitted');

    if (error) throw new BadRequestException(error.message);

    if ((count ?? 0) > 0) {
      throw new BadRequestException('You have already submitted this form');
    }
  }

  // Access resolution

  /**
   * The single security gate shared by both endpoints:
   *
   * 1. the funnel exists and is published;
   * 2. a PUBLISHED page of that funnel actually embeds this exact form via a
   *    `formBuilderForm` element (otherwise the endpoint would be an open proxy
   *    to any form in any organization);
   * 3. the form is not soft-deleted and its status is `published`;
   * 4. audience gate: assignments require a signed-in active assignee, while
   *    `require_login` requires a signed-in active organization member; otherwise
   *    the caller is anonymous. Verified users are attributed as submitters;
   * 5. the form contains no field type unsupported/unsafe for anonymous filling.
   *
   * Returns `submitterUserId` = the signed-in user's id ONLY when they are a verified
   * assignee or organization member; `null` otherwise (anonymous, incl. approval-only forms).
   */
  private async resolvePublicForm(
    funnelId: string,
    formId: string,
    pageId?: string,
    user?: RequestUser,
  ): Promise<{
    form: FormRow;
    fields: FieldRow[];
    submitterUserId: string | null;
  }> {
    const funnel = await this.getPublishedFunnel(funnelId);

    await this.assertFormEmbeddedOnFunnel(funnelId, formId, pageId);

    const { data: formData, error: formError } = await this.client
      .from(FORMS_TABLE)
      .select(
        'id, organization_id, space_id, name, description, status, settings, is_deleted',
      )
      .eq('id', formId)
      .maybeSingle();

    if (formError) throw new BadRequestException(formError.message);
    if (!formData) throw new BadRequestException('Form not found');

    const form = formData as unknown as FormRow;

    if (form.is_deleted) throw new BadRequestException('Form not found');

    // Cross-tenant guard: the embedded form must belong to the funnel's org.
    if (form.organization_id !== funnel.organization_id) {
      throw new BadRequestException('Form not found');
    }

    if (form.status !== 'published') {
      throw new BadRequestException('This form is not accepting responses');
    }

    const settings: Record<string, unknown> = form.settings ?? {};

    // Reuse the standalone public-form audience ladder so embedded forms have the same
    // require_login, active-membership, assignment, and attribution semantics.
    await this.publicFormBuilder.assertTenancyLive(form as PublicAudienceForm);

    const { submitterUserId } = await this.publicFormBuilder.resolveAudience(
      form as PublicAudienceForm,
      user,
    );

    await this.assertNotClosed(form.id, settings);

    const fields = await this.loadFields(form.id);

    // `products` is servable only when the space has a working gateway — otherwise a buyer is shown
    // a price no checkout can take.
    const paymentConfigured = await this.hasUsablePaymentConfig(
      form.organization_id,
      form.space_id,
    );

    this.assertFieldsAreAnonymousSafe(fields, { paymentConfigured });

    return { form, fields, submitterUserId };
  }

  private async getPublishedFunnel(
    funnelId: string,
  ): Promise<{ id: string; organization_id: string }> {
    const { data, error } = await this.client
      .from(FUNNELS_TABLE)
      .select('id, organization_id, published')
      .eq('id', funnelId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new BadRequestException('Funnel not found');

    const funnel = data as unknown as {
      id: string;
      organization_id: string;
      published: boolean;
    };

    if (!funnel.published) {
      throw new BadRequestException('Funnel is not published');
    }

    return { id: funnel.id, organization_id: funnel.organization_id };
  }

  /**
   * Proves the form is genuinely embedded on the funnel. Without this the
   * endpoint would happily serve (and accept submissions for) any form UUID a
   * caller guessed, in any organization.
   */
  private async assertFormEmbeddedOnFunnel(
    funnelId: string,
    formId: string,
    pageId?: string,
  ): Promise<void> {
    let query = this.client
      .from(PAGES_TABLE)
      .select('id, content')
      .eq('funnel_id', funnelId)
      .eq('published', true);

    if (pageId) query = query.eq('id', pageId);

    const { data, error } = await query;

    if (error) throw new BadRequestException(error.message);

    const pages = (data ?? []) as Array<{ id: string; content: unknown }>;

    const embedded = pages.some((page) =>
      this.contentReferencesForm(page.content, formId),
    );

    if (!embedded) {
      throw new BadRequestException('Form is not available on this page');
    }
  }

  private contentReferencesForm(content: unknown, formId: string): boolean {
    if (!Array.isArray(content)) return false;

    for (const raw of content as EditorElementLike[]) {
      if (!raw || typeof raw !== 'object') continue;

      if (raw.type === ELEMENT_TYPE) {
        const inner = raw.content as { formId?: unknown } | undefined;

        if (inner && inner.formId === formId) return true;
      }

      if (Array.isArray(raw.content)) {
        if (this.contentReferencesForm(raw.content, formId)) return true;
      }
    }

    return false;
  }

  /** Honours the form's schedule window and response cap. */
  private async assertNotClosed(
    formId: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    const schedule = (settings.schedule ?? null) as {
      opens_at?: string;
      closes_at?: string;
    } | null;

    const now = Date.now();

    if (schedule?.opens_at) {
      const opensAt = Date.parse(schedule.opens_at);

      if (Number.isFinite(opensAt) && now < opensAt) {
        throw new BadRequestException('This form is not open yet');
      }
    }

    if (schedule?.closes_at) {
      const closesAt = Date.parse(schedule.closes_at);

      if (Number.isFinite(closesAt) && now > closesAt) {
        throw new BadRequestException('This form is closed');
      }
    }

    const maxResponses = Number(settings.max_responses);

    if (Number.isFinite(maxResponses) && maxResponses > 0) {
      const { count, error } = await this.client
        .from(SUBMISSIONS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('form_id', formId)
        .eq('status', 'submitted');

      if (error) throw new BadRequestException(error.message);

      if ((count ?? 0) >= maxResponses) {
        throw new BadRequestException(
          'This form has reached its response limit',
        );
      }
    }
  }

  private async loadFields(formId: string): Promise<FieldRow[]> {
    const { data, error } = await this.client
      .from(FIELDS_TABLE)
      .select('*')
      .eq('form_id', formId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as unknown as FieldRow[];
  }

  /**
   * Refuses the WHOLE form (not just the offending field) when it contains
   * anything the anonymous path cannot handle safely — so a visitor never
   * submits a partial response to a form that expects a signature, a payment or
   * a file.
   */
  private assertFieldsAreAnonymousSafe(
    fields: FieldRow[],
    ctx: PublicSafetyContext = {},
  ): void {
    const scanned = fields.filter(
      (f) =>
        // `hidden` was tolerated here before this path shared the standalone list, and must stay
        // tolerated or an existing embed containing one starts failing. It is server-owned: never
        // answerable (see answerableFields) and never served, so tolerating it grants nothing.
        f.field_type !== 'hidden' &&
        // Served with a server-resolved, space-scoped member list rather than a directory lookup —
        // the same narrow exposure PUBLIC_CUSTOM_FIELD_TYPES already makes for task-type fields.
        f.field_type !== 'user_select' &&
        // An unconfigured reCAPTCHA has no keys, so it can neither render nor be verified. Omit
        // that one field instead of refusing the whole form over a widget that does nothing.
        !(f.field_type === 'recaptcha' && !isRecaptchaConfigured(f)),
    );

    // Scans nested `layout` cells too, which a flat field loop cannot see.
    const unsafe = findPubliclyUnsafeTypes(scanned, ctx);

    if (unsafe.length === 0) return;

    // An unconnected gateway is fixable — say so instead of "remove these fields".
    if (isPaymentConfigOnlyBlocker(unsafe)) {
      throw new BadRequestException(
        'This form cannot be filled in anonymously until a payment gateway is connected',
      );
    }

    throw new BadRequestException(
      `This form cannot be filled in anonymously (contains "${unsafe.join('", "')}" fields)`,
    );
  }

  // Sanitization
  /**
   * Fields an anonymous visitor may see AND answer. Hidden and read-only fields
   * are excluded from BOTH the served definition and the accepted answer set,
   * so a crafted payload cannot write to them.
   */
  private answerableFields(fields: FieldRow[]): FieldRow[] {
    return fields.filter(
      (f) =>
        (PUBLIC_INPUT_TYPES.has(f.field_type) ||
          // Conditional in the shared list, but this path serves it from a space-scoped member
          // list, so its answer (a user id from that same list) is accepted too.
          f.field_type === 'user_select') &&
        f.is_hidden !== true &&
        f.read_only !== true,
    );
  }

  /**
   * Fields the visitor SEES. A superset of {@link answerableFields}: `products` and `recaptcha`
   * render but are never accepted as ordinary answers — payment and verification handle them.
   */
  private servedFields(fields: FieldRow[]): FieldRow[] {
    return fields.filter(
      (f) =>
        f.field_type !== 'hidden' &&
        !(f.field_type === 'recaptcha' && !isRecaptchaConfigured(f)) &&
        f.is_hidden !== true,
    );
  }

  private toPublicField(
    field: FieldRow,
    taskOptions?: TaskOptionCatalogue,
    assetOptions?: PublicAssetOptions,
    memberOptions?: Array<{ label: string; value: string }>,
    parentTaskSignIn = false,
  ): PublicFormFieldDefinition {
    const rules = sanitizePublicValidationRules(
      withAssetDependsOnRule(field.validation_rules, field, assetOptions),
      field.field_type,
    );

    return {
      field_key: field.field_key,
      field_type: field.field_type,
      label: field.label,
      placeholder: field.placeholder ?? null,
      help_text: field.help_text ?? null,
      required: field.required === true,
      // Live task choices win over the field's stored placeholders. Keyed off `task_field` rather than
      // `field_type`, because dropdown / radio / checkboxes / button_group can all carry the mapping.
      // An empty catalogue entry falls through to the stored options — never to an empty dropdown.
      // A products catalog and a layout grid are not `{label,value}` shaped — the generic reducer
      // would empty them. Assets are resolved server-side, so their stored options are empty.
      options: this.optionsFor(field, taskOptions, assetOptions, memberOptions),
      validation_rules:
        parentTaskSignIn && this.taskFieldOf(field) === 'parent_task'
          ? { ...rules, [PARENT_TASK_SIGN_IN_RULE]: true }
          : rules,
      sort_order: field.sort_order,
      // Served so the embed evaluates visibility; submit re-evaluates it server-side.
      conditional_logic: field.conditional_logic ?? null,
    };
  }

  /** Choice options are reduced to `{ label, value }` — nothing else survives. */
  private sanitizeOptions(options: unknown): unknown {
    if (!Array.isArray(options)) return null;

    return options
      .filter(
        (opt): opt is Record<string, unknown> =>
          typeof opt === 'object' && opt !== null,
      )
      .map((opt) => {
        const label = this.asScalarString(opt.label);
        const value = this.asScalarString(opt.value);

        return { label: label || value, value: value || label };
      })
      .filter((opt) => opt.value !== '');
  }

  /** True when the form's space has an active gateway with a usable secret. Fails closed. */
  private async hasUsablePaymentConfig(
    orgId: string,
    spaceId: string,
  ): Promise<boolean> {
    try {
      const config = await this.paymentConfig.getFillConfig({ orgId, spaceId });

      return config.enabled === true;
    } catch (error) {
      this.logger.warn(
        `payment config lookup failed for space ${spaceId}: ${String(error)}`,
      );

      return false;
    }
  }

  /** Verifies each configured reCAPTCHA with Google. Mirrors the standalone public-form path. */
  private async assertRecaptcha(
    fields: FieldRow[],
    data: Record<string, unknown>,
    ipAddress: string | null,
  ): Promise<void> {
    for (const field of fields) {
      if (field.field_type !== 'recaptcha') continue;
      if (!isRecaptchaConfigured(field)) continue;

      const rules = field.validation_rules ?? {};
      const minScore = Number(rules.recaptcha_min_score);

      const result = await this.recaptcha.verify(
        String(rules.recaptcha_secret_key),
        data[field.field_key],
        {
          remoteIp: ipAddress,
          version:
            typeof rules.recaptcha_version === 'string'
              ? rules.recaptcha_version
              : 'v2_checkbox',
          minScore: Number.isFinite(minScore) ? minScore : undefined,
        },
      );

      if (result.ok) continue;

      // Reason to the log, not to the visitor — a scripted caller learns nothing.
      this.logger.warn(
        `recaptcha rejected for field ${field.field_key}: ${result.reason ?? 'unknown'}`,
      );

      if (result.reason === 'missing-token') {
        throw new BadRequestException(
          'Please complete the reCAPTCHA challenge before submitting.',
        );
      }

      if (result.reason === 'verify-unavailable') {
        throw new BadRequestException(
          'Could not reach the reCAPTCHA service. Please try again in a moment.',
        );
      }

      throw new BadRequestException(
        'reCAPTCHA could not be verified — it may have expired. Please solve it again and resubmit.',
      );
    }
  }

  /** Per-type option shaping, mirroring the standalone public-form path. */
  private optionsFor(
    field: FieldRow,
    taskOptions?: TaskOptionCatalogue,
    assetOptions?: Map<string, Array<{ label: string; value: string }>>,
    memberOptions?: Array<{ label: string; value: string }>,
  ): unknown {
    const type = field.field_type;

    // Author-curated `custom` lists keep their own options; every other source resolves to the
    // space-scoped member list rather than exposing a directory lookup.
    if (type === 'user_select') {
      const source = field.validation_rules?.userSource;

      return source === 'custom'
        ? sanitizePublicOptions(field.options)
        : (memberOptions ?? []);
    }

    if (type === 'products') return sanitizeProductOptions(field.options);
    if (type === 'layout') return sanitizeLayoutOptions(field.options);

    if (type === 'asset' || type === 'asset_multi') {
      return assetOptions?.get(field.field_key) ?? [];
    }

    // Live task choices win over the field's stored placeholders. Keyed off `task_field` rather than
    // `field_type`, because dropdown / radio / checkboxes / button_group can all carry the mapping.
    // An empty catalogue entry falls through to the stored options — never to an empty dropdown.
    const taskField = this.taskFieldOf(field);
    const live = taskOptions?.get(taskField);

    // Parent tasks never fall back to the stored "Option 1 / Option 2" placeholders.
    if (taskField === 'parent_task' && live) return live;

    return sanitizePublicOptions(live?.length ? live : field.options);
  }

  // ── Submission validation ──────────────────────────────────────────────────

  private assertPayloadSize(data: Record<string, unknown>): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestException('Invalid submission payload');
    }

    const keys = Object.keys(data);

    if (keys.length > MAX_ANSWER_KEYS) {
      throw new BadRequestException('Too many answers in submission');
    }

    let serialized: string;

    try {
      serialized = JSON.stringify(data);
    } catch {
      throw new BadRequestException('Invalid submission payload');
    }

    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new BadRequestException('Submission payload too large');
    }
  }

  /**
   * Drops every key that is not an answerable field of this form, enforces
   * required answers, and strips HTML / `javascript:` from string values.
   */
  private validateAndClean(
    fields: FieldRow[],
    data: Record<string, unknown>,
    states: Record<string, FieldLogicState>,
  ): Record<string, unknown> {
    const clean: Record<string, unknown> = {};

    for (const field of fields) {
      const state = states[field.field_key];

      // Hidden by logic: dropped silently so a stale draft cannot 400 an anonymous visitor.
      if (state && !state.visible) continue;

      const raw = data[field.field_key];
      const value = this.sanitizeValue(raw, field.field_type);
      const isEmpty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);

      if ((state ? state.required : field.required === true) && isEmpty) {
        throw new BadRequestException(`Required field missing: ${field.label}`);
      }

      if (!isEmpty) clean[field.field_key] = value;
    }

    return clean;
  }

  private sanitizeValue(value: unknown, fieldType?: string): unknown {
    if (fieldType === 'multi_photo' && Array.isArray(value)) {
      return this.sanitizeMultiPhotoValue(value);
    }

    if (typeof value === 'string') return this.sanitizeString(value, fieldType);

    if (Array.isArray(value)) {
      const entries = value as unknown[];

      if (entries.length > MAX_ARRAY_LENGTH) {
        throw new BadRequestException('Too many values for one field');
      }

      return entries.map((entry) =>
        typeof entry === 'string'
          ? this.sanitizeString(entry, fieldType)
          : entry,
      );
    }

    if (typeof value === 'object' && value !== null) {
      // Composite answers (address / full_name) — one level of flat key/values.
      const out: Record<string, unknown> = {};

      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (typeof entry === 'object' && entry !== null) continue;
        out[key] =
          typeof entry === 'string'
            ? this.sanitizeString(entry, fieldType)
            : entry;
      }

      return out;
    }

    return value;
  }

  /** Photos are data URIs bounded on combined length, so 200 entries cannot add up to ~60 MB. */
  private sanitizeMultiPhotoValue(value: unknown[]): string[] {
    if (value.length > MAX_ARRAY_LENGTH) {
      throw new BadRequestException('Too many values for one field');
    }

    const photos = value.filter(
      (entry): entry is string => typeof entry === 'string',
    );
    const total = photos.reduce((sum, photo) => sum + photo.length, 0);

    if (total > MAX_MULTI_PHOTO_TOTAL_BYTES) {
      throw new BadRequestException(
        'Photos exceed the maximum allowed total size',
      );
    }

    return photos;
  }

  private sanitizeString(value: string, fieldType?: string): string {
    const limit = DATA_URI_STRING_TYPES.has(fieldType ?? '')
      ? MAX_DATA_URI_STRING_LENGTH
      : MAX_STRING_LENGTH;

    if (value.length > limit) {
      throw new BadRequestException(
        `Answer too long (max ${limit.toLocaleString('en-US')} characters)`,
      );
    }

    return value.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '');
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

  /**
   * Enforces the two anonymous submission budgets: per IP over a short window,
   * and per form over an hour.
   *
   * Both counts are deliberately scoped:
   *
   * - **By organization.** Without it the IP budget is a single global counter
   *   shared by every tenant, so anonymous traffic to one org's form consumes
   *   the allowance of every other org's forms — visitors behind a common NAT,
   *   CDN or corporate proxy would start rejecting each other across tenant
   *   boundaries. Scoping keeps one tenant's traffic from denying service to
   *   another's.
   * - **By `status` / `is_test`.** Abandoned payment drafts (inserted with a
   *   null submitter) and test previews are not real submissions and must not
   *   consume a real visitor's budget. A draft that never reaches the Stripe
   *   `checkout.session.expired` handler would otherwise inflate the counter
   *   for its entire window.
   */
  private async assertRateLimits(
    formId: string,
    organizationId: string,
    ipAddress: string | undefined,
  ): Promise<void> {
    if (ipAddress) {
      const { count, error } = await this.client
        .from(SUBMISSIONS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('ip_address', ipAddress)
        .eq('organization_id', organizationId)
        .eq('status', 'submitted')
        .eq('is_test', false)
        .is('submitted_by', null)
        .gte('created_at', new Date(Date.now() - IP_WINDOW_MS).toISOString());

      if (error) throw new BadRequestException(error.message);

      if ((count ?? 0) >= IP_MAX_SUBMISSIONS) {
        throw new BadRequestException(
          'Too many submissions. Please try again later.',
        );
      }
    }

    const { count: formCount, error: formError } = await this.client
      .from(SUBMISSIONS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('form_id', formId)
      .eq('status', 'submitted')
      .eq('is_test', false)
      .is('submitted_by', null)
      .gte('created_at', new Date(Date.now() - FORM_WINDOW_MS).toISOString());

    if (formError) throw new BadRequestException(formError.message);

    if ((formCount ?? 0) >= FORM_MAX_SUBMISSIONS) {
      throw new BadRequestException(
        'Too many submissions. Please try again later.',
      );
    }
  }

  /** Coerces only primitive values to a string; objects/arrays become ''. */
  private asScalarString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    return '';
  }

  private asOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }
}
