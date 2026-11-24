import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { EmailTemplateService } from './email-template.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

interface MailCall {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
}

describe('MailService', () => {
  let service: MailService;
  let mockSendMail: jest.Mock;

  function getLastMailCall(): MailCall {
    const calls = mockSendMail.mock.calls as MailCall[][];
    return calls[0][0];
  }

  beforeEach(() => {
    mockSendMail = jest.fn().mockResolvedValue(true);

    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        const config: Record<string, string | number> = {
          'smtp.host': 'smtp.test.com',
          'smtp.port': 587,
          'smtp.from': 'test@example.com',
          'smtp.pass': 'password',
        };
        return config[key];
      }),
    } as unknown as ConfigService;

    // Real template engine: these tests assert on the *rendered* MJML/Handlebars
    // output (escaping, interpolated names), so a stubbed renderer would silently
    // exercise MailService's plain-text fallback instead of the real path.
    // Branding is only fetched for a non-null organizationId, which no test passes,
    // so the Supabase admin client is never touched.
    const emailTemplates = new EmailTemplateService(configService, {
      getClient: jest.fn(),
    } as unknown as SupabaseAdminService);
    emailTemplates.onModuleInit();

    service = new MailService(configService, emailTemplates);
    (
      service as unknown as { transporter: { sendMail: jest.Mock } }
    ).transporter = { sendMail: mockSendMail };
  });

  describe('sendSignupOtp', () => {
    it('should send email with correct subject', async () => {
      await service.sendSignupOtp('user@example.com', '123456');
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          // Localized via the i18n catalog key `subject.auth.otp.signup`.
          subject: 'Verify your email to finish signing up',
        }),
      );
    });

    it('should include OTP in the email body', async () => {
      await service.sendSignupOtp('user@example.com', '123456');
      const call = getLastMailCall();
      expect(call.html).toContain('123456');
    });
  });

  describe('sendVerificationOtp', () => {
    it('should send email with correct subject', async () => {
      await service.sendVerificationOtp('user@example.com', '654321');
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          // Localized via the i18n catalog key `subject.auth.otp.verify`.
          subject: 'Verify your email',
        }),
      );
    });
  });

  describe('sendPasswordReset', () => {
    it('should include firstName in greeting', async () => {
      await service.sendPasswordReset(
        'user@example.com',
        'https://reset.link',
        'Prince',
      );
      const call = getLastMailCall();
      expect(call.html).toContain('Prince');
    });

    it('should handle missing firstName', async () => {
      await service.sendPasswordReset('user@example.com', 'https://reset.link');
      const call = getLastMailCall();
      // Template greets with `auth.reset.greeting` + the 'there' name fallback.
      expect(call.html).toContain('Hi there,');
    });
  });

  describe('sendInvitation', () => {
    it('should include org name and role', async () => {
      await service.sendInvitation('user@example.com', {
        invitationLink: 'https://invite.link',
        organizationName: 'ABJ Experts',
        firstName: 'Test',
        lastName: 'User',
        role: 'member',
      });
      const call = getLastMailCall();
      expect(call.html).toContain('ABJ Experts');
      expect(call.html).toContain('member');
    });
  });

  describe('sendSpaceInvitation', () => {
    it('should include space name and inviter', async () => {
      await service.sendSpaceInvitation('user@example.com', {
        invitationLink: 'https://invite.link',
        organizationName: 'ABJ',
        spaceName: 'Engineering',
        firstName: 'Test',
        spaceRole: 'admin',
        inviterName: 'Prince',
        expiresAt: '2099-01-01',
      });
      const call = getLastMailCall();
      expect(call.html).toContain('Engineering');
      expect(call.html).toContain('Prince');
    });
  });

  describe('HTML escaping', () => {
    it('should escape <script> tags in user-controlled fields', async () => {
      await service.sendInvitation('user@example.com', {
        invitationLink: 'https://invite.link',
        organizationName: '<script>alert("xss")</script>',
        firstName: '<img src=x onerror=alert(1)>',
        lastName: 'User',
        role: 'member',
      });
      const call = getLastMailCall();
      expect(call.html).not.toContain('<script>');
      expect(call.html).toContain('&lt;script&gt;');
      expect(call.html).not.toContain('<img src=x');
    });
  });

  describe('fallback when SMTP not configured', () => {
    it('should not crash when transporter is null', async () => {
      (service as unknown as { transporter: null }).transporter = null;
      await expect(
        service.sendSignupOtp('user@example.com', '123456'),
      ).resolves.not.toThrow();
    });
  });

  describe('sendNotificationEmail', () => {
    it('sends a notification email with subject, text body, and wrapped html', async () => {
      await service.sendNotificationEmail(
        'user@example.com',
        'Task assigned',
        'You have been assigned to "Fix bug #42".',
      );

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const call = getLastMailCall();
      expect(call.to).toBe('user@example.com');
      expect(call.subject).toBe('Task assigned');
      // The plain-text alternative is now derived from the rendered HTML (so it
      // also carries the title/footer); it must still carry the body verbatim.
      expect(call.text).toContain('You have been assigned to "Fix bug #42".');
      // `send()` builds an RFC 5322 From header with the brand display name.
      expect(call.from).toBe('XISUITE <test@example.com>');
      // Body is HTML-escaped (the quotes become &quot;) and wrapped in a div.
      expect(call.html).toContain('<div');
      expect(call.html).toContain('&quot;Fix bug #42&quot;');
    });

    it('converts newlines in the body to <br> in the HTML version', async () => {
      await service.sendNotificationEmail(
        'user@example.com',
        'Multiline',
        'line1\nline2\r\nline3',
      );
      const call = getLastMailCall();
      expect(call.html).toContain('line1<br>line2<br>line3');
      // Original newlines are preserved in the plain-text version.
      expect(call.text).toContain('line1\nline2');
    });

    it('escapes HTML in the body to prevent injection', async () => {
      await service.sendNotificationEmail(
        'user@example.com',
        'Subj',
        '<script>alert("xss")</script>',
      );
      const call = getLastMailCall();
      expect(call.html).not.toContain('<script>');
      expect(call.html).toContain('&lt;script&gt;');
    });

    it('throws when the recipient is not a valid email address', async () => {
      await expect(
        service.sendNotificationEmail('not-an-email', 'Subj', 'Body'),
      ).rejects.toThrow(/Invalid recipient email address/);
      expect(mockSendMail).not.toHaveBeenCalled();
    });
  });
});
