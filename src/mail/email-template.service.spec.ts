import { ConfigService } from '@nestjs/config';
import mjml2html from 'mjml';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { EmailTemplateService } from './email-template.service';

jest.mock('mjml', () => jest.fn(jest.requireActual<typeof mjml2html>('mjml')));

describe('EmailTemplateService', () => {
  it('renders HTML and text without invoking the vulnerable MJML minifier', async () => {
    const service = new EmailTemplateService(
      new ConfigService({ appUrl: 'https://app.example.com' }),
      { getClient: jest.fn() } as unknown as SupabaseAdminService,
    );
    service.onModuleInit();

    const result = await service.render({
      template: 'notification',
      data: { title: 'Task assigned', body: 'Review <changes>\nToday' },
    });

    expect(mjml2html).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ minify: false }),
    );
    expect(result.html).toContain('Review &lt;changes&gt;<br>Today');
    expect(result.html).toContain('name="color-scheme"');
    expect(result.text).toContain('Review <changes>\nToday');
  });
});
