import { MigrationQueueService } from './migration-queue.service';

const run = {
  id: 'run-1',
  organization_id: 'org-1',
} as any;

function queueHarness(
  options: {
    existing?: Set<string>;
    bulkError?: { message: string; code?: string } | null;
    rowErrors?: ({ message: string; code?: string } | null)[];
  } = {},
) {
  const lookupBatches: string[][] = [];
  const inserts: unknown[] = [];
  let rowAttempt = 0;
  const existing = options.existing ?? new Set<string>();

  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: (_column: string, refs: string[]) => {
      lookupBatches.push(refs);

      return Promise.resolve({
        data: refs
          .filter((ref) => existing.has(ref))
          .map((source_ref) => ({ source_ref, entity_type: 'attachment' })),
        error: null,
      });
    },
    insert: (rows: unknown) => {
      inserts.push(rows);
      if (Array.isArray(rows))
        return Promise.resolve({ error: options.bulkError ?? null });

      return Promise.resolve({
        error: options.rowErrors?.[rowAttempt++] ?? null,
      });
    },
  };
  const db = { from: () => chain };
  const service = new MigrationQueueService({ getClient: () => db } as any);

  return { service, lookupBatches, inserts };
}

describe('MigrationQueueService.seedEntityItems', () => {
  it('chunks encoded attachment refs and only inserts non-existing entity rows', async () => {
    const refs = Array.from(
      { length: 6 },
      (_, i) =>
        `https://jira.example.test/secure/attachment/${i}/${encodeURIComponent(
          `attachment ${i} ä & `.repeat(60),
        )}.pdf`,
    );
    const h = queueHarness({ existing: new Set([refs[2]]) });

    const seeded = await h.service.seedEntityItems(run, 'attachments', 1, [
      ...refs.map((sourceRef) => ({ entityType: 'attachment', sourceRef })),
      // The index includes entity_type, so an existing attachment must not hide
      // a different entity that happens to share the same source reference.
      { entityType: 'comment', sourceRef: refs[2] },
    ]);

    expect(h.lookupBatches.length).toBeGreaterThan(1);
    expect(
      h.lookupBatches.every(
        (batch) =>
          batch.reduce(
            (total, ref) => total + encodeURIComponent(ref).length + 1,
            0,
          ) <= 4_000,
      ),
    ).toBe(true);
    expect(seeded).toBe(6);
    expect(
      h.inserts[0] as { entity_type: string; source_ref: string }[],
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_type: 'comment',
          source_ref: refs[2],
        }),
      ]),
    );
    expect(
      (h.inserts[0] as { entity_type: string; source_ref: string }[]).some(
        (row) => row.entity_type === 'attachment' && row.source_ref === refs[2],
      ),
    ).toBe(false);
  });

  it('keeps the row-by-row 23505 recovery after chunked lookup', async () => {
    const duplicate = { message: 'duplicate key', code: '23505' };
    const h = queueHarness({
      bulkError: duplicate,
      rowErrors: [duplicate, null],
    });

    const seeded = await h.service.seedEntityItems(run, 'attachments', 1, [
      { entityType: 'attachment', sourceRef: 'attachment-1' },
      { entityType: 'attachment', sourceRef: 'attachment-2' },
    ]);

    expect(seeded).toBe(1);
    expect(h.inserts).toHaveLength(3);
  });
});

describe('MigrationQueueService.failSourceItem', () => {
  function failureHarness() {
    const rateUpsert = jest.fn().mockResolvedValue({ error: null });
    const itemPatch: Record<string, unknown>[] = [];
    const itemChain: any = {
      update: jest.fn((patch: Record<string, unknown>) => {
        itemPatch.push(patch);

        return itemChain;
      }),
      eq: jest.fn(() => itemChain),
      select: jest
        .fn()
        .mockResolvedValue({ data: [{ id: 'item-1' }], error: null }),
    };
    const db = {
      from: jest.fn((table: string) =>
        table === 'migration_rate_state' ? { upsert: rateUpsert } : itemChain,
      ),
    };
    const service = new MigrationQueueService({ getClient: () => db } as any);

    return { service, rateUpsert, itemPatch };
  }

  const sourceRun = {
    id: 'run-1',
    organization_id: 'org-1',
    connection_id: 'connection-1',
  } as any;

  const sourceItem = {
    id: 'item-1',
    organization_id: 'org-1',
    worker_id: 'worker-1',
    retry_count: 0,
    max_attempts: 3,
  } as any;

  it('cools the connection and requeues a 5xx without sleeping it', async () => {
    const h = failureHarness();

    await h.service.failSourceItem(
      sourceItem,
      sourceRun,
      'GET failed with 500',
    );

    expect(h.rateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        connection_id: 'connection-1',
        last_retry_after_ms: 60_000,
      }),
      { onConflict: 'organization_id,connection_id' },
    );
    expect(h.itemPatch[0]).toEqual(
      expect.objectContaining({
        status: 'pending',
        retry_count: 1,
        error_class: 'transient',
      }),
    );
    expect(h.itemPatch[0]).not.toHaveProperty('wakeup_at');
  });

  it('still dead-letters an exhausted source failure', async () => {
    const h = failureHarness();

    await h.service.failSourceItem(
      { ...sourceItem, retry_count: 2 },
      sourceRun,
      'GET failed with 500',
    );

    expect(h.rateUpsert).toHaveBeenCalledTimes(1);
    expect(h.itemPatch[0]).toEqual(
      expect.objectContaining({
        status: 'dead',
        retry_count: 3,
        error_class: 'transient',
      }),
    );
  });
});

describe('MigrationQueueService.leaseItems', () => {
  it('surfaces an RPC failure instead of reporting an empty queue', async () => {
    const db = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'function lease_migration_items does not exist' },
      }),
    };
    const service = new MigrationQueueService({ getClient: () => db } as any);

    await expect(service.leaseItems('worker-1', 25)).rejects.toThrow(
      'lease_migration_items failed: function lease_migration_items does not exist',
    );
  });
});
