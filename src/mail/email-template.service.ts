/**
 * @fileoverview Email rendering engine. Compiles brand-aware, localized transactional
 * emails from MJML templates authored with Handlebars syntax.
 *
 * Pipeline per email: **Handlebars (with context) -> MJML source -> mjml2html -> { html, text }**.
 * Handlebars runs first so structural `{{#if}}` / `{{#each}}` and `{{> partials}}` produce a single
 * complete MJML document, which is then compiled once into responsive, Outlook-safe HTML.
 *
 * Reusable design-system pieces are Handlebars partials (`templates/partials/*.mjml.hbs`) plus a
 * shared `layout.mjml.hbs`; every template renders inside the layout via `{{#> layout}} ... {{/layout}}`.
 *
 * Copy is localized through a small backend catalog (`i18n/{en,de}.json`) exposed to templates as the
 * `{{t 'key' ...}}` helper, keyed off the recipient's `users.language` (fallback `en`).
 *
 * Branding is resolved per organization from `organization_branding` (logo + primary colour) with the
 * global XISUITE brand as fallback, so each tenant's email still feels like their own product.
 *
 * @module src/mail/email-template.service
 * @author Prince Jadiya
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Handlebars from 'handlebars';
import mjml2html from 'mjml';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

/** Supported email locales. Anything else falls back to `en`. */
export type EmailLocale = 'en' | 'de';

/** Resolved branding passed to every template as `brand`. */
export interface EmailBrand {
  /** Product name (always XISUITE). */
  appName: string;
  /** Display name for the recipient's organization (footer). */
  orgName: string;
  /** Sender display name used by MailService for the `from` header. */
  fromName: string;
  /** Absolute, email-embeddable logo URL (org logo or XISUITE fallback). */
  logoUrl: string;
  /** Brand/accent colour (org primary or `#f79e08`). */
  primaryColor: string;
  /** Slightly darker accent for borders/hover affordances. */
  primaryDark: string;
  /** Base app URL, used to build any other absolute asset links. */
  appUrl: string;
}

/** Result of rendering a template: an HTML body and a plain-text alternative. */
export interface RenderResult {
  html: string;
  text: string;
}

/** Options for {@link EmailTemplateService.render}. */
export interface RenderOptions {
  /** Template basename without extension, e.g. `'auth-otp'`. */
  template: string;
  /** Recipient locale (typically `users.language`). Normalized to en/de. */
  locale?: string | null;
  /** Organization id used to resolve per-tenant branding. */
  organizationId?: string | null;
  /** Template-specific data, exposed under `data` in the template. */
  data?: Record<string, any>;
}

const TEMPLATE_EXT = '.mjml.hbs';
const SUPPORTED_LOCALES: EmailLocale[] = ['en', 'de'];
const BRAND_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PRIMARY = '#f79e08';
const DEFAULT_PRIMARY_DARK = '#f18217';

/** Minimal shape of the options object Handlebars passes to inline helpers. */
interface HbsHelperOptions {
  hash?: Record<string, unknown>;
  data?: { root?: Record<string, unknown> };
}

/**
 * Coerces an unknown interpolation value to a display string, ignoring objects
 * (so a stray object never renders as `[object Object]` in an email).
 */
function toDisplayString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);

  return '';
}

/** Interpolates `{placeholder}` tokens in a catalog string from a vars map. */
function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m: string, k: string) =>
    toDisplayString(vars[k]),
  );
}

/**
 * Renders MJML+Handlebars email templates into localized, brand-aware HTML + text.
 */
@Injectable()
export class EmailTemplateService implements OnModuleInit {
  private readonly logger = new Logger(EmailTemplateService.name);

  /** Isolated Handlebars environment so helpers/partials never leak globally. */
  private readonly hbs = Handlebars.create();

  /** Compiled top-level template cache keyed by template name. */
  private readonly compiled = new Map<string, HandlebarsTemplateDelegate>();

  /** Loaded i18n catalogs keyed by locale. */
  private readonly catalogs: Record<string, Record<string, string>> = {};

  /** Short-lived per-org branding cache. */
  private readonly brandCache = new Map<
    string,
    { value: EmailBrand; expires: number }
  >();

  private readonly templatesDir = path.join(__dirname, 'templates');
  private readonly partialsDir = path.join(this.templatesDir, 'partials');
  private readonly i18nDir = path.join(__dirname, 'i18n');

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  /**
   * Loads partials, registers helpers, and reads i18n catalogs once at startup.
   * Never throws; a misconfigured template dir degrades to a logged warning so
   * the app still boots (individual renders then fail loudly and fall back).
   */
  onModuleInit(): void {
    try {
      this.registerHelpers();
      this.registerPartials();
      this.loadCatalogs();
      this.logger.log(
        `Email templates ready (locales: ${Object.keys(this.catalogs).join(', ') || 'none'})`,
      );
    } catch (err) {
      this.logger.error('Failed to initialize email templates', err as Error);
    }
  }

  /**
   * Renders a template into responsive HTML + a plain-text alternative.
   *
   * @param {RenderOptions} opts - template name, locale, org id, and data
   * @returns {Promise<RenderResult>} the compiled `{ html, text }`
   * @throws {Error} when the template is missing or MJML fails fatally
   */
  async render(opts: RenderOptions): Promise<RenderResult> {
    const locale = this.normalizeLocale(opts.locale);
    const brand = await this.resolveBrand(opts.organizationId ?? null);
    const templateFn = this.getCompiled(opts.template);

    const context = {
      data: opts.data ?? {},
      brand,
      locale,
      // Internal channels read by the `t` helper.
      _catalog: this.catalogs[locale] ?? {},
      _fallback: this.catalogs.en ?? {},
    };

    const mjmlSource = templateFn(context);
    const { html, errors } = mjml2html(mjmlSource, {
      validationLevel: 'soft',
      minify: false,
      filePath: this.templatesDir,
    });

    const issues = (errors ?? []) as Array<{
      formattedMessage?: string;
      message?: string;
    }>;
    if (issues.length > 0) {
      this.logger.warn(
        `MJML soft-validation issues in "${opts.template}": ${issues
          .map((e) => e.formattedMessage ?? e.message ?? '')
          .join('; ')}`,
      );
    }

    // MJML cannot emit head <meta>; declare color-scheme support so clients
    // don't aggressively force-invert the (intentionally light) design.
    const withMeta = html.replace(
      /<head([^>]*)>/i,
      '<head$1><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">',
    );

    return { html: withMeta, text: this.htmlToText(withMeta) };
  }

  /**
   * Translates a catalog key for a locale (with `{placeholder}` interpolation),
   * falling back to English and then the key itself. Used for subject lines.
   *
   * @param {string|null|undefined} locale - recipient locale
   * @param {string} key - catalog key
   * @param {Record<string, any>} [vars] - placeholder values
   * @returns {string} the resolved string
   */
  translate(
    locale: string | null | undefined,
    key: string,
    vars?: Record<string, unknown>,
  ): string {
    const loc = this.normalizeLocale(locale);
    const template =
      (this.catalogs[loc] ?? {})[key] ?? (this.catalogs.en ?? {})[key] ?? key;

    return interpolate(template, vars ?? {});
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Resolves branding for an organization, with the global XISUITE brand as fallback.
   * Cached briefly so outbox batches don't re-query per recipient.
   *
   * @private
   */
  private async resolveBrand(orgId: string | null): Promise<EmailBrand> {
    const appUrl = (
      this.configService.get<string>('appUrl') || 'http://localhost:3000'
    ).replace(/\/+$/, '');

    const fallback: EmailBrand = {
      appName: 'XISUITE',
      orgName: 'XISUITE',
      fromName: 'XISUITE',
      // logoUrl: `${appUrl}/images/logo/xisuite_logo_wide.png`,
      // A local app address cannot be loaded by an outside mailbox, so a public one may be set instead.
      logoUrl:
        process.env.EMAIL_LOGO_URL?.trim() ||
        `${appUrl}/images/logo/xisuite_logo_wide.png`,
      primaryColor: DEFAULT_PRIMARY,
      primaryDark: DEFAULT_PRIMARY_DARK,
      appUrl,
    };

    if (!orgId) return fallback;

    const cached = this.brandCache.get(orgId);
    if (cached && cached.expires > Date.now()) return cached.value;

    try {
      const client = this.supabaseAdmin.getClient();
      const [orgRes, brandingRes] = await Promise.all([
        client.from('organizations').select('name').eq('id', orgId).single(),
        client
          .from('organization_branding')
          .select('logo_light_url, primary_color')
          .eq('organization_id', orgId)
          .maybeSingle(),
      ]);

      const org = orgRes.data as { name?: string } | null;
      const branding = brandingRes.data as {
        logo_light_url?: string;
        primary_color?: string;
      } | null;

      const primaryColor =
        this.normalizeHex(branding?.primary_color) ?? DEFAULT_PRIMARY;
      const value: EmailBrand = {
        appName: 'XISUITE',
        orgName: org?.name || 'XISUITE',
        fromName: org?.name || 'XISUITE',
        logoUrl: branding?.logo_light_url || fallback.logoUrl,
        primaryColor,
        primaryDark:
          primaryColor === DEFAULT_PRIMARY
            ? DEFAULT_PRIMARY_DARK
            : this.darken(primaryColor, 0.12),
        appUrl,
      };

      this.brandCache.set(orgId, {
        value,
        expires: Date.now() + BRAND_CACHE_TTL_MS,
      });

      return value;
    } catch (err) {
      this.logger.warn(
        `Branding lookup failed for org ${orgId}; using XISUITE defaults: ${(err as Error).message}`,
      );

      return fallback;
    }
  }

  /**
   * Compiles (and caches) a top-level template by name.
   *
   * @private
   * @throws {Error} when the template file does not exist
   */
  private getCompiled(name: string): HandlebarsTemplateDelegate {
    const existing = this.compiled.get(name);
    if (existing) return existing;

    const file = path.join(this.templatesDir, `${name}${TEMPLATE_EXT}`);
    if (!fs.existsSync(file)) {
      throw new Error(`Email template not found: ${name} (${file})`);
    }

    const source = fs.readFileSync(file, 'utf8');
    const fn = this.hbs.compile(source, { noEscape: false });
    this.compiled.set(name, fn);

    return fn;
  }

  /**
   * Registers `layout.mjml.hbs` plus every `partials/*.mjml.hbs` as Handlebars partials.
   *
   * @private
   */
  private registerPartials(): void {
    const layoutFile = path.join(this.templatesDir, `layout${TEMPLATE_EXT}`);
    if (fs.existsSync(layoutFile)) {
      this.hbs.registerPartial('layout', fs.readFileSync(layoutFile, 'utf8'));
    }

    if (!fs.existsSync(this.partialsDir)) return;

    for (const f of fs.readdirSync(this.partialsDir)) {
      if (!f.endsWith(TEMPLATE_EXT)) continue;
      const name = f.slice(0, -TEMPLATE_EXT.length);
      this.hbs.registerPartial(
        name,
        fs.readFileSync(path.join(this.partialsDir, f), 'utf8'),
      );
    }
  }

  /**
   * Registers template helpers: `t` (i18n), plus small logic helpers.
   *
   * @private
   */
  private registerHelpers(): void {
    // {{t 'some.key' name=foo}}: translate + interpolate {placeholders}; auto-escaped by Handlebars.
    this.hbs.registerHelper('t', (key: string, options: HbsHelperOptions) => {
      const root = options?.data?.root ?? {};
      const catalog = (root._catalog ?? {}) as Record<string, string>;
      const fallback = (root._fallback ?? {}) as Record<string, string>;
      const template = catalog[key] ?? fallback[key] ?? key;

      return interpolate(template, options?.hash ?? {});
    });

    // {{nl2br text}}: escape then convert newlines to <br>, returned as safe markup.
    const hbs = this.hbs;
    this.hbs.registerHelper('nl2br', (s: unknown) =>
      s == null
        ? ''
        : new hbs.SafeString(
            hbs.Utils.escapeExpression(toDisplayString(s)).replace(
              /\r?\n/g,
              '<br>',
            ),
          ),
    );

    this.hbs.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    this.hbs.registerHelper('ne', (a: unknown, b: unknown) => a !== b);
    this.hbs.registerHelper('or', (...args: unknown[]) =>
      args.slice(0, -1).some(Boolean),
    );
    this.hbs.registerHelper('upper', (s: unknown) =>
      toDisplayString(s).toUpperCase(),
    );
    this.hbs.registerHelper('fallback', (v: unknown, d: unknown) =>
      v == null || v === '' ? d : v,
    );
  }

  /**
   * Loads every `i18n/<locale>.json` catalog found on disk.
   *
   * @private
   */
  private loadCatalogs(): void {
    if (!fs.existsSync(this.i18nDir)) {
      this.logger.warn(`Email i18n dir missing: ${this.i18nDir}`);

      return;
    }

    for (const f of fs.readdirSync(this.i18nDir)) {
      if (!f.endsWith('.json')) continue;
      const locale = f.slice(0, -'.json'.length);
      try {
        this.catalogs[locale] = JSON.parse(
          fs.readFileSync(path.join(this.i18nDir, f), 'utf8'),
        ) as Record<string, string>;
      } catch (err) {
        this.logger.error(`Failed to parse email catalog ${f}`, err as Error);
      }
    }
  }

  /**
   * Normalizes a free-form locale string to a supported locale, defaulting to `en`.
   *
   * @private
   */
  private normalizeLocale(locale?: string | null): EmailLocale {
    const short = (locale || 'en').toLowerCase().split('-')[0];

    return (SUPPORTED_LOCALES as string[]).includes(short)
      ? (short as EmailLocale)
      : 'en';
  }

  /**
   * Validates a `#rrggbb` / `#rgb` hex colour; returns null for anything else
   * (so a malformed org colour can never inject markup into a style attribute).
   *
   * @private
   */
  private normalizeHex(value?: string | null): string | null {
    if (!value) return null;
    const v = value.trim();

    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : null;
  }

  /**
   * Darkens a hex colour by `amount` (0..1) for borders/hover affordances.
   *
   * @private
   */
  private darken(hex: string, amount: number): string {
    let h = hex.replace('#', '');
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    const num = parseInt(h, 16);
    const r = Math.max(0, Math.round(((num >> 16) & 0xff) * (1 - amount)));
    const g = Math.max(0, Math.round(((num >> 8) & 0xff) * (1 - amount)));
    const b = Math.max(0, Math.round((num & 0xff) * (1 - amount)));

    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }

  /**
   * Derives a readable plain-text alternative from the compiled HTML.
   * Keeps link targets as "text (url)" and preserves block boundaries.
   *
   * @private
   */
  private htmlToText(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(
        /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_m: string, href: string, txt: string) => {
          const label = txt.replace(/<[^>]+>/g, '').trim();

          return label && !href.includes(label) ? `${label} (${href})` : href;
        },
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6]|td)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
