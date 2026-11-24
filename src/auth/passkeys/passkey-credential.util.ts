import { BadRequestException, UnauthorizedException } from '@nestjs/common';

export type PasskeyCredential = {
  id: string;
  rawId?: string;
  type: 'public-key';
  authenticatorAttachment?: 'platform' | 'cross-platform';
  clientExtensionResults?: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    authenticatorData?: string;
    attestationObject?: string;
    signature?: string;
    userHandle?: string;
    transports?: string[];
    publicKey?: string;
    publicKeyAlgorithm?: number;
  };
};

type ClientData = {
  type?: string;
  origin?: string;
  crossOrigin?: boolean;
};

type AuthenticatorFlags = {
  up: boolean;
  uv: boolean;
};

export function decodeClientData(clientDataJSON: string): ClientData {
  try {
    return JSON.parse(
      fromBase64Url(clientDataJSON).toString('utf8'),
    ) as ClientData;
  } catch {
    throw new BadRequestException('Invalid passkey client data');
  }
}

export function ensureCredentialOrigin(
  credential: Pick<PasskeyCredential, 'type' | 'response'>,
  requestOrigin: string,
  allowedOrigins: string[],
  expectedType: 'webauthn.create' | 'webauthn.get',
): void {
  const clientData = decodeClientData(credential.response.clientDataJSON);

  if (
    credential.type !== 'public-key' ||
    clientData.type !== expectedType ||
    clientData.origin !== requestOrigin ||
    clientData.crossOrigin === true ||
    !allowedOrigins.includes(requestOrigin)
  ) {
    throw new BadRequestException('Passkey origin mismatch');
  }
}

export function readAssertionFlags(
  credential: Pick<PasskeyCredential, 'response'>,
): AuthenticatorFlags {
  const authenticatorData = credential.response.authenticatorData;

  if (!authenticatorData) {
    throw new BadRequestException('Missing authenticator data');
  }

  const bytes = fromBase64Url(authenticatorData);
  if (bytes.length < 33) {
    throw new BadRequestException('Invalid authenticator data');
  }

  return readFlagsByte(bytes[32]);
}

export function readRegistrationFlags(
  credential: Pick<PasskeyCredential, 'response'>,
): AuthenticatorFlags {
  const attestationObject = credential.response.attestationObject;

  if (!attestationObject) {
    throw new BadRequestException('Missing attestation object');
  }

  const decoded = fromBase64Url(attestationObject);
  const authData = extractAuthDataFromAttestation(decoded);

  if (authData.length < 33) {
    throw new BadRequestException('Invalid attestation auth data');
  }

  return readFlagsByte(authData[32]);
}

export function ensureUserVerifiedAndPresent(flags: AuthenticatorFlags): void {
  if (!flags.up) {
    throw new UnauthorizedException('Passkey requires user presence');
  }

  if (!flags.uv) {
    throw new UnauthorizedException('Passkey requires user verification');
  }
}

function readFlagsByte(value: number): AuthenticatorFlags {
  return {
    up: (value & 0x01) === 0x01,
    uv: (value & 0x04) === 0x04,
  };
}

function extractAuthDataFromAttestation(attestationObject: Buffer): Buffer {
  try {
    const cursor = { offset: 0 };
    const decoded = decodeCborValue(attestationObject, cursor, 0);

    if (cursor.offset !== attestationObject.length || !isUnknownMap(decoded)) {
      throw new Error('Invalid CBOR root');
    }

    const authData = decoded.get('authData');
    if (!Buffer.isBuffer(authData)) {
      throw new Error('authData is not a byte string');
    }

    return authData;
  } catch {
    throw new BadRequestException('Attestation auth data missing');
  }
}

function decodeCborValue(
  bytes: Buffer,
  cursor: { offset: number },
  depth: number,
): unknown {
  if (depth > 16 || cursor.offset >= bytes.length) {
    throw new Error('Invalid CBOR');
  }

  const initial = bytes[cursor.offset++];
  if (initial === 0xff) throw new Error('Unexpected CBOR break');

  const major = initial >> 5;
  const additional = initial & 0x1f;

  if (major === 7) {
    if (additional < 24) return additional;
    const byteLength =
      additional === 24
        ? 1
        : additional === 25
          ? 2
          : additional === 26
            ? 4
            : additional === 27
              ? 8
              : 0;
    if (!byteLength) throw new Error('Unsupported CBOR simple value');
    ensureCborAvailable(bytes, cursor, byteLength);
    cursor.offset += byteLength;
    return null;
  }

  const length = readCborLength(bytes, cursor, additional);

  if (major === 0) return requireDefiniteLength(length);
  if (major === 1) return -1 - requireDefiniteLength(length);

  if (major === 2 || major === 3) {
    if (length === null) {
      const chunks: Array<Buffer | string> = [];
      while (peekCborByte(bytes, cursor) !== 0xff) {
        chunks.push(
          decodeCborValue(bytes, cursor, depth + 1) as Buffer | string,
        );
      }
      cursor.offset += 1;

      if (major === 2 && chunks.every((chunk) => Buffer.isBuffer(chunk))) {
        return Buffer.concat(chunks);
      }
      if (major === 3 && chunks.every((chunk) => typeof chunk === 'string')) {
        return chunks.join('');
      }
      throw new Error('Invalid indefinite CBOR string');
    }

    ensureCborAvailable(bytes, cursor, length);
    const value = bytes.subarray(cursor.offset, cursor.offset + length);
    cursor.offset += length;
    return major === 2 ? Buffer.from(value) : value.toString('utf8');
  }

  if (major === 4) {
    const values: unknown[] = [];
    readCborCollection(bytes, cursor, length, () => {
      values.push(decodeCborValue(bytes, cursor, depth + 1));
    });
    return values;
  }

  if (major === 5) {
    const values = new Map<unknown, unknown>();
    readCborCollection(bytes, cursor, length, () => {
      const key = decodeCborValue(bytes, cursor, depth + 1);
      const value = decodeCborValue(bytes, cursor, depth + 1);
      if (values.has(key)) throw new Error('Duplicate CBOR map key');
      values.set(key, value);
    });
    return values;
  }

  if (major === 6) {
    requireDefiniteLength(length);
    return decodeCborValue(bytes, cursor, depth + 1);
  }

  throw new Error('Unsupported CBOR value');
}

function readCborLength(
  bytes: Buffer,
  cursor: { offset: number },
  additional: number,
): number | null {
  if (additional < 24) return additional;
  if (additional === 31) return null;

  const byteLength =
    additional === 24
      ? 1
      : additional === 25
        ? 2
        : additional === 26
          ? 4
          : additional === 27
            ? 8
            : 0;
  if (!byteLength) throw new Error('Unsupported CBOR length');
  ensureCborAvailable(bytes, cursor, byteLength);

  let value = 0n;
  for (let index = 0; index < byteLength; index += 1) {
    value = (value << 8n) | BigInt(bytes[cursor.offset + index]);
  }
  cursor.offset += byteLength;

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('CBOR length is too large');
  }
  return Number(value);
}

function readCborCollection(
  bytes: Buffer,
  cursor: { offset: number },
  length: number | null,
  readItem: () => void,
): void {
  if (length === null) {
    while (peekCborByte(bytes, cursor) !== 0xff) readItem();
    cursor.offset += 1;
    return;
  }

  for (let index = 0; index < length; index += 1) readItem();
}

function peekCborByte(bytes: Buffer, cursor: { offset: number }): number {
  ensureCborAvailable(bytes, cursor, 1);
  return bytes[cursor.offset];
}

function ensureCborAvailable(
  bytes: Buffer,
  cursor: { offset: number },
  length: number,
): void {
  if (length < 0 || cursor.offset + length > bytes.length) {
    throw new Error('Truncated CBOR');
  }
}

function requireDefiniteLength(length: number | null): number {
  if (length === null) throw new Error('Indefinite CBOR integer');
  return length;
}

function isUnknownMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
