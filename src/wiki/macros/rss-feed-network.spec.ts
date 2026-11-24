import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { request } from 'node:http';
import { fetchFeed } from './rss-feed';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:http', () => ({ request: jest.fn() }));

const dns = lookup as jest.Mock;
const http = request as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  dns.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});
function respond(
  statusCode: number,
  headers: Record<string, string>,
  body: string | Buffer,
) {
  http.mockImplementationOnce((_url, options, callback) => {
    // The socket must use the validated address even if DNS changes later.
    options.lookup(
      'feed.example',
      {},
      (_error: unknown, address: string, family: number) => {
        expect(address).toBe('93.184.216.34');
        expect(family).toBe(4);
      },
    );
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const response = Object.assign(new PassThrough(), {
        statusCode,
        headers,
      });
      callback(response);
      response.end(body);
    };
    return req;
  });
}
it('pins DNS and refuses a redirect to a private address', async () => {
  respond(302, { location: 'http://127.0.0.1/private' }, '');
  await expect(fetchFeed('http://feed.example/redirect')).rejects.toThrow(
    'public address',
  );
  expect(http).toHaveBeenCalledTimes(1);
});
it('refuses mixed public and private DNS answers before connecting', async () => {
  dns.mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '10.1.2.3', family: 4 },
  ]);
  await expect(fetchFeed('http://feed.example/mixed')).rejects.toThrow(
    'public address',
  );
  expect(http).not.toHaveBeenCalled();
});
it('bounds redirects and response size', async () => {
  for (let index = 0; index < 4; index++)
    respond(302, { location: '/loop' }, '');
  await expect(fetchFeed('http://feed.example/loop')).rejects.toThrow(
    'redirects',
  );
  respond(200, {}, Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(fetchFeed('http://feed.example/large')).rejects.toThrow('2 MB');
});
it('decodes declared non-UTF8 feeds and caches a successful response', async () => {
  respond(
    200,
    { 'content-type': 'application/rss+xml; charset=iso-8859-1' },
    Buffer.from('<rss><channel><title>Café</title></channel></rss>', 'latin1'),
  );
  expect((await fetchFeed('http://feed.example/latin')).title).toBe('Café');
  expect((await fetchFeed('http://feed.example/latin')).title).toBe('Café');
  expect(http).toHaveBeenCalledTimes(1);
});

it('reports malformed redirect locations as errors without crashing the request handler', async () => {
  respond(302, { location: 'http://[' }, '');
  await expect(fetchFeed('http://feed.example/bad-redirect')).rejects.toThrow();
});

it('bounds a DNS lookup that never completes', async () => {
  const controller = new AbortController();
  const timeout = jest
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(controller.signal);
  dns.mockReturnValue(new Promise(() => undefined));
  try {
    const pending = fetchFeed('http://feed.example/dns-timeout');
    controller.abort();
    await expect(pending).rejects.toThrow('timed out');
    expect(http).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});
