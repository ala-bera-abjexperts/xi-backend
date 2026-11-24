import { lookup as dnsLookup } from 'dns';
import { EventEmitter } from 'events';
import { request } from 'https';
import type { LookupFunction } from 'net';

import {
  CI_REQUEST_TIMEOUT_MS,
  publicOnlyLookup,
  safeHttpsRequest,
} from './safe-https-request';

jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('dns', () => ({ lookup: jest.fn() }));

const requestMock = request as unknown as jest.Mock;
const dnsMock = dnsLookup as unknown as jest.Mock;
const URL_OK = 'https://ci.example.com/build';

interface FakeRequest extends EventEmitter {
  write: jest.Mock;
  end: jest.Mock;
  destroy: jest.Mock;
}

interface FakeResponse extends EventEmitter {
  statusCode: number;
}

interface Captured {
  outgoing: FakeRequest;
  options: Record<string, unknown>;
  respond: (statusCode: number) => FakeResponse;
}

/** Makes the next call use a stand-in request, and hands back how to answer it. */
function captureRequest(): Captured {
  const outgoing = Object.assign(new EventEmitter(), {
    write: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
  });
  const captured = {
    outgoing,
    options: {},
    respond: () => {
      throw new Error('Not requested yet');
    },
  } as Captured;

  requestMock.mockImplementationOnce(
    (
      _target: URL,
      options: Record<string, unknown>,
      onResponse: (response: FakeResponse) => void,
    ) => {
      captured.options = options;
      captured.respond = (statusCode) => {
        const response = Object.assign(new EventEmitter(), { statusCode });

        onResponse(response);

        return response;
      };

      return outgoing;
    },
  );

  return captured;
}

function lookupResult(
  options: Parameters<LookupFunction>[1],
): Promise<{ error: unknown; address: unknown; family: unknown }> {
  return new Promise((resolve) => {
    publicOnlyLookup('ci.example.com', options, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

describe('safeHttpsRequest', () => {
  beforeEach(() => {
    requestMock.mockReset();
    dnsMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('refuses a plain http address without calling it', async () => {
    await expect(
      safeHttpsRequest('http://ci.example.com/build', 'POST', {}, null),
    ).resolves.toEqual({ body: '', failure: 'CI_BLOCKED_HOST' });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('leaves no timer behind when the address cannot be read', async () => {
    jest.useFakeTimers();

    await expect(
      safeHttpsRequest('not a url', 'POST', {}, null),
    ).rejects.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports a request Node refuses and leaves no timer to crash later', async () => {
    jest.useFakeTimers();
    requestMock.mockImplementationOnce(() => {
      throw new TypeError('Invalid character in header content');
    });

    await expect(
      safeHttpsRequest(URL_OK, 'POST', { A: 'caf€' }, null),
    ).resolves.toEqual({ body: '', failure: 'CI_UNREACHABLE' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sends the body with its length through the safe lookup', async () => {
    const call = captureRequest();
    const result = safeHttpsRequest(
      URL_OK,
      'PUT',
      { Authorization: 'Bearer x' },
      '{"a":"é"}',
    );

    expect(call.options).toMatchObject({
      method: 'PUT',
      lookup: publicOnlyLookup,
      headers: { Authorization: 'Bearer x', 'content-length': 10 },
    });
    expect(call.outgoing.write).toHaveBeenCalledWith('{"a":"é"}');
    expect(call.outgoing.end).toHaveBeenCalledTimes(1);

    const response = call.respond(201);

    response.emit('data', Buffer.from('ok'));
    response.emit('end');

    await expect(result).resolves.toEqual({ status: 201, body: 'ok' });
  });

  it('sends no body and no length when there is none', () => {
    const call = captureRequest();

    void safeHttpsRequest(URL_OK, 'POST', { A: 'b' }, null);

    expect(call.options.headers).toEqual({ A: 'b' });
    expect(call.outgoing.write).not.toHaveBeenCalled();

    call.outgoing.emit('error', new Error('stop'));
  });

  it('reports a redirect as an answer and never follows it', async () => {
    const call = captureRequest();
    const result = safeHttpsRequest(URL_OK, 'POST', {}, null);

    call.respond(302).emit('end');

    await expect(result).resolves.toEqual({ status: 302, body: '' });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('stops reading at 2 KB and closes the connection', async () => {
    const call = captureRequest();
    const result = safeHttpsRequest(URL_OK, 'POST', {}, null);
    const response = call.respond(200);

    response.emit('data', Buffer.alloc(1500, 'a'));
    expect(call.outgoing.destroy).not.toHaveBeenCalled();

    response.emit('data', Buffer.alloc(1500, 'b'));

    const answer = await result;

    expect(answer.status).toBe(200);
    expect(answer.body).toHaveLength(2048);
    expect(answer.body.endsWith('b')).toBe(true);
    expect(call.outgoing.destroy).toHaveBeenCalledTimes(1);
  });

  it('ends a slow answer at the limit even while bytes keep coming', async () => {
    jest.useFakeTimers();

    const call = captureRequest();
    const result = safeHttpsRequest(URL_OK, 'POST', {}, null);
    const response = call.respond(200);

    jest.advanceTimersByTime(CI_REQUEST_TIMEOUT_MS - 1);
    response.emit('data', Buffer.from('a'));
    expect(call.outgoing.destroy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);

    await expect(result).resolves.toEqual({ body: '', failure: 'CI_TIMEOUT' });
    expect(call.outgoing.destroy).toHaveBeenCalledTimes(1);
  });

  it('clears the limit once the answer is in', async () => {
    jest.useFakeTimers();

    const call = captureRequest();
    const result = safeHttpsRequest(URL_OK, 'POST', {}, null);

    call.respond(200).emit('end');
    await result;

    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports a connection failure as unreachable', async () => {
    const call = captureRequest();
    const result = safeHttpsRequest(URL_OK, 'POST', {}, null);

    call.outgoing.emit('error', new Error('ECONNREFUSED'));

    await expect(result).resolves.toEqual({
      body: '',
      failure: 'CI_UNREACHABLE',
    });
  });

  it('reports a host the lookup refused as blocked', async () => {
    dnsMock.mockImplementation(
      (
        _host: string,
        _options: unknown,
        done: (error: null, list: unknown[]) => void,
      ) => done(null, [{ address: '10.0.0.5', family: 4 }]),
    );

    const { error } = await lookupResult({ all: true });
    const call = captureRequest();
    const result = safeHttpsRequest(URL_OK, 'POST', {}, null);

    call.outgoing.emit('error', error);

    await expect(result).resolves.toEqual({
      body: '',
      failure: 'CI_BLOCKED_HOST',
    });
  });

  it('passes on where the reply points, without going there', async () => {
    const outgoing = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    });

    requestMock.mockImplementationOnce(
      (_target: URL, _options: unknown, onResponse: (r: unknown) => void) => {
        const response = Object.assign(new EventEmitter(), {
          statusCode: 201,
          headers: { location: 'https://ci.example.com/queue/item/7/' },
        });

        onResponse(response);
        response.emit('end');

        return outgoing;
      },
    );

    await expect(safeHttpsRequest(URL_OK, 'POST', {}, null)).resolves.toEqual({
      status: 201,
      body: '',
      location: 'https://ci.example.com/queue/item/7/',
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('adds no location when the reply has none', async () => {
    const call = captureRequest();
    const result = safeHttpsRequest(URL_OK, 'POST', {}, null);

    call.respond(200).emit('end');

    expect(Object.keys(await result)).toEqual(['status', 'body']);
  });
});

describe('publicOnlyLookup', () => {
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
