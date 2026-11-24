import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  // A minimal, fully-valid production config. Every test starts from a clone of
  // this and removes / overrides only what it needs.
  const baseProdConfig = (): Record<string, unknown> => ({
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_JWT_SECRET: 'a'.repeat(64),
    SESSION_SIGNING_SECRET: 'b'.repeat(32),
  });

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does NOT throw in production when MCP_S2S_SIGNING_SECRET is absent', () => {
    const config = baseProdConfig();

    // Regression guard: a non-MCP production deployment must still boot.
    expect(() => validateEnv(config)).not.toThrow();
  });

  it('returns the config and warns when MCP_S2S_SIGNING_SECRET is absent in production', () => {
    const config = baseProdConfig();

    const result = validateEnv(config);

    expect(result).toBe(config);
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes('MCP_S2S_SIGNING_SECRET'),
    );

    expect(warned).toBe(true);
  });

  it('does not emit the MCP warning when the secret IS set in production', () => {
    const config = baseProdConfig();

    config.MCP_S2S_SIGNING_SECRET = 'c'.repeat(40);

    validateEnv(config);

    const warnedAboutMcp = warnSpy.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes('MCP_S2S_SIGNING_SECRET'),
    );

    expect(warnedAboutMcp).toBe(false);
  });

  it('still throws in production when a genuinely required var is missing', () => {
    const config = baseProdConfig();

    delete config.SUPABASE_URL;

    expect(() => validateEnv(config)).toThrow(/Environment validation failed/);
  });

  it('fails production startup when passkeys are enabled without security configuration', () => {
    const config = {
      ...baseProdConfig(),
      PASSKEY_AUTH_ENABLED: 'true',
    };

    expect(() => validateEnv(config)).toThrow(/PASSKEY_ORIGIN/);
    expect(() => validateEnv(config)).toThrow(/PASSKEY_TRUSTED_DEVICE_SECRET/);
  });

  it('accepts a complete production passkey configuration', () => {
    const config = {
      ...baseProdConfig(),
      PASSKEY_AUTH_ENABLED: 'true',
      PASSKEY_ORIGIN: 'https://auth.xisuite.cloud',
      PASSKEY_TRUSTED_DEVICE_SECRET: 'p'.repeat(32),
      PASSKEY_COUNTRY_HEADER: 'x-vercel-ip-country',
      PASSKEY_TRUSTED_DEVICE_TTL_DAYS: '90',
      PASSKEY_RECENT_TOTP_SECONDS: '600',
    };

    expect(() => validateEnv(config)).not.toThrow();
  });

  it('rejects placeholder secrets and non-canonical production origins', () => {
    const placeholder = {
      ...baseProdConfig(),
      PASSKEY_AUTH_ENABLED: 'true',
      PASSKEY_ORIGIN: 'https://auth.xisuite.cloud/',
      PASSKEY_TRUSTED_DEVICE_SECRET: '__SET_ME_TO_A_RANDOM_32_CHAR_STRING__',
    };
    const insecure = {
      ...baseProdConfig(),
      PASSKEY_AUTH_ENABLED: 'true',
      PASSKEY_ORIGIN: 'http://auth.xisuite.cloud',
      PASSKEY_TRUSTED_DEVICE_SECRET: 'p'.repeat(32),
    };

    expect(() => validateEnv(placeholder)).toThrow(/placeholder/);
    expect(() => validateEnv(placeholder)).toThrow(/exact origin/);
    expect(() => validateEnv(insecure)).toThrow(/HTTPS/);
  });

  it('bounds passkey trust and recent-TOTP windows', () => {
    const config = {
      ...baseProdConfig(),
      PASSKEY_AUTH_ENABLED: 'true',
      PASSKEY_ORIGIN: 'https://auth.xisuite.cloud',
      PASSKEY_TRUSTED_DEVICE_SECRET: 'p'.repeat(32),
      PASSKEY_TRUSTED_DEVICE_TTL_DAYS: '0',
      PASSKEY_RECENT_TOTP_SECONDS: '3601',
    };

    expect(() => validateEnv(config)).toThrow(/between 1 and 365/);
    expect(() => validateEnv(config)).toThrow(/between 60 and 3600/);
  });

  it('treats an empty PASSKEY_MAX_PER_USER as unset instead of failing boot', () => {
    // A deploy template like `PASSKEY_MAX_PER_USER=${PASSKEY_MAX_PER_USER}` with
    // the outer variable unset yields ''. Before this, the regex rejected it and
    // validateEnv threw in production, so the app never booted and every auth
    // path died at once. An optional tuning knob must never be able to do that.
    expect(() =>
      validateEnv({ ...baseProdConfig(), PASSKEY_MAX_PER_USER: '' }),
    ).not.toThrow();
  });

  it('still rejects a non-numeric PASSKEY_MAX_PER_USER', () => {
    expect(() =>
      validateEnv({ ...baseProdConfig(), PASSKEY_MAX_PER_USER: 'ten' }),
    ).toThrow(/PASSKEY_MAX_PER_USER must be an integer/);
  });
});
