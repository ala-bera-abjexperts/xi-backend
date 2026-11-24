import {
  FileExplorerStorageCleanupError,
  FileExplorerStorageService,
} from './file-explorer-storage.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const SPACE = '22222222-2222-4222-8222-222222222222';
const PREFIX = `${ORG}/file-explorer/${SPACE}`;

describe('FileExplorerStorageService strict space cleanup', () => {
  const buildService = (list: jest.Mock, remove?: jest.Mock) => {
    const removeMock =
      remove ??
      jest.fn((paths: string[]) => {
        void paths;
        return Promise.resolve({ error: null });
      });
    const getClient = jest.fn().mockReturnValue({
      storage: {
        from: jest.fn().mockReturnValue({ list, remove: removeMock }),
      },
    });
    return {
      service: new FileExplorerStorageService({
        getClient,
      } as unknown as SupabaseAdminService),
      remove: removeMock,
    };
  };

  it('returns no-op for an empty archived-space prefix', async () => {
    const list = jest.fn().mockResolvedValue({ data: [], error: null });
    const { service, remove } = buildService(list);

    await expect(service.purgeSpaceStorage(ORG, SPACE)).resolves.toEqual({
      status: 'no-op',
      removed: 0,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('recursively removes nested objects in batches of 1000', async () => {
    const files = Array.from({ length: 1001 }, (_, index) => ({
      name: `file-${index}.txt`,
      metadata: { size: 1 },
    }));
    const list = jest
      .fn()
      .mockImplementation(
        (
          prefix: string,
          options: { offset?: number; limit?: number },
        ): Promise<{ data: unknown[]; error: null }> => {
          if (prefix === PREFIX) {
            return Promise.resolve({
              data: [{ name: 'node', metadata: null }],
              error: null,
            });
          }
          if (prefix === `${PREFIX}/node`) {
            const offset = options.offset ?? 0;
            const limit = options.limit ?? 1000;
            return Promise.resolve({
              data: files.slice(offset, offset + limit),
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
      );
    const removedBatches: string[][] = [];
    const remove = jest.fn((paths: string[]) => {
      removedBatches.push(paths);
      return Promise.resolve({ error: null });
    });
    const { service } = buildService(list, remove);

    await expect(service.purgeSpaceStorage(ORG, SPACE)).resolves.toEqual({
      status: 'removed',
      removed: 1001,
    });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(removedBatches[0]).toHaveLength(1000);
    expect(removedBatches[1]).toHaveLength(1);
  });

  it('fails closed when storage listing fails', async () => {
    const list = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'storage unavailable' },
    });
    const { service, remove } = buildService(list);

    await expect(service.purgeSpaceStorage(ORG, SPACE)).rejects.toEqual(
      expect.objectContaining({
        name: FileExplorerStorageCleanupError.name,
        operation: 'list',
        prefix: PREFIX,
      }),
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('fails closed when a storage removal batch fails', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [{ name: 'file.txt', metadata: { size: 1 } }],
      error: null,
    });
    const remove = jest.fn().mockResolvedValue({
      error: { message: 'delete rejected' },
    });
    const { service } = buildService(list, remove);

    await expect(service.purgeSpaceStorage(ORG, SPACE)).rejects.toEqual(
      expect.objectContaining({
        name: FileExplorerStorageCleanupError.name,
        operation: 'remove',
        prefix: PREFIX,
      }),
    );
  });
});
