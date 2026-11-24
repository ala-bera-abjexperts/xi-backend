import {
  validateNonGoogleProvider,
  VERIFIABLE_PROVIDERS,
} from './connection-validators';

// The validators make a single live "whoami" fetch per provider — mock global fetch so no
// network is hit and we can assert the URL/auth + status mapping (2xx→active, 401/403→invalid, else→error).
describe('connection-validators', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const mockFetch = (status: number, body: unknown = {}) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      headers: { get: () => null },
    }) as unknown as typeof fetch;
  };

  const lastCall = () =>
    (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];

  it('registers the new hubspot + twilio validators', () => {
    expect(VERIFIABLE_PROVIDERS).toEqual(
      expect.arrayContaining(['hubspot', 'twilio']),
    );
  });

  it('returns unsupported for a provider with no validator', async () => {
    const r = await validateNonGoogleProvider('nope', 'x', {});

    expect(r.status).toBe('unsupported');
  });

  describe('twilio (Basic auth, account_sid from metadata)', () => {
    it('errors when account_sid metadata is missing (no fetch)', async () => {
      global.fetch = jest.fn() as unknown as typeof fetch;
      const r = await validateNonGoogleProvider('twilio', 'token', {});

      expect(r.status).toBe('error');
      expect(r.detail).toMatch(/Account SID/i);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('active on 200 and hits the Accounts URL with a Basic header', async () => {
      mockFetch(200);
      const r = await validateNonGoogleProvider('twilio', 'token', {
        account_sid: 'AC123',
      });

      expect(r.status).toBe('active');
      const [url, init] = lastCall();

      expect(url).toContain('api.twilio.com/2010-04-01/Accounts/AC123.json');
      expect((init.headers as Record<string, string>).Authorization).toMatch(
        /^Basic /,
      );
    });

    it('invalid on 401', async () => {
      mockFetch(401);
      const r = await validateNonGoogleProvider('twilio', 'bad', {
        account_sid: 'AC123',
      });

      expect(r.status).toBe('invalid');
    });
  });

  describe('hubspot (Bearer)', () => {
    it('active on 200 and hits the CRM contacts endpoint with a Bearer header', async () => {
      mockFetch(200);
      const r = await validateNonGoogleProvider('hubspot', 'pat', {});

      expect(r.status).toBe('active');
      const [url, init] = lastCall();

      expect(url).toContain('api.hubapi.com/crm/v3/objects/contacts');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer pat',
      );
    });

    it('invalid on 403 (token lacking CRM scope)', async () => {
      mockFetch(403);
      const r = await validateNonGoogleProvider('hubspot', 'pat', {});

      expect(r.status).toBe('invalid');
    });
  });

  describe('mapHttpStatus (via github)', () => {
    it('maps 429 to error (transient, not invalid)', async () => {
      mockFetch(429);
      const r = await validateNonGoogleProvider('github', 'token', {});

      expect(r.status).toBe('error');
    });
  });

  it('never throws — a network failure degrades to error', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const r = await validateNonGoogleProvider('hubspot', 'pat', {});

    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/reach provider/i);
  });
});
