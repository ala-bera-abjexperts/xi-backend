// Live credential validators for automation connection health checks.
//
// Each validator receives a decrypted API-key/token secret (+ the connection metadata for providers
// that need extra config like a Jira domain/email or a Salesforce instance URL), makes a single
// read-only "whoami" call to the provider, and maps the result to a status. google_* connections are
// NOT handled here — the service validates those via getGoogleAccessToken (which also refreshes).
// Validators never throw out (network/abort/decrypt → `error`). Auth patterns mirror the controller's
// resource-picker endpoints; metadata keys verified against real rows.

export type ConnectionCheckStatus =
  | 'active'
  | 'expired'
  | 'invalid'
  | 'revoked'
  | 'unsupported'
  | 'error';

export interface ConnectionCheckResult {
  status: ConnectionCheckStatus;
  provider: string;
  detail: string | null;
  // ISO expiry only when the provider genuinely exposes it (e.g. GitHub fine-grained tokens); else null.
  expiresAt: string | null;
  checkedAt: string;
}

export interface ValidatorResult {
  status: ConnectionCheckStatus;
  detail: string | null;
  expiresAt?: string | null;
}

type Meta = Record<string, unknown>;
type Validator = (secret: string, metadata: Meta) => Promise<ValidatorResult>;

const TIMEOUT_MS = 8000;

// fetch with an 8s abort so a hung provider can never block the request.
async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 2xx → active · 401/403 → invalid (reconnect) · everything else (429/5xx/…) → error (transient).
function mapHttpStatus(status: number): ConnectionCheckStatus {
  if (status >= 200 && status < 300) return 'active';
  if (status === 401 || status === 403) return 'invalid';

  return 'error';
}

// GET with a ready-made Authorization header value ("Bearer x" for OAuth/most APIs, or the raw
// token for ClickUp/Linear). validity == 2xx.
function authGet(
  url: string,
  authHeader: string,
  extraHeaders?: Record<string, string>,
): Promise<ValidatorResult> {
  return timedFetch(url, {
    headers: { Authorization: authHeader, ...extraHeaders },
  }).then((res) => ({ status: mapHttpStatus(res.status), detail: null }));
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

// Parse GitHub's fine-grained-token expiry header ("2025-12-31 23:59:59 UTC") → ISO, else null.
function parseGithubExpiry(header: string | null): string | null {
  if (!header) return null;

  const trimmed = header.trim();
  const candidates = [
    trimmed,
    trimmed.replace(' UTC', 'Z').replace(' ', 'T'),
    trimmed.replace(' ', 'T'),
  ];

  for (const c of candidates) {
    const d = new Date(c);

    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

async function validateGithub(secret: string): Promise<ValidatorResult> {
  const res = await timedFetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (res.status !== 200)
    return { status: mapHttpStatus(res.status), detail: null };

  return {
    status: 'active',
    detail: null,
    expiresAt: parseGithubExpiry(
      res.headers.get('github-authentication-token-expiration'),
    ),
  };
}

// Slack returns HTTP 200 even for a bad token, with { ok:false, error } — so parse the body.
async function validateSlack(secret: string): Promise<ValidatorResult> {
  const res = await timedFetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  if (!res.ok) return { status: mapHttpStatus(res.status), detail: null };

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    team?: string;
  };

  if (body.ok) return { status: 'active', detail: body.team ?? null };

  const rejected = [
    'invalid_auth',
    'token_revoked',
    'account_inactive',
    'token_expired',
    'not_authed',
  ];

  return {
    status: rejected.includes(body.error ?? '') ? 'invalid' : 'error',
    detail: body.error ?? null,
  };
}

// Linear returns 200 with a GraphQL error for a bad key — so require a viewer id.
async function validateLinear(secret: string): Promise<ValidatorResult> {
  const res = await timedFetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ viewer { id } }' }),
  });

  if (!res.ok) return { status: mapHttpStatus(res.status), detail: null };

  const body = (await res.json().catch(() => ({}))) as {
    data?: { viewer?: { id?: string } };
  };

  return { status: body.data?.viewer?.id ? 'active' : 'invalid', detail: null };
}

async function validateJira(
  secret: string,
  metadata: Meta,
): Promise<ValidatorResult> {
  const domainRaw = str(metadata['domain']) ?? str(metadata['base_url']);
  const email = str(metadata['email']);

  if (!domainRaw || !email)
    return { status: 'error', detail: 'Missing Jira domain/email' };

  const domain = domainRaw.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const basic = Buffer.from(`${email}:${secret}`).toString('base64');

  return authGet(`https://${domain}/rest/api/3/myself`, `Basic ${basic}`, {
    Accept: 'application/json',
  });
}

async function validateTrello(
  secret: string,
  metadata: Meta,
): Promise<ValidatorResult> {
  const key = str(metadata['api_key']);

  if (!key) return { status: 'error', detail: 'Missing Trello API key' };

  const res = await timedFetch(
    `https://api.trello.com/1/members/me?key=${encodeURIComponent(key)}&token=${encodeURIComponent(secret)}`,
  );

  return { status: mapHttpStatus(res.status), detail: null };
}

async function validateSalesforce(
  secret: string,
  metadata: Meta,
): Promise<ValidatorResult> {
  const instanceUrl =
    str(metadata['instanceUrl']) ?? str(metadata['instance_url']);

  if (!instanceUrl)
    return { status: 'error', detail: 'Missing Salesforce instance URL' };

  return authGet(
    `${instanceUrl.replace(/\/$/, '')}/services/oauth2/userinfo`,
    `Bearer ${secret}`,
  );
}

async function validateTwilio(
  secret: string,
  metadata: Meta,
): Promise<ValidatorResult> {
  const sid = str(metadata['account_sid']);

  if (!sid) return { status: 'error', detail: 'Missing Twilio Account SID' };

  // Twilio uses Basic auth with Account SID (metadata) as user + auth token (secret) as password.
  const basic = Buffer.from(`${sid}:${secret}`).toString('base64');

  return authGet(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
    `Basic ${basic}`,
  );
}

// Inbound mailbox: app-only (client credentials), so the stored secret is a
// client_secret, not a token. Exchange it, then prove the app can actually read
// THIS mailbox — a token alone says nothing about mailbox access.
async function validateGraphMailbox(
  secret: string,
  metadata: Meta,
): Promise<ValidatorResult> {
  // Reuses the module-level str() helper, same as the Jira/Trello validators.
  const tenantId = str(metadata['tenantId'])?.trim();
  const clientId = str(metadata['clientId'])?.trim();
  const mailbox = str(metadata['mailboxAddress'])?.trim();

  if (!tenantId || !clientId || !mailbox) {
    return {
      status: 'invalid',
      detail: 'Tenant ID, client ID and mailbox address are all required',
    };
  }

  const tokenRes = await timedFetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    },
  );

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');

    return {
      status: 'invalid',
      detail: body.includes('AADSTS7000215')
        ? 'Client secret is invalid or expired'
        : 'Could not obtain a token — check tenant ID, client ID and secret',
    };
  }

  const { access_token: token } = (await tokenRes.json()) as {
    access_token?: string;
  };

  if (!token) return { status: 'error', detail: 'No token returned' };

  const probe = await timedFetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?$top=1&$select=id`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (probe.ok) return { status: 'active', detail: null };

  // 403 here is consent or an access policy — never "reconnect", which is what a
  // delegated flow would have meant.
  if (probe.status === 403) {
    return {
      status: 'invalid',
      detail:
        'Access denied. Grant Mail.Read as an APPLICATION permission with admin consent, and make sure any Exchange Application Access Policy includes this mailbox.',
    };
  }
  if (probe.status === 404) {
    return {
      status: 'invalid',
      detail: `Mailbox "${mailbox}" not found. Microsoft 365 group mailboxes are not supported.`,
    };
  }

  return {
    status: mapHttpStatus(probe.status),
    detail: `Mailbox check failed (${probe.status})`,
  };
}

// Providers validated with a stored secret. google_* are handled by the service (refresh flow).
const VALIDATORS: Record<string, Validator> = {
  github: (s) => validateGithub(s),
  slack: (s) => validateSlack(s),
  notion: (s) =>
    authGet('https://api.notion.com/v1/users/me', `Bearer ${s}`, {
      'Notion-Version': '2022-06-28',
    }),
  stripe: (s) => authGet('https://api.stripe.com/v1/balance', `Bearer ${s}`),
  asana: (s) =>
    authGet('https://app.asana.com/api/1.0/users/me', `Bearer ${s}`),
  airtable: (s) =>
    authGet('https://api.airtable.com/v0/meta/whoami', `Bearer ${s}`),
  clickup: (s) => authGet('https://api.clickup.com/api/v2/user', s),
  linear: (s) => validateLinear(s),
  teams: (s) => authGet('https://graph.microsoft.com/v1.0/me', `Bearer ${s}`),
  outlook: (s) => authGet('https://graph.microsoft.com/v1.0/me', `Bearer ${s}`),
  ms_graph_mailbox: (s, m) => validateGraphMailbox(s, m),
  jira: (s, m) => validateJira(s, m),
  trello: (s, m) => validateTrello(s, m),
  salesforce: (s, m) => validateSalesforce(s, m),
  hubspot: (s) =>
    authGet(
      'https://api.hubapi.com/crm/v3/objects/contacts?limit=1',
      `Bearer ${s}`,
    ),
  twilio: (s, m) => validateTwilio(s, m),
  // Discord connections store an incoming-webhook URL as the secret — GET it to confirm it's live.
  discord: (s) =>
    timedFetch(s).then((res) => ({
      status: mapHttpStatus(res.status),
      detail: null,
    })),
};

export const VERIFIABLE_PROVIDERS = Object.keys(VALIDATORS);

export async function validateNonGoogleProvider(
  provider: string,
  secret: string,
  metadata: Meta,
): Promise<ValidatorResult> {
  const validator = VALIDATORS[provider];

  if (!validator) return { status: 'unsupported', detail: null };

  try {
    return await validator(secret, metadata);
  } catch {
    // network failure, DNS, abort/timeout, malformed response, etc. → transient
    return { status: 'error', detail: 'Could not reach provider' };
  }
}
