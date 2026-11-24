import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { FormBuilderFieldsService } from './form-builder-fields.service';
import { sanitizeFormSettings } from './form-settings-sanitizer.util';
import { FormBuilderPaymentConfigService } from './form-builder-payment-config.service';
import {
  findPubliclyUnsafeTypes,
  isPaymentConfigOnlyBlocker,
} from './public/public-form-safety.util';
import { isReservedSlug } from '../common/constants/reserved-slugs';
import type { CreateFormBuilderDto } from './dto/create-form-builder.dto';
import type { UpdateFormBuilderDto } from './dto/update-form-builder.dto';
import type { UpdateFormPublicLinkDto } from './dto/update-form-public-link.dto';

const TABLE = 'form_builder';

// The field-definition columns copied verbatim when a form is duplicated / saved as a
// template. field_key is preserved so conditional_logic / calculation (which reference
// other fields by field_key, not id) keep working with no id remap. Excludes id / form_id
// / org / space / timestamps — the RPC regenerates ids and sets form_id from its param.
const CLONE_FIELD_KEYS = [
  'field_key',
  'field_type',
  'label',
  'label_i18n',
  'placeholder',
  'help_text',
  'description',
  'required',
  'options',
  'validation_rules',
  'default_value',
  'conditional_logic',
  'calculation',
  'page_index',
  'section',
  'column_span',
  'sort_order',
  'is_hidden',
  'read_only',
] as const;

@Injectable()
export class FormBuilderService {
  private readonly logger = new Logger(FormBuilderService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly fieldsService: FormBuilderFieldsService,

    // Optional so a wiring gap degrades to "payments not configured", which only makes the
    // publish-time public-safety check stricter, never looser.
    @Optional()
    private readonly paymentConfig?: FormBuilderPaymentConfigService,

    // Optional so a wiring gap degrades to "no automation trigger" rather than breaking form CRUD.
    @Optional()
    private readonly automationOutbox?: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Mirrors the fill page's `enabled` rule, so publish-time and fill-time can never disagree. */
  private async hasUsablePaymentConfig(
    orgId: string,
    spaceId: string,
  ): Promise<boolean> {
    if (!this.paymentConfig) return false;

    try {
      const config = await this.paymentConfig.getFillConfig({ orgId, spaceId });

      return config.enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Publish a form lifecycle automation event (`app.form.created|updated|deleted`) so a matching
   * trigger can fire. Fire-and-forget in its own catch — a failed outbox write must never break the
   * CRUD operation. Top-level `formId` is the deterministic filter target (see the trigger's
   * configSchema); `form` carries the row for `{{ trigger.form.* }}` templating.
   */
  private emitFormLifecycleEvent(
    kind: 'app.form.created' | 'app.form.updated' | 'app.form.deleted',
    form: {
      id?: unknown;
      name?: unknown;
      status?: unknown;
      is_template?: unknown;
    },
    spaceId: string,
    organizationId: string,
  ): void {
    if (!this.automationOutbox) return;

    const formId = typeof form.id === 'string' ? form.id : undefined;

    if (!formId) return;

    void this.automationOutbox
      .write(organizationId, spaceId, kind, {
        formId,
        formName: (form.name as string | undefined) ?? null,
        spaceId,
        organizationId,
        form: {
          id: formId,
          name: (form.name as string | undefined) ?? null,
          status: (form.status as string | undefined) ?? null,
          is_template: form.is_template === true,
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `${kind} automation emit failed: ${(err as Error)?.message ?? err}`,
        ),
      );
  }

  async list(
    spaceId: string,
    organizationId: string,
    includeArchived = false,
    isTemplate = false,
  ) {
    let query = this.client
      .from(TABLE)
      .select('*')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      // templates live in their own tab; the normal list must never surface them
      .eq('is_template', isTemplate)
      .order('updated_at', { ascending: false });

    if (!includeArchived) query = query.neq('status', 'archived');

    const { data, error } = await query;

    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }

  async getOne(id: string, spaceId: string, organizationId: string) {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Form not found');

    return data;
  }

  async create(
    dto: CreateFormBuilderDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const formKey = await this.allocateFormKey(spaceId);

    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        name: dto.name,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        status: 'draft',
        settings: sanitizeFormSettings(dto.settings ?? {}),
        form_key: formKey,
        public_slug: this.normalizeSlug(dto.public_slug),
        version: 1,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) throw this.mapSlugConflict(error, dto.public_slug);

    this.emitFormLifecycleEvent(
      'app.form.created',
      data as Record<string, unknown>,
      spaceId,
      organizationId,
    );

    return data;
  }

  async update(
    id: string,
    dto: UpdateFormBuilderDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const patch: Record<string, unknown> = {
      updated_by: userId,
      version: dto.version + 1,
    };
    console.log('Updating form', id, 'with patch', patch, 'and dto', dto);

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (dto.status !== undefined) patch.status = dto.status;

    // `settings` arrives as an untyped record that ValidationPipe cannot reach
    // into; sanitize at the write boundary so every caller is covered.
    if (dto.settings !== undefined)
      patch.settings = sanitizeFormSettings(dto.settings);

    if (dto.public_slug !== undefined) {
      const slug = this.normalizeSlug(dto.public_slug);

      patch.public_slug = slug;

      // Releasing the slug must also take the form off its public URL —
      // otherwise `is_public` would stay true with nothing to serve it at, and
      // re-adding any slug later would silently republish the form.
      if (slug === null) patch.is_public = false;
    }

    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .eq('version', dto.version)
      .select('*')
      .maybeSingle();

    if (error) throw this.mapSlugConflict(error, dto.public_slug);

    if (!data) {
      const exists = await this.client
        .from(TABLE)
        .select('id')
        .eq('id', id)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('is_deleted', false)
        .maybeSingle();

      if (!exists.data) throw new NotFoundException('Form not found');
      throw new ConflictException('Stale version — refresh and retry');
    }

    this.emitFormLifecycleEvent(
      'app.form.updated',
      data as Record<string, unknown>,
      spaceId,
      organizationId,
    );

    return data;
  }

  async remove(
    id: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: userId,
      })
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .select('id, name, status, is_template')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Form not found');

    this.emitFormLifecycleEvent(
      'app.form.deleted',
      data as Record<string, unknown>,
      spaceId,
      organizationId,
    );

    return { success: true as const };
  }

  // Duplicate a form into a new draft in the same space. Copies name/description/icon/
  // settings + all field definitions (verbatim field_keys); does NOT copy submissions,
  // orders or attachments. Runs fully server-side — the source field rows carry columns
  // the field DTO forbids (id/form_id/…), so they must not be routed back through a
  // controller/ValidationPipe; here they go straight into the RPC via replaceAll.
  async duplicate(
    sourceId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const source = await this.getOne(sourceId, spaceId, organizationId);

    return this.cloneForm(source, spaceId, organizationId, userId, {
      name: `${source.name} (copy)`,
      isTemplate: false,
    });
  }

  // Save a form as a reusable template (is_template=true). Kept as a draft under its
  // original name; templates surface only in the Templates tab, never the normal list.
  async saveAsTemplate(
    sourceId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const source = await this.getOne(sourceId, spaceId, organizationId);

    return this.cloneForm(source, spaceId, organizationId, userId, {
      name: source.name,
      isTemplate: true,
    });
  }

  async listTemplates(spaceId: string, organizationId: string) {
    return this.list(spaceId, organizationId, false, true);
  }

  // Create a working draft from a template. The source must be a template.
  async instantiateTemplate(
    templateId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const template = await this.getOne(templateId, spaceId, organizationId);

    if (!template.is_template)
      throw new BadRequestException('This form is not a template');

    return this.cloneForm(template, spaceId, organizationId, userId, {
      name: template.name,
      isTemplate: false,
    });
  }

  private async cloneForm(
    source: Record<string, any>,
    spaceId: string,
    organizationId: string,
    userId: string,
    opts: { name: string; isTemplate: boolean },
  ) {
    const formKey = await this.allocateFormKey(spaceId);

    const { data: newForm, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        name: opts.name,
        description: source.description ?? null,
        icon: source.icon ?? null,
        status: 'draft',
        // Sanitize on clone too: `source` is an existing row that may predate
        // the write-boundary guard, and duplicating it must not carry a legacy
        // unsafe redirect into a new form.
        settings: sanitizeFormSettings(source.settings ?? {}),
        form_key: formKey,
        version: 1,
        is_template: opts.isTemplate,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    // copy the field definitions verbatim (field_key preserved → logic/calc survive)
    const sourceFields = await this.fieldsService.list(
      source.id,
      spaceId,
      organizationId,
    );

    if (sourceFields.length) {
      await this.fieldsService.replaceAll(
        newForm.id,
        {
          version: newForm.version,
          fields: sourceFields.map((f) => this.pickFieldColumns(f)),
        } as any,
        spaceId,
        organizationId,
        userId,
      );
    }

    // re-read so the returned form reflects the version bumped by replaceAll
    return this.getOne(newForm.id, spaceId, organizationId);
  }

  private pickFieldColumns(field: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};

    for (const key of CLONE_FIELD_KEYS) {
      if (field[key] !== undefined) out[key] = field[key];
    }

    return out;
  }

  /**
   * Enables or disables the standalone public link for a form.
   *
   * Validation happens HERE, at publish time, rather than only when a visitor
   * loads the page. An owner who publishes a form containing a field that cannot
   * be filled anonymously gets a named-field error immediately; without this the
   * link would simply 404 for every visitor and the owner would have no idea why.
   */
  async updatePublicLink(
    formId: string,
    dto: UpdateFormPublicLinkDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    // getOne is typed `any` (the Supabase row shape is untyped throughout this
    // service); narrow to the two fields this method actually reads.
    const form = (await this.getOne(
      formId,
      spaceId,
      organizationId,
    )) as unknown as {
      name: string;
      public_slug: string | null;
    };

    if (dto.is_public) {
      const { data: fieldRows, error: fieldsError } = await this.client
        .from('form_builder_fields')
        .select('field_type')
        .eq('form_id', formId);

      if (fieldsError) throw new BadRequestException(fieldsError.message);

      const rows = (fieldRows ?? []) as Array<{ field_type: string }>;

      // A Products field is publishable as long as the space can actually take money; without a
      // gateway the public page would advertise a price no checkout could complete.
      const paymentConfigured = rows.some((f) => f.field_type === 'products')
        ? await this.hasUsablePaymentConfig(organizationId, spaceId)
        : false;

      const unsafe = findPubliclyUnsafeTypes(rows, { paymentConfigured });

      if (isPaymentConfigOnlyBlocker(unsafe)) {
        throw new BadRequestException(
          'This form contains a Products field, but no payment gateway is connected for this space. Connect Stripe in the payment settings before sharing it publicly.',
        );
      }

      if (unsafe.length) {
        throw new BadRequestException(
          `This form cannot be shared publicly because it contains: ${unsafe.join(', ')}. Remove or replace these fields first.`,
        );
      }
    }

    const patch: Record<string, unknown> = {
      is_public: dto.is_public,
      updated_by: userId,
    };

    const desired = dto.public_slug ?? form.public_slug ?? undefined;

    // Generate from the name only on first enable, so an existing link is never
    // silently repointed by a rename.
    const slug =
      desired ??
      (dto.is_public ? await this.generateUniqueSlug(form.name) : null);

    if (slug) {
      if (isReservedSlug(slug)) {
        throw new ConflictException(`"${slug}" is reserved — choose another`);
      }

      patch.public_slug = slug;
    }

    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .select('*')
      .maybeSingle();

    // 23505 = unique_violation on form_builder_public_slug_uq. Surfaced as a
    // conflict the owner can act on, not a 500.
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(
          `The link "${slug ?? ''}" is already taken — choose another`,
        );
      }

      throw new BadRequestException(error.message);
    }

    if (!data) throw new NotFoundException('Form not found');

    // The audience is derived, never stored: presence of assignees IS the gate,
    // so removing the last assignee silently opens the form to anyone with the
    // link. Returning it lets the UI state the effective audience plainly.
    const { count: assigneeCount } = await this.client
      .from('form_builder_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('form_id', formId);

    const settings =
      ((data as Record<string, unknown>).settings as Record<string, unknown>) ??
      {};

    return {
      ...(data as Record<string, unknown>),
      audience:
        (assigneeCount ?? 0) > 0
          ? 'assignees'
          : settings.require_login === true
            ? 'organization'
            : 'anyone',
      assignee_count: assigneeCount ?? 0,
    };
  }

  /**
   * Normalizes a caller-supplied slug and rejects reserved words.
   *
   * Lower-cased because the unique index is on `lower(public_slug)` — storing
   * mixed case would let 'Acme' and 'acme' look distinct in the API while
   * colliding in the database.
   *
   * @throws ConflictException when the slug is reserved.
   */
  private normalizeSlug(slug: string | null | undefined): string | null {
    if (slug === null) return null;
    if (slug === undefined) return null;

    const normalized = slug.trim().toLowerCase();

    if (!normalized) return null;

    if (isReservedSlug(normalized)) {
      throw new ConflictException(
        `"${normalized}" is reserved — choose another`,
      );
    }

    return normalized;
  }

  /**
   * Translates a Postgres unique violation on the public-slug index into a 409
   * the caller can act on.
   *
   * Uniqueness is enforced by the DATABASE, not by a pre-flight lookup: two
   * requests claiming the same slug at once would both pass a "is it free?"
   * check and one would still fail on insert. Letting the index decide and
   * mapping its error is the only race-free option.
   */
  private mapSlugConflict(
    error: { code?: string; message: string },
    slug: string | null | undefined,
  ): Error {
    if (
      error.code === '23505' &&
      (error.message ?? '').includes('public_slug')
    ) {
      return new ConflictException(
        `The link "${slug ?? ''}" is already taken — choose another`,
      );
    }

    return new BadRequestException(error.message);
  }

  /** Slugifies the form name and appends a counter until the slug is free. */
  private async generateUniqueSlug(name: string): Promise<string> {
    const base =
      (name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'form';
    const candidateBase = base.length >= 3 ? base : `form-${base}`;

    for (let attempt = 0; attempt < 25; attempt++) {
      const candidate =
        attempt === 0 ? candidateBase : `${candidateBase}-${attempt + 1}`;

      if (isReservedSlug(candidate)) continue;

      const { data } = await this.client
        .from(TABLE)
        .select('id')
        .eq('public_slug', candidate)
        .maybeSingle();

      if (!data) return candidate;
    }

    // Deterministic fallback rather than looping forever on a crowded base.
    return `${candidateBase}-${Date.now().toString(36)}`;
  }

  private async allocateFormKey(spaceId: string): Promise<string> {
    const { data, error } = await this.client.rpc('generate_form_builder_key', {
      p_space_id: spaceId,
    });

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Could not allocate form key',
      );

    return data as string;
  }
}
