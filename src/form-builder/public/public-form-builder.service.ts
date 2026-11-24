import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { FormBuilderSubmissionEventsService } from '../form-builder-submission-events.service';
import { FormBuilderAssignmentsService } from '../form-builder-assignments.service';
import { FormBuilderUploadsService } from '../form-builder-uploads.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PublicFormBuilderSubmitDto } from './dto/public-form-builder.dto';
import { FormBuilderPaymentConfigService } from '../form-builder-payment-config.service';
import { FormBuilderPaymentsService } from '../form-builder-payments.service';
import type { PublicFormPaymentSessionDto } from './dto/public-form-payment.dto';
import { RecaptchaVerifierService } from './recaptcha-verifier.service';
import { computeFieldStates } from '../logic/condition-evaluator';
import type { FieldLogicState, LogicField } from '../logic/condition-evaluator';
import {
  findPubliclyUnsafeTypes,
  isRecaptchaConfigured,
  PUBLIC_INPUT_TYPES,
  sanitizeLayoutOptions,
  sanitizeOptions,
  sanitizeProductOptions,
  sanitizeValidationRules,
} from './public-form-safety.util';
import { ATTRIBUTE_FIELD_KEY_PATTERN } from '../../assets-objects/filtering/asset-filter-fields';
import {
  applyInheritedAssetConfigs,
  loadInheritableAssetCustomFields,
} from '../asset-config-inheritance';
import {
  dropUnlinkedAssetAnswers,
  loadAssetParentIds,
  readAssetDependency,
  withAssetDependsOnRule,
} from './public-asset-dependency';
import type {
  PublicAssetOption,
  PublicAssetOptions,
} from './public-asset-dependency';

const FORMS_TABLE = 'form_builder';
const FIELDS_TABLE = 'form_builder_fields';
const SUBMISSIONS_TABLE = 'form_builder_submissions';
const ASSIGNMENTS_TABLE = 'form_builder_assignments';

/**
 * Slug format. ASCII-only by design: it excludes homoglyphs (a Cyrillic 'а' in
 * an otherwise-Latin word), RTL overrides and zero-width joiners, any of which
 * could be used to mint a slug that renders identically to another tenant's.
 * Mirrors the CHECK constraint on `form_builder.public_slug`.
 */
const PUBLIC_SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;

/**
 * Cap on asset options embedded in a public form definition. Anonymous callers
 * get a bounded list, not the whole inventory.
 */
const PUBLIC_ASSET_OPTION_LIMIT = 100;

/** Payload ceilings for an unauthenticated writer. */
const MAX_ANSWER_KEYS = 200;
const MAX_STRING_LENGTH = 10_000;
const MAX_ARRAY_LENGTH = 200;

/**
 * Answer-length ceiling for the single-capture data-URI types (camera,
 * signature). A 640px-wide JPEG at quality 0.75 — the fill component's fixed
 * capture size — typically base64-encodes to 40-150 KB; a signature PNG is
 * usually smaller. 300 KB leaves headroom over the worst realistic capture
 * while staying far under the 10 MB body-parser limit (main.ts) once the rest
 * of the submission is accounted for.
 */
const MAX_DATA_URI_STRING_LENGTH = 300_000;
const DATA_URI_STRING_TYPES = new Set(['camera', 'signature']);

/**
 * multi_photo's TOTAL budget across the whole array, not per entry —
 * MAX_ARRAY_LENGTH (200) × a per-entry data-URI cap could approach 60 MB and
 * blow past the 10 MB body-parser limit before this check ever runs.
 */
const MAX_MULTI_PHOTO_TOTAL_BYTES = 2_000_000;

/** The only field types an anonymous visitor may upload a file for. */
export const PUBLIC_UPLOAD_FIELD_TYPES = new Set(['file_upload', 'audio']);

/**
 * Server-side MIME allowlist for anonymous uploads, independent of a field's own
 * `acceptedTypes` config — an unauthenticated endpoint must not accept an
 * unbounded file-type set even when the author's own field config says '*'.
 * `audio` is restricted to what MediaRecorder actually produces
 * (`FormBuilderAudioInput.tsx`); `file_upload` covers common document/image
 * types an anonymous submitter would realistically attach.
 */
export const PUBLIC_UPLOAD_MIME_TYPES: Record<string, Set<string>> = {
  audio: new Set([
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/x-m4a',
  ]),
  file_upload: new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
};

export interface PublicAudienceForm {
  id: string;
  organization_id: string;
  space_id: string;
  settings: Record<string, unknown> | null;
}

interface FormRow extends PublicAudienceForm {
  name: string;
  description: string | null;
  status: string;
  is_deleted: boolean;
  is_public: boolean;
  public_slug: string | null;
}

interface FieldRow {
  id: string;
  field_key: string;
  field_type: string;
  label: string | null;
  placeholder: string | null;
  help_text: string | null;
  required: boolean | null;
  options: unknown;
  validation_rules: unknown;
  page_index: number | null;
  section: string | null;
  column_span: number | null;
  sort_order: number | null;
  conditional_logic: unknown;
  calculation: unknown;
  default_value: unknown;
}

/** How the caller relates to this form — drives attribution and the UI gate. */
type AudienceKind = 'anonymous' | 'assignee' | 'org_member';

interface ResolvedPublicForm {
  form: FormRow;
  fields: FieldRow[];
  /** Non-null only for a verified assignee or a verified org member. */
  submitterUserId: string | null;
  audience: AudienceKind;
}

/**
 * Serves a form at its standalone public URL (`/forms/{slug}`).
 *
 * Distinct from `site-studio/public-form`, which serves a form *embedded on a
 * published funnel page* and proves intent by finding the form referenced in
 * that funnel's published content. Here the proof of intent is explicit and
 * lives on the form itself: `is_public = true AND status = 'published'`.
 *
 * Every negative outcome except the assignment gate returns the SAME
 * `404 Form not found`. Distinguishable messages would turn a guessable URL into
 * an oracle for which slugs exist, which are published, which are scheduled and
 * how full they are. The assignment gate is the one deliberate exception,
 * because a real assignee has to be told to sign in.
 */
@Injectable()
export class PublicFormBuilderService {
  private readonly logger = new Logger(PublicFormBuilderService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModules: OrganizationModulesService,
    private readonly events: FormBuilderSubmissionEventsService,
    private readonly assignments: FormBuilderAssignmentsService,
    private readonly paymentConfig: FormBuilderPaymentConfigService,
    private readonly payments: FormBuilderPaymentsService,
    private readonly recaptcha: RecaptchaVerifierService,
    private readonly uploads: FormBuilderUploadsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Verifies each configured reCAPTCHA with Google before any row is written. */
  private async assertRecaptcha(
    fields: FieldRow[],
    data: Record<string, unknown>,
    ipAddress: string | null,
  ): Promise<void> {
    for (const field of fields) {
      if (field.field_type !== 'recaptcha') continue;
      if (!isRecaptchaConfigured(field)) continue;

      const rules = (field.validation_rules ?? {}) as Record<string, unknown>;
      const version = String(rules.recaptcha_version ?? 'v2_checkbox');
      const minScore = Number(rules.recaptcha_min_score);

      const result = await this.recaptcha.verify(
        String(rules.recaptcha_secret_key),
        data[field.field_key],
        {
          remoteIp: ipAddress,
          version,
          minScore: Number.isFinite(minScore) ? minScore : undefined,
        },
      );

      if (result.ok) continue;

      // Reason to the log, not to the visitor — a scripted caller learns nothing.
      this.logger.warn(
        `recaptcha rejected for field ${field.field_key}: ${result.reason ?? 'unknown'}${
          result.errorCodes?.length ? ` (${result.errorCodes.join(', ')})` : ''
        }${typeof result.score === 'number' ? ` score=${result.score}` : ''}`,
      );

      // Distinct messages: "you skipped it" and "it was refused" need different actions, and a
      // single generic string sent people round the loop with a token that could never pass.
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

      // Tokens are single-use and expire in about two minutes, so the usual cause of a rejection on
      // a retry is a stale token. Say so, since the fix is to solve it again.
      throw new BadRequestException(
        'reCAPTCHA could not be verified — it may have expired. Please solve it again and resubmit.',
      );
    }
  }

  /** Rejects a free submit carrying a real order; selecting nothing is fine. */
  private assertNoUnpaidOrder(
    fields: FieldRow[],
    data: Record<string, unknown>,
  ): void {
    for (const field of fields) {
      if (field.field_type !== 'products') continue;

      const order = data[field.field_key] as
        | { items?: unknown; subtotal?: unknown }
        | undefined;

      if (!order || typeof order !== 'object') continue;

      const hasItems = Array.isArray(order.items) && order.items.length > 0;
      const hasTotal = typeof order.subtotal === 'number' && order.subtotal > 0;

      if (hasItems || hasTotal) {
        throw new BadRequestException(
          'This form requires payment. Complete checkout to submit it.',
        );
      }
    }
  }

  /** Can this space actually take money? Same rule as the fill page. Fails closed. */
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

  /** The single denial used for every "you may not have this" outcome. */
  private notFound(): never {
    throw new NotFoundException('Form not found');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async getDefinition(slug: string, user?: RequestUser) {
    const { form, fields, audience, submitterUserId } =
      await this.resolvePublicForm(slug, user);
    const settings = form.settings ?? {};
    const styles = (settings.styles as Record<string, unknown>) ?? {};

    // Only a viewer the audience gate verified may narrow "assigned only" fields.
    const assetOptions = await this.resolveAssetOptions(
      form,
      fields,
      submitterUserId,
    );

    return {
      form: {
        name: form.name,
        description: form.description,
        submit_label: (settings.submit_button_label as string) ?? null,
        success_message: (settings.success_message as string) ?? null,
        layout: (settings.layout as string) ?? 'classic',
        multi_page: settings.multi_page === true,
        show_progress_bar: settings.show_progress_bar === true,
        question_numbering: settings.question_numbering === true,
        content_alignment: (settings.content_alignment as string) ?? null,

        // Classic-layout presentation. These live at the TOP level of settings,
        // not under `styles`, so they have to be listed explicitly — a published
        // form would otherwise silently lose its row treatment.
        classic_row_style: (settings.classic_row_style as string) ?? 'bordered',
        classic_show_answered_indicator:
          settings.classic_show_answered_indicator !== false,

        // Card-layout presentation — same top-level trap as the classic keys above. Without these
        // a card-layout form reached the published page with `layout: 'card'` but no grouping
        // options, so it rendered as a stack of single-question cards regardless of what the
        // author configured. Normalized here exactly as FormBuilderFillView does for the preview,
        // so both renderers agree on the defaults for a form that predates these settings.
        card_fields_per_card: Number(settings.card_fields_per_card) || 1,
        card_cards_per_view: Number(settings.card_cards_per_view) || 1,
        card_welcome: settings.card_welcome !== false,
        card_stepper: settings.card_stepper === true,
        card_orientation:
          settings.card_orientation === 'vertical' ? 'vertical' : 'horizontal',

        // Styling travels with the definition so the published page looks like
        // the builder preview. `custom_css` is sanitized client-side before it is
        // injected — DOMPurify no-ops under Node, so sanitizing here would
        // silently degrade to a regex pass.
        styles,
      },
      // `redirect_url` is deliberately NOT exposed. It is assigned to
      // window.location.href, and this endpoint is reachable by anyone.
      fields: fields.map((field) => this.toPublicField(field, assetOptions)),
      audience,
    };
  }

  // Slug-addressed: the public page holds no ids, and the space-scoped payment routes skip the
  // public gate ladder entirely. Resolving from the slug first applies every gate.

  /** Non-secret gateway config (enabled flag + publishable key) for a published form's fill page. */
  async getPaymentConfig(slug: string, user?: RequestUser) {
    const { form } = await this.resolvePublicForm(slug, user);

    return this.payments.getFillConfig(form.space_id, form.id);
  }

  /** Opens an anonymous Stripe Checkout session for a published form's `products` field. */
  async createPaymentSession(
    slug: string,
    dto: PublicFormPaymentSessionDto,
    user?: RequestUser,
    origin?: string,
    ipAddress: string | null = null,
  ) {
    const { form, fields } = await this.resolvePublicForm(slug, user);

    this.assertPayloadSize(dto.submission_data);

    // Checkout writes a draft submission, so it is a second public write path and must clear the
    // same bot check as `submit()` — otherwise a form could be spammed through the payment door.
    await this.assertRecaptcha(fields, dto.submission_data ?? {}, ipAddress);

    // `is_test` is absent from the public DTO by design, so this always takes the real path: the
    // published-status and response-limit gates in the submissions service stay in force.
    return this.payments.createCheckoutSession(
      form.space_id,
      form.id,
      { ...dto, is_test: false },
      origin,
    );
  }

  /** Payment/order state for a session the caller already holds. */
  async getPaymentStatus(slug: string, sessionId: string, user?: RequestUser) {
    const { form } = await this.resolvePublicForm(slug, user);

    return this.payments.getStatus(form.space_id, form.id, sessionId);
  }

  /**
   * Anonymous file upload for a `file_upload`/`audio` field on a published
   * form. Runs the same closed/response-cap gate `submit()` does — an upload
   * against a form that can no longer accept answers would just waste storage
   * — then writes through the SAME storage path an authenticated submission
   * uses (`FormBuilderUploadsService`).
   */
  async uploadFile(
    slug: string,
    fieldKey: string,
    file: Express.Multer.File,
    user?: RequestUser,
  ): Promise<{ publicUrl: string; path: string }> {
    const { form, fields } = await this.resolvePublicForm(slug, user);

    await this.assertNotClosed(form);

    // Never trust the caller's claim about which field this is for — resolve
    // it from the form's OWN field list and re-check its type server-side.
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

  async submit(
    slug: string,
    dto: PublicFormBuilderSubmitDto,
    ipAddress: string | undefined,
    userAgent: string | undefined,
    user?: RequestUser,
  ): Promise<{ id: string; created_at: string }> {
    // Honeypot: hidden from humans, filled by bots. Answer 201 so a bot learns
    // nothing from the response, but write nothing.
    if (dto.hp && dto.hp.trim() !== '') {
      this.logger.debug(`honeypot tripped for slug ${slug}`);

      return {
        id: '00000000-0000-0000-0000-000000000000',
        created_at: new Date().toISOString(),
      };
    }

    this.assertPayloadSize(dto.data);

    const { form, fields, submitterUserId } = await this.resolvePublicForm(
      slug,
      user,
    );

    await this.assertNotClosed(form);

    if (submitterUserId) {
      await this.assertSingleSubmission(form, submitterUserId);
    }

    await this.assertRateLimits(form, ipAddress);

    // A silent drop would record a submission for goods nobody paid for.
    this.assertNoUnpaidOrder(fields, dto.data ?? {});
    await this.assertRecaptcha(fields, dto.data ?? {}, ipAddress ?? null);

    const answerable = fields.filter((f) =>
      PUBLIC_INPUT_TYPES.has(f.field_type),
    );

    // Over every served field, so a hidden layout parent hides its cells too.
    const states = computeFieldStates(fields as LogicField[], dto.data ?? {});
    const clean = this.validateAndClean(answerable, dto.data ?? {}, states);

    // Same served lists as getDefinition, so a forged or stale dependent answer cannot land.
    const dropped = dropUnlinkedAssetAnswers(
      clean,
      await this.resolveAssetOptions(form, fields, submitterUserId),
    );

    if (dropped) {
      this.logger.warn(
        `public submission for form ${form.id}: dropped ${dropped} unlinked dependent asset answer(s)`,
      );
    }

    const { data, error } = (await this.client
      .from(SUBMISSIONS_TABLE)
      .insert({
        form_id: form.id,
        // From the FORM row, never the request.
        organization_id: form.organization_id,
        space_id: form.space_id,
        submitted_by: submitterUserId,
        data: clean,
        // Snapshot the sanitized shape the visitor actually saw — not the raw
        // rows, which carry unfiltered validation_rules (gateway config, etc.).
        // Asset options are left unresolved here on purpose: nothing reads them
        // back (response surfaces resolve asset names live by id), so re-running
        // the lookup would only add latency to the submit path.
        field_snapshot: fields.map((f) => this.toPublicField(f)),
        status: 'submitted',
        version: 1,
        ip_address: ipAddress ?? null,
        user_agent: userAgent ?? null,
        is_test: false,
      })
      // Wide enough for dispatch(), which reads space_id / organization_id / id /
      // form_id and returns SILENTLY if any is missing — a narrow select here
      // would make every public submission skip approvals, task creation,
      // webhooks and notifications with no error at all.
      .select(
        'id, created_at, form_id, organization_id, space_id, submitted_by, data, is_test',
      )
      .single()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      this.logger.error(
        `public submission insert failed for form ${form.id}: ${error?.message ?? 'no row'}`,
      );

      throw new BadRequestException('Could not save your response');
    }

    // Same post-submission pipeline as an in-app fill: approvals, webhooks,
    // integrations, task creation, automations. Fire-and-forget with its own
    // internal error handling.
    void this.events.dispatch(data);

    if (submitterUserId) {
      void this.assignments
        .markCompletedOnSubmit(
          form.id,
          submitterUserId,
          data.id as string,
          form.space_id,
          form.organization_id,
        )
        .catch(() => undefined);
    }

    this.logger.log(
      `${submitterUserId ? 'Identified' : 'Anonymous'} public submission ${String(data.id)} for form ${form.id}`,
    );

    return {
      id: data.id as string,
      created_at: data.created_at as string,
    };
  }

  // ── The gate ───────────────────────────────────────────────────────────────

  /**
   * Resolves a slug to a servable form, or throws.
   *
   * Order matters: cheap format rejection before any query (the slug is
   * interpolated into a PostgREST filter), then existence and publish state,
   * then tenancy liveness, then licensing, and only then the audience gate.
   */
  private async resolvePublicForm(
    slug: string,
    user?: RequestUser,
  ): Promise<ResolvedPublicForm> {
    if (!PUBLIC_SLUG_RE.test(slug)) this.notFound();

    const { data: formData, error } = await this.client
      .from(FORMS_TABLE)
      .select(
        'id, organization_id, space_id, name, description, status, settings, is_deleted, is_public, public_slug',
      )
      .eq('public_slug', slug)
      .maybeSingle();

    // Never surface the driver message — it leaks column and constraint names.
    if (error) {
      this.logger.error(
        `public form lookup failed for ${slug}: ${error.message}`,
      );
      this.notFound();
    }

    const form = formData as FormRow | null;

    if (!form || form.is_deleted) this.notFound();

    // Two independent conditions: the owner minted a link AND the form is live.
    // Unpublishing closes the link without surrendering the slug.
    if (!form.is_public || form.status !== 'published') this.notFound();

    await this.assertTenancyLive(form);

    // Licensing, resolved from the FORM's org. Fails CLOSED: a licensing outage
    // must never un-gate a paid module on a public URL.
    const moduleEnabled = await this.orgModules.isEnabled(
      form.organization_id,
      'form_builder',
    );

    if (!moduleEnabled) this.notFound();

    const fields = await this.loadFields(form.id);

    // Per request, so revoking Stripe closes the field immediately. Only queried when needed.
    const paymentConfigured = fields.some((f) => f.field_type === 'products')
      ? await this.hasUsablePaymentConfig(form.organization_id, form.space_id)
      : false;

    const unsafe = findPubliclyUnsafeTypes(fields, { paymentConfigured });

    if (unsafe.length) {
      this.logger.warn(
        `form ${form.id} is public but contains non-public field types: ${unsafe.join(', ')}`,
      );
      this.notFound();
    }

    const { submitterUserId, audience } = await this.resolveAudience(
      form,
      user,
    );

    return { form, fields, submitterUserId, audience };
  }

  /**
   * The audience ladder.
   *
   * 1. Form has assignees  -> caller must be a signed-in, active, still-a-member
   *    assignee. This is the case the 401/403 distinction exists for.
   * 2. `require_login`     -> caller must be a signed-in member of the form's org.
   * 3. Otherwise           -> anonymous.
   */
  async resolveAudience(
    form: PublicAudienceForm,
    user?: RequestUser,
  ): Promise<{ submitterUserId: string | null; audience: AudienceKind }> {
    const assigneeIds = await this.loadAssigneeIds(form.id);

    if (assigneeIds.length) {
      if (!user?.userId) {
        throw new UnauthorizedException('This form requires you to sign in');
      }

      if (user.isActive === false) {
        throw new ForbiddenException('Your account is not active');
      }

      if (!assigneeIds.includes(user.userId)) {
        throw new ForbiddenException('You are not assigned to this form');
      }

      // An assignment row outlives the assignee's space membership (it is only
      // FK-cascaded on user DELETE), so someone offboarded from the space would
      // otherwise keep a working link. Mirrors how approvers are intersected
      // with active space members before they are notified.
      if (!(await this.isActiveSpaceMember(form.space_id, user.userId))) {
        throw new ForbiddenException('You are not assigned to this form');
      }

      return { submitterUserId: user.userId, audience: 'assignee' };
    }

    const settings = form.settings ?? {};

    if (settings.require_login === true) {
      if (!user?.userId) {
        throw new UnauthorizedException('This form requires you to sign in');
      }

      if (user.isActive === false) {
        throw new ForbiddenException('Your account is not active');
      }

      if (!(await this.isOrgMember(form.organization_id, user.userId))) {
        throw new ForbiddenException(
          'This form is only available to members of the organization that published it',
        );
      }

      return { submitterUserId: user.userId, audience: 'org_member' };
    }

    // Anonymous. An incidentally signed-in caller is NOT attributed: they may be
    // from another tenant entirely, and `submitted_by` is a tenant-scoped FK.
    return { submitterUserId: null, audience: 'anonymous' };
  }

  /** Rejects forms whose owning space or organization is no longer live. */
  async assertTenancyLive(form: PublicAudienceForm): Promise<void> {
    if (!form.space_id) throw new NotFoundException('Form not found');

    const [{ data: space }, { data: org }] = await Promise.all([
      this.client
        .from('spaces')
        .select('is_active, is_archived')
        .eq('id', form.space_id)
        .maybeSingle(),
      this.client
        .from('organizations')
        .select('is_active')
        .eq('id', form.organization_id)
        .maybeSingle(),
    ]);

    const spaceRow = space as {
      is_active: boolean | null;
      is_archived: boolean | null;
    } | null;
    const orgRow = org as { is_active: boolean | null } | null;

    if (
      !spaceRow ||
      spaceRow.is_active === false ||
      spaceRow.is_archived === true ||
      !orgRow ||
      orgRow.is_active === false
    ) {
      throw new NotFoundException('Form not found');
    }
  }

  /**
   * Assignee ids for a form.
   *
   * Counts ROWS, not non-null user ids, when deciding whether the form is gated.
   * `assign()` always expands roles to per-user rows, so a role-only row is not
   * reachable through the API today — but RLS permits a direct insert, and
   * treating "rows exist but no user ids" as ungated would silently serve an
   * assigned form to the whole internet. Fail closed instead.
   */
  private async loadAssigneeIds(formId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from(ASSIGNMENTS_TABLE)
      .select('assignee_user_id')
      .eq('form_id', formId);

    if (error) {
      this.logger.error(
        `assignment lookup failed for form ${formId}: ${error.message}`,
      );

      // Fail closed: an unreadable assignment table must not open a gated form.
      throw new ForbiddenException('This form is not available right now');
    }

    const rows = (data ?? []) as Array<{ assignee_user_id: string | null }>;
    const ids = rows
      .map((r) => r.assignee_user_id)
      .filter((id): id is string => !!id);

    if (rows.length && !ids.length) {
      this.logger.warn(
        `form ${formId} has assignment rows with no user ids — treating as gated`,
      );

      // Gated, but nobody can satisfy it. Correct: better closed than open.
      return ['__unsatisfiable__'];
    }

    return ids;
  }

  private async isActiveSpaceMember(
    spaceId: string,
    userId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('space_members')
      .select('user_id')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('member_type', 'user')
      .maybeSingle();

    if (error) {
      this.logger.error(`space membership check failed: ${error.message}`);

      return false;
    }

    return !!data;
  }

  private async isOrgMember(
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      this.logger.error(`org membership check failed: ${error.message}`);

      return false;
    }

    return !!data;
  }

  /**
   * A form must not keep collecting into a space that has been archived or an
   * organization that has been deactivated. Neither check exists on the funnel
   * path, which is a gap there too.
   */
  async loadFields(formId: string): Promise<FieldRow[]> {
    const { data, error } = await this.client
      .from(FIELDS_TABLE)
      .select(
        'id, field_key, field_type, label, placeholder, help_text, required, options, validation_rules, page_index, section, column_span, sort_order, conditional_logic, calculation, default_value',
      )
      .eq('form_id', formId)
      .order('sort_order', { ascending: true });

    if (error) {
      this.logger.error(
        `field load failed for form ${formId}: ${error.message}`,
      );
      this.notFound();
    }

    return (data ?? []) as FieldRow[];
  }

  /**
   * Resolves `asset` fields to a flat option list for the anonymous page.
   *
   * An anonymous visitor cannot call the asset endpoints (they require space
   * membership), so the picker would always be empty. Instead we resolve the
   * options here, server-side, strictly within what the field was configured to
   * expose — same shape as a dropdown's options, same as the custom user list.
   *
   * `assigned_only` narrows to the viewer's own assets when the audience gate
   * verified one (`viewerUserId`). Otherwise it FAILS CLOSED: serving the
   * unfiltered list would expose every asset the author explicitly meant to
   * restrict to one person. An empty list is the safe read of that intent.
   *
   * `depends_on` narrows on the page: each option lists the served parent options
   * it is linked to (`parent_ids`) and the field serves its parent's key. An
   * unresolvable link serves no options, never the unfiltered list.
   */
  // Public so the Site Studio embed path can reuse it — same bounded, server-resolved option list.
  // Takes only the three columns it reads, so either stack's row shape satisfies it.
  async resolveAssetOptions(
    form: {
      organization_id: string;
      space_id: string | null;

      // Only with settings can a mapped asset custom field supply the config (ticket integration).
      settings?: Record<string, unknown> | null;
    },
    fields: Array<{
      field_key: string;
      field_type: string;
      validation_rules: unknown;
    }>,
    viewerUserId?: string | null,
    // Off for task-type custom fields, which narrow through attachAssetParents instead.
    { narrowDependents = true }: { narrowDependents?: boolean } = {},
  ): Promise<PublicAssetOptions> {
    const resolved: PublicAssetOptions = new Map();

    const assetFields = fields.filter(
      (f) => f.field_type === 'asset' || f.field_type === 'asset_multi',
    );

    if (!assetFields.length) return resolved;

    const integration = form.settings?.task_integration as
      | Record<string, unknown>
      | undefined;
    const integrationEnabled = integration?.enabled === true;
    const targetSpaceId =
      typeof integration?.target_space_id === 'string'
        ? integration.target_space_id
        : null;
    const customFields = await loadInheritableAssetCustomFields(
      this.client,
      form.organization_id,
      targetSpaceId,
      assetFields,
      integrationEnabled,
    );

    // Fail closed: without the authoritative config, a mapped field's own scope may be too broad.
    if (!customFields) {
      this.logger.error(
        `public asset custom field lookup failed for org ${form.organization_id}`,
      );
      for (const field of assetFields) resolved.set(field.field_key, []);

      return resolved;
    }

    const effectiveFields = applyInheritedAssetConfigs(assetFields, {
      customFields,
      integrationEnabled,
      targetSpaceId,
      lookupFields: fields,
    });

    for (const field of effectiveFields) {
      const cfg = (field.validation_rules as Record<string, unknown> | null)
        ?.asset as Record<string, unknown> | undefined;

      const schemaId = typeof cfg?.schema_id === 'string' ? cfg.schema_id : '';

      const typeIds = Array.isArray(cfg?.object_type_ids)
        ? (cfg.object_type_ids as unknown[]).filter(
            (v): v is string => typeof v === 'string' && v.length > 0,
          )
        : [];

      const spaceId =
        typeof cfg?.space_id === 'string' && cfg.space_id
          ? cfg.space_id
          : form.space_id;

      if (!schemaId || !typeIds.length || !spaceId) {
        resolved.set(field.field_key, []);
        continue;
      }

      const assigneeKey =
        typeof cfg?.assignee_attribute_key === 'string'
          ? cfg.assignee_attribute_key
          : '';

      // See the note above: with no verified viewer or no usable key this filter
      // cannot be satisfied, and it must not be dropped.
      if (
        cfg?.assigned_only === true &&
        (!viewerUserId || !ATTRIBUTE_FIELD_KEY_PATTERN.test(assigneeKey))
      ) {
        resolved.set(field.field_key, []);
        continue;
      }

      let effectiveTypeIds = typeIds;

      if (cfg?.include_child_types === true) {
        const { data: descendants } = await this.client
          .from('asset_object_types')
          .select('id')
          .eq('organization_id', form.organization_id)
          .eq('space_id', spaceId)
          .eq('schema_id', schemaId)
          .overlaps('parent_ids', typeIds);

        effectiveTypeIds = Array.from(
          new Set([
            ...typeIds,
            ...((descendants ?? []) as Array<{ id: string }>).map((d) => d.id),
          ]),
        );
      }

      let query = this.client
        .from('asset_objects')
        .select('id, name')
        .eq('organization_id', form.organization_id)
        .eq('space_id', spaceId)
        .eq('schema_id', schemaId)
        .in('object_type_id', effectiveTypeIds)
        .eq('is_archived', false);

      // A user attribute stores a bare id; user_multi stores an array of ids.
      if (cfg?.assigned_only === true && viewerUserId) {
        query =
          cfg.assignee_attribute_kind === 'user_multi'
            ? query.contains('attribute_values', {
                [assigneeKey]: [viewerUserId],
              })
            : query.eq(`attribute_values->>${assigneeKey}`, viewerUserId);
      }

      const { data, error } = await query
        .order('name', { ascending: true })
        .limit(PUBLIC_ASSET_OPTION_LIMIT);

      if (error) {
        this.logger.error(
          `public asset options failed for field ${field.field_key}: ${error.message}`,
        );
        resolved.set(field.field_key, []);
        continue;
      }

      const options: PublicAssetOption[] = (
        (data ?? []) as Array<{ id: string; name: string }>
      ).map((o) => ({ label: o.name, value: o.id }));
      const dependency = narrowDependents ? readAssetDependency(cfg) : null;

      if (!dependency) {
        resolved.set(field.field_key, options);
        continue;
      }

      (resolved.dependsOn ??= new Map()).set(
        field.field_key,
        dependency.sourceKey,
      );

      const parents = await loadAssetParentIds(
        this.client,
        { organizationId: form.organization_id, spaceId, schemaId },
        dependency,
        options.map((o) => o.value),
      );

      // Fail closed: an unresolvable link must never serve the unfiltered list.
      if (!parents) {
        this.logger.error(
          `public asset dependency lookup failed for field ${field.field_key}`,
        );
        resolved.set(field.field_key, []);
        continue;
      }

      resolved.set(
        field.field_key,
        options.map((o) => ({ ...o, parent_ids: parents.get(o.value) ?? [] })),
      );
    }

    // Only a served parent can be answered; other linked ids are neither usable nor ours to expose.
    for (const [key, sourceKey] of resolved.dependsOn ?? []) {
      const served = new Set(
        (resolved.get(sourceKey) ?? []).map((o) => o.value),
      );

      resolved.set(
        key,
        (resolved.get(key) ?? []).map((o) => ({
          ...o,
          parent_ids: (o.parent_ids ?? []).filter((id) => served.has(id)),
        })),
      );
    }

    return resolved;
  }

  /** Serializes a field for an untrusted audience. Drops ids and internal config. */
  toPublicField(field: FieldRow, assetOptions?: PublicAssetOptions) {
    return {
      field_key: field.field_key,
      field_type: field.field_type,
      label: field.label,
      placeholder: field.placeholder,
      help_text: field.help_text,
      required: field.required === true,

      // Neither a `products` catalog nor a `layout` grid is `{ label, value }` shaped — the
      // generic reducer would flatten a catalog to empty strings, and return null for a grid
      // (its `rows`/`columns` are cell COUNTS, not option arrays), silently emptying the field.
      options:
        field.field_type === 'products'
          ? sanitizeProductOptions(field.options)
          : field.field_type === 'layout'
            ? sanitizeLayoutOptions(field.options)
            : // Assets are resolved server-side (see resolveAssetOptions); the
              // stored `options` is empty for this type.
              field.field_type === 'asset' || field.field_type === 'asset_multi'
              ? (assetOptions?.get(field.field_key) ?? [])
              : sanitizeOptions(field.options),
      validation_rules: sanitizeValidationRules(
        withAssetDependsOnRule(field.validation_rules, field, assetOptions),
        field.field_type,
      ),
      page_index: field.page_index ?? 0,
      section: field.section ?? null,
      column_span: field.column_span ?? null,
      sort_order: field.sort_order ?? 0,
      // Carried so the published page evaluates visibility exactly as the
      // builder preview does. The server re-evaluates on submit regardless.
      conditional_logic: field.conditional_logic ?? null,
      calculation: field.calculation ?? null,
      default_value: field.default_value ?? null,
    };
  }

  // ── Limits and validation ──────────────────────────────────────────────────

  private assertPayloadSize(data: unknown): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestException('Invalid submission payload');
    }

    const keys = Object.keys(data as Record<string, unknown>);

    if (keys.length > MAX_ANSWER_KEYS) {
      throw new BadRequestException('Submission payload too large');
    }
  }

  private async assertNotClosed(form: FormRow): Promise<void> {
    const settings = form.settings ?? {};
    const schedule = settings.schedule as
      | { opens_at?: string; closes_at?: string }
      | undefined;
    const now = Date.now();

    if (schedule?.opens_at && now < Date.parse(schedule.opens_at)) {
      throw new BadRequestException('This form is not open yet');
    }

    if (schedule?.closes_at && now > Date.parse(schedule.closes_at)) {
      throw new BadRequestException('This form is closed');
    }

    const maxResponses = settings.max_responses;

    if (typeof maxResponses === 'number' && maxResponses > 0) {
      const { count } = await this.client
        .from(SUBMISSIONS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('form_id', form.id)
        .eq('status', 'submitted')
        .eq('is_test', false);

      if ((count ?? 0) >= maxResponses) {
        throw new BadRequestException('This form is closed');
      }
    }
  }

  private async assertSingleSubmission(
    form: FormRow,
    userId: string,
  ): Promise<void> {
    const settings = form.settings ?? {};

    if (settings.allow_multiple_submissions !== false) return;

    const { count } = await this.client
      .from(SUBMISSIONS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('form_id', form.id)
      .eq('submitted_by', userId)
      .eq('status', 'submitted');

    if ((count ?? 0) > 0) {
      throw new BadRequestException('You have already submitted this form');
    }
  }

  /**
   * Anonymous submission budgets, scoped by organization so one tenant's public
   * traffic can never exhaust another tenant's allowance, and excluding drafts
   * and test rows so neither can burn a real visitor's quota.
   */
  private async assertRateLimits(
    form: FormRow,
    ipAddress: string | undefined,
  ): Promise<void> {
    const IP_WINDOW_MS = 600_000;
    const IP_MAX = 10;
    const FORM_WINDOW_MS = 3_600_000;
    const FORM_MAX = 500;

    if (ipAddress) {
      const { count } = await this.client
        .from(SUBMISSIONS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('ip_address', ipAddress)
        .eq('organization_id', form.organization_id)
        .eq('status', 'submitted')
        .eq('is_test', false)
        .is('submitted_by', null)
        .gte('created_at', new Date(Date.now() - IP_WINDOW_MS).toISOString());

      if ((count ?? 0) >= IP_MAX) {
        throw new BadRequestException(
          'Too many submissions. Please try again later.',
        );
      }
    }

    const { count: formCount } = await this.client
      .from(SUBMISSIONS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('form_id', form.id)
      .eq('status', 'submitted')
      .eq('is_test', false)
      .is('submitted_by', null)
      .gte('created_at', new Date(Date.now() - FORM_WINDOW_MS).toISOString());

    if ((formCount ?? 0) >= FORM_MAX) {
      throw new BadRequestException(
        'Too many submissions. Please try again later.',
      );
    }
  }

  /** Drops unknown keys, enforces required, and caps value sizes. */
  private validateAndClean(
    fields: FieldRow[],
    data: Record<string, unknown>,
    states: Record<string, FieldLogicState>,
  ): Record<string, unknown> {
    const clean: Record<string, unknown> = {};

    for (const field of fields) {
      // Output-only: whatever the client sent is discarded; the authenticated
      // recompute path owns this value.
      if (field.field_type === 'calculated') continue;

      const state = states[field.field_key];

      // Hidden by logic: never stored, and its required flag no longer applies.
      if (state && !state.visible) continue;

      const raw = data[field.field_key];
      const value = this.sanitizeValue(raw, field.field_type);
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);

      if (empty) {
        if (state ? state.required : field.required === true) {
          throw new BadRequestException(
            `"${field.label ?? field.field_key}" is required`,
          );
        }

        continue;
      }

      clean[field.field_key] = value;
    }

    return clean;
  }

  private sanitizeValue(value: unknown, fieldType?: string): unknown {
    if (fieldType === 'multi_photo' && Array.isArray(value)) {
      return this.sanitizeMultiPhotoValue(value);
    }

    if (typeof value === 'string') {
      const limit = DATA_URI_STRING_TYPES.has(fieldType ?? '')
        ? MAX_DATA_URI_STRING_LENGTH
        : MAX_STRING_LENGTH;

      if (value.length > limit) {
        throw new BadRequestException('Answer too long');
      }

      return value;
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        throw new BadRequestException('Too many values');
      }

      return value.map((entry) => this.sanitizeValue(entry));
    }

    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};

      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        // One level only — deeper structures are not a shape any public field
        // produces, and unbounded recursion is a DoS surface.
        out[key] = typeof entry === 'object' ? null : this.sanitizeValue(entry);
      }

      return out;
    }

    return value;
  }

  /**
   * multi_photo answers are an array of data: URIs, bounded on TOTAL combined
   * length rather than per-entry — see MAX_MULTI_PHOTO_TOTAL_BYTES. Non-string
   * entries are dropped rather than kept as empty placeholders.
   */
  private sanitizeMultiPhotoValue(value: unknown[]): string[] {
    if (value.length > MAX_ARRAY_LENGTH) {
      throw new BadRequestException('Too many values');
    }

    const photos = value.filter(
      (entry): entry is string => typeof entry === 'string',
    );
    const totalLength = photos.reduce((sum, photo) => sum + photo.length, 0);

    if (totalLength > MAX_MULTI_PHOTO_TOTAL_BYTES) {
      throw new BadRequestException(
        'Photos exceed the maximum allowed total size',
      );
    }

    return photos;
  }
}
