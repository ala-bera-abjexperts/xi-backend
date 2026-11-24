import { lookup as dnsLookup } from 'dns';
import { EventEmitter } from 'events';
import { request } from 'https';
import type { LookupFunction } from 'net';

import { safeGetLookup, safeHttpsGet } from './safe-https-get';

jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('dns', () => ({ lookup: jest.fn() }));

const requestMock = request as unknown as jest.Mock;
const dnsMock = dnsLookup as unknown as jest.Mock;

interface FakeResponse extends EventEmitter {
  statusCode: number;
}

function lookupResult(
  options: Parameters<LookupFunction>[1],
): Promise<{ error: unknown; address: unknown; family: unknown }> {
  return new Promise((resolve) => {
    safeGetLookup('ci.example.com', options, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

describe('safeGetLookup', () => {
  const answers = (list: { address: string; family: number }[]) =>
    dnsMock.mockImplementation(
      (
        _host: string,
        _options: unknown,
        done: (error: null, addresses: unknown[]) => void,
      ) => done(null, list),
    );

  beforeEach(() => {
    dnsMock.mockReset();
  });

  it('hands back the first address of a public host', async () => {
    answers([{ address: '93.184.216.34', family: 4 }]);

    await expect(lookupResult({})).resolves.toEqual({
      error: null,
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('hands back the whole list when asked for all of them', async () => {
    const list = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];

    answers(list);

    await expect(lookupResult({ all: true })).resolves.toMatchObject({
      error: null,
      address: list,
    });
  });

  it.each(['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '::1'])(
    'refuses a host when any address is %s',
    async (address) => {
      answers([
        { address: '93.184.216.34', family: 4 },
        { address, family: address.includes(':') ? 6 : 4 },
      ]);

      const { error } = await lookupResult({});

      expect(error).toBeInstanceOf(Error);
    },
  );

  it('refuses a host with no address', async () => {
    answers([]);

    const { error } = await lookupResult({});

    expect(error).toBeInstanceOf(Error);
  });

  it('passes on a failed lookup', async () => {
    const failed = new Error('ENOTFOUND');

    dnsMock.mockImplementation(
      (_host: string, _options: unknown, done: (error: Error) => void) =>
        done(failed),
    );

    await expect(lookupResult({})).resolves.toMatchObject({ error: failed });
  });
});

describe('safeHttpsGet', () => {
  const OPTIONS = { maxBytes: 100, deadlineMs: 5_000 };

  /** The address and options of the nth GET that was sent. */
  function sent(index: number): {
    target: string;
    headers: unknown;
    lookup: unknown;
  } {
    const [target, options] = requestMock.mock.calls[index] as [
      URL,
      { headers: unknown; lookup: unknown },
    ];

    return {
      target: target.toString(),
      headers: options.headers,
      lookup: options.lookup,
    };
  }

  /** Answers the next GET with this status, headers and body once it is sent. */
  function answerNext(
    statusCode: number,
    headers: Record<string, string> = {},
    body = '',
  ): void {
    requestMock.mockImplementationOnce(
      (
        _target: URL,
        _options: Record<string, unknown>,
        onResponse: (response: FakeResponse) => void,
      ) => {
        const outgoing = Object.assign(new EventEmitter(), {
          write: jest.fn(),
          end: jest.fn(() => {
            const response = Object.assign(new EventEmitter(), {
              statusCode,
              headers,
            });

            onResponse(response);
            if (body) response.emit('data', Buffer.from(body));
            response.emit('end');
          }),
          destroy: jest.fn(),
        });

        return outgoing;
      },
    );
  }

  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('follows a redirect to another host and drops the sign-in header', async () => {
    answerNext(307, { location: 'https://cdn.example.com/blob' });
    answerNext(200, {}, 'data');

    const result = await safeHttpsGet(
      'https://registry.example.com/v2/a',
      { authorization: 'Bearer t', accept: 'x' },
      OPTIONS,
    );

    expect(result.body.toString()).toBe('data');
    expect(sent(1)).toEqual({
      target: 'https://cdn.example.com/blob',
      headers: { accept: 'x' },
      lookup: safeGetLookup,
    });
  });

  it('keeps the sign-in header on the same host', async () => {
    answerNext(302, { location: '/v2/b' });
    answerNext(200);

    await safeHttpsGet(
      'https://registry.example.com/v2/a',
      { authorization: 'Bearer t' },
      OPTIONS,
    );

    expect(sent(1).headers).toEqual({ authorization: 'Bearer t' });
  });

  it('refuses plain http, also after a redirect', async () => {
    await expect(
      safeHttpsGet('http://registry.example.com/v2/a', {}, OPTIONS),
    ).rejects.toMatchObject({
      failure: 'BLOCKED_HOST',
    });

    answerNext(302, { location: 'http://cdn.example.com/blob' });

    await expect(
      safeHttpsGet('https://registry.example.com/v2/a', {}, OPTIONS),
    ).rejects.toMatchObject({
      failure: 'BLOCKED_HOST',
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('reports a broken redirect as unreachable', async () => {
    answerNext(302, { location: 'https://exa mple.com:99999/blob' });

    await expect(
      safeHttpsGet('https://registry.example.com/v2/a', {}, OPTIONS),
    ).rejects.toMatchObject({
      failure: 'UNREACHABLE',
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('stops after three redirects', async () => {
    for (let index = 0; index < 4; index++)
      answerNext(302, { location: `/v2/${index}` });

    await expect(
      safeHttpsGet('https://registry.example.com/v2/a', {}, OPTIONS),
    ).rejects.toMatchObject({
      failure: 'TOO_MANY_REDIRECTS',
    });
  });

  it('stops an answer larger than the limit', async () => {
    answerNext(200, {}, 'x'.repeat(101));

    await expect(
      safeHttpsGet('https://registry.example.com/v2/a', {}, OPTIONS),
    ).rejects.toMatchObject({
      failure: 'TOO_LARGE',
    });
  });

  it('stops at the time limit', async () => {
    jest.useFakeTimers();

    const outgoing = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    });

    requestMock.mockImplementationOnce(() => outgoing);

    const pending = safeHttpsGet(
      'https://registry.example.com/v2/a',
      {},
      OPTIONS,
    );

    jest.advanceTimersByTime(5_000);

    await expect(pending).rejects.toMatchObject({ failure: 'TIMEOUT' });
    expect(outgoing.destroy).toHaveBeenCalled();
  });

  it('reports a host the lookup refused as blocked', async () => {
    const outgoing = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    });

    requestMock.mockImplementationOnce(() => outgoing);

    dnsMock.mockImplementationOnce(
      (
        _host: string,
        _options: unknown,
        done: (error: null, list: unknown[]) => void,
      ) => done(null, [{ address: '10.0.0.5', family: 4 }]),
    );

    const { error } = await lookupResult({ all: true });
    const pending = safeHttpsGet(
      'https://registry.example.com/v2/a',
      {},
      OPTIONS,
    );

    outgoing.emit('error', error);

    await expect(pending).rejects.toMatchObject({ failure: 'BLOCKED_HOST' });
  });

  it('refuses an IP address in any form, before anything is sent', async () => {
    const addresses = [
      'https://10.0.0.5/v2/a',
      'https://127.0.0.1./v2/a',
      'https://2130706433/v2/a',
      'https://0x7f.1/v2/a',
      'https://0177.0.0.1/v2/a',
      'https://[::1]/v2/a',
      'https://[::ffff:127.0.0.1]/v2/a',
      'https://8.8.8.8/v2/a',
    ];

    for (const address of addresses) {
      await expect(safeHttpsGet(address, {}, OPTIONS)).rejects.toMatchObject({
        failure: 'BLOCKED_HOST',
      });
    }

    expect(requestMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect to an IP address', async () => {
    for (const location of ['https://10.0.0.5/blob', 'https://[::1]/blob']) {
      requestMock.mockReset();
      answerNext(302, { location });

      await expect(
        safeHttpsGet('https://registry.example.com/v2/a', {}, OPTIONS),
      ).rejects.toMatchObject({ failure: 'BLOCKED_HOST' });
      expect(requestMock).toHaveBeenCalledTimes(1);
    }
  });
});
