import { NotFoundException } from '@nestjs/common';

import type { AttachmentsService } from '../attachments/attachments.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AgentFilesService, MAX_FILE_BYTES, MAX_RUN_FILE_CHARS, storageUrl } from './agent-files.service';

const invoker = { userId: 'me', organizationId: 'org-1' };
const file = (n: number, over: Record<string, unknown> = {}) => ({
  handle: `F${n}`,
  attachmentId: `att-${n}`,
  name: `notes-${n}.txt`,
  mime: 'text/plain',
  size: 100,
  from: 'm3',
  ...over,
});

describe('storageUrl (1.18)', () => {
  it('resolves a browser-relative signed URL against the storage, and fetches nothing else', () => {
    expect(storageUrl('/storage/v1/object/sign/attachments/a.pdf?token=t', 'http://127.0.0.1:54321')).toBe(
      'http://127.0.0.1:54321/storage/v1/object/sign/attachments/a.pdf?token=t',
    );
    expect(storageUrl('https://x.supabase.co/storage/v1/object/sign/a?token=t', 'https://x.supabase.co')).toContain('https://x.supabase.co/');
    expect(() => storageUrl('http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:54321')).toThrow();
    expect(() => storageUrl('http://127.0.0.1:54321/rest/v1/users', 'http://127.0.0.1:54321')).toThrow();
  });
});

describe('AgentFilesService (1.18)', () => {
  let getDownloadInfo: jest.Mock;
  let fetchMock: jest.Mock;
  let service: AgentFilesService;
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.SUPABASE_URL ??= 'http://127.0.0.1:54321';
    getDownloadInfo = jest.fn(({ attachmentId }: { attachmentId: string }) =>
      attachmentId === 'att-9'
        ? Promise.reject(new NotFoundException('Attachment not found'))
        : Promise.resolve({ signedUrl: `/storage/v1/object/sign/attachments/${attachmentId}` }),
    );
    fetchMock = jest.fn((url: string) =>
      Promise.resolve(new Response(url.endsWith('att-big') ? 'x'.repeat(MAX_FILE_BYTES + 10) : `Text of ${url.split('/').pop()}`)),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    service = new AgentFilesService(
      {} as SupabaseAdminService,
      { getDownloadInfo } as unknown as AttachmentsService,
    );
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reads a file only through the invoker download check, and downloads nothing without access', async () => {
    const out = await service.read(invoker, [file(1), file(9)]);
    expect(getDownloadInfo).toHaveBeenCalledWith({ attachmentId: 'att-1', user: invoker });
    expect(out[0]).toMatchObject({ handle: 'F1', text: 'Text of att-1', truncated: false });
    expect(out[1]).toMatchObject({ handle: 'F9', text: '', unreadable: 'no_access' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips a file that is too large before and while downloading', async () => {
    const out = await service.read(invoker, [file(2, { size: MAX_FILE_BYTES + 1 }), file(3, { attachmentId: 'att-big', size: null })]);
    expect(out.map((f) => f.unreadable)).toEqual(['too_large', 'too_large']);
    expect(getDownloadInfo).toHaveBeenCalledTimes(1);
  });

  it('reads at most 8 files and shares the run budget fairly, so no file is left unread', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(Array.from({ length: 4_000 }, (_, i) => `line ${i}`).join('\n'))));
    const out = await service.read(invoker, Array.from({ length: 12 }, (_, i) => file(i + 1)));
    expect(out).toHaveLength(8);
    expect(out.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(MAX_RUN_FILE_CHARS);
    for (const f of out) {
      expect(f.text.length).toBeGreaterThan(1_000);
      expect(f.truncated).toBe(true);
      expect(f.readPercent).toBeGreaterThan(0);
    }
  });

  it('gives what a short file does not need to the long one, and keeps what the request asks for', async () => {
    const long = `${Array.from({ length: 2_000 }, (_, i) => `Background sentence number ${i}.`).join('\n\n')}\n\nThe warranty period is seven years.`;
    fetchMock.mockImplementation((url: string) => Promise.resolve(new Response(url.endsWith('att-1') ? 'short note' : long)));
    const out = await service.read(invoker, [file(1), file(2)], 'what is the warranty period?', 20_000);
    expect(out[0].truncated).toBe(false);
    expect(out[0].text).toBe('[F1 notes-1.txt]\nshort note');
    expect(out[1].text).toContain('The warranty period is seven years.');
    expect(out[1].text.length).toBeGreaterThan(15_000);
    expect(out[1].text).toContain('characters not read');
  });

  it('turns a failed download into a reason, never a thrown run', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect((await service.read(invoker, [file(1)]))[0].unreadable).toBe('broken');
  });
});
