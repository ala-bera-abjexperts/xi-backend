/**
 * `getAttachmentBytes` origin-pinning tests — the on-premise failure mode behind
 * "Attachment URL host (...) does not match the connection origin": Jira's configured `base.url`
 * routinely differs from the URL the connection was created with, so attachment `content` URLs
 * carry a foreign host. The adapter must fetch that URL's PATH from the connection origin (and
 * warn), never contact the advertised host, and never fail the download over the difference.
 */
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AtlassianHttpClient } from '../http/atlassian-http-client';
import type { IAuthStrategy } from '../source-adapter.interface';
import { JiraServerAdapter } from './jira-server.adapter';

const auth: IAuthStrategy = {
  // eslint-disable-next-line @typescript-eslint/require-await
  apply: async (headers: Record<string, string>) => {
    headers.Authorization = 'Basic c2VjcmV0';
  },
};

const CONNECTION_ORIGIN = 'https://10.20.30.40:8080';
const ADVERTISED =
  'https://jira.muenzent.austrian-mint.at/secure/attachment/79837/plan.pdf?x=1';

function bytesRes(payload: Buffer): Response {
  const headers = new Map<string, string>([
    ['content-type', 'application/pdf'],
    ['content-length', String(payload.byteLength)],
  ]);

  return {
    status: 200,
    ok: true,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength,
      ),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(payload));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe('JiraAdapterBase attachment downloads', () => {
  let fetchMock: jest.Mock;
  let adapter: JiraServerAdapter;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(bytesRes(Buffer.from('PDF')));
    global.fetch = fetchMock as unknown as typeof fetch;
    adapter = new JiraServerAdapter(
      new AtlassianHttpClient(CONNECTION_ORIGIN, auth),
    );
  });

  it('fetches a foreign-host URL by its path from the connection origin, never the advertised host', async () => {
    const out = await adapter.getAttachmentBytes(ADVERTISED);

    expect(out.data.toString()).toBe('PDF');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${CONNECTION_ORIGIN}/secure/attachment/79837/plan.pdf?x=1`,
    );
  });

  it('normalizes a relative download URL against the connection origin', async () => {
    await adapter.getAttachmentBytes('secure/attachment/1/a.png');

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${CONNECTION_ORIGIN}/secure/attachment/1/a.png`,
    );
  });

  it('rejects a blank download URL instead of downloading the site homepage', async () => {
    await expect(adapter.getAttachmentBytes('  ')).rejects.toThrow(
      'Attachment has no download URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getAttachmentBytesToFile pins the same way and streams to the destination', async () => {
    const dest = join(tmpdir(), `xisuite-adapter-spec-${Date.now()}`);

    try {
      const out = await adapter.getAttachmentBytesToFile(ADVERTISED, dest);

      expect(out.size).toBe(3);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${CONNECTION_ORIGIN}/secure/attachment/79837/plan.pdf?x=1`,
      );
      expect((await fs.readFile(dest)).toString()).toBe('PDF');
    } finally {
      await fs.unlink(dest).catch(() => undefined);
    }
  });
});
