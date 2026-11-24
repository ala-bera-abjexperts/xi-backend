// XISUITE self-test: create, read, update and delete a test case through the deployed backend API.
const API = (process.env.API_URL || process.env.TM_API_URL || 'https://api.xisuite.cloud/api/v1').replace(/\/$/, '');
const TENANT_SLUG = process.env.TENANT_SLUG || 'ambertech-solutions';
const SPACE_ID = process.env.SPACE_ID || process.env.TM_SPACE_ID || 'd253b1d3-4783-485f-bd38-7f5cd12246ed';
const CASES = `${API}/spaces/${SPACE_ID}/test-management/cases`;

const stamp = Date.now();
const title = `Self-test case ${stamp}`;
const objective = `Created by the XISUITE self-test ${stamp}`;
const newTitle = `Self-test case ${stamp} changed`;
const newObjective = `Changed by the XISUITE self-test ${stamp}`;

interface Answer {
  status: number;
  data: Record<string, unknown> | null;
  text: string;
}

let headers: Record<string, string> = {};
let caseId = '';
let revision = 0;

async function call(method: string, url: string, body?: unknown): Promise<Answer> {
  const response = await fetch(url, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: { data?: unknown } | null = null;

  try {
    json = text ? (JSON.parse(text) as { data?: unknown }) : null;
  } catch {
    json = null;
  }

  return { status: response.status, data: (json?.data ?? json) as Answer['data'], text };
}

const failure = (label: string, answer: Answer) => `${label} gave ${answer.status}: ${answer.text.slice(0, 300)}`;

function expectStatus(label: string, answer: Answer, status: number) {
  if (answer.status !== status) throw new Error(failure(label, answer));
}

describe('Test cases panel CRUD', () => {
  beforeAll(async () => {
    if (!process.env.QA_EMAIL || !process.env.QA_PASSWORD) {
      throw new Error('QA_EMAIL and QA_PASSWORD must be set as secrets');
    }

    const response = await fetch(`${API}/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Slug': TENANT_SLUG },
      body: JSON.stringify({ email: process.env.QA_EMAIL, password: process.env.QA_PASSWORD }),
    });
    const body = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown> };
    const result = (body?.data ?? body) as { access_token?: string; mfaRequired?: boolean };

    if (!response.ok) throw new Error(`sign-in gave ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    if (result?.mfaRequired) throw new Error('the QA account needs two-step sign-in; use an account without it');

    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('access_token='));
    const token = result?.access_token ?? cookie?.split(';')[0].slice('access_token='.length);

    if (!token) throw new Error(`sign-in gave no token (status ${response.status})`);

    headers = { Authorization: `Bearer ${token}`, Cookie: `access_token=${token}`, 'X-Tenant-Slug': TENANT_SLUG };

    // A 403 here means Test Management is off for the space or the account lacks access.
    expectStatus(`test case list in space ${SPACE_ID}`, await call('GET', CASES), 200);
  });

  afterAll(async () => {
    // A case left behind by a failed step is removed so the space stays clean.
    if (caseId) await call('DELETE', `${CASES}/${caseId}`).catch(() => null);
  });

  it('Create a test case', async () => {
    const created = await call('POST', CASES, { title, objective });

    expectStatus('create', created, 201);
    expect(created.data?.title).toBe(title);

    caseId = String(created.data?.id ?? '');
    revision = Number(created.data?.revision ?? 0);
    expect(caseId).not.toBe('');
  });

  it('Read the test case', async () => {
    if (!caseId) throw new Error('the create step did not finish');

    const read = await call('GET', `${CASES}/${caseId}`);

    expectStatus('read', read, 200);
    expect(read.data?.title).toBe(title);
    expect(read.data?.objective).toBe(objective);

    revision = Number(read.data?.revision ?? revision);
  });

  it('Update the test case', async () => {
    if (!caseId) throw new Error('the create step did not finish');

    const updated = await call('PATCH', `${CASES}/${caseId}`, {
      expected_revision: revision,
      title: newTitle,
      objective: newObjective,
    });

    expectStatus('update', updated, 200);

    const read = await call('GET', `${CASES}/${caseId}`);

    expect(read.data?.title).toBe(newTitle);
    expect(read.data?.objective).toBe(newObjective);
  });

  it('Delete the test case', async () => {
    if (!caseId) throw new Error('the create step did not finish');

    expectStatus('delete', await call('DELETE', `${CASES}/${caseId}`), 200);
    expectStatus('read after delete', await call('GET', `${CASES}/${caseId}`), 404);

    caseId = '';
  });
});
