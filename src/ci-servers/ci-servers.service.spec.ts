/**
 * @fileoverview Unit tests for CiServersService and the Jenkins helpers: address rules, no secrets in
 * responses, duplicate and in-use refusals, the sign-in test and the job list. The database is a small
 * queued mock; addresses are public IP literals, so no DNS is involved.
 * @module src/ci-servers/ci-servers.service.spec
 */

import { ConflictException, ServiceUnavailableException } from '@nestjs/common';

import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { GithubActionsError } from '../test-management/automation/test-automation-github.client';
import { readToolJson } from '../test-management/automation/test-automation-gitlab.client';
import { CiServersService, type ICiServerRow } from './ci-servers.service';
import {
  basicAuthorization,
  flattenJobs,
  normalizeJenkinsUrl,
} from './jenkins-api';
import { encryptApiKey } from '../lib/crypto/encryption';

jest.mock(
  '../test-management/automation/test-automation-gitlab.client',
  () => ({
    ...jest.requireActual<object>(
      '../test-management/automation/test-automation-gitlab.client',
    ),
    readToolJson: jest.fn(),
  }),
);

process.env.AI_ENCRYPTION_SECRET ??= 'a'.repeat(64);

const ORG = 'org-1';
const USER = 'user-1';
const ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://93.184.216.34/jenkins';
const readJson = readToolJson as jest.MockedFunction<typeof readToolJson>;

interface IResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

function makeDb() {
  const queues = new Map<string, IResult[]>();
  const updates: { table: string; patch: unknown }[] = [];

  const from = (table: string) => {
    const result = () => {
      const next = queues.get(table)?.shift() ?? {};

      return { data: next.data ?? null, error: next.error ?? null };
    };
    const builder: Record<string, unknown> = {};

    for (const method of ['select', 'insert', 'delete', 'eq', 'is', 'order'])
      builder[method] = () => builder;
    builder.update = (patch: unknown) => {
      updates.push({ table, patch });

      return builder;
    };
    builder.single = () => Promise.resolve(result());
    builder.maybeSingle = () => Promise.resolve(result());
    builder.then = (resolve: (value: unknown) => unknown) => resolve(result());

    return builder;
  };

  return {
    supabase: {
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService,
    queue: (table: string, ...results: IResult[]) =>
      queues.set(table, [...(queues.get(table) ?? []), ...results]),
    updates,
  };
}

function row(overrides: Partial<ICiServerRow> = {}): ICiServerRow {
  const secret = encryptApiKey('tok-123');

  return {
    id: ID,
    organization_id: ORG,
    provider: 'jenkins',
    name: 'Jenkins',
    base_url: BASE,
    username: 'ci-bot',
    status: 'active',
    status_reason: null,
    last_tested_at: null,
    created_at: '2026-11-09T00:00:00Z',
    updated_at: '2026-11-09T00:00:00Z',
    encrypted_secret: secret.encrypted,
    encryption_iv: secret.iv,
    encryption_tag: secret.tag,
    ...overrides,
  };
}

function setup() {
  const db = makeDb();
  const audit = { logAction: jest.fn() } as unknown as AuditLogsService;

  return { db, audit, service: new CiServersService(db.supabase, audit) };
}

beforeEach(() => readJson.mockReset());

describe('jenkins helpers', () => {
  it('normalises the address and refuses unsafe forms', () => {
    expect(normalizeJenkinsUrl(' HTTPS://CI.Example.com:8443/Jenkins/ ')).toBe(
      'https://ci.example.com:8443/Jenkins',
    );
    expect(normalizeJenkinsUrl('http://ci.example.com')).toBeNull();
    expect(normalizeJenkinsUrl('https://ci.example.com/?a=1')).toBeNull();
    expect(normalizeJenkinsUrl('https://ci.example.com/#x')).toBeNull();
    expect(normalizeJenkinsUrl('https://u:p@ci.example.com')).toBeNull();
  });

  it('flattens jobs two levels deep and drops foreign addresses', () => {
    const jobs = flattenJobs(BASE, {
      jobs: [
        {
          name: 'build',
          url: `${BASE}/job/build/`,
          _class: 'hudson.model.FreeStyleProject',
          property: [{ parameterDefinitions: [{ name: 'BRANCH' }] }],
        },
        {
          name: 'team',
          url: `${BASE}/job/team/`,
          _class: 'com.cloudbees.hudson.plugins.folder.Folder',
          jobs: [
            {
              name: 'app',
              url: `${BASE}/job/team/job/app/`,
              _class:
                'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject',
            },
          ],
        },
        { name: 'evil', url: 'https://evil.example.com/job/evil/' },
      ],
    });

    expect(jobs).toEqual([
      {
        name: 'build',
        url: `${BASE}/job/build/`,
        kind: 'job',
        has_parameters: true,
      },
      {
        name: 'team',
        url: `${BASE}/job/team/`,
        kind: 'folder',
        has_parameters: false,
      },
      {
        name: 'team/app',
        url: `${BASE}/job/team/job/app/`,
        kind: 'multibranch',
        has_parameters: false,
      },
    ]);
  });
});

describe('CiServersService', () => {
  it('creates a server without returning the token', async () => {
    const { db, service } = setup();
    // Even a row that carried the encrypted columns must not pass them on.
    db.queue('ci_servers', { data: row() });

    const dto = await service.create(ORG, USER, {
      name: ' Jenkins ',
      base_url: `${BASE}/`,
      username: ' ci-bot ',
      api_token: 'tok-123',
    });

    expect(dto.has_token).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('tok-123');
    expect(dto).not.toHaveProperty('encrypted_secret');
  });

  it('maps a duplicate address to DUPLICATE_SERVER', async () => {
    const { db, service } = setup();

    db.queue('ci_servers', { error: { message: 'dup', code: '23505' } });

    await expect(
      service.create(ORG, USER, {
        name: 'J',
        base_url: BASE,
        username: 'u',
        api_token: 't',
      }),
    ).rejects.toMatchObject({
      response: { code: 'DUPLICATE_SERVER' },
    });
  });

  it('refuses to delete a server a CI job uses', async () => {
    const { db, service } = setup();

    db.queue('ci_servers', { data: row() });
    db.queue('test_automation_configs', {
      data: [
        { id: 'c1', name: 'Nightly', ci_url: `${BASE}/job/nightly/build` },
        {
          id: 'c2',
          name: 'Other',
          ci_url: 'https://93.184.216.34/other/job/x',
        },
      ],
    });

    const error: unknown = await service
      .remove(ORG, ID, USER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'SERVER_IN_USE',
      jobs: ['Nightly'],
    });
  });

  it('passes the test only when Jenkins names the saved user', async () => {
    const { db, service } = setup();

    db.queue('ci_servers', { data: row() }, {});
    readJson.mockResolvedValueOnce({ id: 'CI-Bot' });

    await expect(service.test(ORG, ID, USER)).resolves.toEqual({
      ok: true,
      status: 'active',
      reason: null,
    });
    expect(readJson.mock.calls[0][1]).toBe(`${BASE}/me/api/json`);
    expect(readJson.mock.calls[0][0].headers.authorization).toBe(
      basicAuthorization('ci-bot', 'tok-123'),
    );
    expect(db.updates[0].patch).toMatchObject({
      status: 'active',
      status_reason: null,
    });
  });

  it('flags a refused token and an unreachable server', async () => {
    const { db, service } = setup();

    db.queue('ci_servers', { data: row() }, {}, { data: row() }, {});
    readJson
      .mockRejectedValueOnce(
        new GithubActionsError(401, 'Jenkins answered 401'),
      )
      .mockRejectedValueOnce(
        new GithubActionsError(null, 'Jenkins could not be reached'),
      );

    await expect(service.test(ORG, ID, USER)).resolves.toMatchObject({
      ok: false,
      status: 'needs_attention',
      code: 'CI_ACCESS_UNAVAILABLE',
    });
    await expect(service.test(ORG, ID, USER)).resolves.toMatchObject({
      ok: false,
      code: 'CI_TOOL_UNAVAILABLE',
    });
    expect(db.updates[0].patch).toMatchObject({ status: 'needs_attention' });
  });

  it('reports an unreachable server on the job list', async () => {
    const { db, service } = setup();

    db.queue('ci_servers', { data: row() });
    readJson.mockRejectedValueOnce(new GithubActionsError(null, 'down'));

    await expect(service.listJobs(ORG, ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('finds the server of a job address by the longest base', async () => {
    const { db, service } = setup();

    db.queue('ci_servers', {
      data: [
        row({ id: 'a', base_url: 'https://93.184.216.34' }),
        row({ id: 'b', base_url: BASE }),
      ],
    });

    await expect(
      service.findForJobUrl(ORG, `${BASE}/job/x/build`),
    ).resolves.toMatchObject({ id: 'b' });
  });

  it('gives one server of the organization, and null for an id it does not have', async () => {
    const { db, service } = setup();

    db.queue('ci_servers', { data: row() }, { data: null });

    await expect(service.rowFor(ORG, ID)).resolves.toMatchObject({
      id: ID,
      encrypted_secret: expect.any(String) as string,
    });
    await expect(service.rowFor(ORG, ID)).resolves.toBeNull();
  });
});
