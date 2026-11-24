/**
 * Failure-classification tests for the Jira attachments stage: an oversize download must fail
 * PERMANENT via the typed 413 (never a message regex — "rate limit exceeded" contains "limit" and
 * must stay transient), and plain transport errors must stay TRANSIENT so the engine retries.
 */
import { AttachmentsStage } from './attachments.stage';
import { AtlassianRequestError } from '../../adapters/http/atlassian-http-client';
import {
  MigrationItemError,
  type MigrationRunItemRow,
  type StageContext,
} from './stage.interface';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';

const ISSUE_TARGET = { status: 'mapped', target_id: 'task-1', metadata: {} };

function makeCtx(): StageContext {
  return {
    orgId: 'org-1',
    dryRun: false,
    job: { id: 'job-1', connection_id: 'conn-1', source_ref: 'PROJ' },
    run: { id: 'run-1', config_snapshot: {} },
    entityMap: {
      // First lookup (the attachment itself) → unmapped; second (owning issue) → mapped.
      getExistingTarget: jest.fn().mockResolvedValue(null),
      getTarget: jest.fn((_org: string, _conn: string, entityType: string) =>
        entityType === 'issue' ? ISSUE_TARGET : null,
      ),
      recordMapping: jest.fn(),
    },
    getAdapter: jest.fn(),
    log: jest.fn(),
  } as unknown as StageContext;
}

function makeItem() {
  return {
    payload: {
      issueSourceId: '10001',
      issueKey: 'PROJ-1',
      attachment: {
        sourceId: '79837',
        filename: 'big.pdf',
        mimeType: 'application/pdf',
        downloadUrl:
          'https://jira.advertised.invalid/secure/attachment/79837/big.pdf',
        sizeBytes: 1024,
      },
    },
  } as unknown as Parameters<AttachmentsStage['processItem']>[1];
}

function mappedTaskDb(
  task: { id: string; space_id: string | null } | null = {
    id: 'task-1',
    space_id: 'space-1',
  },
) {
  return {
    from: (table: string) => {
      if (table !== 'tasks') throw new Error(`unexpected table ${table}`);

      const query = {
        eq: () => query,
        maybeSingle: () => Promise.resolve({ data: task, error: null }),
      };

      return { select: () => query };
    },
  };
}

async function rejectedMigrationItem(
  promise: Promise<unknown>,
): Promise<MigrationItemError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof MigrationItemError) return error;

    throw error;
  }

  throw new Error('processItem did not throw');
}

async function classify(downloadError: Error): Promise<MigrationItemError> {
  const stage = new AttachmentsStage({
    getClient: () => mappedTaskDb(),
  } as unknown as SupabaseAdminService);
  const ctx = makeCtx();

  (ctx.getAdapter as jest.Mock).mockResolvedValue({
    product: 'jira',
    listProjects: () => [],
    getAttachmentBytes: jest.fn().mockRejectedValue(downloadError),
    getAttachmentBytesToFile: jest.fn().mockRejectedValue(downloadError),
  });

  try {
    await stage.processItem(ctx, makeItem());
  } catch (err) {
    if (err instanceof MigrationItemError) return err;
    throw err;
  }

  throw new Error('processItem did not throw');
}

describe('AttachmentsStage download failure classification', () => {
  it('classifies a typed 413 (over the byte cap) as permanent', async () => {
    const err = await classify(
      new AtlassianRequestError(
        'Attachment x is 6000000000 bytes (> cap)',
        413,
      ),
    );

    expect(err.errorClass).toBe('permanent');
    expect(err.message).toContain('big.pdf');
  });

  it('keeps "rate limit exceeded" transient — the word "limit" must not match', async () => {
    const err = await classify(new Error('rate limit exceeded'));

    expect(err.errorClass).toBe('transient');
  });

  it('classifies a missing download URL as permanent', async () => {
    const err = await classify(new Error('Attachment has no download URL'));

    expect(err.errorClass).toBe('permanent');
  });

  it('keeps a plain network failure transient so the engine retries', async () => {
    const err = await classify(new Error('socket hang up'));

    expect(err.errorClass).toBe('transient');
  });
});

describe('AttachmentsStage mapped task and compensation', () => {
  interface WriteState {
    storageRemoved: string[][];
    versionsDeleted: string[];
    attachmentsDeleted: string[];
    linkError: { message: string } | null;
    uploadError?: { message: string };
    upload?: jest.Mock;
    storageRemoveError?: { message: string } | null;
    versionDeleteError?: { message: string } | null;
    attachmentDeleteError?: { message: string } | null;
  }

  function writeDb(
    state: WriteState,
    task = { id: 'task-1', space_id: 'space-1' },
  ) {
    return {
      storage: {
        from: () => ({
          upload:
            state.upload ??
            jest.fn().mockResolvedValue({ error: state.uploadError ?? null }),
          remove: jest.fn((paths: string[]) => {
            state.storageRemoved.push(paths);

            return Promise.resolve({ error: state.storageRemoveError ?? null });
          }),
        }),
      },
      from: (table: string) => {
        if (table === 'tasks') {
          const query = {
            eq: () => query,
            maybeSingle: () => Promise.resolve({ data: task, error: null }),
          };

          return { select: () => query };
        }

        if (table === 'file_attachments') {
          return {
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: 'fa-new' }, error: null }),
              }),
            }),
            update: () => ({
              eq: () => Promise.resolve({ error: state.linkError }),
            }),
            delete: () => ({
              eq: (_column: string, id: string) => {
                state.attachmentsDeleted.push(id);

                return Promise.resolve({
                  error: state.attachmentDeleteError ?? null,
                });
              },
            }),
          };
        }

        if (table === 'file_versions') {
          return {
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: 'fv-new' }, error: null }),
              }),
            }),
            delete: () => ({
              eq: (_column: string, id: string) => {
                state.versionsDeleted.push(id);

                return Promise.resolve({
                  error: state.versionDeleteError ?? null,
                });
              },
            }),
          };
        }

        throw new Error(`unexpected table ${table}`);
      },
    };
  }

  function liveAdapter() {
    return {
      product: 'jira' as const,
      listProjects: jest.fn(),
      getAttachmentBytes: jest
        .fn()
        .mockResolvedValue({ data: Buffer.from('attachment'), size: 10 }),
    };
  }

  function liveCtx(recordMapping = jest.fn().mockResolvedValue(undefined)) {
    const ctx = makeCtx();
    const entityMap = ctx.entityMap as unknown as {
      recordMapping: jest.Mock;
    };
    const run = ctx.run as unknown as { created_by: string };

    (ctx.getAdapter as jest.Mock).mockResolvedValue(liveAdapter());
    entityMap.recordMapping = recordMapping;
    run.created_by = 'migration-actor';

    return ctx;
  }

  it.each([
    [
      'report.xls',
      'Application/Vnd.Ms-Excel; charset=UTF-8',
      'application/vnd.ms-excel',
    ],
    [
      'report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['report.xls', 'not a MIME type', 'application/octet-stream'],
    ['report.xls', 'text/plain\r\nInjected: yes', 'application/octet-stream'],
    ['diagram.svg', ' IMAGE/SVG+XML; charset=utf-8 ', 'image/svg+xml'],
  ])(
    'normalizes Jira current %s without altering bytes or signed-download semantics',
    async (filename, mimeType, expected) => {
      const upload = jest.fn().mockResolvedValue({ error: null });
      const state: WriteState = {
        storageRemoved: [],
        versionsDeleted: [],
        attachmentsDeleted: [],
        linkError: null,
        upload,
      };
      const stage = new AttachmentsStage({
        getClient: () => writeDb(state),
      } as unknown as SupabaseAdminService);
      const base = makeItem();
      const payload = base.payload as { attachment: Record<string, unknown> };
      const item = {
        ...base,
        payload: {
          ...payload,
          attachment: { ...payload.attachment, filename, mimeType },
        },
      };
      const ctx = liveCtx();
      const bytes = Buffer.from([0, 255, 17, 128]);
      (ctx.getAdapter as jest.Mock).mockResolvedValue({
        ...liveAdapter(),
        getAttachmentBytes: jest
          .fn()
          .mockResolvedValue({ data: bytes, size: bytes.length }),
      });
      await stage.processItem(ctx, item);
      expect(upload).toHaveBeenCalledWith(
        expect.stringContaining(filename),
        bytes,
        { contentType: expected, upsert: false },
      );
      expect(upload.mock.calls[0][1]).toBe(bytes);
      expect(ctx.entityMap.recordMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ filename, mime_type: expected }),
        }),
      );
    },
  );

  it.each([
    ['Invalid Content-Type header', 'permanent'],
    ['socket hang up', 'transient'],
  ])('classifies Jira storage error %s as %s', async (message, errorClass) => {
    const state: WriteState = {
      storageRemoved: [],
      versionsDeleted: [],
      attachmentsDeleted: [],
      linkError: null,
      uploadError: { message },
    };
    const stage = new AttachmentsStage({
      getClient: () => writeDb(state),
    } as unknown as SupabaseAdminService);
    const err = await rejectedMigrationItem(
      stage.processItem(liveCtx(), makeItem()),
    );
    expect(err.errorClass).toBe(errorClass);
    expect(state.attachmentsDeleted).toEqual(['fa-new']);
  });

  it('cleans up and permanently fails a thrown invalid Content-Type error', async () => {
    const state: WriteState = {
      storageRemoved: [],
      versionsDeleted: [],
      attachmentsDeleted: [],
      linkError: null,
      upload: jest
        .fn()
        .mockRejectedValue(new TypeError('Invalid Content-Type header')),
    };
    const stage = new AttachmentsStage({
      getClient: () => writeDb(state),
    } as unknown as SupabaseAdminService);
    await expect(
      stage.processItem(liveCtx(), makeItem()),
    ).rejects.toMatchObject({ errorClass: 'permanent' });
    expect(state.attachmentsDeleted).toEqual(['fa-new']);
  });

  it('permanently rejects a stale mapped task before downloading the Jira file', async () => {
    const stage = new AttachmentsStage({
      getClient: () => mappedTaskDb(null),
    } as unknown as SupabaseAdminService);
    const ctx = makeCtx();
    const getAdapter = jest.fn();
    (ctx as unknown as { getAdapter: jest.Mock }).getAdapter = getAdapter;

    const err = await rejectedMigrationItem(stage.processItem(ctx, makeItem()));

    expect(err.errorClass).toBe('permanent');
    expect(err.message).toContain('big.pdf');
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('removes the new object, version, and header when current-version linking fails', async () => {
    const state: WriteState = {
      storageRemoved: [],
      versionsDeleted: [],
      attachmentsDeleted: [],
      linkError: { message: 'link rejected' },
    };
    const stage = new AttachmentsStage({
      getClient: () => writeDb(state),
    } as unknown as SupabaseAdminService);
    const ctx = liveCtx();

    const err = await rejectedMigrationItem(stage.processItem(ctx, makeItem()));

    expect(err.errorClass).toBe('transient');
    expect(err.message).toContain('Linking current version failed');
    expect(state.storageRemoved).toHaveLength(1);
    expect(state.versionsDeleted).toEqual(['fa-new']);
    expect(state.attachmentsDeleted).toEqual(['fa-new']);
  });

  it('surfaces resolved Supabase cleanup errors instead of silently treating cleanup as complete', async () => {
    const state: WriteState = {
      storageRemoved: [],
      versionsDeleted: [],
      attachmentsDeleted: [],
      linkError: { message: 'link rejected' },
      storageRemoveError: { message: 'object still present' },
      versionDeleteError: { message: 'version still present' },
      attachmentDeleteError: { message: 'header still present' },
    };
    const stage = new AttachmentsStage({
      getClient: () => writeDb(state),
    } as unknown as SupabaseAdminService);

    const err = await rejectedMigrationItem(
      stage.processItem(liveCtx(), makeItem()),
    );

    expect(err.message).toContain(
      'Cleanup incomplete: storage object: object still present',
    );
    expect(err.message).toContain('file version: version still present');
    expect(err.message).toContain('attachment row: header still present');
    expect(state.storageRemoved).toHaveLength(1);
    expect(state.versionsDeleted).toEqual(['fa-new']);
    expect(state.attachmentsDeleted).toEqual(['fa-new']);
  });

  it('removes only a newly created attachment when crosswalk recording fails', async () => {
    const state: WriteState = {
      storageRemoved: [],
      versionsDeleted: [],
      attachmentsDeleted: [],
      linkError: null,
    };
    const stage = new AttachmentsStage({
      getClient: () => writeDb(state),
    } as unknown as SupabaseAdminService);
    const ctx = liveCtx(
      jest.fn().mockRejectedValue(new Error('crosswalk unavailable')),
    );

    await expect(stage.processItem(ctx, makeItem())).rejects.toThrow(
      'crosswalk unavailable',
    );
    expect(state.storageRemoved).toHaveLength(1);
    expect(state.versionsDeleted).toEqual(['fa-new']);
    expect(state.attachmentsDeleted).toEqual(['fa-new']);
  });

  it('does not clean up an adopted attachment when crosswalk recording fails', async () => {
    const stage = new AttachmentsStage({
      getClient: () => mappedTaskDb(),
    } as unknown as SupabaseAdminService);
    const write = jest
      .spyOn(stage as never, 'writeUnifiedAttachment')
      .mockResolvedValue({ id: 'fa-adopted', created: false });
    const cleanup = jest.spyOn(stage as never, 'cleanupCreatedAttachment');
    const ctx = liveCtx(
      jest.fn().mockRejectedValue(new Error('crosswalk unavailable')),
    );

    await expect(stage.processItem(ctx, makeItem())).rejects.toThrow(
      'crosswalk unavailable',
    );
    expect(write).toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
});

/**
 * Duplicate-filename adoption: Jira allows two DIFFERENT attachments with the same name on one
 * issue. The old unconditional 23505-adopt silently threw the second file's bytes away while the
 * run reported success. The fix adopts ONLY when the crosswalk proves the existing row belongs to
 * THIS source attachment; otherwise it retries under a deterministic disambiguated name.
 */
describe('AttachmentsStage.insertOrAdoptRow duplicate-name handling', () => {
  interface FakeState {
    /** file_name → row id already in file_attachments. */
    rows: Map<string, string>;
    /** target_id → source_id rows in migration_entity_map. */
    crosswalk: { target_id: string; source_id: string }[];
    inserted: string[];
  }

  function makeDb(state: FakeState) {
    let nextId = state.rows.size + 1;

    return {
      from: (table: string) => {
        if (table === 'file_attachments') {
          return {
            insert: (row: { file_name: string }) => ({
              select: () => ({
                single: () => {
                  if (state.rows.has(row.file_name)) {
                    return Promise.resolve({
                      data: null,
                      error: { message: 'duplicate key', code: '23505' },
                    });
                  }

                  const id = `fa-${nextId++}`;

                  state.rows.set(row.file_name, id);
                  state.inserted.push(row.file_name);

                  return Promise.resolve({ data: { id }, error: null });
                },
              }),
            }),
            select: () => {
              const eqs: Record<string, string> = {};
              const chain = {
                eq: (col: string, val: string) => {
                  eqs[col] = val;

                  return chain;
                },
                maybeSingle: () => {
                  const id = state.rows.get(eqs.file_name);

                  return Promise.resolve({ data: id ? { id } : null });
                },
              };

              return chain;
            },
          };
        }

        if (table === 'migration_entity_map') {
          const eqs: Record<string, string> = {};
          const chain = {
            eq: (col: string, val: string) => {
              eqs[col] = val;

              return chain;
            },
            limit: () =>
              Promise.resolve({
                data: state.crosswalk.filter(
                  (r) => r.target_id === eqs.target_id,
                ),
                error: null,
              }),
          };

          return { select: () => chain };
        }

        throw new Error(`unexpected table ${table}`);
      },
    };
  }

  function run(state: FakeState, sourceId: string, fileName = 'Bild.png') {
    const stage = new AttachmentsStage({
      getClient: () => makeDb(state),
    } as unknown as SupabaseAdminService);

    return (
      stage as unknown as {
        insertOrAdoptRow: (
          ctx: StageContext,
          a: {
            taskId: string;
            fileName: string;
            sourceId: string;
            uploader: string;
          },
          spaceId: string | null,
          when: string,
        ) => Promise<{ id: string; fileName: string; adopted: boolean }>;
      }
    ).insertOrAdoptRow(
      makeCtx(),
      { taskId: 'task-1', fileName, sourceId, uploader: 'u-1' },
      null,
      '2026-01-01T00:00:00.000Z',
    );
  }

  it('inserts cleanly when the name is free', async () => {
    const state: FakeState = { rows: new Map(), crosswalk: [], inserted: [] };
    const out = await run(state, '111');

    expect(out).toEqual({ id: 'fa-1', fileName: 'Bild.png', adopted: false });
  });

  it('adopts when the crosswalk proves the row is this same source attachment', async () => {
    const state: FakeState = {
      rows: new Map([['Bild.png', 'fa-1']]),
      crosswalk: [{ target_id: 'fa-1', source_id: '111' }],
      inserted: [],
    };
    const out = await run(state, '111');

    expect(out).toEqual({ id: 'fa-1', fileName: 'Bild.png', adopted: true });
    expect(state.inserted).toHaveLength(0);
  });

  it('disambiguates a DIFFERENT source attachment with the same name — bytes must not be lost', async () => {
    const state: FakeState = {
      rows: new Map([['Bild.png', 'fa-1']]),
      crosswalk: [{ target_id: 'fa-1', source_id: '111' }],
      inserted: [],
    };
    const out = await run(state, '222');

    expect(out.adopted).toBe(false);
    expect(out.fileName).toBe('Bild (222).png');
    expect(state.inserted).toEqual(['Bild (222).png']);
  });

  it('disambiguates when the crosswalk cannot confirm ownership (fail toward duplication)', async () => {
    const state: FakeState = {
      rows: new Map([['Bild.png', 'fa-1']]),
      crosswalk: [],
      inserted: [],
    };
    const out = await run(state, '333');

    expect(out.adopted).toBe(false);
    expect(out.fileName).toBe('Bild (333).png');
  });

  it('re-run of the disambiguated file adopts its own suffixed row', async () => {
    const state: FakeState = {
      rows: new Map([
        ['Bild.png', 'fa-1'],
        ['Bild (222).png', 'fa-2'],
      ]),
      crosswalk: [
        { target_id: 'fa-1', source_id: '111' },
        { target_id: 'fa-2', source_id: '222' },
      ],
      inserted: [],
    };
    const out = await run(state, '222');

    expect(out).toEqual({
      id: 'fa-2',
      fileName: 'Bild (222).png',
      adopted: true,
    });
    expect(state.inserted).toHaveLength(0);
  });
});

/**
 * A deliberate `include_attachments: false` exclusion used to seed 0 items and log at `info`, so the
 * run finalised `succeeded` with no indication the operator had excluded attachments. An operator
 * then reasonably reported "attachments are missing" while the monitor looked clean. The exclusion
 * must be inspectable through the channel the monitor already renders: a `warn` log carrying a
 * `context.reason`, which the run report's `lossy` section and the live log viewer both surface.
 * It must NOT fail the run — the exclusion is intentional.
 */
describe('AttachmentsStage scope exclusion is explicit and inspectable', () => {
  function makeJiraAdapter(pages: unknown[] = []) {
    // eslint-disable-next-line @typescript-eslint/require-await
    const iterateIssues = jest.fn(async function* () {
      for (const page of pages) yield page;
    });

    return {
      product: 'jira',
      listProjects: jest.fn(),
      iterateIssues,
    };
  }

  function makeProduceCtx(
    scope: Record<string, unknown>,
    adapter: ReturnType<typeof makeJiraAdapter>,
  ) {
    const log = jest.fn().mockResolvedValue(undefined);
    const ctx = {
      orgId: 'org-1',
      dryRun: false,
      job: {
        id: 'job-1',
        connection_id: 'conn-1',
        source_ref: 'PROJ',
        scope: {},
      },
      run: { id: 'run-1', config_snapshot: { scope } },
      entityMap: {},
      getAdapter: jest.fn().mockResolvedValue(adapter),
      log,
    } as unknown as StageContext;

    return { ctx, log, adapter };
  }

  function makeCollectionItem() {
    return { checkpoint: null } as unknown as MigrationRunItemRow;
  }

  const attachment = {
    sourceId: '79837',
    filename: 'spec.pdf',
    mimeType: 'application/pdf',
    downloadUrl: 'https://jira.example/secure/attachment/79837/spec.pdf',
    sizeBytes: 10,
  };

  it('logs a warn with a reason when attachments are excluded, and never marks the run failed', async () => {
    const stage = new AttachmentsStage({} as unknown as SupabaseAdminService);
    const adapter = makeJiraAdapter();
    const { ctx, log } = makeProduceCtx(
      { include_attachments: false },
      adapter,
    );

    const result = await stage.produce(ctx, makeCollectionItem());

    expect(result).toEqual({
      items: [],
      nextCheckpoint: null,
      done: true,
    });

    // The inspectable channel: a warn (not info) carrying a structured `reason`.
    const warnings = log.mock.calls.filter(([level]) => level === 'warn') as [
      string,
      string,
      Record<string, unknown>?,
    ][];

    expect(warnings).toHaveLength(1);
    const [level, message, context] = warnings[0];

    expect(level).toBe('warn');
    expect(message).toContain('attachments');
    expect(message).toMatch(/excluded by job scope/i);
    expect(context?.reason).toBe('attachments excluded by job scope');
    // The source was not even queried — the exclusion is honoured, not just logged.
    expect(adapter.iterateIssues).not.toHaveBeenCalled();
  });

  it('keeps the enabled path unchanged: seeds items and emits no exclusion warning', async () => {
    const stage = new AttachmentsStage({} as unknown as SupabaseAdminService);
    const page = {
      items: [{ sourceId: '10001', key: 'PROJ-1', attachments: [attachment] }],
      nextCursor: null,
    };
    const adapter = makeJiraAdapter([page]);
    const { ctx, log } = makeProduceCtx({ include_attachments: true }, adapter);

    const result = await stage.produce(ctx, makeCollectionItem());

    expect(result.items).toEqual([
      {
        entityType: 'attachment',
        sourceRef: '79837',
        payload: {
          issueSourceId: '10001',
          issueKey: 'PROJ-1',
          attachment,
        },
      },
    ]);
    expect(result.done).toBe(true);
    expect(adapter.iterateIssues).toHaveBeenCalledTimes(1);

    const warnings = log.mock.calls.filter(([level]) => level === 'warn');
    expect(warnings).toHaveLength(0);
  });
});
