import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  DRAIN_INTERVAL_MS,
  ROW_DRAIN_BUDGET_MS,
  SpaceStorageCleanupProcessor,
  type SpaceDeletionScope,
} from './space-storage-cleanup.processor';

type MockError = { message: string } | null;
type MockEntry = { name: string; metadata: Record<string, unknown> | null };
type RpcResult = { data: unknown; error: MockError };

const anyString = (): unknown => expect.any(String) as unknown;
const containing = (value: string): unknown =>
  expect.stringContaining(value) as unknown;

const scope = (
  overrides: Partial<SpaceDeletionScope> = {},
): SpaceDeletionScope => ({
  id: 'scope-1',
  job_id: 'job-1',
  organization_id: 'org-1',
  space_id: '11111111-1111-4111-8111-111111111111',
  bucket: 'attachments',
  path: 'org-1/tasks/task-1/file.png',
  kind: 'exact',
  attempt_count: 1,
  settle_after: '2026-09-02T03:00:00.000Z',
  ...overrides,
});

function setup(rows: SpaceDeletionScope[]) {
  const remove = jest
    .fn<Promise<{ error: MockError }>, [string[]]>()
    .mockResolvedValue({ error: null });
  const list = jest
    .fn<
      Promise<{ data: MockEntry[]; error: MockError }>,
      [string, { limit: number; offset: number }]
    >()
    .mockResolvedValue({ data: [], error: null });
  const storageFrom = jest.fn(() => ({ remove, list }));
  const rpc = jest.fn<Promise<RpcResult>, [string, Record<string, unknown>]>(
    (name: string) =>
      Promise.resolve(
        name === 'claim_space_deletion_scopes'
          ? { data: rows, error: null }
          : { data: null, error: null },
      ),
  );
  // spaces queued for deletion: .from('spaces').select().not().order().limit()
  const deletingSpaces: { id: string }[] = [];
  const query = {
    select: () => query,
    not: () => query,
    order: () => query,
    limit: () => Promise.resolve({ data: deletingSpaces, error: null }),
  };
  const from = jest.fn(() => query);
  const admin = {
    getClient: () => ({ rpc, from, storage: { from: storageFrom } }),
  } as unknown as SupabaseAdminService;

  return {
    processor: new SpaceStorageCleanupProcessor(admin),
    list,
    remove,
    rpc,
    storageFrom,
    deletingSpaces,
  };
}

const SPACE = '22222222-2222-4222-8222-222222222222';
const calls = (
  rpc: jest.Mock<Promise<RpcResult>, [string, Record<string, unknown>]>,
  name: string,
) => rpc.mock.calls.filter(([called]) => called === name);

describe('SpaceStorageCleanupProcessor', () => {
  it('can immediately drain only the just-deleted space without waiting for the cron', async () => {
    const { processor, rpc } = setup([]);

    await expect(
      processor.drainSpace('11111111-1111-4111-8111-111111111111'),
    ).resolves.toBe(0);

    expect(rpc).toHaveBeenCalledWith('claim_space_deletion_scopes', {
      p_worker_id: anyString(),
      p_limit: 100,
      p_space_id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('claims bounded work, removes exact keys in chunks of at most 1000, and completes every scope', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) =>
      scope({ id: `scope-${index}`, path: `space/task/${index}.png` }),
    );
    const { processor, remove, rpc } = setup(rows);

    await expect(processor.drainOnce()).resolves.toBe(1001);

    expect(rpc).toHaveBeenCalledWith('claim_space_deletion_scopes', {
      p_worker_id: anyString(),
      p_limit: 100,
      p_space_id: null,
    });
    expect(remove.mock.calls.map(([paths]) => paths.length)).toEqual([1000, 1]);
    expect(
      rpc.mock.calls.filter(
        ([name]) => name === 'complete_space_deletion_scope',
      ),
    ).toHaveLength(1001);
  });

  it('recursively drains prefixes from offset zero and delegates the settling rescan to the completion RPC', async () => {
    const row = scope({
      kind: 'prefix',
      bucket: 'file-explorer',
      path: 'org-1/file-explorer/11111111-1111-4111-8111-111111111111',
    });
    const { processor, list, remove, rpc } = setup([row]);
    const responses = new Map<string, MockEntry[][]>([
      [
        row.path,
        [
          [
            { name: 'nested', metadata: null },
            { name: 'root.png', metadata: { size: 1 } },
          ],
          [],
        ],
      ],
      [
        `${row.path}/nested`,
        [[{ name: 'deep.png', metadata: { size: 1 } }], []],
      ],
    ]);
    list.mockImplementation((prefix: string) =>
      Promise.resolve({
        data: responses.get(prefix)?.shift() ?? [],
        error: null,
      }),
    );

    await processor.drainOnce();

    expect(list.mock.calls.every(([, options]) => options.offset === 0)).toBe(
      true,
    );
    expect(remove).toHaveBeenCalledWith([`${row.path}/nested/deep.png`]);
    expect(remove).toHaveBeenCalledWith([`${row.path}/root.png`]);
    expect(rpc).toHaveBeenCalledWith('complete_space_deletion_scope', {
      p_scope_id: row.id,
      p_worker_id: anyString(),
    });
  });

  it('releases all affected scopes when a storage batch fails', async () => {
    const rows = [scope(), scope({ id: 'scope-2', path: 'space/task/2.png' })];
    const { processor, remove, rpc } = setup(rows);
    remove.mockResolvedValue({ error: { message: 'storage unavailable' } });

    await expect(processor.drainOnce()).resolves.toBe(2);

    for (const row of rows) {
      expect(rpc).toHaveBeenCalledWith('release_space_deletion_scope', {
        p_scope_id: row.id,
        p_worker_id: anyString(),
        p_error: 'storage unavailable',
      });
    }
    expect(
      rpc.mock.calls.filter(
        ([name]) => name === 'complete_space_deletion_scope',
      ),
    ).toHaveLength(0);
  });

  it('never touches ambiguous shared editor-images paths', async () => {
    const row = scope({
      bucket: 'wiki-attachments',
      path: 'editor-images/user-1/shared.png',
    });
    const { processor, remove, rpc, storageFrom } = setup([row]);

    await processor.drainOnce();

    expect(storageFrom).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('release_space_deletion_scope', {
      p_scope_id: row.id,
      p_worker_id: anyString(),
      p_error: containing('editor-images'),
    });
  });

  it('removes legacy space icon prefixes', async () => {
    const row = scope({
      kind: 'prefix',
      bucket: 'space-icons',
      path: 'icons/11111111-1111-4111-8111-111111111111',
    });
    const { processor, list, rpc } = setup([row]);

    await processor.drainOnce();

    expect(list).toHaveBeenCalledWith(row.path, { limit: 1000, offset: 0 });
    expect(rpc).toHaveBeenCalledWith('complete_space_deletion_scope', {
      p_scope_id: row.id,
      p_worker_id: anyString(),
    });
  });

  it('releases a scope when recording completion fails so an expired lease can retry it', async () => {
    const row = scope();
    const { processor, rpc } = setup([row]);
    rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'claim_space_deletion_scopes'
          ? { data: [row], error: null }
          : name === 'complete_space_deletion_scope'
            ? {
                data: null,
                error: { message: 'database unavailable' },
              }
            : { data: null, error: null },
      ),
    );

    await processor.drainOnce();

    expect(rpc).toHaveBeenCalledWith('release_space_deletion_scope', {
      p_scope_id: row.id,
      p_worker_id: anyString(),
      p_error: 'database unavailable',
    });
  });

  it('rejects an unsafe root prefix without listing or removing storage', async () => {
    const row = scope({
      kind: 'prefix',
      bucket: 'form_builder_submission_attachments',
      path: '/',
    });
    const { processor, list, remove, rpc } = setup([row]);

    await processor.drainOnce();

    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('release_space_deletion_scope', {
      p_scope_id: row.id,
      p_worker_id: anyString(),
      p_error: containing('unsafe storage path'),
    });
  });

  describe('row drain', () => {
    afterEach(() => jest.restoreAllMocks());

    it('keeps the per-tick budget below the cron interval', () => {
      expect(ROW_DRAIN_BUDGET_MS).toBeLessThan(DRAIN_INTERVAL_MS);
    });

    it('drains a space to zero and then finalizes it', async () => {
      const { processor, rpc } = setup([]);
      const batches = [500, 3, 0];
      rpc.mockImplementation((name: string) =>
        Promise.resolve(
          name === 'delete_space_rows_batch'
            ? { data: batches.shift(), error: null }
            : { data: name === 'finalize_space_deletion', error: null },
        ),
      );

      await expect(processor.drainSpaceRows(SPACE)).resolves.toBe(503);

      expect(calls(rpc, 'delete_space_rows_batch')).toHaveLength(3);
      expect(rpc).toHaveBeenCalledWith('finalize_space_deletion', {
        p_space_id: SPACE,
      });
    });

    it('does not start an overlapping drain() while one is still running', async () => {
      const { processor, rpc, deletingSpaces } = setup([]);
      deletingSpaces.push({ id: SPACE });
      let release!: (value: RpcResult) => void;
      rpc.mockImplementation((name: string) =>
        name === 'delete_space_rows_batch'
          ? new Promise<RpcResult>((resolve) => (release = resolve))
          : Promise.resolve({ data: null, error: null }),
      );

      const first = processor.drain();
      await new Promise(setImmediate);
      const callsWhilePending = rpc.mock.calls.length;

      await processor.drain();
      expect(rpc.mock.calls.length).toBe(callsWhilePending);

      release({ data: 0, error: null });
      await first;
    });

    it('returns 0 without any RPC for a space this process is already draining', async () => {
      const { processor, rpc } = setup([]);
      let release!: (value: RpcResult) => void;
      rpc.mockImplementation((name: string) =>
        name === 'delete_space_rows_batch'
          ? new Promise<RpcResult>((resolve) => (release = resolve))
          : Promise.resolve({ data: null, error: null }),
      );

      const first = processor.drainSpaceRows(SPACE);
      await new Promise(setImmediate);
      const callsWhilePending = rpc.mock.calls.length;

      await expect(processor.drainSpaceRows(SPACE)).resolves.toBe(0);
      expect(rpc.mock.calls.length).toBe(callsWhilePending);

      release({ data: 0, error: null });
      await first;
    });

    it('backs a failing space off, retries it after 30 s, and clears the backoff on success', async () => {
      const { processor, rpc, deletingSpaces } = setup([]);
      deletingSpaces.push({ id: SPACE });
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      let fail = true;
      rpc.mockImplementation((name: string) =>
        Promise.resolve(
          name === 'delete_space_rows_batch'
            ? fail
              ? { data: null, error: { message: 'lock timeout' } }
              : { data: 0, error: null }
            : { data: true, error: null },
        ),
      );

      await processor.drainDeletingSpaces();
      expect(calls(rpc, 'delete_space_rows_batch')).toHaveLength(1);

      // Still backing off: neither the cron tick nor the post-delete kick touches it.
      now += 10_000;
      await processor.drainDeletingSpaces();
      await expect(processor.drainSpaceRows(SPACE)).resolves.toBe(0);
      expect(calls(rpc, 'delete_space_rows_batch')).toHaveLength(1);

      fail = false;
      now += 21_000;
      await processor.drainDeletingSpaces();
      expect(calls(rpc, 'delete_space_rows_batch')).toHaveLength(2);
      expect(calls(rpc, 'finalize_space_deletion')).toHaveLength(1);

      // Success cleared the backoff: the very next tick drains again.
      await processor.drainDeletingSpaces();
      expect(calls(rpc, 'delete_space_rows_batch')).toHaveLength(3);
    });
  });
});
