import { EventEmitter } from 'events';
import { request } from 'https';
import { Readable } from 'stream';

import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import { publicOnlyLookup } from './safe-https-request';
import {
  cancelPipeline,
  ciToolFetch,
  downloadJobArtifacts,
  getPipeline,
  gitlabAccess,
  gitlabBearerAccess,
  gitlabPipelineAddress,
  gitlabStart,
  hasPrivateToken,
  listPipelineJobs,
  readJobTrace,
  type CiToolAccess,
} from './test-automation-gitlab.client';

jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('../../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn(),
  isBlockedAddress: jest.fn(() => false),
}));

const requestMock = request as unknown as jest.Mock;
const publicCheck = assertPublicHttpUrl as jest.Mock;
const CI_URL = 'https://gitlab.example.com/api/v4/projects/42/pipeline';
const RUN_URL = 'https://gitlab.example.com/group/app/-/pipelines/7';

const access = gitlabAccess(
  CI_URL,
  { 'Private-Token': 'glpat-secret-1' },
  RUN_URL,
) as CiToolAccess;

/** The next call answers with this status, headers and body. */
function answer(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  requestMock.mockImplementationOnce(
    (_url: URL, _options: unknown, onResponse: (r: unknown) => void) => {
      const outgoing = Object.assign(new EventEmitter(), { end: jest.fn() });
      const incoming = Object.assign(Readable.from([Buffer.from(body)]), {
        statusCode: status,
        headers,
      });

      setImmediate(() => onResponse(incoming));

      return outgoing;
    },
  );
}

const calledUrl = (index = 0) =>
  String((requestMock.mock.calls as unknown[][])[index][0]);

describe('GitLab client', () => {
  beforeEach(() => {
    requestMock.mockReset();
    publicCheck.mockReset().mockResolvedValue(undefined);
  });

  describe('access from a setting', () => {
    it('reads with the saved token on the setting’s own host', () => {
      expect(access).toMatchObject({
        origin: 'https://gitlab.example.com',
        base: 'https://gitlab.example.com/api/v4',
        headers: { 'private-token': 'glpat-secret-1' },
        secrets: ['glpat-secret-1'],
      });
    });

    it.each([
      [CI_URL, {}, RUN_URL],
      [CI_URL, { Authorization: 'Bearer x' }, RUN_URL],
      [CI_URL, { 'PRIVATE-TOKEN': 'x' }, 'https://evil.example.com/a'],
      ['https://ci.example.com/job/a/build', { 'PRIVATE-TOKEN': 'x' }, RUN_URL],
    ])('gives none for %s %j %s', (ciUrl, stored, runUrl) => {
      expect(gitlabAccess(ciUrl, stored, runUrl)).toBeNull();
    });

    it('reads with a connection token as Bearer, hiding the bare token too', () => {
      expect(
        gitlabBearerAccess('https://gitlab.example.com/api/v4', 'gl-oauth-123'),
      ).toEqual({
        origin: 'https://gitlab.example.com',
        base: 'https://gitlab.example.com/api/v4',
        label: 'GitLab',
        headers: {
          authorization: 'Bearer gl-oauth-123',
          accept: 'application/json',
          'user-agent': 'XISUITE-Test-Management',
        },
        secrets: ['Bearer gl-oauth-123', 'gl-oauth-123'],
      });
    });

    it('sees a saved private token in any letter case, even blank', () => {
      expect(hasPrivateToken({ 'Private-Token': '' })).toBe(true);
      expect(hasPrivateToken({ Accept: 'x' })).toBe(false);
    });
  });

  describe('the address saved for a connected project', () => {
    it('reads the API root and numeric project', () => {
      expect(gitlabPipelineAddress(CI_URL)).toEqual({
        base: 'https://gitlab.example.com/api/v4',
        projectId: '42',
      });
      expect(
        gitlabPipelineAddress(
          'https://example.com/gitlab/api/v4/projects/7/pipeline',
        ),
      ).toEqual({ base: 'https://example.com/gitlab/api/v4', projectId: '7' });
    });

    it.each([
      ['https://gitlab.example.com/api/v4/projects/42/trigger/pipeline'],
      ['https://gitlab.example.com/api/v4/projects/group%2Fapp/pipeline'],
      ['https://gitlab.example.com/api/v4/projects/42/pipeline/'],
      ['https://gitlab.example.com/api/v4/projects/42/pipeline?ref=main'],
      ['http://gitlab.example.com/api/v4/projects/42/pipeline'],
      ['https://u:p@gitlab.example.com/api/v4/projects/42/pipeline'],
      ['not a url'],
    ])('leaves %s alone', (url) => {
      expect(gitlabPipelineAddress(url)).toBeNull();
    });

    it('follows a start through the connection without a saved token', () => {
      const answer = JSON.stringify({
        id: 7,
        project_id: 42,
        web_url: RUN_URL,
      });

      expect(gitlabStart(CI_URL, {}, answer)).toBeNull();
      expect(gitlabStart(CI_URL, {}, answer, true)).toMatchObject({
        provider: 'gitlab',
        state: 'queued',
        full_name: 'group/app',
        run_id: 7,
        project_id: 42,
      });
    });
  });

  describe('calls', () => {
    it('never sends the token to another host', async () => {
      await expect(
        ciToolFetch(access, 'https://evil.example.com/api/v4/x', 'GET'),
      ).rejects.toMatchObject({ permanent: true });
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('checks the host is public and connects through the safe lookup', async () => {
      answer(200, '{"status":"running"}');

      await getPipeline(access, 42, 7);

      expect(publicCheck).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42/pipelines/7',
      );
      expect((requestMock.mock.calls as unknown[][])[0][1]).toMatchObject({
        method: 'GET',
        lookup: publicOnlyLookup,
        headers: { 'private-token': 'glpat-secret-1' },
      });
    });

    it('does not call a host that stopped being public', async () => {
      publicCheck.mockRejectedValue(new Error('blocked'));

      await expect(getPipeline(access, 42, 7)).rejects.toThrow(
        'GitLab is not a public host',
      );
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('sends a connection token only as Bearer', async () => {
      answer(200, '{"status":"running"}');

      await getPipeline(
        gitlabBearerAccess('https://gitlab.example.com/api/v4', 'gl-oauth-123'),
        42,
        7,
      );

      const { headers } = (requestMock.mock.calls as unknown[][])[0][1] as {
        headers: Record<string, string>;
      };

      expect(headers.authorization).toBe('Bearer gl-oauth-123');
      expect(headers['private-token']).toBeUndefined();
    });

    it('treats a redirect as an answer and does not follow it', async () => {
      answer(302, '', { location: 'https://evil.example.com/' });

      await expect(getPipeline(access, 42, 7)).rejects.toMatchObject({
        status: 302,
      });
      expect(requestMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('pipelines and jobs', () => {
    it.each([
      ['pending', 'queued'],
      ['manual', 'queued'],
      ['running', 'running'],
      ['success', 'passed'],
      ['skipped', 'passed'],
      ['failed', 'failed'],
      ['canceling', 'cancelled'],
      ['canceled', 'cancelled'],
      ['constructor', 'queued'],
    ])('reads a pipeline that is %s as %s', async (status, state) => {
      answer(200, JSON.stringify({ status, sha: 'c'.repeat(40), ref: 'dev' }));

      await expect(getPipeline(access, 42, 7)).resolves.toEqual({
        state,
        head_sha: 'c'.repeat(40),
        head_branch: 'dev',
      });
    });

    it('shows jobs in the GitHub job shape', async () => {
      answer(
        200,
        JSON.stringify([
          {
            id: 1,
            name: 'unit',
            status: 'success',
            started_at: '2026-11-06T10:00:00Z',
            finished_at: '2026-11-06T10:01:00Z',
            web_url: 'https://gitlab.example.com/group/app/-/jobs/1',
          },
          { id: 2, name: 'lint', status: 'failed', web_url: 'javascript:x' },
          { id: 3, name: 'e2e', status: 'running' },
          { id: 4, name: 'deploy', status: 'manual' },
          { id: 5, name: 'later', status: 'created' },
          { id: 'x', name: 'broken' },
        ]),
      );

      const jobs = await listPipelineJobs(access, 42, 7);

      expect(calledUrl()).toBe(
        'https://gitlab.example.com/api/v4/projects/42/pipelines/7/jobs?per_page=100',
      );
      expect(jobs).toEqual([
        {
          id: '1',
          name: 'unit',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-11-06T10:00:00Z',
          completed_at: '2026-11-06T10:01:00Z',
          html_url: 'https://gitlab.example.com/group/app/-/jobs/1',
          steps: [],
        },
        expect.objectContaining({
          id: '2',
          status: 'completed',
          conclusion: 'failure',
          html_url: null,
        }),
        expect.objectContaining({ status: 'in_progress', conclusion: null }),
        expect.objectContaining({ status: 'completed', conclusion: 'skipped' }),
        expect.objectContaining({ status: 'queued', conclusion: null }),
      ]);
    });

    it('hides the saved token in a job log', async () => {
      const log = 'token glpat-secret-1 used\n\u001b[32mok\u001b[0m';

      answer(200, log);

      await expect(readJobTrace(access, 42, '9')).resolves.toEqual({
        text: 'token *** used\nok',
        truncated: false,
        bytes: Buffer.byteLength(log),
      });
      expect(calledUrl()).toBe(
        'https://gitlab.example.com/api/v4/projects/42/jobs/9/trace',
      );
    });

    it('asks GitLab to cancel a pipeline', async () => {
      answer(200, '{}');

      await cancelPipeline(access, 42, 7);

      expect(calledUrl()).toBe(
        'https://gitlab.example.com/api/v4/projects/42/pipelines/7/cancel',
      );
      expect((requestMock.mock.calls as unknown[][])[0][1]).toMatchObject({
        method: 'POST',
      });
    });
  });
});

describe('GitLab job artifacts', () => {
  const ARTIFACTS =
    'https://gitlab.example.com/api/v4/projects/42/jobs/900/artifacts';
  const STORAGE = 'https://storage.example.com/a.zip?signature=abc';
  const MAX = 64;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    requestMock.mockReset();
    publicCheck.mockReset().mockResolvedValue(undefined);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  it('downloads the zip with the saved token from the job’s address', async () => {
    answer(200, 'zip-bytes');

    const zip = await downloadJobArtifacts(access, 42, '900', MAX);

    expect(zip?.toString()).toBe('zip-bytes');
    expect(calledUrl()).toBe(ARTIFACTS);
    expect((requestMock.mock.calls as unknown[][])[0][1]).toMatchObject({
      method: 'GET',
      lookup: publicOnlyLookup,
      headers: { 'private-token': 'glpat-secret-1', accept: '*/*' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives null for a job that kept no artifacts', async () => {
    answer(404, '{"message":"404 Not found"}');

    await expect(downloadJobArtifacts(access, 42, '900', MAX)).resolves.toBe(
      null,
    );
  });

  it('follows a storage redirect once, without the token', async () => {
    answer(302, '', { location: STORAGE });
    fetchSpy.mockResolvedValue(new Response('zip-bytes'));

    const zip = await downloadJobArtifacts(access, 42, '900', MAX);

    expect(zip?.toString()).toBe('zip-bytes');
    expect(publicCheck).toHaveBeenLastCalledWith(STORAGE);

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(STORAGE);
    expect(options.headers).toBeUndefined();
    expect(options.redirect).toBe('error');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to an address that isn’t public', async () => {
    answer(302, '', { location: 'https://10.0.0.5/a.zip' });
    publicCheck
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('private'));

    await expect(
      downloadJobArtifacts(access, 42, '900', MAX),
    ).rejects.toMatchObject({ permanent: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a redirect without an address', async () => {
    answer(302, '');

    await expect(
      downloadJobArtifacts(access, 42, '900', MAX),
    ).rejects.toMatchObject({ status: 302, permanent: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a zip over the size limit', async () => {
    answer(200, 'x'.repeat(MAX + 1));

    await expect(
      downloadJobArtifacts(access, 42, '900', MAX),
    ).rejects.toMatchObject({ permanent: true });
  });

  it('treats a GitLab outage as something to try again', async () => {
    answer(502, 'bad gateway');

    await expect(
      downloadJobArtifacts(access, 42, '900', MAX),
    ).rejects.toMatchObject({ status: 502, permanent: false });
  });
});
