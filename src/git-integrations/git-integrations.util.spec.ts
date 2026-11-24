/**
 * @fileoverview Unit tests for the Git integrations helpers: signed tokens, the OAuth state
 * provider tag, and the return-origin allowlist.
 * @module src/git-integrations/git-integrations.util.spec
 */

import {
  createState,
  readState,
} from '../calendar/integrations/calendar-oauth.state';
import { createHash, createHmac } from 'node:crypto';

import {
  identityReturnUrl,
  identityStateTag,
  integrationsPageUrl,
  parseIdentityStateTag,
  parseStateProviderTag,
  pkceVerifier,
  readToken,
  safeReturnOrigin,
  signToken,
  stateProviderTag,
  extractTaskKeys,
  isRepositoryLive,
  MAX_TASK_KEYS,
  parsePullRequestUrl,
  branchFromRef,
  branchUrl,
  buildPhaseOf,
  buildStateFromGithub,
  buildStateFromGithubStatus,
  missingGithubPermissions,
  buildStateFromGitlab,
  changeIdOf,
  combineBuildStates,
  type IBuildRow,
  summarizeBuilds,
  commitSearchUrl,
  commitTitle,
  comparePullRequests,
  displayStateOf,
  extractClosingKeys,
  pullRequestEvents,
  buildEvent,
} from './git-integrations.util';

const UUID = '0b6f2c3e-1a2b-4c3d-8e9f-0123456789ab';
const ENV_KEYS = [
  'ALLOWED_ORIGINS',
  'FRONTEND_URL',
  'APP_URL',
  'CALENDAR_STATE_SECRET',
] as const;

describe('git-integrations.util', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
    {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.ALLOWED_ORIGINS =
      'https://app.example.com, http://localhost:3000';
    process.env.FRONTEND_URL = 'https://app.example.com/';
    delete process.env.APP_URL;
    process.env.CALENDAR_STATE_SECRET = 'test-secret';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.useRealTimers();
  });

  describe('signToken / readToken', () => {
    it('round-trips the payload', () => {
      const payload = {
        userId: 'u1',
        organizationId: 'o1',
        nested: { a: [1, 2] },
      };

      expect(readToken(signToken(payload))).toEqual(payload);
    });

    it('rejects a missing or malformed token', () => {
      expect(readToken(undefined)).toBeNull();
      expect(readToken('')).toBeNull();
      expect(readToken('no-dot')).toBeNull();
      expect(readToken('.sig')).toBeNull();
    });

    it('rejects a tampered body', () => {
      const [, signature] = signToken({ userId: 'u1' }).split('.');
      const forged = Buffer.from(
        JSON.stringify({ d: { userId: 'admin' }, e: Date.now() + 60_000 }),
      ).toString('base64url');

      expect(readToken(`${forged}.${signature}`)).toBeNull();
    });

    it('rejects a tampered signature', () => {
      const [body, signature] = signToken({ userId: 'u1' }).split('.');
      const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);

      expect(readToken(`${body}.${flipped}`)).toBeNull();
      expect(readToken(`${body}.${signature}x`)).toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
      const token = signToken({ userId: 'u1' });

      process.env.CALENDAR_STATE_SECRET = 'other-secret';

      expect(readToken(token)).toBeNull();
    });

    it('expires after the ttl', () => {
      jest.useFakeTimers({ now: Date.parse('2026-10-16T10:00:00Z') });
      const token = signToken({ userId: 'u1' }, 1000);

      jest.setSystemTime(Date.parse('2026-10-16T10:00:01Z'));
      expect(readToken(token)).toEqual({ userId: 'u1' });

      jest.setSystemTime(Date.parse('2026-10-16T10:00:01.001Z'));
      expect(readToken(token)).toBeNull();
    });

    it('expires after the default ttl of 10 minutes', () => {
      jest.useFakeTimers({ now: Date.parse('2026-10-16T10:00:00Z') });
      const token = signToken('x');

      jest.setSystemTime(Date.parse('2026-10-16T10:09:59Z'));
      expect(readToken(token)).toBe('x');

      jest.setSystemTime(Date.parse('2026-10-16T10:10:01Z'));
      expect(readToken(token)).toBeNull();
    });

    it('is domain-separated from the calendar state, which shares the secret', () => {
      const calendarState = createState('u1', 'o1', 'git:github');

      expect(readState(calendarState)).not.toBeNull();
      expect(readToken(calendarState)).toBeNull();

      const gitToken = signToken({
        u: 'u1',
        o: 'o1',
        p: 'google',
        n: 'n',
        e: Date.now() + 60_000,
      });

      expect(readState(gitToken)).toBeNull();
    });
  });

  describe('stateProviderTag / parseStateProviderTag', () => {
    it('round-trips a provider without a connection id', () => {
      expect(stateProviderTag('github')).toBe('git:github');
      expect(parseStateProviderTag(stateProviderTag('github'))).toEqual({
        provider: 'github',
        connectionId: null,
      });
      expect(parseStateProviderTag(stateProviderTag('gitlab'))).toEqual({
        provider: 'gitlab',
        connectionId: null,
      });
    });

    it('round-trips a reconnect tag with the connection id', () => {
      expect(stateProviderTag('gitlab', UUID)).toBe(`git:gitlab:${UUID}`);
      expect(parseStateProviderTag(stateProviderTag('gitlab', UUID))).toEqual({
        provider: 'gitlab',
        connectionId: UUID,
      });
    });

    it.each([
      'google',
      'git:bitbucket',
      'git:github:',
      'git:github:not-a-uuid',
      `xgit:github`,
      `git:github:${UUID}x`,
      '',
    ])('rejects %p', (tag) => {
      expect(parseStateProviderTag(tag)).toBeNull();
    });
  });

  describe('safeReturnOrigin', () => {
    it('keeps an allowed configured origin', () => {
      expect(safeReturnOrigin('https://app.example.com')).toBe(
        'https://app.example.com',
      );
      expect(safeReturnOrigin('http://localhost:3000')).toBe(
        'http://localhost:3000',
      );
    });

    it('keeps a subdomain of a configured origin', () => {
      expect(safeReturnOrigin('https://acme.app.example.com')).toBe(
        'https://acme.app.example.com',
      );
    });

    it('strips the path, query and hash down to the origin', () => {
      expect(
        safeReturnOrigin('https://acme.app.example.com/tenant-config?tab=x#y'),
      ).toBe('https://acme.app.example.com');
    });

    it.each([
      'https://evil.com',
      'https://app.example.com.evil.com',
      'https://evilapp.example.com',
      'http://app.example.com',
      'javascript:alert(1)',
      'not a url',
    ])('falls back to FRONTEND_URL for %p', (returnTo) => {
      expect(safeReturnOrigin(returnTo)).toBe('https://app.example.com');
    });

    it('falls back when nothing is given', () => {
      expect(safeReturnOrigin(undefined)).toBe('https://app.example.com');
    });

    it('uses FRONTEND_URL as the allowlist when ALLOWED_ORIGINS is unset', () => {
      delete process.env.ALLOWED_ORIGINS;
      process.env.FRONTEND_URL = 'https://other.example.org';

      expect(safeReturnOrigin('https://t1.other.example.org/x')).toBe(
        'https://t1.other.example.org',
      );
      expect(safeReturnOrigin('https://app.example.com')).toBe(
        'https://other.example.org',
      );
    });

    it('falls back to localhost when nothing is configured', () => {
      delete process.env.ALLOWED_ORIGINS;
      delete process.env.FRONTEND_URL;

      expect(safeReturnOrigin('https://evil.com')).toBe(
        'http://localhost:3000',
      );
    });
  });

  describe('integrationsPageUrl', () => {
    it('builds the tenant config integrations url with encoded params', () => {
      const url = integrationsPageUrl(
        'https://acme.app.example.com/whatever',
        'github',
        {
          status: 'error',
          message: 'a b&c=d/é',
        },
      );

      expect(
        url.startsWith('https://acme.app.example.com/tenant-config?'),
      ).toBe(true);
      expect(url).toBe(
        'https://acme.app.example.com/tenant-config?tab=integrations&integration=github&status=error&message=a+b%26c%3Dd%2F%C3%A9',
      );

      const parsed = new URL(url);

      expect(parsed.searchParams.get('message')).toBe('a b&c=d/é');
    });

    it('never lets caller params override tab or integration', () => {
      const url = integrationsPageUrl('https://app.example.com', 'github', {
        tab: 'x',
        integration: 'gitlab',
      });
      const query = new URL(url).searchParams;

      expect([...query.keys()].slice(0, 2)).toEqual(['tab', 'integration']);
      expect(query.getAll('tab')).toEqual(['integrations']);
      expect(query.getAll('integration')).toEqual(['github']);
      expect(url).toContain('?tab=integrations&integration=github');
    });

    it('uses the fallback origin for a foreign returnTo', () => {
      expect(integrationsPageUrl('https://evil.com', 'gitlab')).toBe(
        'https://app.example.com/tenant-config?tab=integrations&integration=gitlab',
      );
    });
  });

  describe('identityStateTag / parseIdentityStateTag', () => {
    it.each([
      ['github', 'profile'],
      ['github', 'integrations'],
      ['gitlab', 'profile'],
      ['gitlab', 'integrations'],
    ] as const)('round-trips %s / %s', (provider, page) => {
      const tag = identityStateTag(provider, page);

      expect(tag).toBe(`git:${provider}:identity:${page}`);
      expect(parseIdentityStateTag(tag)).toEqual({ provider, page });
    });

    it('survives a signed state round trip', () => {
      const opened = readState(
        createState('u1', 'o1', identityStateTag('gitlab', 'profile')),
      );

      expect(parseIdentityStateTag(opened!.provider)).toEqual({
        provider: 'gitlab',
        page: 'profile',
      });
    });

    it('parseStateProviderTag rejects identity tags, so org connect handlers never accept them', () => {
      expect(
        parseStateProviderTag(identityStateTag('github', 'profile')),
      ).toBeNull();
      expect(
        parseStateProviderTag(identityStateTag('gitlab', 'integrations')),
      ).toBeNull();
    });

    it.each([
      'git:github',
      'git:gitlab',
      `git:github:${UUID}`,
      'git:github:identity',
      'git:github:identity:',
      'git:github:identity:admin',
      'git:github:identity:Profile',
      'git:github:identity:profile:x',
      'git:bitbucket:identity:profile',
      'xgit:github:identity:profile',
      'google',
      '',
    ])('parseIdentityStateTag rejects %p', (tag) => {
      expect(parseIdentityStateTag(tag)).toBeNull();
    });
  });

  describe('identityReturnUrl', () => {
    it('profile page forces tab=connectedAccounts', () => {
      const url = identityReturnUrl(
        'https://acme.app.example.com/x',
        'github',
        'profile',
        {
          tab: 'security',
          connected: 'github',
        },
      );
      const query = new URL(url).searchParams;

      expect(url.startsWith('https://acme.app.example.com/user-profile?')).toBe(
        true,
      );
      expect(query.getAll('tab')).toEqual(['connectedAccounts']);
      expect(query.get('connected')).toBe('github');
    });

    it('profile page allow-lists the origin', () => {
      expect(
        identityReturnUrl('https://evil.com', 'gitlab', 'profile', {
          error: 'x',
        }),
      ).toBe(
        'https://app.example.com/user-profile?tab=connectedAccounts&error=x',
      );
      expect(identityReturnUrl(undefined, 'gitlab', 'profile')).toBe(
        'https://app.example.com/user-profile?tab=connectedAccounts',
      );
    });

    it('integrations page delegates to integrationsPageUrl', () => {
      const params = { connected: 'gitlab', tab: 'x', integration: 'github' };

      expect(
        identityReturnUrl(
          'https://acme.app.example.com',
          'gitlab',
          'integrations',
          params,
        ),
      ).toBe(
        integrationsPageUrl('https://acme.app.example.com', 'gitlab', params),
      );
      expect(
        identityReturnUrl('https://evil.com', 'github', 'integrations'),
      ).toBe(
        'https://app.example.com/tenant-config?tab=integrations&integration=github',
      );
    });
  });

  describe('state secret', () => {
    // Bug: hasStateSecret() (git-integrations.util.ts:24) uses `||` but the shared secret()
    // (calendar-oauth.state.ts:39) uses `??`. With CALENDAR_STATE_SECRET set to '' (e.g. `KEY=` in
    // .env) and another secret configured, the Git flows think a real secret exists while every
    // state is signed with an EMPTY key, so anyone can forge a state for any user / org.
    it('a state signed with an empty key is rejected when another secret is configured', () => {
      const savedAi = process.env.AI_ENCRYPTION_SECRET;

      try {
        process.env.CALENDAR_STATE_SECRET = '';
        process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);

        const body = Buffer.from(
          JSON.stringify({
            u: 'victim',
            o: 'org',
            p: identityStateTag('github', 'profile'),
            n: 'x',
            e: Date.now() + 60_000,
          }),
        ).toString('base64url');
        const forged = `${body}.${createHmac('sha256', '').update(body).digest('base64url')}`;

        expect(readState(forged)).toBeNull();
      } finally {
        if (savedAi === undefined) delete process.env.AI_ENCRYPTION_SECRET;
        else process.env.AI_ENCRYPTION_SECRET = savedAi;
      }
    });
  });
});

describe('extractTaskKeys (ticket 4)', () => {
  it.each([
    [['XE-T656-git-integration'], ['XE-T656']],
    [['XE-T1 and XE-T2'], ['XE-T1', 'XE-T2']],
    [['xe-t656'], ['XE-T656']],
    [
      ['feature/XE-T5', 'fix_RM-T9', '(ISO9001-T3)'],
      ['XE-T5', 'RM-T9', 'ISO9001-T3'],
    ],
    [['XE-T5-fix', 'XE-T5fix'], ['XE-T5']],
    [['TASK-12 cleanup'], ['TASK-12']],
    [['XE-T1', 'xe-t1', 'XE-T1'], ['XE-T1']],
  ])('%j -> %j', (texts, keys) => {
    expect(extractTaskKeys(...texts)).toEqual(keys);
  });

  it('matches whole keys only: XE-T6560 is not XE-T656, ABCDEFGHI-T1 is not a key', () => {
    expect(extractTaskKeys('XE-T6560')).toEqual(['XE-T6560']);
    expect(extractTaskKeys('XE-T6560')).not.toContain('XE-T656');
    expect(extractTaskKeys('ABCDEFGHI-T1')).toEqual([]);
    expect(extractTaskKeys('MYTASK-12')).toEqual([]);
  });

  it('ignores empty input and caps the number of keys', () => {
    expect(extractTaskKeys(null, undefined, '')).toEqual([]);

    const many = Array.from({ length: 80 }, (_, i) => `XE-T${i + 1}`).join(' ');

    expect(extractTaskKeys(many)).toHaveLength(MAX_TASK_KEYS);
  });
});

describe('parsePullRequestUrl (ticket 4)', () => {
  it.each([
    [
      'https://github.com/acme/api/pull/12',
      {
        provider: 'github',
        host: 'github.com',
        fullName: 'acme/api',
        number: 12,
      },
    ],
    [
      'https://www.github.com/acme/api/pull/12/files#diff',
      {
        provider: 'github',
        host: 'github.com',
        fullName: 'acme/api',
        number: 12,
      },
    ],
    [
      ' https://github.com/acme/api/pull/7?w=1 ',
      {
        provider: 'github',
        host: 'github.com',
        fullName: 'acme/api',
        number: 7,
      },
    ],
    [
      'https://gitlab.com/group/sub/project/-/merge_requests/3#note_1',
      {
        provider: 'gitlab',
        host: 'gitlab.com',
        fullName: 'group/sub/project',
        number: 3,
      },
    ],
    [
      'https://git.acme.io:8443/g/p/-/merge_requests/9/diffs',
      {
        provider: 'gitlab',
        host: 'git.acme.io:8443',
        fullName: 'g/p',
        number: 9,
      },
    ],
  ])('%s', (url, expected) => {
    expect(parsePullRequestUrl(url)).toEqual(expected);
  });

  it.each([
    'not a url',
    'ftp://github.com/a/b/pull/1',
    'https://github.com/acme/api/issues/12',
    'https://github.com/acme/api/pull/0',
    'https://github.com/acme/api/pull/99999999999',
    'https://gitlab.com/g/p/merge_requests/3',
    'https://github.com/acme/%E0%A4%A/pull/1',
  ])('rejects %s', (url) => {
    expect(parsePullRequestUrl(url)).toBeNull();
  });
});

describe('isRepositoryLive (ticket 4)', () => {
  it('needs a connection that is not disconnected, an enabled and not removed repository', () => {
    const repo = { is_enabled: true, removed_at: null };

    expect(isRepositoryLive({ status: 'active' }, repo)).toBe(true);
    expect(isRepositoryLive({ status: 'needs_attention' }, repo)).toBe(true);
    expect(isRepositoryLive({ status: 'disconnected' }, repo)).toBe(false);
    expect(
      isRepositoryLive({ status: 'active' }, { ...repo, is_enabled: false }),
    ).toBe(false);
    expect(
      isRepositoryLive(
        { status: 'active' },
        { ...repo, removed_at: '2026-01-01' },
      ),
    ).toBe(false);
  });
});

describe('development panel helpers (ticket 5)', () => {
  it.each([
    [{ state: 'merged', isDraft: true, reviewState: 'approved' }, 'merged'],
    [
      { state: 'closed', isDraft: false, reviewState: 'changes_requested' },
      'closed',
    ],
    [{ state: 'open', isDraft: true, reviewState: 'approved' }, 'draft'],
    [
      { state: 'open', isDraft: false, reviewState: 'changes_requested' },
      'changes_requested',
    ],
    [{ state: 'open', isDraft: false, reviewState: 'approved' }, 'approved'],
    [{ state: 'open', isDraft: false, reviewState: null }, 'open'],
  ] as const)('displayStateOf(%j) = %s', (pr, expected) => {
    expect(displayStateOf(pr)).toBe(expected);
  });

  it('orders open → merged → closed, newest first in each group', () => {
    const rows = [
      { id: 'c', state: 'closed', updatedAt: '2026-10-19T09:00:00Z' },
      { id: 'm', state: 'merged', updatedAt: '2026-10-19T12:00:00Z' },
      { id: 'o-old', state: 'open', updatedAt: '2026-10-01T00:00:00Z' },
      { id: 'o-new', state: 'open', updatedAt: '2026-10-19T08:00:00Z' },
    ] as const;

    expect([...rows].sort(comparePullRequests).map((r) => r.id)).toEqual([
      'o-new',
      'o-old',
      'm',
      'c',
    ]);
  });

  it.each([
    ['refs/heads/feature/XE-T5', 'feature/XE-T5'],
    ['XE-T5-fix', 'XE-T5-fix'],
    ['refs/tags/v1', null],
    ['refs/heads/', null],
    [undefined, null],
  ])('branchFromRef(%s) = %s', (ref, expected) => {
    expect(branchFromRef(ref)).toBe(expected);
  });

  it('builds provider branch URLs with encoded segments', () => {
    expect(
      branchUrl('github', 'https://github.com/acme/api/', 'feature/a b'),
    ).toBe('https://github.com/acme/api/tree/feature/a%20b');
    expect(branchUrl('gitlab', 'https://gitlab.com/g/p', 'x#1')).toBe(
      'https://gitlab.com/g/p/-/tree/x%231',
    );
    expect(branchUrl('github', null, 'x')).toBeNull();
  });
});

describe('commits (ticket 6)', () => {
  it.each([
    ['Fixes XE-T1', ['XE-T1']],
    ['fixed xe-t1 and closes XE-T2', ['XE-T1', 'XE-T2']],
    ['Closes: XE-T1, XE-T2 and XE-T3', ['XE-T1', 'XE-T2', 'XE-T3']],
    ['Resolves XE-T1 & TASK-7', ['XE-T1', 'TASK-7']],
    ['fix XE-T1\n\nalso Refs XE-T2', ['XE-T1']],
    ['Refs XE-T1 update docs', []],
    ['Part of XE-T1', []],
    ['XE-T1 fixes the login', []],
    ['prefix XE-T1 fix', []],
    ['Fixes XE-T6560', ['XE-T6560']],
    ['Fixes XE-T1, see XE-T2', ['XE-T1']],
    ['bugfixes XE-T1', []],
    ['Revert "Fixes XE-T1"', []],
    ['Undo\n\nThis reverts commit 1234567abc. Fixes XE-T1', []],
    ['', []],
  ])('extractClosingKeys(%j) = %j', (message, expected) => {
    expect(extractClosingKeys(message)).toEqual(expected);
  });

  it('commitTitle keeps the first line only, trimmed, at most 300 characters', () => {
    expect(commitTitle('Refs XE-T1 docs\r\n\nbody')).toBe('Refs XE-T1 docs');
    expect(commitTitle('  x  ')).toBe('x');
    expect(commitTitle('a'.repeat(400))).toHaveLength(300);
    expect(commitTitle(null)).toBe('');
  });

  it('changeIdOf is stable across sha, email case and time zone; falls back to the sha', () => {
    const id = changeIdOf(
      'Dev@Example.com',
      '2026-10-01T12:00:00+02:00',
      'a'.repeat(40),
    );

    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(
      changeIdOf(' dev@example.com ', '2026-10-01T10:00:00Z', 'b'.repeat(40)),
    ).toBe(id);
    expect(
      changeIdOf('dev@example.com', '2026-10-01T10:00:01Z', 'a'.repeat(40)),
    ).not.toBe(id);
    expect(
      changeIdOf('other@example.com', '2026-10-01T10:00:00Z', 'a'.repeat(40)),
    ).not.toBe(id);
    expect(changeIdOf(null, '2026-10-01T10:00:00Z', 'ABC')).toBe('sha:abc');
    expect(changeIdOf('dev@example.com', 'not a date', 'abc')).toBe('sha:abc');
    expect(changeIdOf('dev@example.com', null, 'abc')).toBe('sha:abc');
  });

  it('commitSearchUrl builds the provider search for one repository', () => {
    expect(
      commitSearchUrl(
        'github',
        'https://github.com/acme/api',
        'acme/api',
        'XE-T1',
      ),
    ).toBe('https://github.com/search?q=repo%3Aacme%2Fapi+XE-T1&type=commits');
    expect(
      commitSearchUrl('gitlab', 'https://gitlab.com/g/p/', 'g/p', 'XE-T1'),
    ).toBe('https://gitlab.com/g/p/-/search?search=XE-T1&scope=commits');
    expect(commitSearchUrl('github', null, 'acme/api', 'XE-T1')).toBeNull();
    expect(
      commitSearchUrl('github', 'not a url', 'acme/api', 'XE-T1'),
    ).toBeNull();
  });
});

describe('builds (ticket 7)', () => {
  it.each([
    ['requested', null, 'queued'],
    ['queued', null, 'queued'],
    ['pending', null, 'queued'],
    ['waiting', null, 'queued'],
    ['in_progress', null, 'running'],
    ['completed', 'success', 'passed'],
    ['completed', 'neutral', 'passed'],
    ['completed', 'failure', 'failed'],
    ['completed', 'timed_out', 'failed'],
    ['completed', 'startup_failure', 'failed'],
    ['completed', 'cancelled', 'cancelled'],
    ['completed', 'stale', 'cancelled'],
    ['completed', 'skipped', 'skipped'],
    ['completed', 'action_required', 'queued'],
    ['completed', 'something_new', 'queued'],
  ] as const)('GitHub %s / %s → %s', (status, conclusion, expected) => {
    expect(buildStateFromGithub(status, conclusion)).toBe(expected);
  });

  it.each([
    ['created', 'queued'],
    ['waiting_for_resource', 'queued'],
    ['preparing', 'queued'],
    ['pending', 'queued'],
    ['scheduled', 'queued'],
    ['manual', 'queued'],
    ['running', 'running'],
    ['waiting_for_callback', 'running'],
    ['success', 'passed'],
    ['failed', 'failed'],
    ['canceling', 'cancelled'],
    ['canceled', 'cancelled'],
    ['skipped', 'skipped'],
    [undefined, 'queued'],
  ] as const)('GitLab %s → %s', (status, expected) => {
    expect(buildStateFromGitlab(status)).toBe(expected);
  });

  it('phases order queued < running < finished', () => {
    expect(
      ['queued', 'running', 'passed', 'failed', 'cancelled', 'skipped'].map(
        (s) => buildPhaseOf(s as never),
      ),
    ).toEqual([0, 1, 2, 2, 2, 2]);
  });

  it.each([
    [['passed', 'failed', 'running'], 'failed'],
    [['passed', 'running'], 'running'],
    [['passed', 'queued'], 'queued'],
    [['passed', 'passed', 'skipped'], 'passed'],
    [['cancelled', 'passed'], 'cancelled'],
    [['cancelled', 'cancelled'], 'cancelled'],
    [['skipped', 'skipped'], 'skipped'],
    [[], null],
  ] as const)('combineBuildStates(%j) = %s', (states, expected) => {
    expect(combineBuildStates([...states])).toBe(expected);
  });

  const row = (overrides: Partial<IBuildRow> = {}): IBuildRow => ({
    id: 'b1',
    provider: 'github',
    workflow_key: 'ci',
    name: 'CI',
    state: 'passed',
    url: 'https://github.com/acme/api/actions/runs/1',
    attempt: 1,
    head_branch: 'XE-T1-x',
    head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    started_at: null,
    completed_at: '2026-10-20T10:05:00Z',
    provider_created_at: '2026-10-20T10:00:00Z',
    ...overrides,
  });

  it("summarizeBuilds: newest run per workflow, combined state, the deciding run's URL", () => {
    const summary = summarizeBuilds(
      [
        row({
          id: 'old-ci',
          state: 'failed',
          url: 'old',
          provider_created_at: '2026-10-20T09:00:00Z',
        }),
        row({ id: 'new-ci', state: 'passed', url: 'ci' }),
        row({
          id: 'lint',
          workflow_key: 'lint',
          state: 'failed',
          url: 'lint-url',
        }),
        row({
          id: 'docs',
          workflow_key: 'docs',
          state: 'skipped',
          url: 'docs',
        }),
      ],
      Array.from({ length: 12 }, (_, i) => row({ id: `h${i}` })),
    );

    expect(summary?.state).toBe('failed');
    expect(summary?.url).toBe('lint-url');
    expect(summary?.runs.map((r) => r.id).sort()).toEqual([
      'docs',
      'lint',
      'new-ci',
    ]);
    expect(summary?.runs[0]).toMatchObject({
      shortSha: 'abcdef1',
      branch: 'XE-T1-x',
      provider: 'github',
    });
    expect(summary?.history).toHaveLength(10);
  });

  it('summarizeBuilds: no current build → null (even with history)', () => {
    expect(summarizeBuilds([], [row()])).toBeNull();
  });
});

describe('development events (ticket 8)', () => {
  describe('pullRequestEvents', () => {
    type Change = Parameters<typeof pullRequestEvents>[0];
    const change = (
      prevState: Change['prevState'],
      prevDraft: boolean | null,
      state: Change['state'],
      isDraft = false,
    ): Change => ({ prevState, prevDraft, state, isDraft });

    it.each<[string, Change, Record<string, string[]>]>([
      [
        'new open → pr_opened',
        change(null, null, 'open'),
        { pr_opened: ['t1'] },
      ],
      ['new draft → none', change(null, null, 'open', true), {}],
      [
        'draft → ready → pr_ready_for_review',
        change('open', true, 'open'),
        { pr_ready_for_review: ['t1'] },
      ],
      ['open → open (duplicate) → none', change('open', false, 'open'), {}],
      ['draft → draft → none', change('open', true, 'open', true), {}],
      [
        'closed → open (reopen) → pr_opened',
        change('closed', false, 'open'),
        { pr_opened: ['t1'] },
      ],
      [
        'open → merged → pr_merged',
        change('open', false, 'merged'),
        { pr_merged: ['t1'] },
      ],
      [
        'new merged → pr_merged',
        change(null, null, 'merged'),
        { pr_merged: ['t1'] },
      ],
      ['merged → merged → none', change('merged', false, 'merged'), {}],
      [
        'open → closed → pr_closed',
        change('open', false, 'closed'),
        { pr_closed: ['t1'] },
      ],
      ['closed → closed → none', change('closed', false, 'closed'), {}],
    ])('%s', (_label, c, expected) => {
      expect(Object.fromEntries(pullRequestEvents(c, ['t1'], []))).toEqual(
        expected,
      );
    });

    it('a task newly linked to an already-open PR gets pr_opened; the old task gets nothing', () => {
      expect(
        Object.fromEntries(
          pullRequestEvents(
            change('open', false, 'open'),
            ['old', 'new'],
            ['new'],
          ),
        ),
      ).toEqual({ pr_opened: ['new'] });
    });

    it('groups mixed tasks per event', () => {
      expect(
        Object.fromEntries(
          pullRequestEvents(
            change('open', true, 'open'),
            ['a', 'b', 'c'],
            ['b', 'c'],
          ),
        ),
      ).toEqual({ pr_ready_for_review: ['a'], pr_opened: ['b', 'c'] });
    });

    it('no tasks → no events', () => {
      expect(pullRequestEvents(change(null, null, 'open'), [], []).size).toBe(
        0,
      );
    });
  });

  describe('buildEvent', () => {
    const run = (
      workflow_key: string,
      state: Parameters<typeof buildEvent>[1],
      provider_created_at = '2026-10-20T10:00:00Z',
    ) => ({
      workflow_key,
      state,
      provider_created_at,
    });

    it('prev == state → null', () => {
      expect(buildEvent('failed', 'failed', [run('ci', 'failed')])).toBeNull();
      expect(buildEvent('passed', 'passed', [run('ci', 'passed')])).toBeNull();
    });

    it('running → failed with any failed → build_failed', () => {
      expect(
        buildEvent('running', 'failed', [
          run('ci', 'failed'),
          run('lint', 'running'),
        ]),
      ).toBe('build_failed');
    });

    it('new failed run (no previous row) → build_failed', () => {
      expect(buildEvent(null, 'failed', [run('ci', 'failed')])).toBe(
        'build_failed',
      );
    });

    it('passed while another workflow still runs → null', () => {
      expect(
        buildEvent('running', 'passed', [
          run('lint', 'passed'),
          run('ci', 'running'),
        ]),
      ).toBeNull();
    });

    it('passed while another workflow failed → null', () => {
      expect(
        buildEvent('running', 'passed', [
          run('lint', 'passed'),
          run('ci', 'failed'),
        ]),
      ).toBeNull();
    });

    it('the last workflow passes, all passed → build_passed', () => {
      expect(
        buildEvent('running', 'passed', [
          run('lint', 'passed'),
          run('ci', 'passed'),
        ]),
      ).toBe('build_passed');
    });

    it('a re-run attempt: the newer row by provider_created_at wins', () => {
      const older = run('ci', 'failed', '2026-10-20T09:00:00Z');
      const newer = run('ci', 'passed', '2026-10-20T11:00:00Z');

      expect(buildEvent('running', 'passed', [older, newer])).toBe(
        'build_passed',
      );
      expect(buildEvent('running', 'passed', [newer, older])).toBe(
        'build_passed',
      );
      expect(
        buildEvent('running', 'failed', [
          run('ci', 'passed', '2026-10-20T09:00:00Z'),
          run('ci', 'failed', '2026-10-20T11:00:00Z'),
        ]),
      ).toBe('build_failed');
    });

    it.each(['cancelled', 'queued', 'running', 'skipped'] as const)(
      '%s → null',
      (state) => {
        expect(buildEvent('running', state, [run('ci', state)])).toBeNull();
      },
    );

    it("skipped workflows don't block passed", () => {
      expect(
        buildEvent('running', 'passed', [
          run('ci', 'passed'),
          run('docs', 'skipped'),
        ]),
      ).toBe('build_passed');
    });
  });
});

describe('GitHub permissions and commit statuses', () => {
  it('missingGithubPermissions compares levels and skips what the account type cannot grant', () => {
    const required = {
      metadata: 'read',
      checks: 'read',
      contents: 'write',
      members: 'read',
      organization_projects: 'read',
      email_addresses: 'read',
    };

    expect(
      missingGithubPermissions(
        required,
        { metadata: 'read', contents: 'read', members: 'read' },
        'Organization',
      ).sort(),
    ).toEqual(['checks', 'contents', 'organization_projects']);
    expect(
      missingGithubPermissions(
        required,
        { metadata: 'read', checks: 'read', contents: 'admin' },
        'User',
      ),
    ).toEqual([]);
    expect(missingGithubPermissions(null, {}, 'Organization')).toEqual([]);
    expect(
      missingGithubPermissions({ checks: 'unknown' }, {}, 'Organization'),
    ).toEqual([]);
  });

  it.each([
    ['success', 'passed'],
    ['failure', 'failed'],
    ['error', 'failed'],
    ['pending', 'running'],
  ])('commit status %s -> %s', (state, expected) => {
    expect(buildStateFromGithubStatus(state)).toBe(expected);
  });
});

describe('Azure DevOps', () => {
  beforeEach(() => {
    process.env.CALENDAR_STATE_SECRET = 'test-secret';
  });

  describe('parsePullRequestUrl', () => {
    const named = (fullName: string, number = 7) => ({
      provider: 'azure_devops',
      host: 'dev.azure.com',
      fullName,
      number,
    });

    it.each([
      [
        'https://dev.azure.com/acme/proj/_git/repo/pullrequest/7',
        named('acme/proj/repo'),
      ],
      [
        'https://dev.azure.com/acme/proj/_git/repo/pullrequest/7?_a=files#x',
        named('acme/proj/repo'),
      ],
      [
        'https://dev.azure.com/acme/proj/_git/repo/pullrequest/7/overview',
        named('acme/proj/repo'),
      ],
      // The address in the Azure DevOps address bar when the repository has the project's name.
      [
        'https://dev.azure.com/rajbhamanekabjexperts/_git/Personal%20Demo/pullrequest/7',
        named('rajbhamanekabjexperts/Personal Demo/Personal Demo'),
      ],
      [
        'https://dev.azure.com/acme/My%20Project/_git/My%20Repo/pullrequest/7',
        named('acme/My Project/My Repo'),
      ],
      [
        'https://acme.visualstudio.com/proj/_git/repo/pullrequest/7',
        named('acme/proj/repo'),
      ],
      [
        'https://acme.visualstudio.com/DefaultCollection/proj/_git/repo/pullrequest/7',
        named('acme/proj/repo'),
      ],
      [
        'https://acme.visualstudio.com/_git/repo/pullrequest/7',
        named('acme/repo/repo'),
      ],
      [
        'https://DEV.AZURE.COM/acme/proj/_git/repo/PullRequest/7',
        named('acme/proj/repo'),
      ],
    ])('reads %s', (url, expected) => {
      expect(parsePullRequestUrl(url)).toEqual(expected);
    });

    it.each([
      // Looks like GitHub by its path, but the host says otherwise.
      'https://dev.azure.com/a/b/pull/12',
      'https://dev.azure.com/acme/proj/_git/repo',
      'https://dev.azure.com/acme/proj/_git/repo/pullrequest/0',
      'https://dev.azure.com/acme/proj/_git/repo/pullrequest/99999999999',
      'https://dev.azure.com/acme/proj/_git/repo/pullrequest/abc',
      'https://dev.azure.com/acme/a/b/_git/repo/pullrequest/7',
      'https://dev.azure.com/acme/%E0%A4%A/_git/repo/pullrequest/7',
    ])('refuses %s', (url) => {
      expect(parsePullRequestUrl(url)).toBeNull();
    });

    it('leaves the other providers as they were', () => {
      expect(parsePullRequestUrl('https://github.com/a/b/pull/1')?.provider).toBe(
        'github',
      );
      expect(
        parsePullRequestUrl('https://gitlab.com/a/b/-/merge_requests/1')
          ?.provider,
      ).toBe('gitlab');
      // A self-managed GitLab whose path merely mentions _git.
      expect(
        parsePullRequestUrl('https://git.co/_git/x/-/merge_requests/1')
          ?.provider,
      ).toBe('gitlab');
    });
  });

  it('builds a branch address with the name encoded, including slashes', () => {
    expect(
      branchUrl(
        'azure_devops',
        'https://dev.azure.com/a/p/_git/r/',
        'feature/XE-T1#2',
      ),
    ).toBe('https://dev.azure.com/a/p/_git/r?version=GBfeature%2FXE-T1%232');
  });

  it('points "more commits" at the commit list', () => {
    expect(
      commitSearchUrl(
        'azure_devops',
        'https://dev.azure.com/a/p/_git/r',
        'a/p/r',
        'XE-T1',
      ),
    ).toBe('https://dev.azure.com/a/p/_git/r/commits');
  });

  it('accepts its state tags', () => {
    expect(parseStateProviderTag(stateProviderTag('azure_devops'))).toEqual({
      provider: 'azure_devops',
      connectionId: null,
    });
    expect(
      parseIdentityStateTag(identityStateTag('azure_devops', 'profile')),
    ).toEqual({ provider: 'azure_devops', page: 'profile' });
  });

  it('derives a PKCE verifier that is valid, per state, and needs the secret', () => {
    const verifier = pkceVerifier('state-1');

    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pkceVerifier('state-1')).toBe(verifier);
    expect(pkceVerifier('state-2')).not.toBe(verifier);
    expect(verifier).not.toBe(
      createHash('sha256').update('state-1').digest('base64url'),
    );
  });
});
