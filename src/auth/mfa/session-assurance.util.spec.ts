import {
  deriveSessionMfaState,
  normalizeAuthenticationMethods,
} from './session-assurance.util';

describe('session assurance policy', () => {
  it('requires TOTP for aal1 password sessions with verified factors', () => {
    const result = deriveSessionMfaState({
      accessToken: jwtWithPayload({
        aal: 'aal1',
        amr: [{ method: 'password', timestamp: 1 }],
      }),
      factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
    });

    expect(result.mfaRequired).toBe(true);
    expect(result.currentLevel).toBe('aal1');
    expect(result.nextLevel).toBe('aal2');
    expect(result.isPasskeyAuthenticated).toBe(false);
  });

  it('does not treat passkey AMR as sufficient without server-side assurance', () => {
    const result = deriveSessionMfaState({
      accessToken: jwtWithPayload({
        aal: 'aal1',
        amr: [{ method: 'passkey', timestamp: 1 }],
      }),
      factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
    });

    expect(result.mfaRequired).toBe(true);
    expect(result.currentLevel).toBe('aal1');
    expect(result.nextLevel).toBe('aal2');
    expect(result.isPasskeyAuthenticated).toBe(true);
    expect(result.isPasskeyAssured).toBe(false);
  });

  it('skips TOTP only for assured low-risk passkey sessions', () => {
    const result = deriveSessionMfaState({
      accessToken: jwtWithPayload({
        aal: 'aal1',
        amr: [{ method: 'passkey', timestamp: 1 }],
      }),
      factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
      passkeyAssured: true,
    });

    expect(result.mfaRequired).toBe(false);
    expect(result.currentLevel).toBe('aal1');
    expect(result.nextLevel).toBe('aal2');
    expect(result.isPasskeyAuthenticated).toBe(true);
    expect(result.isPasskeyAssured).toBe(true);
  });

  it('forces TOTP when a high-risk step-up is pending', () => {
    const result = deriveSessionMfaState({
      accessToken: jwtWithPayload({
        aal: 'aal1',
        amr: [{ method: 'passkey', timestamp: 1 }],
      }),
      factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }],
      passkeyAssured: true,
      forceMfa: true,
    });

    expect(result.mfaRequired).toBe(true);
  });

  it('normalizes string and object AMR entries', () => {
    expect(
      normalizeAuthenticationMethods([
        'password',
        { method: 'webauthn', timestamp: 123 },
      ]),
    ).toEqual([
      { method: 'password', timestamp: 0 },
      { method: 'webauthn', timestamp: 123 },
    ]);
  });
});

function jwtWithPayload(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `header.${encoded}.signature`;
}
