type AuthenticationMethodInput =
  | string
  | {
      method?: string;
      timestamp?: number;
    };

export type AuthenticationMethod = {
  method: string;
  timestamp: number;
};

export type SessionAssuranceFactor = {
  status?: string;
  factor_type?: string;
  factorType?: string;
};

export type SessionAssuranceTokenPayload = {
  sub?: unknown;
  session_id?: unknown;
  aal?: unknown;
  amr?: unknown;
} | null;

export type SessionMfaState = {
  mfaRequired: boolean;
  tokenLevel: string;
  currentLevel: string;
  nextLevel: string;
  authenticationMethod: string | null;
  stepUpReason: string | null;
  recentTotpRequired: boolean;
  currentAuthenticationMethods: AuthenticationMethod[];
  hasVerifiedFactors: boolean;
  verifiedTotpCount: number;
  hasVerifiedTotp: boolean;
  hasRecentTotp: boolean;
  isPasskeyAuthenticated: boolean;
  isPasskeyAssured: boolean;
};

export function deriveSessionMfaState(input: {
  accessToken: string;
  factors?: SessionAssuranceFactor[] | null;
  passkeyAssured?: boolean;
  forceMfa?: boolean;
  recentTotpSeconds?: number;
}): SessionMfaState {
  const tokenPayload = getSessionAssuranceTokenPayload(input.accessToken);
  const methods = normalizeAuthenticationMethods(tokenPayload?.amr);
  const tokenLevel =
    typeof tokenPayload?.aal === 'string' ? tokenPayload.aal : 'aal1';
  const verifiedFactors =
    input.factors?.filter((factor) => factor.status === 'verified') ?? [];
  const verifiedTotpCount = verifiedFactors.filter(
    (factor) => normalizeFactorType(factor) === 'totp',
  ).length;
  const isPasskeyAuthenticated = methods.some(
    (method) => method.method.toLowerCase() === 'passkey',
  );
  const isPasskeyAssured =
    isPasskeyAuthenticated && input.passkeyAssured === true && !input.forceMfa;
  const currentLevel = tokenLevel;
  const nextLevel =
    currentLevel === 'aal2' || verifiedFactors.length > 0 ? 'aal2' : 'aal1';
  const hasRecentTotp = hasRecentTotpMethod(
    methods,
    input.recentTotpSeconds ?? 0,
  );
  const recentTotpRequired = verifiedTotpCount > 0 && !hasRecentTotp;
  const mfaRequired = input.forceMfa
    ? currentLevel !== 'aal2' && verifiedFactors.length > 0
    : currentLevel === 'aal1' &&
      verifiedFactors.length > 0 &&
      !isPasskeyAssured;
  const authenticationMethod = pickAuthenticationMethod(methods);
  const stepUpReason = mfaRequired
    ? input.forceMfa
      ? 'high_risk'
      : isPasskeyAuthenticated
        ? 'passkey_assurance_missing'
        : 'verified_mfa_factor'
    : recentTotpRequired
      ? 'recent_totp_required'
      : null;

  return {
    mfaRequired,
    tokenLevel,
    currentLevel,
    nextLevel,
    authenticationMethod,
    stepUpReason,
    recentTotpRequired,
    currentAuthenticationMethods: methods,
    hasVerifiedFactors: verifiedFactors.length > 0,
    verifiedTotpCount,
    hasVerifiedTotp: verifiedTotpCount > 0,
    hasRecentTotp,
    isPasskeyAuthenticated,
    isPasskeyAssured,
  };
}

export function getSessionAssuranceTokenPayload(
  accessToken: string,
): SessionAssuranceTokenPayload {
  const [, payload] = accessToken.split('.');

  if (!payload) return null;

  try {
    return JSON.parse(
      Buffer.from(toPaddedBase64(payload), 'base64').toString('utf8'),
    ) as SessionAssuranceTokenPayload;
  } catch {
    return null;
  }
}

export function normalizeAuthenticationMethods(
  methods: unknown,
): AuthenticationMethod[] {
  if (!Array.isArray(methods)) return [];

  return methods.map((method): AuthenticationMethod => {
    if (typeof method === 'string') {
      return { method, timestamp: 0 };
    }

    const entry = method as Exclude<AuthenticationMethodInput, string>;

    return {
      method: entry.method ?? 'unknown',
      timestamp: entry.timestamp ?? 0,
    };
  });
}

function normalizeFactorType(factor: SessionAssuranceFactor): string {
  const value = factor.factor_type ?? factor.factorType ?? '';

  return value.toLowerCase();
}

function hasRecentTotpMethod(
  methods: AuthenticationMethod[],
  recentTotpSeconds: number,
): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return methods.some((method) => {
    if (method.method.toLowerCase() !== 'totp') return false;
    if (recentTotpSeconds <= 0) return true;
    if (method.timestamp <= 0) return false;

    return nowSeconds - method.timestamp <= recentTotpSeconds;
  });
}

function pickAuthenticationMethod(
  methods: AuthenticationMethod[],
): string | null {
  if (methods.length === 0) return null;

  const explicitPasskey = methods.find(
    (method) => method.method.toLowerCase() === 'passkey',
  );

  return (explicitPasskey ?? methods[methods.length - 1]).method;
}

function toPaddedBase64(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');

  return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
}
