import { RecaptchaVerifierService } from './recaptcha-verifier.service';

describe('RecaptchaVerifierService', () => {
  let service: RecaptchaVerifierService;
  let fetchMock: jest.Mock;

  const ok = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });

  beforeEach(() => {
    service = new RecaptchaVerifierService();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // A bot posts no token at all; that must never reach Google, let alone pass.
  it.each([undefined, null, '', '   ', 42, {}])(
    'rejects a non-token value (%p) without calling Google',
    async (token) => {
      const result = await service.verify('secret', token);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('missing-token');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('accepts a successful v2 solve', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));

    await expect(service.verify('secret', 'tok')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('sends the secret and token to siteverify', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));

    await service.verify('s3cr3t', 'tok', { remoteIp: '1.2.3.4' });

    const [url, init] = fetchMock.mock.calls[0];
    const body = String((init as { body: URLSearchParams }).body);

    expect(url).toContain('siteverify');
    expect(body).toContain('secret=s3cr3t');
    expect(body).toContain('response=tok');
    expect(body).toContain('remoteip=1.2.3.4');
  });

  // A forwarded-for chain is not a single address; sending it would be worse than sending nothing.
  it('omits a comma-joined remote ip', async () => {
    fetchMock.mockResolvedValue(ok({ success: true }));

    await service.verify('secret', 'tok', { remoteIp: '1.2.3.4, 5.6.7.8' });

    expect(String(fetchMock.mock.calls[0][1].body)).not.toContain('remoteip');
  });

  it('rejects when Google says the token is bad', async () => {
    fetchMock.mockResolvedValue(
      ok({ success: false, 'error-codes': ['invalid-input-response'] }),
    );

    await expect(service.verify('secret', 'tok')).resolves.toMatchObject({
      ok: false,
      reason: 'rejected',
      errorCodes: ['invalid-input-response'],
    });
  });

  describe('v3 scoring', () => {
    it('rejects a passing token whose score is below the threshold', async () => {
      fetchMock.mockResolvedValue(ok({ success: true, score: 0.1 }));

      await expect(
        service.verify('secret', 'tok', { version: 'v3' }),
      ).resolves.toMatchObject({ ok: false, reason: 'low-score', score: 0.1 });
    });

    it('accepts a score at or above the threshold', async () => {
      fetchMock.mockResolvedValue(ok({ success: true, score: 0.9 }));

      await expect(
        service.verify('secret', 'tok', { version: 'v3' }),
      ).resolves.toMatchObject({ ok: true, score: 0.9 });
    });

    it('honours a per-field threshold', async () => {
      fetchMock.mockResolvedValue(ok({ success: true, score: 0.6 }));

      await expect(
        service.verify('secret', 'tok', { version: 'v3', minScore: 0.8 }),
      ).resolves.toMatchObject({ ok: false, reason: 'low-score' });
    });

    // success:true with no score would otherwise default to "pass" and let every bot through.
    it('treats a missing score as zero', async () => {
      fetchMock.mockResolvedValue(ok({ success: true }));

      await expect(
        service.verify('secret', 'tok', { version: 'v3' }),
      ).resolves.toMatchObject({ ok: false, reason: 'low-score' });
    });

    it('does not score a v2 solve', async () => {
      fetchMock.mockResolvedValue(ok({ success: true, score: 0.1 }));

      await expect(
        service.verify('secret', 'tok', { version: 'v2_checkbox' }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  // A Checkbox key and an Invisible/v3 key are indistinguishable by inspection, and the wrong one
  // renders a BLANK widget with no error. This probe is the only way to catch that before a visitor.
  describe('probeSiteKey', () => {
    const KEY = '6LcTestKeyTestKeyTestKeyTestKey00000000';
    const ORIGIN = 'https://forms.example.com';

    const anchor = (rejected: boolean) => ({
      ok: true,
      status: 200,
      text: async () =>
        rejected
          ? '<html>recaptcha.anchor.ErrorMain.init("[\\x22ainput\\x22]")</html>'
          : '<html>recaptcha widget markup</html>',
    });

    /** Routes by URL so checkbox/invisible/siteverify can each be answered differently. */
    function route(handlers: {
      normal?: unknown;
      invisible?: unknown;
      siteverify?: unknown;
    }) {
      fetchMock.mockImplementation((url: string) => {
        if (String(url).includes('siteverify')) {
          return Promise.resolve(handlers.siteverify ?? ok({ success: false }));
        }

        return Promise.resolve(
          String(url).includes('size=invisible')
            ? (handlers.invisible ?? anchor(false))
            : (handlers.normal ?? anchor(false)),
        );
      });
    }

    it('identifies an invisible-only key', async () => {
      route({ normal: anchor(true), invisible: anchor(false) });

      await expect(
        service.probeSiteKey(KEY, undefined, ORIGIN),
      ).resolves.toMatchObject({
        supportsCheckbox: false,
        supportsInvisible: true,
      });
    });

    it('identifies a checkbox-only key', async () => {
      route({ normal: anchor(false), invisible: anchor(true) });

      await expect(
        service.probeSiteKey(KEY, undefined, ORIGIN),
      ).resolves.toMatchObject({
        supportsCheckbox: true,
        supportsInvisible: false,
      });
    });

    // Fails OPEN: this is advisory, so an outage must never accuse a good key.
    it('reports unknown when Google is unreachable', async () => {
      fetchMock.mockRejectedValue(new Error('ENOTFOUND'));

      await expect(
        service.probeSiteKey(KEY, 'secret', ORIGIN),
      ).resolves.toEqual({
        supportsCheckbox: null,
        supportsInvisible: null,
        secretValid: null,
      });
    });

    // Google refuses every size when no origin is sent, so probing without one reported a perfectly
    // good key as supporting nothing. Caught by running the probe against a real key pair.
    it('gives no opinion when no origin is supplied', async () => {
      route({});

      const result = await service.probeSiteKey(KEY, undefined, undefined);

      expect(result.supportsCheckbox).toBeNull();
      expect(result.supportsInvisible).toBeNull();
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes('anchor')),
      ).toHaveLength(0);
    });

    it('sends the origin as base64 `co`', async () => {
      route({});
      await service.probeSiteKey(KEY, undefined, ORIGIN);

      const expected = Buffer.from(ORIGIN, 'utf8')
        .toString('base64')
        .replace(/=/g, '.');

      expect(String(fetchMock.mock.calls[0][0])).toContain(`co=${expected}`);
    });

    it('does not call Google for a malformed site key', async () => {
      const result = await service.probeSiteKey('nope', undefined, ORIGIN);

      expect(result.supportsCheckbox).toBeNull();
      expect(result.supportsInvisible).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('secret checking', () => {
      it('flags a secret Google does not recognise', async () => {
        route({
          siteverify: ok({
            success: false,
            'error-codes': ['invalid-input-secret'],
          }),
        });

        await expect(
          service.probeSiteKey(KEY, 'wrong', ORIGIN),
        ).resolves.toMatchObject({
          secretValid: false,
        });
      });

      // Google objecting only to the junk token means the SECRET was accepted.
      it('accepts a secret when only the token is rejected', async () => {
        route({
          siteverify: ok({
            success: false,
            'error-codes': ['invalid-input-response'],
          }),
        });

        await expect(
          service.probeSiteKey(KEY, 'right', ORIGIN),
        ).resolves.toMatchObject({
          secretValid: true,
        });
      });

      it('never sends the secret when none was supplied', async () => {
        route({});

        const result = await service.probeSiteKey(KEY, undefined, ORIGIN);

        expect(result.secretValid).toBeNull();
        expect(
          fetchMock.mock.calls.filter((c) =>
            String(c[0]).includes('siteverify'),
          ),
        ).toHaveLength(0);
      });
    });
  });

  // Fail CLOSED: a Google outage must not become an open door on a form that asked for protection.
  describe('failing closed', () => {
    it('rejects on a network error', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.verify('secret', 'tok')).resolves.toMatchObject({
        ok: false,
        reason: 'verify-unavailable',
      });
    });

    it('rejects on a non-200 response', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      });

      await expect(service.verify('secret', 'tok')).resolves.toMatchObject({
        ok: false,
        reason: 'verify-unavailable',
      });
    });

    it('rejects on an unparseable body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      });

      await expect(service.verify('secret', 'tok')).resolves.toMatchObject({
        ok: false,
        reason: 'verify-unavailable',
      });
    });
  });
});
