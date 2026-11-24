import { EventEmitter } from 'events';
import { request } from 'https';
import type { LookupFunction } from 'net';

import { safeHttpsStream, type SafeStreamOptions } from './safe-https-stream';

jest.mock('https', () => ({ request: jest.fn() }));

const requestMock = request as unknown as jest.Mock;

const GET: SafeStreamOptions = {
  method: 'GET',
  maxBytes: 100,
  deadlineMs: 5_000,
};

interface Sent {
  target: string;
  method: unknown;
  headers: unknown;
}

function sent(index: number): Sent {
  const [target, options] = requestMock.mock.calls[index] as [
    URL,
    { method: unknown; headers: unknown },
  ];

  return {
    target: target.toString(),
    method: options.method,
    headers: options.headers,
  };
}

/** Answers the next request with this status, headers and body pieces once it is sent. */
function answerNext(
  statusCode: number,
  headers: Record<string, string> = {},
  pieces: string[] = [],
): void {
  requestMock.mockImplementationOnce(
    (
      _target: URL,
      _options: Record<string, unknown>,
      onResponse: (response: EventEmitter) => void,
    ) =>
      Object.assign(new EventEmitter(), {
        end: jest.fn(() => {
          const response = Object.assign(new EventEmitter(), {
            statusCode,
            headers,
            pause: jest.fn(),
            resume: jest.fn(),
          });

          onResponse(response);

          for (const piece of pieces) response.emit('data', Buffer.from(piece));

          response.emit('end');
        }),
        destroy: jest.fn(),
      }),
  );
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('safeHttpsStream', () => {
  it('hands a body over piece by piece, after a redirect to storage without the sign-in', async () => {
    const pieces: string[] = [];

    answerNext(307, { location: 'https://cdn.example.com/blob' });
    answerNext(200, { 'content-length': '6' }, ['abc', 'def']);

    const result = await safeHttpsStream(
      'https://registry.example.com/v2/a/blobs/x',
      { authorization: 'Bearer t', accept: 'x' },
      { ...GET, onData: (chunk) => void pieces.push(chunk.toString()) },
    );

    expect(pieces).toEqual(['abc', 'def']);
    expect(result).toMatchObject({ status: 200, bytes: 6 });
    expect(sent(1)).toEqual({
      target: 'https://cdn.example.com/blob',
      method: 'GET',
      headers: { accept: 'x' },
    });
  });

  it('waits for a slow receiver and keeps the order', async () => {
    const pieces: string[] = [];

    answerNext(200, {}, ['1', '2', '3']);

    await safeHttpsStream(
      'https://registry.example.com/b',
      {},
      {
        ...GET,
        onData: async (chunk) => {
          await new Promise((done) => setTimeout(done, 5));
          pieces.push(chunk.toString());
        },
      },
    );

    expect(pieces).toEqual(['1', '2', '3']);
  });

  it('asks only for the headers with HEAD', async () => {
    const onData = jest.fn();

    answerNext(200, { 'content-length': '1234' });

    const result = await safeHttpsStream(
      'https://registry.example.com/b',
      {},
      {
        ...GET,
        method: 'HEAD',
        onData,
      },
    );

    expect(result.headers['content-length']).toBe('1234');
    expect(sent(0).method).toBe('HEAD');
    expect(onData).not.toHaveBeenCalled();
  });

  it('gives back a refusal without handing its body over', async () => {
    const onData = jest.fn();

    answerNext(404, {}, ['not found']);

    await expect(
      safeHttpsStream(
        'https://registry.example.com/b',
        {},
        {
          ...GET,
          onData,
        },
      ),
    ).resolves.toMatchObject({ status: 404 });
    expect(onData).not.toHaveBeenCalled();
  });

  it('stops past the size limit, on a body cut short and when the receiver fails', async () => {
    answerNext(200, {}, ['x'.repeat(60), 'x'.repeat(60)]);
    await expect(
      safeHttpsStream('https://registry.example.com/b', {}, GET),
    ).rejects.toMatchObject({ failure: 'TOO_LARGE' });

    answerNext(200, { 'content-length': '10' }, ['abc']);
    await expect(
      safeHttpsStream('https://registry.example.com/b', {}, GET),
    ).rejects.toMatchObject({ failure: 'UNREACHABLE' });

    const full = new Error('disk full');

    answerNext(200, {}, ['abc']);
    await expect(
      safeHttpsStream(
        'https://registry.example.com/b',
        {},
        {
          ...GET,
          onData: () => Promise.reject(full),
        },
      ),
    ).rejects.toBe(full);
  });

  it('refuses plain http and IP addresses without sending anything', async () => {
    for (const url of [
      'http://registry.example.com/b',
      'https://10.0.0.5/b',
      'https://[::1]/b',
    ]) {
      await expect(safeHttpsStream(url, {}, GET)).rejects.toMatchObject({
        failure: 'BLOCKED_HOST',
      });
    }

    expect(requestMock).not.toHaveBeenCalled();
  });

  it('tells a host the lookup refused apart from one that cannot be reached', async () => {
    const refusing: LookupFunction = (_host, _options, callback) =>
      callback(new Error('blocked'), '', 0);

    requestMock.mockImplementationOnce(
      (_target: URL, options: { lookup: LookupFunction }) => {
        const outgoing = Object.assign(new EventEmitter(), {
          end: jest.fn(() =>
            options.lookup('registry.example.com', {}, (error) =>
              outgoing.emit('error', error),
            ),
          ),
          destroy: jest.fn(),
        });

        return outgoing;
      },
    );

    await expect(
      safeHttpsStream('https://registry.example.com/b', {}, GET, refusing),
    ).rejects.toMatchObject({ failure: 'BLOCKED_HOST' });
  });

  it('stops at once when the work is stopped', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      safeHttpsStream(
        'https://registry.example.com/b',
        {},
        {
          ...GET,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ failure: 'TIMEOUT' });
    expect(requestMock).not.toHaveBeenCalled();
  });
});
