/**
 * @fileoverview Transactional email service using Nodemailer SMTP transport.
 * Sends OTP verification, password reset, and organization/space invitation emails,
 * rendered through the MJML-based {@link EmailTemplateService} (brand-aware + localized).
 * Falls back to console logging when SMTP is not configured (development mode), and to a
 * minimal plain email if template rendering ever fails, so a render error never blocks
 * the triggering request.
 * @module src/mail/mail.service
 * @author Prince Jadiya
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { EmailTemplateService } from './email-template.service';

/** Optional per-recipient context for branding + localization. */
export interface MailContext {
  /** Recipient locale (e.g. `users.language`). Defaults to `en`. */
  locale?: string | null;
  /** Organization id used to resolve per-tenant branding. */
  organizationId?: string | null;
}

/**
 * Service responsible for sending all transactional emails in the application.
 *
 * Initializes a Nodemailer SMTP transport on construction if SMTP credentials are configured.
 * When SMTP is not configured, emails are logged to the console for local development.
 *
 * @example
 * constructor(private readonly mailService: MailService) {}
 * await this.mailService.sendSignupOtp('user@example.com', '123456');
 */
@Injectable()
export class MailService {
  /** @private Logger instance scoped to this service */
  private readonly logger = new Logger(MailService.name);

  /** @private Nodemailer transport instance, or null if SMTP is not configured */
  private transporter: nodemailer.Transporter | null = null;

  /**
   * @param {ConfigService} configService - NestJS config service for reading SMTP settings
   * @param {EmailTemplateService} emailTemplates - MJML/Handlebars email renderer
   */
  constructor(
    private readonly configService: ConfigService,
    private readonly emailTemplates: EmailTemplateService,
  ) {
    const enabled =
      this.configService.get<boolean>('smtp.enabled') ??
      process.env.NODE_ENV === 'production';
    const host = this.configService.get<string>('smtp.host');
    const port = this.configService.get<number>('smtp.port') || 587;
    const user =
      this.configService.get<string>('smtp.user') ||
      this.configService.get<string>('smtp.from');
    const pass = this.configService.get<string>('smtp.pass');

    if (enabled && host && user && pass) {
      const rejectUnauthorized =
        this.configService.get<boolean>('smtp.tlsRejectUnauthorized') ??
        process.env.NODE_ENV === 'production';
      this.transporter = nodemailer.createTransport({
        host,
        port,
        // Implicit TLS only on 465; 587/25 negotiate STARTTLS (nodemailer upgrades).
        secure: port === 465,
        auth: { user, pass },
        // Fail fast: without these a blackholed/firewalled relay hangs the awaiting
        // request (signup/invite/reset) instead of surfacing a clear error.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        tls: { rejectUnauthorized },
      });
      if (!rejectUnauthorized && process.env.NODE_ENV === 'production') {
        this.logger.warn(
          'SMTP TLS certificate verification is DISABLED (SMTP_TLS_REJECT_UNAUTHORIZED=false) — the relay connection is exposed to man-in-the-middle. Prefer trusting the relay CA via NODE_EXTRA_CA_CERTS (on-prem: ./certs/extra-ca.pem).',
        );
      }
    } else {
      this.logger.warn(
        enabled
          ? 'SMTP credentials not configured - emails will be logged only'
          : 'SMTP delivery disabled - emails will be logged only',
      );
    }
  }

  /**
   * Whether emails really leave this server. False when SMTP is disabled or not
   * configured: every send is then only logged and still resolves.
   */
  get deliveryEnabled(): boolean {
    return this.transporter !== null;
  }

  /**
   * Escapes HTML special characters to prevent XSS in fallback email bodies.
   *
   * @private
   * @param {string} s - The raw string to escape
   * @returns {string} The HTML-escaped string
   */
  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Validates that a URL is an absolute http(s) link, returning `#` otherwise.
   * Prevents `javascript:` / `data:` URI injection into CTA links.
   *
   * @private
   */
  private safeHttpUrl(url: string): string {
    return /^https?:\/\//i.test(url) ? url : '#';
  }

  /**
   * Returns the configured sender email address, falling back to `noreply@xisuite.com`.
   *
   * @private
   * @returns {string} The sender email address
   */
  private get fromEmail(): string {
    return this.configService.get<string>('smtp.from') || 'noreply@xisuite.com';
  }

  /**
   * Sends an email via the configured SMTP transport, or logs it in development.
   *
   * @private
   * @param {string} to - Recipient email address
   * @param {string} subject - Email subject line
   * @param {string} html - HTML email body
   * @param {string} [text] - Optional plain text fallback body
   * @param {string} [fromName] - Optional sender display name (defaults to XISUITE)
   * @returns {Promise<void>}
   */
  private async send(
    to: string,
    subject: string,
    html: string,
    text?: string,
    fromName = 'XISUITE',
  ): Promise<void> {
    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: `${fromName} <${this.fromEmail}>`,
          to,
          subject,
          html,
          text,
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        this.logger.error(
          `SMTP send to ${to} via ${this.configService.get<string>('smtp.host')}:${this.configService.get<number>('smtp.port') || 587} failed (${e.code ?? 'no-code'}): ${e.message}`,
        );
        throw err;
      }
      this.logger.log(`Email sent to ${to}: ${subject}`);
    } else {
      this.logger.log(`[DEV] Email to ${to}: ${subject}`);
    }
  }

  /**
   * Sends an ad-hoc email with file attachments (e.g. an exported document).
   * Mirrors the private `send()` transport path but adds a nodemailer `attachments`
   * array and accepts one or many recipients. Used by the Document Designer
   * "export by template" automation to deliver the generated file.
   */
  async sendWithAttachments(opts: {
    to: string | string[];
    subject: string;
    html: string;
    text?: string;
    fromName?: string;
    attachments?: Array<{
      filename: string;
      content: Buffer | string;
      contentType?: string;
    }>;
  }): Promise<void> {
    const to = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;
    const attachmentCount = opts.attachments?.length ?? 0;

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: `${opts.fromName ?? 'XISUITE'} <${this.fromEmail}>`,
          to,
          subject: opts.subject,
          html: opts.html,
          text: opts.text,
          attachments: opts.attachments,
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        this.logger.error(
          `SMTP send (with attachments) to ${to} failed (${e.code ?? 'no-code'}): ${e.message}`,
        );
        throw err;
      }
      this.logger.log(
        `Email sent to ${to}: ${opts.subject} (${attachmentCount} attachment(s))`,
      );
    } else {
      this.logger.log(
        `[DEV] Email to ${to}: ${opts.subject} (${attachmentCount} attachment(s))`,
      );
    }
  }

  /**
   * Renders a template and sends it, with a localized subject and a plain-text
   * fallback if rendering fails. Never throws on render errors; only `send()`
   * (the transport) can throw, which callers may choose to retry.
   *
   * @private
   */
  private async deliver(opts: {
    to: string;
    template: string;
    /** Explicit subject; when set, `subjectKey` is ignored. */
    subject?: string;
    subjectKey?: string;
    subjectVars?: Record<string, any>;
    fallbackSubject: string;
    fallbackText: string;
    locale?: string | null;
    organizationId?: string | null;
    data?: Record<string, any>;
  }): Promise<void> {
    const locale = opts.locale ?? 'en';
    let subject = opts.subject ?? opts.fallbackSubject;
    let html: string | undefined;
    let text: string | undefined;

    try {
      if (!opts.subject && opts.subjectKey) {
        subject =
          this.emailTemplates.translate(
            locale,
            opts.subjectKey,
            opts.subjectVars,
          ) || opts.fallbackSubject;
      }
      const rendered = await this.emailTemplates.render({
        template: opts.template,
        locale,
        organizationId: opts.organizationId ?? null,
        data: opts.data ?? {},
      });
      html = rendered.html;
      text = rendered.text;
    } catch (err) {
      this.logger.error(
        `Email render failed for "${opts.template}"; sending plain fallback`,
        err as Error,
      );
    }

    if (!html) {
      html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22303E;padding:16px"><p style="margin:0">${this.escapeHtml(
        opts.fallbackText,
      ).replace(/\r?\n/g, '<br>')}</p></div>`;
      text = opts.fallbackText;
    }

    await this.send(opts.to, subject, html, text);
  }

  /**
   * Sends a signup OTP verification email to a newly registered user.
   *
   * @param {string} email - Recipient email address
   * @param {string} otp - The 6-digit OTP verification code
   * @param {MailContext} [ctx] - Optional branding/locale context
   * @returns {Promise<void>}
   */
  async sendSignupOtp(
    email: string,
    otp: string,
    ctx?: MailContext,
  ): Promise<void> {
    await this.deliver({
      to: email,
      template: 'auth-otp',
      subjectKey: 'subject.auth.otp.signup',
      fallbackSubject: 'Verify your email to finish signing up',
      fallbackText: `Welcome to XISUITE!\n\nYour verification code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
      locale: ctx?.locale,
      organizationId: ctx?.organizationId,
      data: {
        titleKey: 'auth.otp.signup.title',
        introKey: 'auth.otp.signup.intro',
        otp,
        preheader: this.emailTemplates.translate(
          ctx?.locale,
          'auth.otp.preheader',
        ),
      },
    });
  }

  /**
   * Sends a verification OTP email for re-verification requests.
   *
   * @param {string} email - Recipient email address
   * @param {string} otp - The 6-digit OTP verification code
   * @param {MailContext} [ctx] - Optional branding/locale context
   * @returns {Promise<void>}
   */
  async sendVerificationOtp(
    email: string,
    otp: string,
    ctx?: MailContext,
  ): Promise<void> {
    await this.deliver({
      to: email,
      template: 'auth-otp',
      subjectKey: 'subject.auth.otp.verify',
      fallbackSubject: 'Verify your email',
      fallbackText: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
      locale: ctx?.locale,
      organizationId: ctx?.organizationId,
      data: {
        titleKey: 'auth.otp.verify.title',
        introKey: 'auth.otp.verify.intro',
        otp,
        preheader: this.emailTemplates.translate(
          ctx?.locale,
          'auth.otp.preheader',
        ),
      },
    });
  }

  /**
   * Sends a password reset email with a secure link.
   *
   * @param {string} email - Recipient email address
   * @param {string} resetLink - The password reset URL generated by Supabase
   * @param {string} [firstName] - The user's first name for a personalized greeting
   * @param {MailContext} [ctx] - Optional branding/locale context
   * @returns {Promise<void>}
   */
  async sendPasswordReset(
    email: string,
    resetLink: string,
    firstName?: string,
    ctx?: MailContext,
  ): Promise<void> {
    await this.deliver({
      to: email,
      template: 'auth-password-reset',
      subjectKey: 'subject.auth.reset',
      fallbackSubject: 'Reset your password',
      fallbackText: `We received a request to reset your password. Open this link to choose a new one: ${this.safeHttpUrl(
        resetLink,
      )}\n\nIf you didn't request this, you can ignore this email. The link expires in 24 hours.`,
      locale: ctx?.locale,
      organizationId: ctx?.organizationId,
      data: {
        name: firstName,
        ctaUrl: this.safeHttpUrl(resetLink),
        preheader: this.emailTemplates.translate(
          ctx?.locale,
          'auth.reset.preheader',
        ),
      },
    });
  }

  /**
   * Sends a welcome email after a user verifies their account (optional).
   *
   * @param {string} email - Recipient email address
   * @param {object} data - Welcome details
   * @param {string} [data.firstName] - Recipient first name
   * @param {string} [data.ctaUrl] - Link to open the app
   * @param {MailContext} [ctx] - Optional branding/locale context
   * @returns {Promise<void>}
   */
  async sendWelcome(
    email: string,
    data: { firstName?: string; ctaUrl?: string },
    ctx?: MailContext,
  ): Promise<void> {
    await this.deliver({
      to: email,
      template: 'auth-welcome',
      subjectKey: 'subject.auth.welcome',
      fallbackSubject: 'Welcome to XISUITE',
      fallbackText: `Your email is verified and your account is ready.${
        data.ctaUrl ? ` Open XISUITE: ${this.safeHttpUrl(data.ctaUrl)}` : ''
      }`,
      locale: ctx?.locale,
      organizationId: ctx?.organizationId,
      data: {
        name: data.firstName,
        ctaUrl: data.ctaUrl ? this.safeHttpUrl(data.ctaUrl) : undefined,
        preheader: this.emailTemplates.translate(
          ctx?.locale,
          'auth.welcome.preheader',
        ),
      },
    });
  }

  /**
   * Sends an organization invitation email.
   *
   * @param {string} email - Recipient email address
   * @param {object} data - Invitation details
   * @param {string} data.invitationLink - The invitation acceptance URL
   * @param {string} data.organizationName - Name of the inviting organization
   * @param {string} data.firstName - Invitee's first name
   * @param {string} data.lastName - Invitee's last name
   * @param {string} data.role - The role being offered (e.g., `'member'`, `'admin'`)
   * @param {string} [data.organizationId] - Org id (for branded email)
   * @param {string} [data.locale] - Recipient locale
   * @returns {Promise<void>}
   */
  async sendInvitation(
    email: string,
    data: {
      invitationLink: string;
      organizationName: string;
      firstName: string;
      lastName: string;
      role: string;
      organizationId?: string;
      locale?: string | null;
    },
  ): Promise<void> {
    await this.deliver({
      to: email,
      template: 'invite-organization',
      subjectKey: 'subject.invite.org',
      subjectVars: { org: data.organizationName },
      fallbackSubject: `You've been invited to join ${data.organizationName}`,
      fallbackText: `You've been invited to join ${data.organizationName} as ${data.role}. Accept your invitation: ${this.safeHttpUrl(
        data.invitationLink,
      )}`,
      locale: data.locale,
      organizationId: data.organizationId,
      data: {
        name: data.firstName,
        org: data.organizationName,
        role: data.role,
        ctaUrl: this.safeHttpUrl(data.invitationLink),
        preheader: this.emailTemplates.translate(
          data.locale,
          'invite.org.preheader',
          { org: data.organizationName },
        ),
      },
    });
  }

  /**
   * Sends a space-level invitation email with space and organization context.
   *
   * @param {string} email - Recipient email address
   * @param {object} data - Space invitation details
   * @param {string} data.invitationLink - The invitation acceptance URL
   * @param {string} data.organizationName - Name of the organization
   * @param {string} data.spaceName - Name of the space being invited to
   * @param {string} data.firstName - Invitee's first name
   * @param {string} data.spaceRole - The space role being offered
   * @param {string} data.inviterName - Name of the person who sent the invitation
   * @param {string} data.expiresAt - ISO timestamp of when the invitation expires
   * @param {string} [data.organizationId] - Org id (for branded email)
   * @param {string} [data.locale] - Recipient locale
   * @returns {Promise<void>}
   */
  async sendSpaceInvitation(
    email: string,
    data: {
      invitationLink: string;
      organizationName: string;
      spaceName: string;
      firstName: string;
      spaceRole: string;
      inviterName: string;
      expiresAt: string;
      organizationId?: string;
      locale?: string | null;
    },
  ): Promise<void> {
    const locale = data.locale ?? 'en';
    const expiryDate = new Date(data.expiresAt).toLocaleDateString(
      locale === 'de' ? 'de-DE' : 'en-US',
      { year: 'numeric', month: 'long', day: 'numeric' },
    );

    await this.deliver({
      to: email,
      template: 'invite-space',
      subjectKey: 'subject.invite.space',
      subjectVars: { space: data.spaceName },
      fallbackSubject: `You've been invited to join ${data.spaceName} on ${data.organizationName}`,
      fallbackText: `${data.inviterName} invited you to join the ${data.spaceName} space in ${data.organizationName} as ${data.spaceRole}. Accept your invitation: ${this.safeHttpUrl(
        data.invitationLink,
      )}`,
      locale,
      organizationId: data.organizationId,
      data: {
        name: data.firstName,
        inviter: data.inviterName,
        space: data.spaceName,
        org: data.organizationName,
        role: data.spaceRole,
        date: expiryDate,
        ctaUrl: this.safeHttpUrl(data.invitationLink),
        preheader: this.emailTemplates.translate(
          locale,
          'invite.space.preheader',
          { space: data.spaceName },
        ),
      },
    });
  }

  /**
   * Sends a notification email rendered with the branded notification template.
   * This is the rich entry point used by the notification email outbox dispatcher.
   *
   * @param {string} to - Recipient email address (validated against a simple email regex)
   * @param {object} payload - Notification content
   * @param {string} payload.title - Notification title (already localized upstream)
   * @param {string} [payload.body] - Notification body text
   * @param {string} [payload.eyebrow] - Small contextual label (e.g. notification type)
   * @param {string} [payload.ctaUrl] - Optional deep-link target
   * @param {string} [payload.ctaLabel] - Optional CTA label
   * @param {string} [payload.recipientName] - Recipient first name for the greeting
   * @param {string} [payload.preferencesUrl] - Manage-preferences link for the footer
   * @param {string} [payload.subject] - Explicit subject (defaults to the title)
   * @param {MailContext} [ctx] - Optional branding/locale context
   * @returns {Promise<void>}
   * @throws {Error} when `to` is not a valid-looking email address
   */
  async sendNotification(
    to: string,
    payload: {
      title: string;
      body?: string;
      eyebrow?: string;
      ctaUrl?: string;
      ctaLabel?: string;
      recipientName?: string;
      preferencesUrl?: string;
      subject?: string;
      /** A second, plain link under the button (e.g. "View build" next to the task link). */
      secondaryUrl?: string;
      secondaryLabel?: string;
    },
    ctx?: MailContext,
  ): Promise<void> {
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_RE.test(to)) {
      throw new Error(`Invalid recipient email address: ${to}`);
    }

    const secondaryUrl =
      payload.secondaryUrl && /^https?:\/\//i.test(payload.secondaryUrl)
        ? payload.secondaryUrl
        : undefined;

    await this.deliver({
      to,
      template: 'notification',
      subject: payload.subject || payload.title,
      fallbackSubject: payload.title,
      fallbackText: `${payload.title}${payload.body ? `\n\n${payload.body}` : ''}${
        payload.ctaUrl ? `\n\n${this.safeHttpUrl(payload.ctaUrl)}` : ''
      }${secondaryUrl ? `\n\n${payload.secondaryLabel ?? ''}: ${secondaryUrl}` : ''}`,
      locale: ctx?.locale,
      organizationId: ctx?.organizationId,
      data: {
        eyebrow: payload.eyebrow,
        title: payload.title,
        body: payload.body,
        recipientName: payload.recipientName,
        ctaUrl: payload.ctaUrl ? this.safeHttpUrl(payload.ctaUrl) : undefined,
        ctaLabel: payload.ctaLabel,
        preferencesUrl: payload.preferencesUrl
          ? this.safeHttpUrl(payload.preferencesUrl)
          : undefined,
        secondaryUrl,
        secondaryLabel: secondaryUrl ? payload.secondaryLabel : undefined,
        preheader: payload.body,
      },
    });
  }

  /** One string from the email catalogs (`mail/i18n`) in `locale`, English as fallback. */
  translate(
    locale: string | null | undefined,
    key: string,
    vars?: Record<string, unknown>,
  ): string {
    return this.emailTemplates.translate(locale, key, vars);
  }

  /**
   * Sends a calendar entry reminder rendered with the branded reminder template.
   *
   * @param {string} to - Recipient email address
   * @param {object} payload - What the reminder says: title, the entry's parts and its links
   * @param {MailContext} [ctx] - Optional branding/locale context
   * @returns {Promise<void>}
   * @throws {Error} when `to` is not a valid-looking email address
   */
  async sendCalendarReminder(
    to: string,
    payload: {
      title: string;
      summary: string;
      when?: string;
      calendar?: string;
      location?: string;
      ctaUrl: string;
      meetingUrl?: string;
      recipientName?: string;
    },
    ctx?: MailContext,
  ): Promise<void> {
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_RE.test(to)) {
      throw new Error(`Invalid recipient email address: ${to}`);
    }

    const lines = [payload.summary, payload.when, payload.calendar]
      .filter(Boolean)
      .join('\n');

    await this.deliver({
      to,
      template: 'calendar-reminder',
      subject: payload.title,
      fallbackSubject: payload.title,
      fallbackText: `${payload.title}\n\n${lines}\n\n${this.safeHttpUrl(payload.ctaUrl)}`,
      locale: ctx?.locale,
      organizationId: ctx?.organizationId,
      data: {
        title: payload.title,
        summary: payload.summary,
        when: payload.when,
        calendar: payload.calendar,
        location: payload.location,
        recipientName: payload.recipientName,
        ctaUrl: this.safeHttpUrl(payload.ctaUrl),
        meetingUrl: payload.meetingUrl
          ? this.safeHttpUrl(payload.meetingUrl)
          : undefined,
        preheader: lines,
      },
    });
  }

  /**
   * Back-compatible plain notification email used by the workflow_outbox
   * SendNotification dispatcher and reminder crons. The subject/body are already
   * templated upstream; here they are rendered inside the branded notification
   * shell so all emails share one look.
   *
   * @param {string} to - Recipient email address
   * @param {string} subject - Email subject line (already templated upstream)
   * @param {string} body - Plain-text email body
   * @param {MailContext} [ctx] - Optional branding/locale context
   * @returns {Promise<void>}
   * @throws {Error} when `to` is not a valid-looking email address
   */
  async sendNotificationEmail(
    to: string,
    subject: string,
    body: string,
    ctx?: MailContext,
  ): Promise<void> {
    await this.sendNotification(to, { title: subject, body, subject }, ctx);
  }
}
