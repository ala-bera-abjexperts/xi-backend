import { Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import { TestAutomationCustomImageCleanupService } from './test-automation-custom-image-cleanup.service';

const ORG = 'org-1';
const hex = (char: string) => char.repeat(64);
const HOURS = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface StoredFile {
  name: string;
  id: string | null;
  created_at: string | null;
}

describe('TestAutomationCustomImageCleanupService upload files', () => {
  let files: StoredFile[];
  let rows: { image_ref: string; status: string; checked_at: string | null }[];
  let list: jest.Mock;
  let remove: jest.Mock;
  let rowQuery: Record<string, jest.Mock>;
  let warn: jest.SpyInstance;
  let service: TestAutomationCustomImageCleanupService;

  beforeEach(() => {
    files = [];
    rows = [];
    list = jest.fn((path: string) =>
      Promise.resolve(
        path === ''
          ? { data: [{ name: ORG, id: null, created_at: null }], error: null }
          : { data: files, error: null },
      ),
    );
    remove = jest.fn().mockResolvedValue({ data: [], error: null });
    rowQuery = {};

    for (const name of ['select', 'eq', 'in']) {
      rowQuery[name] = jest.fn(() => rowQuery);
    }

    Object.assign(rowQuery, {
      then: (done: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(done),
    });
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    service = new TestAutomationCustomImageCleanupService({
      getClient: () => ({
        from: jest.fn(() => rowQuery),
        storage: { from: jest.fn(() => ({ list, remove })) },
      }),
    } as unknown as SupabaseAdminService);
  });

  afterEach(() => warn.mockRestore());

  it('removes files of blocked or refused images and old files no image claims', async () => {
    files = [
      { name: hex('a'), id: '1', created_at: ago(1 * HOURS) },
      { name: hex('b'), id: '2', created_at: ago(5 * HOURS) },
      { name: hex('c'), id: '3', created_at: ago(1 * HOURS) },
      { name: hex('d'), id: '4', created_at: ago(5 * HOURS) },
      { name: hex('e'), id: '5', created_at: ago(1 * HOURS) },
      { name: hex('f'), id: '6', created_at: ago(1 * HOURS) },
    ];
    rows = [
      {
        image_ref: `upload/image@sha256:${hex('c')}`,
        status: 'blocked',
        checked_at: null,
      },
      {
        image_ref: `upload/image@sha256:${hex('d')}`,
        status: 'refused',
        checked_at: ago(2 * HOURS),
      },
      // Uploaded again after its refusal, waiting for its new check.
      {
        image_ref: `upload/image@sha256:${hex('e')}`,
        status: 'refused',
        checked_at: ago(2 * HOURS),
      },
      {
        image_ref: `upload/image@sha256:${hex('f')}`,
        status: 'approved',
        checked_at: ago(3 * HOURS),
      },
    ];

    await service.removeUploadFiles();

    expect(list).toHaveBeenCalledWith(ORG, {
      limit: 100,
      sortBy: { column: 'created_at', order: 'asc' },
    });
    expect(rowQuery.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(rowQuery.eq).toHaveBeenCalledWith('registry', 'upload');
    expect(remove).toHaveBeenCalledWith([
      `${ORG}/${hex('b')}`,
      `${ORG}/${hex('c')}`,
      `${ORG}/${hex('d')}`,
    ]);
  });

  it('stays quiet without the bucket and logs other storage errors', async () => {
    list.mockResolvedValueOnce({
      data: null,
      error: { message: 'Bucket not found' },
    });
    await service.removeUploadFiles();
    expect(warn).not.toHaveBeenCalled();

    list.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    await service.removeUploadFiles();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    expect(remove).not.toHaveBeenCalled();
  });

  it('skips a removal that fails and goes on next time', async () => {
    files = [{ name: 'stray.tar', id: '1', created_at: ago(5 * HOURS) }];
    remove.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });

    await expect(service.removeUploadFiles()).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith([`${ORG}/stray.tar`]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });
});
