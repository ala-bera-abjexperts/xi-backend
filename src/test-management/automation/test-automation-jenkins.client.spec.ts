import { EventEmitter } from 'events';
import { request } from 'https';
import { Readable } from 'stream';

import type { CiToolAccess } from './test-automation-gitlab.client';
import {
  cancelQueueItem,
  jenkinsAccess,
  jenkinsBuildJob,
  jenkinsJobName,
  jenkinsProgress,
  jenkinsStart,
  readConsole,
  stopBuild,
} from './test-automation-jenkins.client';

jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('../../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn().mockResolvedValue(undefined),
  isBlockedAddress: jest.fn(() => false),
}));

const requestMock = request as unknown as jest.Mock;
const CI_URL = 'https://jenkins.example.com/job/team/job/nightly/build';
const QUEUE_URL = 'https://jenkins.example.com/queue/item/55/';
const BUILD_URL = 'https://jenkins.example.com/job/team/job/nightly/8/';
const LOGIN = 'Basic dXNlcjp0b2tlbjEyMzQ=';

const access = jenkinsAccess(
  CI_URL,
  { authorization: LOGIN },
  QUEUE_URL,
) as CiToolAccess;

function answer(status: number, body: string) {
  requestMock.mockImplementationOnce(
    (_url: URL, _options: unknown, onResponse: (r: unknown) => void) => {
      const outgoing = Object.assign(new EventEmitter(), { end: jest.fn() });
      const incoming = Object.assign(Readable.from([Buffer.from(body)]), {
        statusCode: status,
        headers: {},
      });

      setImmediate(() => onResponse(incoming));

      return outgoing;
    },
  );
}

const calledUrl = (index = 0) =>
  String((requestMock.mock.calls as unknown[][])[index][0]);

describe('Jenkins client', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it.each([
    ['https://j.example.com/job/a/build', 'a'],
    [
      'https://j.example.com/view/x/job/f%20x/job/b/buildWithParameters/',
      'f x/b',
    ],
    ['https://j.example.com/job/a/', null],
    ['https://j.example.com/build', null],
    ['https://j.example.com/job/%E0/build', null],
  ])('names the job of %s as %s', (url, name) => {
    expect(jenkinsJobName(url)).toBe(name);
  });

  it('reads only with a saved login on the setting’s host', () => {
    expect(access).toMatchObject({
      origin: 'https://jenkins.example.com',
      headers: { authorization: LOGIN },
      secrets: [LOGIN, 'dXNlcjp0b2tlbjEyMzQ='],
    });
    expect(jenkinsAccess(CI_URL, {}, QUEUE_URL)).toBeNull();
    expect(
      jenkinsAccess(CI_URL, { Authorization: LOGIN }, 'https://x.example.com/'),
    ).toBeNull();
  });

  it('follows a start without a saved login only when a connected server signs it in', () => {
    expect(jenkinsStart(CI_URL, {}, QUEUE_URL)).toBeNull();
    expect(jenkinsStart(CI_URL, {}, QUEUE_URL, true)).toEqual({
      provider: 'jenkins',
      state: 'queued',
      full_name: 'team/nightly',
      queue_url: QUEUE_URL,
    });
    expect(
      jenkinsStart('https://jenkins.example.com/hooks/x', {}, QUEUE_URL, true),
    ).toBeNull();
  });

  describe('progress', () => {
    it('stays queued while the queue item has no build', async () => {
      answer(200, '{"cancelled":false,"executable":null}');

      await expect(
        jenkinsProgress(access, { queue_url: QUEUE_URL }),
      ).resolves.toEqual({ state: 'queued' });
      expect(calledUrl()).toBe(
        `${QUEUE_URL}api/json?tree=cancelled,executable%5Bnumber,url%5D`,
      );
    });

    it('sees a queue item that was cancelled', async () => {
      answer(200, '{"cancelled":true}');

      await expect(
        jenkinsProgress(access, { queue_url: QUEUE_URL }),
      ).resolves.toEqual({ state: 'cancelled' });
    });

    it('takes the build number and reads the build once it started', async () => {
      answer(
        200,
        JSON.stringify({ executable: { number: 8, url: BUILD_URL } }),
      );
      answer(200, '{"building":true,"result":null}');

      await expect(
        jenkinsProgress(access, { queue_url: QUEUE_URL }),
      ).resolves.toEqual({ state: 'running', run_id: 8, html_url: BUILD_URL });
      expect(calledUrl(1)).toBe(
        `${BUILD_URL}api/json?tree=building,result,timestamp,duration`,
      );
    });

    it('refuses a build named on another host', async () => {
      answer(
        200,
        JSON.stringify({
          executable: { number: 8, url: 'https://evil.example.com/job/x/8/' },
        }),
      );

      await expect(
        jenkinsProgress(access, { queue_url: QUEUE_URL }),
      ).rejects.toMatchObject({ permanent: true });
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['SUCCESS', 'passed'],
      ['FAILURE', 'failed'],
      ['UNSTABLE', 'failed'],
      ['ABORTED', 'cancelled'],
      ['NOT_BUILT', 'cancelled'],
    ])('reads a build that ended %s as %s', async (result, state) => {
      answer(200, JSON.stringify({ building: false, result }));

      await expect(
        jenkinsProgress(access, { run_id: 8, html_url: BUILD_URL }),
      ).resolves.toEqual({ state });
    });
  });

  it('shows the build as one job', async () => {
    answer(
      200,
      JSON.stringify({
        building: false,
        result: 'UNSTABLE',
        timestamp: Date.UTC(2026, 10, 6, 10),
        duration: 60_000,
      }),
    );

    await expect(
      jenkinsBuildJob(access, 'team/nightly', 8, BUILD_URL),
    ).resolves.toEqual({
      id: '8',
      name: 'team/nightly',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-11-06T10:00:00.000Z',
      completed_at: '2026-11-06T10:01:00.000Z',
      html_url: BUILD_URL,
      steps: [],
    });
  });

  it('hides the saved login in the console', async () => {
    answer(200, 'auth dXNlcjp0b2tlbjEyMzQ= done');

    await expect(readConsole(access, BUILD_URL)).resolves.toMatchObject({
      text: 'auth *** done',
    });
    expect(calledUrl()).toBe(`${BUILD_URL}consoleText`);
  });

  it('stops a build and takes a queued one out, a redirect counting as done', async () => {
    answer(302, '');
    answer(204, '');

    await stopBuild(access, BUILD_URL);
    await cancelQueueItem(access, QUEUE_URL);

    expect(calledUrl(0)).toBe(`${BUILD_URL}stop`);
    expect(calledUrl(1)).toBe(
      'https://jenkins.example.com/queue/cancelItem?id=55',
    );
    expect((requestMock.mock.calls as unknown[][])[1][1]).toMatchObject({
      method: 'POST',
    });
  });

  it('reports a refused stop', async () => {
    answer(403, 'no');

    await expect(stopBuild(access, BUILD_URL)).rejects.toMatchObject({
      status: 403,
    });
  });
});
