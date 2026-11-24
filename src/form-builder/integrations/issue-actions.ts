import * as nodemailer from 'nodemailer';

import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';

// Bounds the SMTP handshake so the 5s drain cron can never hang on a dead server.
const FETCH_TIMEOUT_MS = 15_000;

const GITHUB_API = 'https://api.github.com';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const AIRTABLE_API = 'https://api.airtable.com/v0';
const AIRTABLE_META_API = 'https://api.airtable.com/v0/meta';
const TRELLO_API = 'https://api.trello.com/1';

// Everything a provider action needs: the decrypted credential, the stored config, the resolved
// field-map ({ toEmail, subject, body }), and fallbacks when a target isn't mapped.
export interface ActionInput {
  provider: string;
  credential: string;
  config: Record<string, unknown>;
  fields: Record<string, string>;
  fallbackTitle: string;
  fallbackBody: string;
}

export interface ActionResult {
  ok: boolean;
  status: number | null;
  externalRef: string | null;
  error?: string | null;

  // 4xx/auth errors are terminal (no retry); connection/timeout/5xx are retryable.
  retryable: boolean;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function str(config: Record<string, unknown>, key: string): string {
  const v = config[key];

  return typeof v === 'string' ? v.trim() : '';
}

function describeError(status: number, raw: string): string {
  const detail = raw ? ` ${raw.slice(0, 300)}` : '';

  return `HTTP ${status}${detail}`;
}

// Moved to common/utils so the migration HTTP client (Jira/Confluence connections) shares one
// implementation with this picker — the same corporate CA breaks both. Re-exported so existing
// importers of this module are unaffected.
export { describeFetchFailure } from '../../common/utils/fetch-failure.util';

// Rate limit + server errors are worth another attempt; 4xx is a config/auth problem.
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Comma-separated mapped value wins; otherwise fall back to labels stored in config.
function parseLabels(
  mapped: string | undefined,
  configLabels: unknown,
): string[] {
  const fromMap = (mapped ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (fromMap.length) return fromMap;

  if (Array.isArray(configLabels))
    return configLabels.filter((l): l is string => typeof l === 'string');

  return [];
}

// Shared JSON POST for HTTP providers. SSRF-guarded, no redirects, bounded by the drain timeout.
async function send(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  extractRef: (json: unknown) => string | null,
): Promise<ActionResult> {
  try {
    await assertPublicHttpUrl(url);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const raw = await response.text();
    let json: unknown = null;

    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }

    if (response.ok)
      return {
        ok: true,
        status: response.status,
        externalRef: extractRef(json),
        retryable: false,
      };

    return {
      ok: false,
      status: response.status,
      externalRef: null,
      error: describeError(response.status, raw),
      retryable: retryableStatus(response.status),
    };
  } catch (err) {
    // network / timeout — retryable.
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: (err as Error)?.message ?? 'request failed',
      retryable: true,
    };
  }
}

// Create a GitHub issue in the configured repo using the stored personal access token.
async function runGithubIssue(input: ActionInput): Promise<ActionResult> {
  const owner = str(input.config, 'owner');
  const repo = str(input.config, 'repo');

  if (!owner || !repo)
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: 'github integration missing owner/repo',
      retryable: false,
    };

  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const title = truncate(
    (input.fields.title || input.fallbackTitle || 'Form submission').trim(),
    256,
  );
  const body = truncate(input.fields.body || input.fallbackBody, 60_000);
  const labels = parseLabels(input.fields.labels, input.config.labels);

  const payload: Record<string, unknown> = { title, body };

  if (labels.length) payload.labels = labels;

  return send(
    url,
    {
      Authorization: `Bearer ${input.credential}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xisuite-form-builder',
      'Content-Type': 'application/json',
    },
    payload,
    (json) => {
      const o = json as { html_url?: unknown };

      return typeof o?.html_url === 'string' ? o.html_url : null;
    },
  );
}

// Send one email over Gmail SMTP using the connected address + a Google App Password.
async function runGmailEmail(input: ActionInput): Promise<ActionResult> {
  const fromEmail = str(input.config, 'fromEmail');
  const fromName = str(input.config, 'fromName');

  // Google shows app passwords as four space-separated groups; strip whitespace or SMTP 535s.
  const appPassword = input.credential.replace(/\s+/g, '');

  // No recipient mapped → send to the connected account (also makes the built-in Test send work,
  // since sendTest passes fields:{}), which doubles as a sensible "notify me" default.
  const toEmail = (input.fields.toEmail || '').trim() || fromEmail;
  const subject = truncate(
    input.fields.subject || input.fallbackTitle || 'Form submission',
    998,
  );
  const body = truncate(input.fields.body || input.fallbackBody, 100_000);

  if (!fromEmail || !appPassword)
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: 'gmail: fromEmail and app password required',
      retryable: false,
    };

  // Must catch internally: nodemailer throws on failure, and the drain loop relies on actions
  // never throwing.
  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: fromEmail, pass: appPassword },
      connectionTimeout: FETCH_TIMEOUT_MS,
      greetingTimeout: FETCH_TIMEOUT_MS,
      socketTimeout: FETCH_TIMEOUT_MS,
    });

    const info = await transporter.sendMail({
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: toEmail,
      subject,
      text: body,
    });

    return {
      ok: true,
      status: 200,
      externalRef: info.messageId ?? null,
      retryable: false,
    };
  } catch (err) {
    // Wrong/expired app password (EAUTH / 535) or any 4xx is terminal; connection/timeout retries.
    const e = err as { code?: string; responseCode?: number; message?: string };
    const terminal =
      e.code === 'EAUTH' ||
      (e.responseCode != null && e.responseCode >= 400 && e.responseCode < 500);

    return {
      ok: false,
      status: e.responseCode ?? null,
      externalRef: null,
      error: `gmail: ${e.message ?? 'send failed'}`,
      retryable: !terminal,
    };
  }
}

export interface GithubRepoOption {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
}

// Repos the token can see, for the dialog's repository picker.
export async function listGithubRepositories(
  credential: string,
): Promise<GithubRepoOption[]> {
  const url = `${GITHUB_API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${credential}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xisuite-form-builder',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok)
    throw new Error(describeError(response.status, await response.text()));

  const json = (await response.json()) as Array<{
    name?: unknown;
    full_name?: unknown;
    private?: unknown;
    owner?: { login?: unknown };
  }>;

  return (Array.isArray(json) ? json : [])
    .map((r) => ({
      owner: typeof r.owner?.login === 'string' ? r.owner.login : '',
      name: typeof r.name === 'string' ? r.name : '',
      fullName: typeof r.full_name === 'string' ? r.full_name : '',
      private: Boolean(r.private),
    }))
    .filter((r) => r.owner && r.name);
}

export interface ClickupListOption {
  id: string;
  name: string;
  spaceName: string;
  folderName?: string;
}

// ClickUp has no single "all lists" endpoint — Lists live under Folders under Spaces under Teams
// (workspaces), plus folderless Lists directly under a Space. So we walk the tree and flatten it into
// a pickable dropdown. The top-level /team call throws on failure (bad/expired token) so the picker
// can surface it; per-space / per-folder failures are skipped (return []) so one bad node can't blank
// the whole dropdown. Capped so a huge workspace can't return an unbounded payload. Raw token auth
// (no `Bearer`) — matches runClickUpTask and the automations traversal.
export async function listClickupLists(
  credential: string,
): Promise<ClickupListOption[]> {
  const headers = {
    Authorization: credential,
    'Content-Type': 'application/json',
  };

  const teamsRes = await fetch(`${CLICKUP_API}/team`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!teamsRes.ok)
    throw new Error(describeError(teamsRes.status, await teamsRes.text()));

  const teamsJson = (await teamsRes.json()) as {
    teams?: Array<{ id: string }>;
  };
  const teams = teamsJson.teams ?? [];

  const MAX_LISTS = 300;
  const out: ClickupListOption[] = [];

  // A GET that resolves to parsed JSON, or null when the node errors — lets us skip a bad space/
  // folder instead of failing the whole traversal.
  const getJson = async <T>(path: string): Promise<T | null> => {
    try {
      const res = await fetch(`${CLICKUP_API}${path}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) return null;

      return (await res.json()) as T;
    } catch {
      return null;
    }
  };

  for (const team of teams) {
    const spacesJson = await getJson<{
      spaces?: Array<{ id: string; name: string }>;
    }>(`/team/${team.id}/space?archived=false`);

    const spaces = spacesJson?.spaces ?? [];

    const perSpace = await Promise.all(
      spaces.map(async (space) => {
        const [listsJson, foldersJson] = await Promise.all([
          getJson<{ lists?: Array<{ id: string; name: string }> }>(
            `/space/${space.id}/list?archived=false`,
          ),
          getJson<{ folders?: Array<{ id: string; name: string }> }>(
            `/space/${space.id}/folder?archived=false`,
          ),
        ]);

        const folderless: ClickupListOption[] = (listsJson?.lists ?? []).map(
          (l) => ({
            id: l.id,
            name: l.name,
            spaceName: space.name,
          }),
        );

        const folderLists = await Promise.all(
          (foldersJson?.folders ?? []).map(async (folder) => {
            const fj = await getJson<{
              lists?: Array<{ id: string; name: string }>;
            }>(`/folder/${folder.id}/list?archived=false`);

            return (fj?.lists ?? []).map(
              (l): ClickupListOption => ({
                id: l.id,
                name: l.name,
                spaceName: space.name,
                folderName: folder.name,
              }),
            );
          }),
        );

        return [...folderless, ...folderLists.flat()];
      }),
    );

    for (const list of perSpace.flat()) {
      out.push(list);
      if (out.length >= MAX_LISTS) return out;
    }
  }

  return out;
}

export interface TrelloListOption {
  id: string;
  name: string;
  boardName: string;
}

// Trello Lists are board-scoped, so one call to /members/me/boards with `lists=open` returns every
// open board with its open Lists nested — we flatten them into one pickable dropdown labelled by
// board. key+token auth as query params. A bad key/token surfaces via describeError for the picker.
export async function listTrelloLists(
  apiKey: string,
  token: string,
): Promise<TrelloListOption[]> {
  const url = new URL('https://api.trello.com/1/members/me/boards');

  url.searchParams.set('fields', 'id,name');
  url.searchParams.set('filter', 'open');
  url.searchParams.set('lists', 'open');
  url.searchParams.set('list_fields', 'id,name');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('token', token);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'xisuite-form-builder' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(describeError(res.status, await res.text()));

  const boards = (await res.json()) as Array<{
    id: string;
    name: string;
    lists?: Array<{ id: string; name: string }>;
  }>;

  const out: TrelloListOption[] = [];

  for (const board of boards ?? []) {
    for (const list of board.lists ?? []) {
      out.push({ id: list.id, name: list.name, boardName: board.name });
    }
  }

  return out;
}

export interface AirtableBaseOption {
  id: string;
  name: string;
}

export interface AirtableTableOption {
  id: string;
  name: string;
}

// Lists all Airtable bases the PAT can read, for the base picker.
export async function listAirtableBases(
  credential: string,
): Promise<AirtableBaseOption[]> {
  const res = await fetch(`${AIRTABLE_META_API}/bases`, {
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(describeError(res.status, await res.text()));

  const json = (await res.json()) as {
    bases?: Array<{ id: string; name: string }>;
  };

  return (json.bases ?? []).map((b) => ({ id: b.id, name: b.name }));
}

// Lists all tables in a given Airtable base, for the cascading table picker.
export async function listAirtableTables(
  credential: string,
  baseId: string,
): Promise<AirtableTableOption[]> {
  const res = await fetch(
    `${AIRTABLE_META_API}/bases/${encodeURIComponent(baseId)}/tables`,
    {
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );

  if (!res.ok) throw new Error(describeError(res.status, await res.text()));

  const json = (await res.json()) as {
    tables?: Array<{ id: string; name: string }>;
  };

  return (json.tables ?? []).map((t) => ({ id: t.id, name: t.name }));
}

// Create a ClickUp task in the configured list. Raw-token auth (no `Bearer`) — matches
// listClickupLists and the automations traversal. `name` is required by ClickUp, so it falls back
// to the submission title; description is optional.
async function runClickupTask(input: ActionInput): Promise<ActionResult> {
  const listId = str(input.config, 'listId');

  if (!listId)
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: 'clickup integration missing listId',
      retryable: false,
    };

  const name = truncate(
    (input.fields.name || input.fallbackTitle || 'Form submission').trim(),
    500,
  );
  const description = truncate(
    input.fields.description || input.fallbackBody,
    60_000,
  );

  const payload: Record<string, unknown> = { name };

  if (description) payload.description = description;

  return send(
    `${CLICKUP_API}/list/${encodeURIComponent(listId)}/task`,
    { Authorization: input.credential, 'Content-Type': 'application/json' },
    payload,
    (json) => {
      const o = json as { id?: unknown; url?: unknown };

      if (typeof o?.url === 'string') return o.url;

      return typeof o?.id === 'string' ? o.id : null;
    },
  );
}

// Create a Trello card in the configured list. key+token go on the query string (Trello's auth
// scheme); name/desc travel in the JSON body. Labels are mapped as comma-separated names, but the
// card-create endpoint only accepts label IDs, so labels are not applied here (a board-label lookup
// would be needed — left as a follow-up rather than silently guessing).
async function runTrelloCard(input: ActionInput): Promise<ActionResult> {
  const apiKey = str(input.config, 'apiKey');
  const listId = str(input.config, 'listId');

  if (!apiKey || !listId)
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: 'trello integration missing apiKey/listId',
      retryable: false,
    };

  const name = truncate(
    (input.fields.name || input.fallbackTitle || 'Form submission').trim(),
    16_384,
  );
  const desc = truncate(input.fields.desc || input.fallbackBody, 16_384);

  const url = new URL(`${TRELLO_API}/cards`);

  url.searchParams.set('key', apiKey);
  url.searchParams.set('token', input.credential);
  url.searchParams.set('idList', listId);

  const payload: Record<string, unknown> = { name };

  if (desc) payload.desc = desc;

  return send(
    url.toString(),
    {
      'Content-Type': 'application/json',
      'User-Agent': 'xisuite-form-builder',
    },
    payload,
    (json) => {
      const o = json as { id?: unknown; shortUrl?: unknown; url?: unknown };

      if (typeof o?.shortUrl === 'string') return o.shortUrl;
      if (typeof o?.url === 'string') return o.url;

      return typeof o?.id === 'string' ? o.id : null;
    },
  );
}

// Create an Airtable record in the configured base/table. The dialog exposes Airtable's default
// columns — the primary "Name" field and the "Notes" long-text field — so those are the write
// targets (mapping to arbitrary columns is out of scope for the type-filter build). `typecast: true`
// lets Airtable coerce strings into the column's type instead of 422-ing.
async function runAirtableRecord(input: ActionInput): Promise<ActionResult> {
  const baseId = str(input.config, 'baseId');
  const tableName = str(input.config, 'tableName');

  if (!baseId || !tableName)
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: 'airtable integration missing baseId/tableName',
      retryable: false,
    };

  const name = (input.fields.name || input.fallbackTitle || '').trim();
  const notes = input.fields.notes || '';
  const fields: Record<string, string> = {};

  if (name) fields.Name = truncate(name, 100_000);
  if (notes) fields.Notes = truncate(notes, 100_000);

  if (!Object.keys(fields).length)
    fields.Name = truncate(input.fallbackBody || 'Form submission', 100_000);

  return send(
    `${AIRTABLE_API}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`,
    {
      Authorization: `Bearer ${input.credential}`,
      'Content-Type': 'application/json',
    },
    { fields, typecast: true },
    (json) => {
      const o = json as { id?: unknown };

      return typeof o?.id === 'string' ? o.id : null;
    },
  );
}

// Router — Gmail (SMTP), GitHub (issue), ClickUp (task), Trello (card), Airtable (record).
// ── Jira / HubSpot / Salesforce resource pickers ────────────────────────────────────────────────
// Read-only metadata lookups that populate the dialog dropdowns. They never create anything, so a
// failure here is surfaced to the picker rather than retried.

export interface JiraProjectOption {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssueTypeOption {
  id: string;
  name: string;
}

export interface CrmFieldOption {
  name: string;
  label: string;
}

// Jira Cloud only. Restricting the host is what stops a crafted siteUrl from turning these
// server-side lookups into an SSRF probe of the internal network.
const JIRA_CLOUD_HOST = /^https:\/\/[a-z0-9-]+\.atlassian\.net$/i;

// Normalises a Jira site URL to a bare origin (callers may paste it with or without the scheme),
// then rejects anything that is not a Jira Cloud host.
function jiraOrigin(siteUrl: string): string {
  const trimmed = siteUrl.trim().replace(/\/+$/, '');
  const origin = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  if (!JIRA_CLOUD_HOST.test(origin))
    throw new Error(
      'Jira site URL must be a Jira Cloud host (https://<site>.atlassian.net)',
    );

  return origin;
}

// Salesforce orgs are always *.salesforce.com / *.force.com — same SSRF reasoning as Jira.
const SALESFORCE_HOST =
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(my\.salesforce\.com|salesforce\.com|force\.com)$/i;

function salesforceOrigin(instanceUrl: string): string {
  const trimmed = instanceUrl.trim().replace(/\/+$/, '');
  const origin = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  // my.salesforce-setup.com is the Setup UI domain — it does not serve the REST/OAuth APIs. It is
  // the URL people copy out of the browser, so call out the fix rather than a generic rejection.
  if (/\.my\.salesforce-setup\.com$/i.test(origin))
    throw new Error(
      `That is the Salesforce Setup domain. Use the same host without "-setup": ${origin.replace(
        '.my.salesforce-setup.com',
        '.my.salesforce.com',
      )}`,
    );

  if (!SALESFORCE_HOST.test(origin))
    throw new Error(
      'Salesforce instance URL must be a Salesforce host (https://<org>.my.salesforce.com)',
    );

  return origin;
}

function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

// Lists the projects the account can see, for the project-key picker. Uses the paginated
// /project/search endpoint (the deprecated /project returns everything unbounded).
export async function listJiraProjects(
  siteUrl: string,
  email: string,
  token: string,
): Promise<JiraProjectOption[]> {
  const url = `${jiraOrigin(siteUrl)}/rest/api/3/project/search?maxResults=100&orderBy=name`;

  const res = await fetch(url, {
    headers: {
      Authorization: basicAuth(email, token),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(describeError(res.status, await res.text()));

  const json = (await res.json()) as {
    values?: Array<{ id: string; key: string; name: string }>;
  };

  return (json.values ?? []).map((p) => ({
    id: String(p.id),
    key: p.key,
    name: p.name,
  }));
}

// Lists the issue types creatable in one project, for the cascading issue-type picker.
export async function listJiraIssueTypes(
  siteUrl: string,
  email: string,
  token: string,
  projectKey: string,
): Promise<JiraIssueTypeOption[]> {
  const url =
    `${jiraOrigin(siteUrl)}/rest/api/3/issue/createmeta` +
    `?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`;

  const res = await fetch(url, {
    headers: {
      Authorization: basicAuth(email, token),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(describeError(res.status, await res.text()));

  const json = (await res.json()) as {
    projects?: Array<{
      issuetypes?: Array<{ id: string; name: string; subtask?: boolean }>;
    }>;
  };

  // Sub-task types cannot be created standalone from a form submission.
  return (json.projects?.[0]?.issuetypes ?? [])
    .filter((it) => !it.subtask)
    .map((it) => ({ id: String(it.id), name: it.name }));
}

// Lists writable HubSpot contact properties, for the field-mapping dropdowns. Read-only and
// calculated properties are dropped because a submission can never populate them.
export async function listHubspotProperties(
  token: string,
): Promise<CrmFieldOption[]> {
  const res = await fetch('https://api.hubapi.com/crm/v3/properties/contacts', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(describeError(res.status, await res.text()));

  const json = (await res.json()) as {
    results?: Array<{
      name: string;
      label?: string;
      modificationMetadata?: { readOnlyValue?: boolean };
      calculated?: boolean;
      hidden?: boolean;
    }>;
  };

  return (json.results ?? [])
    .filter(
      (p) =>
        !p.calculated &&
        !p.hidden &&
        !p.modificationMetadata?.readOnlyValue &&
        !!p.name,
    )
    .map((p) => ({ name: p.name, label: p.label || p.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Exchanges a Connected App's Client ID + Client Secret for a short-lived access token using the
// OAuth 2.0 client-credentials grant. The Connected App must have that flow enabled and a run-as
// user assigned. Salesforce issues these tokens from the org's My Domain, not login.salesforce.com.
export async function salesforceAccessToken(
  instanceUrl: string,
): Promise<{ accessToken: string; instanceUrl: string }> {
  const clientId = (process.env.SALESFORCE_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.SALESFORCE_CLIENT_SECRET ?? '').trim();

  if (!clientId || !clientSecret)
    throw new Error(
      'Salesforce is not configured on this server — SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET must be set',
    );

  const origin = salesforceOrigin(instanceUrl);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(`${origin}/services/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const raw = await res.text();

  if (!res.ok) {
    // Salesforce returns { error, error_description } — surface the description, it is actionable
    // (e.g. "client credentials flow not enabled for this connected app").
    let detail = raw;

    try {
      const parsed = JSON.parse(raw) as {
        error?: string;
        error_description?: string;
      };

      detail = parsed.error_description || parsed.error || raw;
    } catch {
      /* keep the raw body */
    }

    throw new Error(`Salesforce auth failed: ${detail.slice(0, 300)}`);
  }

  const json = JSON.parse(raw) as {
    access_token?: string;
    instance_url?: string;
  };

  if (!json.access_token)
    throw new Error('Salesforce auth failed: no access_token returned');

  // Prefer the instance_url Salesforce hands back — it is authoritative for subsequent API calls.
  return {
    accessToken: json.access_token,
    instanceUrl: json.instance_url
      ? salesforceOrigin(json.instance_url)
      : origin,
  };
}

// Lists createable Salesforce Lead fields via the describe API, for the field-mapping dropdowns.
// Authenticates with the server's Connected App credentials — nothing is supplied by the user.
export async function listSalesforceLeadFields(
  instanceUrl: string,
): Promise<CrmFieldOption[]> {
  const auth = await salesforceAccessToken(instanceUrl);
  const url = `${auth.instanceUrl}/services/data/v60.0/sobjects/Lead/describe`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  console.log('LIST OF FIELDS', res);

  if (!res.ok) throw new Error(describeError(res.status, await res.text()));

  const json = (await res.json()) as {
    fields?: Array<{ name: string; label?: string; createable?: boolean }>;
  };

  return (json.fields ?? [])
    .filter((f) => f.createable && !!f.name)
    .map((f) => ({ name: f.name, label: f.label || f.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Delivery actions: Jira / HubSpot / Salesforce
// Minimal Atlassian Document Format: each line becomes a paragraph (empty line → empty paragraph).
// Jira Cloud's v3 API rejects a plain string for `description`, and rejects empty text nodes.
function toADF(text: string): Record<string, unknown> {
  const lines = (text || '').split('\n');
  const content = lines.map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : [],
  }));

  return {
    type: 'doc',
    version: 1,
    content: content.length ? content : [{ type: 'paragraph', content: [] }],
  };
}

// POST {siteUrl}/rest/api/3/issue — Jira Cloud, Basic auth (email:apiToken), ADF description.
async function runJiraIssue(input: ActionInput): Promise<ActionResult> {
  const siteUrlRaw = str(input.config, 'siteUrl');
  const email = str(input.config, 'email');
  const projectKey = str(input.config, 'projectKey');
  const issueType = str(input.config, 'issueType') || 'Task';

  if (!siteUrlRaw || !email || !projectKey)
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: 'jira integration missing siteUrl/email/projectKey',
      retryable: false,
    };

  let siteUrl: string;

  try {
    siteUrl = jiraOrigin(siteUrlRaw);
  } catch (err) {
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: (err as Error).message,
      retryable: false,
    };
  }

  const summary = truncate(
    (input.fields.summary || input.fallbackTitle || 'Form submission').trim(),
    255,
  );
  const description = toADF(input.fields.description || input.fallbackBody);
  const basic = Buffer.from(`${email}:${input.credential}`).toString('base64');

  return send(
    `${siteUrl}/rest/api/3/issue`,
    {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    {
      fields: {
        project: { key: projectKey },
        issuetype: { name: issueType },
        summary,
        description,
      },
    },
    (json) => {
      const o = json as { key?: unknown };

      return typeof o?.key === 'string' ? `${siteUrl}/browse/${o.key}` : null;
    },
  );
}

// POST /crm/v3/objects/contacts — every mapped target is a HubSpot contact property name, so the
// field map is forwarded as-is rather than through a fixed whitelist.
async function runHubspotContact(input: ActionInput): Promise<ActionResult> {
  const properties: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.fields))
    if (value != null && value !== '') properties[key] = value;

  // HubSpot needs at least one identifying property. Fall back rather than refusing, so the Test
  // button (which sends no fields) still produces a clearly-labelled contact.
  if (!properties.email && !properties.firstname && !properties.lastname)
    properties.lastname = input.fallbackTitle || 'Form submission';

  return send(
    'https://api.hubapi.com/crm/v3/objects/contacts',
    {
      Authorization: `Bearer ${input.credential}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    { properties },
    (json) => {
      const o = json as { id?: unknown };

      return typeof o?.id === 'string'
        ? `https://app.hubspot.com/contacts/objects/0-1/${o.id}`
        : null;
    },
  );
}

// POST {instanceUrl}/services/data/v60.0/sobjects/Lead — authenticates with the server's Connected
// App credentials (SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET) via the client-credentials grant.
async function runSalesforceLead(input: ActionInput): Promise<ActionResult> {
  const instanceUrl = str(input.config, 'instanceUrl');

  if (!instanceUrl)
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: 'salesforce integration missing instanceUrl',
      retryable: false,
    };

  const fields: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.fields))
    if (value != null && value !== '') fields[key] = value;

  // Salesforce hard-requires LastName + Company. Fall back rather than refusing, so an unmapped
  // form still delivers and the Test button (which sends no fields at all) works.
  fields.LastName = fields.LastName || input.fallbackTitle || 'Form submission';
  fields.Company = fields.Company || input.fallbackTitle || 'Form submission';

  let auth: { accessToken: string; instanceUrl: string };

  try {
    auth = await salesforceAccessToken(instanceUrl);
  } catch (err) {
    // Bad key/secret or the flow isn't enabled on the Connected App — terminal, not worth retrying.
    return {
      ok: false,
      status: null,
      externalRef: null,
      error: (err as Error).message,
      retryable: false,
    };
  }

  return send(
    `${auth.instanceUrl}/services/data/v60.0/sobjects/Lead`,
    {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    fields,
    (json) => {
      const o = json as { id?: unknown };

      return typeof o?.id === 'string'
        ? `${auth.instanceUrl}/lightning/r/Lead/${o.id}/view`
        : null;
    },
  );
}

export async function runIssueAction(
  provider: string,
  input: ActionInput,
): Promise<ActionResult> {
  if (provider === 'gmail') return runGmailEmail(input);
  if (provider === 'github') return runGithubIssue(input);
  if (provider === 'clickup') return runClickupTask(input);
  if (provider === 'trello') return runTrelloCard(input);
  if (provider === 'airtable') return runAirtableRecord(input);
  if (provider === 'jira') return runJiraIssue(input);
  if (provider === 'hubspot') return runHubspotContact(input);
  if (provider === 'salesforce') return runSalesforceLead(input);

  return {
    ok: false,
    status: null,
    externalRef: null,
    error: `unsupported provider: ${provider}`,
    retryable: false,
  };
}
