/**
 * getBytes redirect-follow tests. Jira Cloud serves attachment content as a 303 to a pre-signed
 * media URL on a DIFFERENT host; the download must follow it, but re-validate every hop (SSRF) and
 * never forward the connection credentials to a foreign host.
 */
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AtlassianHttpClient,
  AtlassianRequestError,
} from './atlassian-http-client';
import type { IAuthStrategy } from '../source-adapter.interface';

const auth: IAuthStrategy = {
  // eslint-disable-next-line @typescript-eslint/require-await
  apply: async (headers: Record<string, string>) => {
    headers.Authorization = 'Basic c2VjcmV0';
  },
};

function res(init: {
  status: number;
  location?: string;
  body?: Buffer;
  contentType?: string;
  retryAfter?: string;
}): Response {
  const headers = new Map<string, string>();

  if (init.location) headers.set('location', init.location);
  if (init.contentType) headers.set('content-type', init.contentType);
  if (init.retryAfter) headers.set('retry-after', init.retryAfter);
  if (init.body) headers.set('content-length', String(init.body.byteLength));

  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      init.body
        ? init.body.buffer.slice(
            init.body.byteOffset,
            init.body.byteOffset + init.body.byteLength,
          )
        : new ArrayBuffer(0),
  } as unknown as Response;
}

describe('AtlassianHttpClient.getBytes redirect handling', () => {
  const origin = 'https://jira.example.com';
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('follows a cross-host 303 to a media URL and returns the bytes', async () => {
    const payload = Buffer.from('PDF-BYTES');

    // hop 0: Jira 303 → media host (IP literal so no DNS is needed in the test)
    fetchMock.mockResolvedValueOnce(
      res({
        status: 303,
        location: 'https://93.184.216.34/media/binary?token=abc',
      }),
    );
    // hop 1: media host 200 with the file
    fetchMock.mockResolvedValueOnce(
      res({ status: 200, body: payload, contentType: 'application/pdf' }),
    );

    const client = new AtlassianHttpClient(origin, auth);
    const out = await client.getBytes('/rest/api/3/attachment/content/10004');

    expect(out.data.toString()).toBe('PDF-BYTES');
    expect(out.contentType).toBe('application/pdf');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Credential-leak guard: the first (Jira) hop carries auth, the cross-host hop does NOT.
    const firstHeaders = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<
      string,
      string
    >;

    expect(firstHeaders.Authorization).toBe('Basic c2VjcmV0');
    expect(secondHeaders.Authorization).toBeUndefined();
  });

  it('keeps auth on a same-host (relative) redirect', async () => {
    const payload = Buffer.from('X');

    fetchMock.mockResolvedValueOnce(
      res({
        status: 302,
        location: '/rest/api/3/attachment/content/10004/binary',
      }),
    );
    fetchMock.mockResolvedValueOnce(res({ status: 200, body: payload }));

    const client = new AtlassianHttpClient(origin, auth);

    await client.getBytes('/rest/api/3/attachment/content/10004');

    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<
      string,
      string
    >;

    expect(secondHeaders.Authorization).toBe('Basic c2VjcmV0');
  });

  it('strips auth on a same-host scheme-downgrade redirect (https → http)', async () => {
    // Same hostname is NOT the same origin: credentials must never travel over the downgraded
    // scheme. IP-literal origin so no DNS is needed; allowInsecureHttp so the http hop itself is
    // permitted and the auth-strip is what's under test.
    fetchMock.mockResolvedValueOnce(
      res({ status: 302, location: 'http://93.184.216.34/secure/file.pdf' }),
    );
    fetchMock.mockResolvedValueOnce(
      res({ status: 200, body: Buffer.from('X') }),
    );

    const client = new AtlassianHttpClient('https://93.184.216.34', auth, {
      allowInsecureHttp: true,
    });

    await client.getBytes('/secure/attachment/1/file.pdf');

    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<
      string,
      string
    >;

    expect(secondHeaders.Authorization).toBeUndefined();
  });

  it('rejects a redirect to a blocked (metadata / link-local) target', async () => {
    fetchMock.mockResolvedValueOnce(
      res({
        status: 303,
        location: 'https://169.254.169.254/latest/meta-data/',
      }),
    );

    const client = new AtlassianHttpClient(origin, auth);

    await expect(
      client.getBytes('/rest/api/3/attachment/content/10004'),
    ).rejects.toBeInstanceOf(AtlassianRequestError);
    // The metadata host is never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still returns bytes directly on a 200 (Server path, no redirect)', async () => {
    fetchMock.mockResolvedValueOnce(
      res({
        status: 200,
        body: Buffer.from('SERVER'),
        contentType: 'text/plain',
      }),
    );

    const client = new AtlassianHttpClient(origin, auth);
    const out = await client.getBytes('/secure/attachment/10004/file.txt');

    expect(out.data.toString()).toBe('SERVER');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 5xx response before reading attachment bytes', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 500 }));
    fetchMock.mockResolvedValueOnce(
      res({ status: 200, body: Buffer.from('RECOVERED') }),
    );

    const client = new AtlassianHttpClient(origin, auth, { maxRetries: 1 });
    const sleep = jest
      .spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);

    const out = await client.getBytes('/secure/attachment/1/a.pdf');

    expect(out.data.toString()).toBe('RECOVERED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries a transient byte-download network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket closed'));
    fetchMock.mockResolvedValueOnce(
      res({ status: 200, body: Buffer.from('RECOVERED') }),
    );

    const client = new AtlassianHttpClient(origin, auth, { maxRetries: 1 });
    jest
      .spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);

    const out = await client.getBytes('/secure/attachment/1/a.pdf');

    expect(out.data.toString()).toBe('RECOVERED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After when retrying a throttled byte response', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 429, retryAfter: '0' }));
    fetchMock.mockResolvedValueOnce(
      res({ status: 200, body: Buffer.from('RECOVERED') }),
    );

    const client = new AtlassianHttpClient(origin, auth, { maxRetries: 1 });
    const sleep = jest
      .spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);

    await client.getBytes('/secure/attachment/1/a.pdf');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });
});

/**
 * getBytesToFile — the streaming large-attachment path. Bytes must land in the destination file
 * (never the heap), the byte cap must produce a typed 413, and a failed download must leave no
 * partial file behind.
 */
describe('AtlassianHttpClient.getBytesToFile', () => {
  const origin = 'https://jira.example.com';
  let fetchMock: jest.Mock;
  let dest: string;

  const streamRes = (
    payload: Buffer,
    init: { contentType?: string; declareLength?: boolean } = {},
  ): Response => {
    // Build headers directly: `declareLength: false` omits content-length so the byte-counter cap
    // (not the declared-length pre-check) is what a test exercises.
    const headers = new Map<string, string>();

    if (init.contentType) headers.set('content-type', init.contentType);
    if (init.declareLength !== false)
      headers.set('content-length', String(payload.byteLength));

    return {
      status: 200,
      ok: true,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(payload));
          controller.close();
        },
      }),
    } as unknown as Response;
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    dest = join(tmpdir(), `xisuite-http-spec-${Date.now()}-${Math.random()}`);
  });

  afterEach(async () => {
    await fs.unlink(dest).catch(() => undefined);
  });

  it('streams the bytes into the destination file and reports size/contentType', async () => {
    const payload = Buffer.from('STREAMED-PDF-BYTES');

    fetchMock.mockResolvedValueOnce(
      streamRes(payload, { contentType: 'application/pdf' }),
    );

    const client = new AtlassianHttpClient(origin, auth);
    const out = await client.getBytesToFile('/secure/attachment/1/a.pdf', dest);

    expect(out.size).toBe(payload.byteLength);
    expect(out.contentType).toBe('application/pdf');
    expect((await fs.readFile(dest)).toString()).toBe('STREAMED-PDF-BYTES');
  });

  it('retries a transient 5xx response before streaming to a file', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 500 }));
    fetchMock.mockResolvedValueOnce(streamRes(Buffer.from('RECOVERED')));

    const client = new AtlassianHttpClient(origin, auth, { maxRetries: 1 });
    jest
      .spyOn(
        client as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);

    await client.getBytesToFile('/secure/attachment/1/a.pdf', dest);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await fs.readFile(dest)).toString()).toBe('RECOVERED');
  });

  it('throws a typed 413 past the byte cap and deletes the partial file', async () => {
    const payload = Buffer.from('TOO-MANY-BYTES-FOR-THE-CAP');

    // No content-length header, so the declared-length pre-check cannot catch it — the counter must.
    fetchMock.mockResolvedValueOnce(
      streamRes(payload, { declareLength: false }),
    );

    const client = new AtlassianHttpClient(origin, auth);
    const attempt = client.getBytesToFile(
      '/secure/attachment/1/a.pdf',
      dest,
      5,
    );

    await expect(attempt).rejects.toMatchObject({
      name: 'AtlassianRequestError',
      status: 413,
    });
    await expect(fs.access(dest)).rejects.toBeDefined();
  });
});

/**
 * Network-failure diagnostics. Before this, every transport fault printed the identical
 * `fetch failed`, so a customer whose self-hosted Jira used an internal CA got no clue what was
 * wrong. These are the first tests in this file that make `fetch` REJECT — the catch blocks had
 * never executed.
 */
describe('AtlassianHttpClient network-failure diagnostics', () => {
  const origin = 'https://jira.example.com';
  let fetchMock: jest.Mock;

  const undiciError = (code: string) =>
    Object.assign(new Error('fetch failed'), {
      cause: Object.assign(
        new Error('unable to verify the first certificate'),
        {
          code,
        },
      ),
    });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('getJson surfaces the TLS code and the CA remedy, keeping the message prefix', async () => {
    fetchMock.mockRejectedValue(undiciError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));

    const client = new AtlassianHttpClient(origin, auth);

    await expect(client.getJson('/rest/api/2/serverInfo')).rejects.toThrow(
      /^Network error calling GET \/rest\/api\/2\/serverInfo: /,
    );
    await expect(client.getJson('/rest/api/2/serverInfo')).rejects.toThrow(
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE[\s\S]*extra-ca\.pem/,
    );
  });

  it('does not retry a certificate failure — it cannot self-heal mid-process', async () => {
    fetchMock.mockRejectedValue(undiciError('SELF_SIGNED_CERT_IN_CHAIN'));

    const client = new AtlassianHttpClient(origin, auth);

    await expect(client.getJson('/rest/api/2/serverInfo')).rejects.toThrow(
      AtlassianRequestError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a refused connection reports its code but suggests no CA', async () => {
    fetchMock.mockRejectedValue(undiciError('ECONNREFUSED'));

    const client = new AtlassianHttpClient(origin, auth, { maxRetries: 0 });

    await expect(client.getJson('/rest/api/2/serverInfo')).rejects.toThrow(
      /ECONNREFUSED/,
    );
    await expect(client.getJson('/rest/api/2/serverInfo')).rejects.not.toThrow(
      /extra-ca\.pem/,
    );
  });

  it('getBytes gets the same treatment, keeping its own prefix', async () => {
    fetchMock.mockRejectedValue(undiciError('DEPTH_ZERO_SELF_SIGNED_CERT'));

    const client = new AtlassianHttpClient(origin, auth);

    await expect(client.getBytes('/secure/attachment/1/a.pdf')).rejects.toThrow(
      /^Byte download failed for \/secure\/attachment\/1\/a\.pdf: [\s\S]*extra-ca\.pem/,
    );
  });
});

/**
 * Context-path support. A customer's Jira Server lived at `http://host:8080/statistik.at/jira`;
 * the client was built from the origin alone, so every request went to `http://host:8080/rest/...`
 * and 404'd while a curl of the configured base URL succeeded.
 */
describe('AtlassianHttpClient context path (basePath)', () => {
  const origin = 'http://jira.example.com:8080';
  let fetchMock: jest.Mock;

  function jsonRes(status: number, body: unknown = {}): Response {
    const text = JSON.stringify(body);

    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(body),
      arrayBuffer: () => Promise.resolve(Buffer.from(text).buffer),
    } as unknown as Response;
  }

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('prefixes relative API paths with the context path', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { version: '9.12.1' }));

    const client = new AtlassianHttpClient(origin, auth, {
      basePath: '/statistik.at/jira',
    });
    const info = await client.getJson<{ version: string }>(
      '/rest/api/2/serverInfo',
    );

    expect(info.version).toBe('9.12.1');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://jira.example.com:8080/statistik.at/jira/rest/api/2/serverInfo',
    );
  });

  it('does not double-prefix a path that already carries the context path', async () => {
    fetchMock.mockResolvedValueOnce(
      res({
        status: 200,
        body: Buffer.from('x'),
        contentType: 'application/pdf',
      }),
    );

    const client = new AtlassianHttpClient(origin, auth, {
      basePath: '/jira/',
    });

    await client.getBytes('/jira/secure/attachment/10001/x.pdf');

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://jira.example.com:8080/jira/secure/attachment/10001/x.pdf',
    );
  });

  it('is byte-identical to the old behaviour without a context path', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, {}));

    const client = new AtlassianHttpClient(origin, auth);

    await client.getJson('/rest/api/2/serverInfo');

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://jira.example.com:8080/rest/api/2/serverInfo',
    );
  });

  it('names the full path in the failure message', async () => {
    fetchMock.mockResolvedValue(jsonRes(404, {}));

    const client = new AtlassianHttpClient(origin, auth, {
      basePath: '/statistik.at/jira',
      maxRetries: 0,
    });

    await expect(client.getJson('/rest/api/2/serverInfo')).rejects.toThrow(
      'GET /statistik.at/jira/rest/api/2/serverInfo failed with 404',
    );
  });
});
