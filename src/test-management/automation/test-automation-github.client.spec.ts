import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import {
  cancelRun,
  cleanJobLog,
  createWorkflowFile,
  downloadArtifact,
  getRun,
  GithubActionsError,
  listArtifacts,
  listRunJobs,
  listWorkflowFiles,
  putRepositoryVariable,
  readJobLog,
  readWorkflowFile,
  runOrigin,
  updateWorkflowFile,
  type GithubAccess,
} from './test-automation-github.client';

jest.mock('../../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn(),
}));

const access: GithubAccess = {
  apiUrl: 'https://api.github.com',
  fullName: 'acme/tests',
  token: 'ghs_token',
};
const MAX = 1024;

const reply = (
  status: number,
  body = '',
  headers: Record<string, string> = {},
): Response => new Response(status === 302 ? null : body, { status, headers });

describe('the GitHub Actions calls', () => {
  const publicCheck = assertPublicHttpUrl as jest.Mock;
  const realFetch = global.fetch;
  const send = jest.fn();

  beforeEach(() => {
    send.mockReset();
    publicCheck.mockReset();
    publicCheck.mockResolvedValue(undefined);
    global.fetch = send as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  const firstCall = () => (send.mock.calls as [string, RequestInit][])[0];

  it('reads a run with the token', async () => {
    send.mockResolvedValue(
      reply(
        200,
        JSON.stringify({ status: 'completed', conclusion: 'success' }),
      ),
    );

    await expect(getRun(access, 7)).resolves.toEqual({
      status: 'completed',
      conclusion: 'success',
    });

    const [url, options] = firstCall();

    expect(url).toBe('https://api.github.com/repos/acme/tests/actions/runs/7');
    expect(options.headers).toMatchObject({
      authorization: 'Bearer ghs_token',
      'user-agent': expect.any(String) as string,
    });
  });

  it('reports GitHub’s status, so 404 can be told from an outage', async () => {
    send.mockResolvedValue(reply(404));

    await expect(getRun(access, 7)).rejects.toMatchObject({
      status: 404,
      permanent: false,
    });
  });

  it('treats no answer as something to try again', async () => {
    send.mockRejectedValue(new Error('socket hang up'));

    await expect(getRun(access, 7)).rejects.toMatchObject({
      status: null,
      permanent: false,
    });
  });

  it('never puts the token in an error message', async () => {
    send.mockRejectedValue(new Error('failed for ghs_token'));

    await expect(getRun(access, 7)).rejects.not.toThrow('ghs_token');
  });

  describe('listWorkflowFiles', () => {
    it('lists only files a setting could use, sorted, from the default branch', async () => {
      send.mockResolvedValue(
        reply(
          200,
          JSON.stringify([
            { name: 'z.yml', type: 'file' },
            { name: 'a.yaml', type: 'file' },
            { name: 'my tests.yml', type: 'file' },
            { name: 'notes.md', type: 'file' },
            { name: 'old.yml', type: 'dir' },
          ]),
        ),
      );

      await expect(listWorkflowFiles(access)).resolves.toEqual([
        'a.yaml',
        'z.yml',
      ]);
      expect(firstCall()[0]).toBe(
        'https://api.github.com/repos/acme/tests/contents/.github/workflows',
      );
      expect(firstCall()[1].redirect).toBe('manual');
    });

    it('answers none when the folder is missing or is a file', async () => {
      send.mockResolvedValueOnce(reply(404));
      await expect(listWorkflowFiles(access)).resolves.toEqual([]);

      send.mockResolvedValueOnce(reply(200, '{"type":"file"}'));
      await expect(listWorkflowFiles(access)).resolves.toEqual([]);
    });

    it('reports a network failure with no status', async () => {
      send.mockRejectedValue(new TypeError('fetch failed'));

      await expect(listWorkflowFiles(access)).rejects.toMatchObject({
        status: null,
      });
    });
  });

  describe('readWorkflowFile', () => {
    const base64 = (text: string) =>
      Buffer.from(text, 'utf8').toString('base64');
    const file = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'file',
        size: 10,
        encoding: 'base64',
        content: `${base64('on: workflow_dispatch\nname: Tëst\n')}\n`,
        sha: 'abc',
        ...extra,
      });

    it('reads the text and sha', async () => {
      send.mockResolvedValue(reply(200, file()));

      await expect(readWorkflowFile(access, 'tests.yml')).resolves.toEqual({
        content: 'on: workflow_dispatch\nname: Tëst\n',
        sha: 'abc',
      });
      expect(firstCall()[0]).toBe(
        'https://api.github.com/repos/acme/tests/contents/.github/workflows/tests.yml',
      );
    });

    it.each([
      ['gone', reply(404)],
      ['a folder', reply(200, '[]')],
      ['a symlink', reply(200, file({ type: 'symlink' }))],
    ])('treats %s as no file', async (_name, answer) => {
      send.mockResolvedValue(answer);

      await expect(readWorkflowFile(access, 'tests.yml')).resolves.toBeNull();
    });

    it.each([
      ['over 64 KB', file({ size: 65_537 })],
      ['too big for GitHub to send', file({ encoding: 'none', content: '' })],
      [
        'not text',
        file({ content: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') }),
      ],
    ])("won't open a file that is %s", async (_name, body) => {
      send.mockResolvedValue(reply(200, body));

      await expect(readWorkflowFile(access, 'tests.yml')).resolves.toBe(
        'unreadable',
      );
    });

    it('passes on any other failure', async () => {
      send.mockResolvedValue(reply(403));

      await expect(readWorkflowFile(access, 'tests.yml')).rejects.toMatchObject(
        {
          status: 403,
        },
      );
    });
  });

  describe('listRunJobs', () => {
    const job = {
      id: 42009643266,
      name: 'tests',
      status: 'in_progress',
      conclusion: null,
      started_at: '2026-11-05T10:00:00Z',
      completed_at: null,
      html_url: 'https://github.com/acme/tests/actions/runs/7/job/1',
      runner_name: 'private-runner',
      labels: ['self-hosted'],
      steps: [
        {
          number: 1,
          name: 'Run tests',
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-11-05T10:00:00Z',
          completed_at: null,
          extra: 'hidden',
        },
      ],
    };

    it('keeps only the fields a page shows', async () => {
      send.mockResolvedValue(reply(200, JSON.stringify({ jobs: [job] })));

      await expect(listRunJobs(access, 7)).resolves.toEqual([
        {
          id: '42009643266',
          name: 'tests',
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-11-05T10:00:00Z',
          completed_at: null,
          html_url: 'https://github.com/acme/tests/actions/runs/7/job/1',
          steps: [
            {
              number: 1,
              name: 'Run tests',
              status: 'in_progress',
              conclusion: null,
              started_at: '2026-11-05T10:00:00Z',
              completed_at: null,
            },
          ],
        },
      ]);
      expect(firstCall()[0]).toBe(
        'https://api.github.com/repos/acme/tests/actions/runs/7/jobs?per_page=100',
      );
    });

    it.each([['javascript:alert(1)'], ['http://github.com/a']])(
      'drops the link %s',
      async (html_url) => {
        send.mockResolvedValue(
          reply(200, JSON.stringify({ jobs: [{ ...job, html_url }] })),
        );

        const [first] = await listRunJobs(access, 7);

        expect(first.html_url).toBeNull();
      },
    );

    it('answers no jobs when GitHub has none yet', async () => {
      send.mockResolvedValue(reply(200, '{"jobs":[]}'));

      await expect(listRunJobs(access, 7)).resolves.toEqual([]);
    });

    it('passes on a failure', async () => {
      send.mockResolvedValue(reply(404));

      await expect(listRunJobs(access, 7)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('createWorkflowFile', () => {
    it('commits with no sha and no branch, so it can never overwrite', async () => {
      send.mockResolvedValue(reply(201, '{}'));

      await expect(
        createWorkflowFile(access, 'tests.yml', 'on: workflow_dispatch'),
      ).resolves.toBe('created');

      const [url, options] = firstCall();
      const body = JSON.parse(options.body as string) as Record<string, string>;

      expect(url).toBe(
        'https://api.github.com/repos/acme/tests/contents/.github/workflows/tests.yml',
      );
      expect(options.method).toBe('PUT');
      expect(options.redirect).toBe('manual');
      expect(Object.keys(body).sort()).toEqual(['content', 'message']);
      expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe(
        'on: workflow_dispatch',
      );
      expect(body.message).not.toContain('tests.yml');
    });

    it('reports a file that already exists', async () => {
      send.mockResolvedValue(reply(422, '{"message":"sha was not supplied."}'));

      await expect(createWorkflowFile(access, 'tests.yml', 'x')).resolves.toBe(
        'exists',
      );
    });

    it.each([[403], [404], [409], [422], [500]])(
      'passes on a %s that is not about an existing file',
      async (status) => {
        send.mockResolvedValue(reply(status, '{}'));

        await expect(
          createWorkflowFile(access, 'tests.yml', 'x'),
        ).rejects.toMatchObject({ status });
      },
    );
  });

  describe('updateWorkflowFile', () => {
    it('commits with the sha that was read, and no branch', async () => {
      send.mockResolvedValue(reply(200, '{}'));

      await expect(
        updateWorkflowFile(access, 'tests.yml', 'on: workflow_dispatch', 'abc'),
      ).resolves.toBe('updated');

      const [, options] = firstCall();
      const body = JSON.parse(options.body as string) as Record<string, string>;

      expect(options.method).toBe('PUT');
      expect(Object.keys(body).sort()).toEqual(['content', 'message', 'sha']);
      expect(body.sha).toBe('abc');
      expect(body.message).not.toContain('tests.yml');
    });

    it.each([
      [409, '{"message":"tests.yml does not match abc"}'],
      [422, '{"message":"sha was not supplied."}'],
    ])('reports a file that changed on a %s', async (status, body) => {
      send.mockResolvedValue(reply(status, body));

      await expect(
        updateWorkflowFile(access, 'tests.yml', 'x', 'abc'),
      ).resolves.toBe('changed');
    });

    it.each([[403], [404], [422], [500]])(
      'passes on a %s that is not about the version',
      async (status) => {
        send.mockResolvedValue(reply(status, '{}'));

        await expect(
          updateWorkflowFile(access, 'tests.yml', 'x', 'abc'),
        ).rejects.toMatchObject({ status });
      },
    );
  });

  describe('cancelRun', () => {
    it('answers true when GitHub accepts', async () => {
      send.mockResolvedValue(reply(202));

      await expect(cancelRun(access, 7)).resolves.toBe(true);
      expect(firstCall()[0]).toContain('/runs/7/cancel');
      expect(firstCall()[1].method).toBe('POST');
    });

    it('answers false when the run already ended', async () => {
      send.mockResolvedValue(reply(409));

      await expect(cancelRun(access, 7)).resolves.toBe(false);
    });

    it('passes on a refusal', async () => {
      send.mockResolvedValue(reply(403));

      await expect(cancelRun(access, 7)).rejects.toMatchObject({ status: 403 });
    });
  });

  it('lists artifacts, and an empty answer is an empty list', async () => {
    send.mockResolvedValue(reply(200, '{}'));

    await expect(listArtifacts(access, 7)).resolves.toEqual([]);
  });

  describe('downloadArtifact', () => {
    const STORAGE = 'https://storage.example.com/file?signature=abc';

    const pointing = (file: Response) => {
      send
        .mockResolvedValueOnce(reply(302, '', { location: STORAGE }))
        .mockResolvedValueOnce(file);
    };

    it('follows GitHub’s pointer and sends the storage address no token', async () => {
      pointing(reply(200, 'zip-bytes'));

      const buffer = await downloadArtifact(access, 9, MAX);

      expect(buffer.toString()).toBe('zip-bytes');
      expect(firstCall()[1].headers).toMatchObject({
        authorization: 'Bearer ghs_token',
      });

      const [url, options] = (send.mock.calls as [string, RequestInit][])[1];

      expect(url).toBe(STORAGE);
      expect(options.headers).toBeUndefined();
      expect(options.redirect).toBe('error');
    });

    it('refuses a pointer to an address that isn’t public', async () => {
      send.mockResolvedValueOnce(reply(302, '', { location: STORAGE }));
      publicCheck.mockRejectedValue(new Error('private'));

      await expect(downloadArtifact(access, 9, MAX)).rejects.toMatchObject({
        permanent: true,
      });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('refuses a file that states it is too large', async () => {
      pointing(reply(200, 'x', { 'content-length': String(MAX + 1) }));

      await expect(downloadArtifact(access, 9, MAX)).rejects.toMatchObject({
        permanent: true,
      });
    });

    it('stops reading a file larger than it stated', async () => {
      pointing(reply(200, 'x'.repeat(MAX + 1), { 'content-length': '1' }));

      await expect(downloadArtifact(access, 9, MAX)).rejects.toMatchObject({
        permanent: true,
      });
    });

    it('reports an expired artifact', async () => {
      send.mockResolvedValueOnce(reply(410));

      await expect(downloadArtifact(access, 9, MAX)).rejects.toBeInstanceOf(
        GithubActionsError,
      );
    });

    it('treats a failed storage read as something to try again', async () => {
      pointing(reply(500));

      await expect(downloadArtifact(access, 9, MAX)).rejects.toMatchObject({
        status: 500,
        permanent: false,
      });
    });
  });
});

describe('commit, branch and job logs', () => {
  const SHA = 'a'.repeat(40);

  describe('runOrigin', () => {
    it('keeps the commit, branch, attempt and event', () => {
      expect(
        runOrigin({
          status: 'completed',
          conclusion: 'success',
          head_sha: SHA,
          head_branch: 'main',
          run_attempt: 2,
          event: 'workflow_dispatch',
        }),
      ).toEqual({
        head_sha: SHA,
        head_branch: 'main',
        run_attempt: 2,
        event: 'workflow_dispatch',
      });
    });

    it.each([
      ['a short sha', 'abc123'],
      ['upper case', 'A'.repeat(40)],
      ['a sha with markup', `${'a'.repeat(39)}<`],
      ['a number', 42],
    ])('leaves out %s', (_name, sha) => {
      expect(
        runOrigin({ status: 'queued', conclusion: null, head_sha: sha }),
      ).toEqual({});
    });

    it('caps a long branch and event at 255 characters', () => {
      const origin = runOrigin({
        status: 'queued',
        conclusion: null,
        head_branch: 'b'.repeat(300),
        event: 'e'.repeat(300),
        run_attempt: 0,
      });

      expect(origin.head_branch).toHaveLength(255);
      expect(origin.event).toHaveLength(255);
      expect(origin).not.toHaveProperty('run_attempt');
    });
  });

  describe('cleanJobLog', () => {
    it('drops terminal codes and control characters, keeping lines and tabs', () => {
      const raw = Buffer.from(
        '\x1b[32mok\x1b[0m\r\nstep\tdone\x07\x1b]0;title\x07\x00end',
      );

      expect(cleanJobLog(raw, false, false, [])).toBe('ok\nstep\tdoneend');
    });

    it('hides the token', () => {
      expect(
        cleanJobLog(Buffer.from('auth ghs_token used'), false, false, [
          'ghs_token',
        ]),
      ).toBe('auth *** used');
    });

    it('drops a character cut in half at either end', () => {
      const bytes = Buffer.from('éaé');

      expect(cleanJobLog(bytes.subarray(1, 4), true, true, [])).toBe('a');
      expect(cleanJobLog(bytes, false, false, [])).toBe('éaé');
    });
  });

  describe('readJobLog', () => {
    const publicCheck = assertPublicHttpUrl as jest.Mock;
    const realFetch = global.fetch;
    const send = jest.fn();
    const STORAGE = 'https://pipelines.actions.githubusercontent.com/log';

    const stream = (chunks: Buffer[]) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = chunks.shift();

            if (next) controller.enqueue(next);
            else controller.close();
          },
        }),
      );

    beforeEach(() => {
      send.mockReset();
      publicCheck.mockReset();
      publicCheck.mockResolvedValue(undefined);
      global.fetch = send as unknown as typeof fetch;
    });

    afterAll(() => {
      global.fetch = realFetch;
    });

    it('follows GitHub to the storage address without the token', async () => {
      send
        .mockResolvedValueOnce(reply(302, '', { location: STORAGE }))
        .mockResolvedValueOnce(reply(200, 'line 1\nghs_token\n'));

      await expect(readJobLog(access, '55')).resolves.toEqual({
        text: 'line 1\n***\n',
        truncated: false,
        bytes: 17,
      });

      const calls = send.mock.calls as [string, RequestInit][];

      expect(calls[0][0]).toBe(
        'https://api.github.com/repos/acme/tests/actions/jobs/55/logs',
      );
      expect(publicCheck).toHaveBeenCalledWith(STORAGE);
      expect(calls[1][0]).toBe(STORAGE);
      expect(calls[1][1].headers).toBeUndefined();
      expect(calls[1][1].redirect).toBe('error');
    });

    it('keeps only the last 256 KB of a long log', async () => {
      send
        .mockResolvedValueOnce(reply(302, '', { location: STORAGE }))
        .mockResolvedValueOnce(
          stream([
            Buffer.alloc(200 * 1024, 'a'),
            Buffer.alloc(200 * 1024, 'b'),
            Buffer.from('END'),
          ]),
        );

      const log = await readJobLog(access, '55');

      expect(log.truncated).toBe(true);
      expect(log.bytes).toBe(400 * 1024 + 3);
      expect(log.text).toHaveLength(256 * 1024);
      expect(log.text.endsWith('bEND')).toBe(true);
    });

    it('stops reading at the hard limit', async () => {
      const chunks = Array.from({ length: 30 }, () =>
        Buffer.alloc(1024 * 1024, 'x'),
      );

      send
        .mockResolvedValueOnce(reply(302, '', { location: STORAGE }))
        .mockResolvedValueOnce(stream(chunks));

      const log = await readJobLog(access, '55');

      expect(log.truncated).toBe(true);
      expect(log.bytes).toBe(20 * 1024 * 1024);
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('refuses a storage address that isn’t public', async () => {
      send.mockResolvedValueOnce(reply(302, '', { location: STORAGE }));
      publicCheck.mockRejectedValue(new Error('private'));

      await expect(readJobLog(access, '55')).rejects.toMatchObject({
        permanent: true,
      });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it.each([404, 410])('passes on GitHub’s %s', async (status) => {
      send.mockResolvedValueOnce(reply(status));

      await expect(readJobLog(access, '55')).rejects.toMatchObject({ status });
    });

    it('reports a storage read that breaks off', async () => {
      send
        .mockResolvedValueOnce(reply(302, '', { location: STORAGE }))
        .mockRejectedValueOnce(new Error('reset'));

      await expect(readJobLog(access, '55')).rejects.toMatchObject({
        status: null,
      });
    });
  });
});

describe('repository variables', () => {
  const realFetch = global.fetch;
  const send = jest.fn();

  beforeEach(() => {
    send.mockReset();
    global.fetch = send as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  const calls = () => send.mock.calls as [string, RequestInit][];

  it('updates an existing variable', async () => {
    send.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      putRepositoryVariable(access, 'XISUITE_TM_KEY', 'secret-value'),
    ).resolves.toBe(204);
    expect(calls()).toHaveLength(1);
    expect(calls()[0][0]).toBe(
      'https://api.github.com/repos/acme/tests/actions/variables/XISUITE_TM_KEY',
    );
    expect(calls()[0][1]).toMatchObject({
      method: 'PATCH',
      redirect: 'manual',
    });
    expect(JSON.parse(calls()[0][1].body as string)).toEqual({
      name: 'XISUITE_TM_KEY',
      value: 'secret-value',
    });
    expect(
      (calls()[0][1].headers as Record<string, string>).authorization,
    ).toBe('Bearer ghs_token');
  });

  it('creates the variable when it does not exist yet', async () => {
    send.mockResolvedValueOnce(reply(404)).mockResolvedValueOnce(reply(201));

    await expect(
      putRepositoryVariable(access, 'XISUITE_URL', 'https://api.example.com'),
    ).resolves.toBe(201);
    expect(calls()[1][0]).toBe(
      'https://api.github.com/repos/acme/tests/actions/variables',
    );
    expect(calls()[1][1]).toMatchObject({ method: 'POST' });
  });

  it('returns a refusal as its status', async () => {
    send.mockResolvedValue(reply(403));

    await expect(
      putRepositoryVariable(access, 'XISUITE_TM_KEY', 'v'),
    ).resolves.toBe(403);
    expect(calls()).toHaveLength(1);
  });

  it('reports GitHub as unreachable without the value', async () => {
    send.mockRejectedValue(new Error('socket hang up'));

    await expect(
      putRepositoryVariable(access, 'XISUITE_TM_KEY', 'secret-value'),
    ).rejects.toEqual(
      new GithubActionsError(null, 'GitHub could not be reached'),
    );
  });
});
