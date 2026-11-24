import {
  FileExplorerStorageRepairError,
  FileExplorerStorageRepairService,
} from './file-explorer-storage-repair.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { FileExplorerStorageService } from './file-explorer-storage.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const LIVE_SPACE = '22222222-2222-4222-8222-222222222222';
const ORPHAN_SPACE = '33333333-3333-4333-8333-333333333333';
const MISSING_ORG = '44444444-4444-4444-8444-444444444444';
const NODE = '55555555-5555-4555-8555-555555555555';
const VERSION = '66666666-6666-4666-8666-666666666666';

const key = (orgId: string, spaceId: string) =>
  `${orgId}/file-explorer/${spaceId}/${NODE}/${VERSION}/file.pdf`;

const buildDb = (
  organizations: string[],
  spaces: Array<{ id: string; organization_id: string }>,
  error?: string,
) => {
  const from = jest.fn((table: string) => {
    const chain = {
      select: jest.fn(),
      in: jest.fn((_column: string, ids: string[]) => {
        if (error)
          return Promise.resolve({ data: null, error: { message: error } });
        const data =
          table === 'organizations'
            ? organizations
                .filter((id) => ids.includes(id))
                .map((id) => ({ id }))
            : spaces.filter((space) => ids.includes(space.id));
        return Promise.resolve({ data, error: null });
      }),
    };
    chain.select.mockReturnValue(chain);
    return chain;
  });
  return { getClient: jest.fn().mockReturnValue({ from }) };
};

describe('FileExplorerStorageRepairService', () => {
  it('reports only canonical paths whose organization exists but space does not', async () => {
    const storage = {
      listPrefixStrict: jest
        .fn()
        .mockResolvedValue([
          key(ORG, ORPHAN_SPACE),
          key(ORG, LIVE_SPACE),
          key(MISSING_ORG, ORPHAN_SPACE),
          `${ORG}/file-explorer/${ORPHAN_SPACE}/not-canonical`,
          `${ORG}/file-explorer/${ORPHAN_SPACE}/not-a-node/${VERSION}/file.pdf`,
        ]),
      removePathsStrict: jest.fn(),
    };
    const service = new FileExplorerStorageRepairService(
      buildDb(
        [ORG],
        [{ id: LIVE_SPACE, organization_id: ORG }],
      ) as unknown as SupabaseAdminService,
      storage as unknown as FileExplorerStorageService,
    );

    await expect(service.repair()).resolves.toMatchObject({
      applied: false,
      removedObjects: 0,
      inventory: {
        scannedObjects: 5,
        ignoredObjects: 2,
        candidates: [
          {
            organizationId: ORG,
            spaceId: ORPHAN_SPACE,
            objectCount: 1,
            prefix: `${ORG}/file-explorer/${ORPHAN_SPACE}`,
          },
        ],
      },
    });
    expect(storage.removePathsStrict).not.toHaveBeenCalled();
  });

  it('rescans before applying and is idempotent after removal', async () => {
    const orphan = key(ORG, ORPHAN_SPACE);
    const storage = {
      listPrefixStrict: jest
        .fn()
        .mockResolvedValueOnce([orphan])
        .mockResolvedValueOnce([orphan])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      removePathsStrict: jest.fn().mockResolvedValue(1),
    };
    const service = new FileExplorerStorageRepairService(
      buildDb([ORG], []) as unknown as SupabaseAdminService,
      storage as unknown as FileExplorerStorageService,
    );

    await expect(service.repair(true)).resolves.toMatchObject({
      applied: true,
      removedObjects: 1,
      removedPrefixes: [`${ORG}/file-explorer/${ORPHAN_SPACE}`],
    });
    await expect(service.repair(true)).resolves.toMatchObject({
      applied: true,
      removedObjects: 0,
      removedPrefixes: [],
    });
    expect(storage.removePathsStrict).toHaveBeenCalledTimes(1);
  });

  it('does not remove paths when database verification fails', async () => {
    const storage = {
      listPrefixStrict: jest.fn().mockResolvedValue([key(ORG, ORPHAN_SPACE)]),
      removePathsStrict: jest.fn(),
    };
    const service = new FileExplorerStorageRepairService(
      buildDb(
        [ORG],
        [],
        'database unavailable',
      ) as unknown as SupabaseAdminService,
      storage as unknown as FileExplorerStorageService,
    );

    await expect(service.inventory()).rejects.toBeInstanceOf(
      FileExplorerStorageRepairError,
    );
    expect(storage.removePathsStrict).not.toHaveBeenCalled();
  });
});
