import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A signed, short-lived value that carries who started a connect flow.
 *
 * Signed rather than stored: the existing automation state table requires a space, and a personal
 * calendar has none. The provider's own code is single-use, and this value expires in minutes.
 */
const TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  u: string;
  o: string;
  p: string;
  n: string;
  e: number;

  /** Where the person started, so they are returned to their own tenant rather than a global default. */
  r?: string;
}

/** Only a real web address is worth carrying back; anything else falls through to the default. */
function webAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value);

    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export function secret(): string {
  // `||`, not `??`: an empty value (e.g. `CALENDAR_STATE_SECRET=` in .env) must fall through to the
  // next real secret, or every state would be signed with an empty key and could be forged.
  return (
    process.env.CALENDAR_STATE_SECRET ||
    process.env.AI_ENCRYPTION_SECRET ||
    process.env.JWT_SECRET ||
    'calendar-state'
  );
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

export function createState(
  userId: string,
  organizationId: string,
  provider: string,
  returnTo?: string,
): string {
  const payload: StatePayload = {
    u: userId,
    o: organizationId,
    p: provider,
    n: randomBytes(8).toString('hex'),
    e: Date.now() + TTL_MS,
    r: webAddress(returnTo),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${body}.${sign(body)}`;
}

/** Null when the value was tampered with, malformed, or has expired. */
export function readState(state: string | undefined): {
  userId: string;
  organizationId: string;
  provider: string;
  returnTo?: string;
} | null {
  if (!state) return null;

  const [body, signature] = state.split('.');

  if (!body || !signature) return null;

  const expected = sign(body);

  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString(),
    ) as StatePayload;

    if (!payload.e || payload.e < Date.now()) return null;

    return {
      userId: payload.u,
      organizationId: payload.o,
      provider: payload.p,
      returnTo: webAddress(payload.r),
    };
  } catch {
    return null;
  }
}
