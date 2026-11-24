import {
  decodeClientData,
  ensureCredentialOrigin,
  ensureUserVerifiedAndPresent,
  readAssertionFlags,
  readRegistrationFlags,
} from './passkey-credential.util';

function base64Url(value: string | Uint8Array): string {
  const buffer =
    typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);

  return buffer.toString('base64url');
}

function registrationAttestationWithFlags(flags: number): string {
  const authData = new Uint8Array(37);
  authData[32] = flags;

  const fmtKey = Buffer.from('fmt', 'utf8');
  const fmtVal = Buffer.from('none', 'utf8');
  const attStmtKey = Buffer.from('attStmt', 'utf8');
  const authDataKey = Buffer.from('authData', 'utf8');

  const bytes = Buffer.concat([
    Buffer.from([0xa3]),
    Buffer.from([0x63]),
    fmtKey,
    Buffer.from([0x64]),
    fmtVal,
    Buffer.from([0x67]),
    attStmtKey,
    Buffer.from([0xa0]),
    Buffer.from([0x68]),
    authDataKey,
    Buffer.from([0x58, authData.length]),
    Buffer.from(authData),
  ]);

  return bytes.toString('base64url');
}

describe('passkey-credential util', () => {
  it('decodes clientDataJSON and validates exact origin', () => {
    const clientData = base64Url(
      JSON.stringify({
        type: 'webauthn.get',
        origin: 'https://auth.xisuite.cloud',
        crossOrigin: false,
      }),
    );

    expect(decodeClientData(clientData)).toMatchObject({
      type: 'webauthn.get',
      origin: 'https://auth.xisuite.cloud',
    });

    expect(() =>
      ensureCredentialOrigin(
        {
          type: 'public-key',
          response: { clientDataJSON: clientData },
        },
        'https://auth.xisuite.cloud',
        ['https://auth.xisuite.cloud'],
        'webauthn.get',
      ),
    ).not.toThrow();
  });

  it('rejects cross-origin or mismatched-origin client data', () => {
    const crossOrigin = base64Url(
      JSON.stringify({
        type: 'webauthn.get',
        origin: 'https://evil.example',
        crossOrigin: true,
      }),
    );

    expect(() =>
      ensureCredentialOrigin(
        {
          type: 'public-key',
          response: { clientDataJSON: crossOrigin },
        },
        'https://auth.xisuite.cloud',
        ['https://auth.xisuite.cloud'],
        'webauthn.get',
      ),
    ).toThrow('Passkey origin mismatch');
  });

  it('reads assertion flags and enforces user presence + verification', () => {
    const authenticatorData = new Uint8Array(37);
    authenticatorData[32] = 0x05;

    const flags = readAssertionFlags({
      type: 'public-key',
      response: {
        clientDataJSON: base64Url(
          JSON.stringify({
            type: 'webauthn.get',
            origin: 'https://auth.xisuite.cloud',
          }),
        ),
        authenticatorData: base64Url(authenticatorData),
      },
    });

    expect(flags).toEqual({ up: true, uv: true });
    expect(() => ensureUserVerifiedAndPresent(flags)).not.toThrow();
  });

  it('reads registration flags from attestationObject and rejects missing UV', () => {
    const flags = readRegistrationFlags({
      type: 'public-key',
      response: {
        clientDataJSON: base64Url(
          JSON.stringify({
            type: 'webauthn.create',
            origin: 'https://auth.xisuite.cloud',
          }),
        ),
        attestationObject: registrationAttestationWithFlags(0x01),
      },
    });

    expect(flags).toEqual({ up: true, uv: false });
    expect(() => ensureUserVerifiedAndPresent(flags)).toThrow(
      'Passkey requires user verification',
    );
  });

  it('reads only the top-level authData field from the CBOR attestation map', () => {
    const fakeAuthData = new Uint8Array(37);
    fakeAuthData[32] = 0x05;
    const realAuthData = new Uint8Array(37);
    realAuthData[32] = 0x01;
    const attestation = Buffer.concat([
      Buffer.from([0xa3, 0x63]),
      Buffer.from('fmt'),
      Buffer.from([0x64]),
      Buffer.from('none'),
      Buffer.from([0x67]),
      Buffer.from('attStmt'),
      Buffer.from([0xa1, 0x68]),
      Buffer.from('authData'),
      Buffer.from([0x58, fakeAuthData.length]),
      Buffer.from(fakeAuthData),
      Buffer.from([0x68]),
      Buffer.from('authData'),
      Buffer.from([0x58, realAuthData.length]),
      Buffer.from(realAuthData),
    ]);

    const flags = readRegistrationFlags({
      type: 'public-key',
      response: {
        clientDataJSON: base64Url('{}'),
        attestationObject: attestation.toString('base64url'),
      },
    });

    expect(flags).toEqual({ up: true, uv: false });
  });

  it('rejects malformed client data and every origin-binding mismatch', () => {
    expect(() => decodeClientData(base64Url('{not-json'))).toThrow(
      'Invalid passkey client data',
    );

    const clientData = base64Url(
      JSON.stringify({
        type: 'webauthn.get',
        origin: 'https://auth.xisuite.cloud',
        crossOrigin: false,
      }),
    );
    const credential = {
      type: 'public-key' as const,
      response: { clientDataJSON: clientData },
    };

    expect(() =>
      ensureCredentialOrigin(
        credential,
        'https://auth.xisuite.cloud',
        ['https://different.example'],
        'webauthn.get',
      ),
    ).toThrow('Passkey origin mismatch');
    expect(() =>
      ensureCredentialOrigin(
        credential,
        'https://auth.xisuite.cloud',
        ['https://auth.xisuite.cloud'],
        'webauthn.create',
      ),
    ).toThrow('Passkey origin mismatch');
    expect(() =>
      ensureCredentialOrigin(
        { ...credential, type: 'password' as never },
        'https://auth.xisuite.cloud',
        ['https://auth.xisuite.cloud'],
        'webauthn.get',
      ),
    ).toThrow('Passkey origin mismatch');
  });

  it('rejects missing or truncated assertion authenticator data', () => {
    expect(() =>
      readAssertionFlags({
        type: 'public-key',
        response: { clientDataJSON: base64Url('{}') },
      }),
    ).toThrow('Missing authenticator data');

    expect(() =>
      readAssertionFlags({
        type: 'public-key',
        response: {
          clientDataJSON: base64Url('{}'),
          authenticatorData: base64Url(new Uint8Array(32)),
        },
      }),
    ).toThrow('Invalid authenticator data');
  });

  it('distinguishes missing user presence from missing user verification', () => {
    expect(() => ensureUserVerifiedAndPresent({ up: false, uv: true })).toThrow(
      'Passkey requires user presence',
    );
    expect(() => ensureUserVerifiedAndPresent({ up: true, uv: false })).toThrow(
      'Passkey requires user verification',
    );
  });

  it('rejects missing, malformed, and undersized registration auth data', () => {
    expect(() =>
      readRegistrationFlags({
        type: 'public-key',
        response: { clientDataJSON: base64Url('{}') },
      }),
    ).toThrow('Missing attestation object');

    expect(() =>
      readRegistrationFlags({
        type: 'public-key',
        response: {
          clientDataJSON: base64Url('{}'),
          attestationObject: base64Url(new Uint8Array([0xa0])),
        },
      }),
    ).toThrow('Attestation auth data missing');

    const shortAuthData = new Uint8Array(32);
    const shortAttestation = Buffer.concat([
      Buffer.from([0xa1, 0x68]),
      Buffer.from('authData'),
      Buffer.from([0x58, shortAuthData.length]),
      Buffer.from(shortAuthData),
    ]);
    expect(() =>
      readRegistrationFlags({
        type: 'public-key',
        response: {
          clientDataJSON: base64Url('{}'),
          attestationObject: shortAttestation.toString('base64url'),
        },
      }),
    ).toThrow('Invalid attestation auth data');
  });

  it('rejects duplicate top-level CBOR map keys and trailing bytes', () => {
    const authData = new Uint8Array(37);
    authData[32] = 0x05;
    const duplicateAuthData = Buffer.concat([
      Buffer.from([0xa2, 0x68]),
      Buffer.from('authData'),
      Buffer.from([0x58, authData.length]),
      Buffer.from(authData),
      Buffer.from([0x68]),
      Buffer.from('authData'),
      Buffer.from([0x58, authData.length]),
      Buffer.from(authData),
    ]);
    const trailingByte = Buffer.concat([
      Buffer.from([0xa1, 0x68]),
      Buffer.from('authData'),
      Buffer.from([0x58, authData.length]),
      Buffer.from(authData),
      Buffer.from([0x00]),
    ]);

    for (const attestationObject of [duplicateAuthData, trailingByte]) {
      expect(() =>
        readRegistrationFlags({
          type: 'public-key',
          response: {
            clientDataJSON: base64Url('{}'),
            attestationObject: attestationObject.toString('base64url'),
          },
        }),
      ).toThrow('Attestation auth data missing');
    }
  });

  it('accepts bounded indefinite CBOR strings used by a valid attestation map', () => {
    const authData = new Uint8Array(37);
    authData[32] = 0x05;
    const attestation = Buffer.concat([
      Buffer.from([0xbf]),
      Buffer.from([0x7f, 0x64]),
      Buffer.from('auth'),
      Buffer.from([0x64]),
      Buffer.from('Data'),
      Buffer.from([0xff]),
      Buffer.from([0x5f, 0x58, authData.length]),
      Buffer.from(authData),
      Buffer.from([0xff, 0xff]),
    ]);

    expect(
      readRegistrationFlags({
        type: 'public-key',
        response: {
          clientDataJSON: base64Url('{}'),
          attestationObject: attestation.toString('base64url'),
        },
      }),
    ).toEqual({ up: true, uv: true });
  });

  it('safely skips tagged and simple CBOR values beside authData', () => {
    const authData = new Uint8Array(37);
    authData[32] = 0x05;
    const attestation = Buffer.concat([
      Buffer.from([0xa2, 0x67]),
      Buffer.from('ignored'),
      Buffer.from([0xf5, 0x68]),
      Buffer.from('authData'),
      Buffer.from([0xc0, 0x58, authData.length]),
      Buffer.from(authData),
    ]);

    expect(
      readRegistrationFlags({
        type: 'public-key',
        response: {
          clientDataJSON: base64Url('{}'),
          attestationObject: attestation.toString('base64url'),
        },
      }),
    ).toEqual({ up: true, uv: true });
  });
});
