import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { SubmitFormDto } from './dto/submit-form.dto';

// ── Local shape mirrors the frontend EditorElement model (only what we need) ──

interface FormFieldOption {
  label: string;
  value: string;
}

interface StoredFormField {
  id: string;
  field_name: string;
  field_type: string;
  label: string;
  required: boolean;
  options?: FormFieldOption[];
  placeholder?: string | null;
  sort_order?: number;
}

interface ContactFormInlineField {
  id: string;
  field_name: string;
  field_type: string;
  label: string;
  required: boolean;
  options?: FormFieldOption[];
  placeholder?: string | null;
}

interface ContactFormContent {
  formId?: string;
  fields?: ContactFormInlineField[];
  customSubmitUrl?: string;
  customSubmitMethod?: 'POST' | 'PUT' | 'PATCH';
}

interface EditorElement {
  type: string;
  content?: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findFormElement(
  elements: EditorElement[],
  formElementId: string,
): EditorElement | null {
  for (const el of elements) {
    if (
      el.type === 'contactForm' &&
      (el.content as ContactFormContent)?.formId === formElementId
    ) {
      return el;
    }

    if (Array.isArray(el.content)) {
      const found = findFormElement(
        el.content as EditorElement[],
        formElementId,
      );

      if (found) return found;
    }
  }

  return null;
}

function isWebhookUrlSafe(raw: string): boolean {
  try {
    const url = new URL(raw);

    if (url.protocol !== 'https:') return false;

    const hostname = url.hostname.toLowerCase();

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1'
    )
      return false;

    const privatePatterns = [
      /^10\./,
      /^192\.168\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^169\.254\./,
      /^0\./,
    ];

    if (privatePatterns.some((r) => r.test(hostname))) return false;

    return true;
  } catch {
    return false;
  }
}

async function fireWebhook(
  url: string,
  payload: Record<string, unknown>,
  method: 'POST' | 'PUT' | 'PATCH' = 'POST',
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error('[webhook] non-ok response', {
        status: response.status,
        url,
      });
    }
  } catch (err) {
    console.error('[webhook] request failed', {
      url,
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export interface SiteStudioContactRecord {
  id: string;
  organization_id: string;
  funnel_id: string;
  source_page_id: string | null;
  email: string | null;
  form_data: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  is_test_submission: boolean | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class SubmitService {
  static readonly FUNNELS_TABLE = 'site_studio_funnels';
  static readonly PAGES_TABLE = 'site_studio_pages';
  static readonly CONTACTS_TABLE = 'site_studio_contacts';
  static readonly FORM_FIELDS_TABLE = 'site_studio_form_fields';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async submitForm(
    dto: SubmitFormDto,
    ipAddress: string | undefined,
    userAgent: string | undefined,
    isTest: boolean,
  ): Promise<SiteStudioContactRecord> {
    // Validate form_data constraints
    if (Object.keys(dto.form_data).length > 50) {
      throw new BadRequestException('Too many form fields (max 50)');
    }

    for (const [, value] of Object.entries(dto.form_data)) {
      if (typeof value === 'string' && value.length > 10_000) {
        throw new BadRequestException(
          'Form field value too long (max 10 000 characters)',
        );
      }
    }

    // Look up funnel
    const { data: funnel, error: funnelError } = await this.client
      .from(SubmitService.FUNNELS_TABLE)
      .select('id, organization_id, published')
      .eq('id', dto.funnel_id)
      .maybeSingle();

    if (funnelError) throw new BadRequestException(funnelError.message);

    if (!funnel || (!funnel.published && !isTest)) {
      throw new BadRequestException('Funnel not found or not published');
    }

    const organizationId = (funnel as Record<string, unknown>)[
      'organization_id'
    ] as string;

    // Validate page_id belongs to funnel
    if (dto.page_id) {
      const { data: page } = await this.client
        .from(SubmitService.PAGES_TABLE)
        .select('id')
        .eq('id', dto.page_id)
        .eq('funnel_id', dto.funnel_id)
        .maybeSingle();

      if (!page) throw new BadRequestException('Invalid page');
    }

    // IP-based rate limiting: max 10 submissions per IP per 10 minutes
    if (ipAddress) {
      const { count, error: rateErr } = await this.client
        .from(SubmitService.CONTACTS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('ip_address', ipAddress)
        .gte('created_at', new Date(Date.now() - 600_000).toISOString());

      if (rateErr) throw new BadRequestException(rateErr.message);

      if ((count ?? 0) >= 10) {
        throw new BadRequestException(
          'Too many submissions. Please try again later.',
        );
      }
    }

    // Per-funnel rate limiting: max 500 per hour
    const { count: funnelCount, error: funnelRateErr } = await this.client
      .from(SubmitService.CONTACTS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('funnel_id', dto.funnel_id)
      .gte('created_at', new Date(Date.now() - 3_600_000).toISOString());

    if (funnelRateErr) throw new BadRequestException(funnelRateErr.message);

    if ((funnelCount ?? 0) >= 500) {
      throw new BadRequestException(
        'Too many submissions. Please try again later.',
      );
    }

    // Get form fields from DB
    const { data: rawFields } = await this.client
      .from(SubmitService.FORM_FIELDS_TABLE)
      .select('*')
      .eq('funnel_id', dto.funnel_id)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true });

    let formFields = (rawFields ?? []) as StoredFormField[];

    // If no DB fields, fall back to inline fields from page content
    if (formFields.length === 0 && dto.form_element_id && dto.page_id) {
      try {
        const { data: page } = await this.client
          .from(SubmitService.PAGES_TABLE)
          .select('content')
          .eq('id', dto.page_id)
          .eq('organization_id', organizationId)
          .maybeSingle();

        if (page?.content) {
          const formEl = findFormElement(
            page.content as unknown as EditorElement[],
            dto.form_element_id,
          );

          const inlineFields = (
            formEl?.content as ContactFormContent | undefined
          )?.fields;

          if (inlineFields?.length) {
            formFields = inlineFields.map((f, i) => ({
              id: f.id,
              field_name: f.field_name,
              field_type: f.field_type,
              label: f.label,
              required: f.required,
              options: f.options ?? [],
              placeholder: f.placeholder ?? null,
              sort_order: i,
            }));
          }
        }
      } catch {
        // Non-fatal — proceed without server-side validation
      }
    }

    // Validate required fields
    for (const field of formFields) {
      if (field.required) {
        const value = dto.form_data[field.field_name];
        const isEmpty =
          value === undefined ||
          value === null ||
          value === '' ||
          (Array.isArray(value) && value.length === 0);

        if (isEmpty) {
          throw new BadRequestException(
            `Required field missing: ${field.label}`,
          );
        }
      }
    }

    // Sanitize: strip HTML tags and javascript: from string values
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(dto.form_data)) {
      if (typeof value === 'string') {
        sanitized[key] = value
          .replace(/<[^>]*>/g, '')
          .replace(/javascript:/gi, '');
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((v) =>
          typeof v === 'string'
            ? v.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '')
            : (v as unknown),
        );
      } else {
        sanitized[key] = value;
      }
    }

    // Extract email
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const emailField = formFields.find(
      (f) => f.field_name === 'email' || f.field_type === 'email',
    );
    const email: string | undefined = emailField
      ? (sanitized[emailField.field_name] as string | undefined)
      : ((sanitized['email'] as string | undefined) ??
        (Object.values(sanitized).find(
          (v) => typeof v === 'string' && EMAIL_RE.test(v),
        ) as string | undefined));

    // Insert contact record
    const { data: contact, error: insertErr } = (await this.client
      .from(SubmitService.CONTACTS_TABLE)
      .insert({
        organization_id: organizationId,
        funnel_id: dto.funnel_id,
        source_page_id: dto.page_id ?? null,
        email: email ?? null,
        form_data: sanitized,
        ip_address: ipAddress ?? null,
        user_agent: userAgent ?? null,
        is_test_submission: isTest || null,
      })
      .select()
      .single()) as {
      data: SiteStudioContactRecord | null;
      error: { message: string } | null;
    };

    if (insertErr) throw new BadRequestException(insertErr.message);

    const saved = contact as unknown as SiteStudioContactRecord;

    void this.auditLogsService.logSystemAction(
      organizationId,
      'site_studio_contact',
      saved.id,
      'create',
      {
        funnel_id: dto.funnel_id,
        page_id: dto.page_id ?? null,
        email: saved.email,
        is_test_submission: saved.is_test_submission === true,
      },
    );

    // Fire webhook if configured (non-blocking)
    if (dto.form_element_id && dto.page_id) {
      try {
        const { data: page } = await this.client
          .from(SubmitService.PAGES_TABLE)
          .select('content')
          .eq('id', dto.page_id)
          .eq('organization_id', organizationId)
          .maybeSingle();

        if (page?.content) {
          const formEl = findFormElement(
            page.content as unknown as EditorElement[],
            dto.form_element_id,
          );

          const webhookUrl = (formEl?.content as ContactFormContent | undefined)
            ?.customSubmitUrl;

          if (webhookUrl) {
            if (!isWebhookUrlSafe(webhookUrl)) {
              console.error('[webhook] blocked unsafe URL', {
                url: webhookUrl,
              });
            } else {
              const webhookMethod =
                (formEl!.content as ContactFormContent).customSubmitMethod ??
                'POST';

              await fireWebhook(
                webhookUrl,
                {
                  event: 'form_submit',
                  funnel_id: dto.funnel_id,
                  page_id: dto.page_id,
                  contact_id: saved.id,
                  form_data: sanitized,
                  submitted_at: new Date().toISOString(),
                },
                webhookMethod,
              );
            }
          }
        }
      } catch (err) {
        console.error(
          '[webhook] lookup error',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return saved;
  }
}
