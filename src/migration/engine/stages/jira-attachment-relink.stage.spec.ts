jest.mock('../../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: jest.fn(
    (value: string | null | undefined) => value ?? null,
  ),
}));

import { sanitizeRichText } from '../../../common/utils/sanitize-rich-text';

import { JiraAttachmentRelinkStage } from './jira-attachment-relink.stage';
import type { StageContext } from './stage.interface';

const ATTACHMENT_ID = '5d04a16a-249e-4a74-baf7-30510c89fb27';
const OTHER_ATTACHMENT_ID = '9c2f7a1e-6f3b-4f8e-9a1c-5d4e3b2a1f0e';
const taskId = 'a0b2d7e7-6877-4d38-aa15-b6a418064302';
const sourceUrl =
  'https://jira.example.test/secure/attachment/79837/report.pdf';
const crossIssueUrl =
  'https://jira.example.test/secure/attachment/80456/pruefprotokoll.pdf';

interface CapturedLog {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

function harness(
  opts: {
    concurrent?: boolean;
    wrongScope?: boolean;
    rpcError?: string;
    attachmentRows?: boolean;
    crossIssueRow?: boolean;
    skippedRow?: boolean;
    targetFileMissing?: boolean;
    repairOfRunId?: string;
    taskDescription?: string;
    commentContent?: string;
    /** The connection URL; defaults to the advertised Jira host. */
    baseUrl?: string;
    /** Issue item refs this run seeded (`migration_run_items.source_ref`). */
    issueRefs?: string[];
  } = {},
) {
  const task = {
    id: taskId,
    description: opts.taskDescription ?? `<a href="${sourceUrl}">report</a>`,
  };
  const comments = [
    {
      id: 'comment-1',
      content:
        opts.commentContent ??
        `<img src="https://jira.example.test/secure/thumbnail/79837/_thumb_79837.png">`,
    },
  ];
  const attachmentRows: Record<string, unknown>[] = [];

  if (opts.attachmentRows !== false) {
    attachmentRows.push({
      source_id: '79837',
      target_id: ATTACHMENT_ID,
      status: 'mapped',
      metadata: {
        issue: 'ITPFM-15',
        source_origin: 'https://jira.example.test',
      },
    });

    if (opts.crossIssueRow) {
      attachmentRows.push({
        source_id: '80456',
        target_id: OTHER_ATTACHMENT_ID,
        status: 'mapped',
        metadata: {
          issue: 'ITPFM-99',
          source_origin: 'https://jira.example.test',
        },
      });
    }

    if (opts.skippedRow) {
      attachmentRows.push({
        source_id: '9002',
        target_id: 'unmigrated-target',
        status: 'skipped',
        metadata: {},
      });
    }
  }

  const updates: {
    table: string;
    id: string;
    value: Record<string, string>;
  }[] = [];
  const logs: CapturedLog[] = [];
  const selectFilters: Record<string, unknown>[] = [];

  const rpc = jest.fn(
    async (
      _name: string,
      args: {
        p_organization_id: string;
        p_task_id: string;
        p_comment_id: string | null;
        p_expected: string;
        p_replacement: string;
      },
    ) => {
      if (opts.rpcError)
        return { data: null, error: { message: opts.rpcError } };
      const comment = comments.find((row) => row.id === args.p_comment_id);
      const original =
        args.p_comment_id === null ? task.description : comment?.content;
      if (
        opts.concurrent ||
        opts.wrongScope ||
        args.p_organization_id !== 'org-1' ||
        args.p_task_id !== taskId ||
        original !== args.p_expected
      )
        return { data: false, error: null };
      updates.push({
        table: args.p_comment_id === null ? 'tasks' : 'task_comments',
        id: args.p_comment_id ?? taskId,
        value: {
          [args.p_comment_id === null ? 'description' : 'content']:
            args.p_replacement,
        },
      });
      return { data: true, error: null };
    },
  );
  const db = {
    rpc,
    from(table: string) {
      const state: {
        table: string;
        filters: Record<string, unknown>;
      } = {
        table,
        filters: {},
      };
      const result = () => {
        if (table === 'migration_run_items') {
          selectFilters.push({ table, ...state.filters });
          const after = state.filters['source_ref:gt'] as string | undefined;

          return {
            data: (opts.issueRefs ?? ['10001'])
              .filter((ref) => after === undefined || ref > after)
              .slice(0, (state.filters[':limit'] as number) ?? undefined)
              .map((ref) => ({ source_ref: ref })),
            error: null,
          };
        }

        if (table === 'migration_entity_map') {
          selectFilters.push({ ...state.filters });
          // The crosswalk is unique per connection; rows from another connection never resolve.
          const isExpectedMapping =
            state.filters.organization_id === 'org-1' &&
            state.filters.source_connection_id === 'conn-1';

          if (!isExpectedMapping) return { data: [], error: null };

          if (state.filters.entity_type === 'attachment') {
            // The once-per-run advertised-origin scan selects `metadata->>source_origin`.
            if ('metadata->>source_origin' in state.filters) {
              return {
                data:
                  opts.attachmentRows === false
                    ? []
                    : [{ source_origin: 'https://jira.example.test' }],
                error: null,
              };
            }

            return { data: attachmentRows, error: null };
          }

          return {
            data: [
              { source_id: '10001', source_key: 'ITPFM-15', target_id: taskId },
            ],
            error: null,
          };
        }

        if (table === 'migration_connections') {
          return {
            data: { base_url: opts.baseUrl ?? 'https://jira.example.test' },
            error: null,
          };
        }

        if (table === 'file_attachments') {
          const wanted = (state.filters['id:in'] as string[]) ?? [];
          const known =
            opts.targetFileMissing || opts.attachmentRows === false
              ? []
              : [
                  ATTACHMENT_ID,
                  ...(opts.crossIssueRow ? [OTHER_ATTACHMENT_ID] : []),
                ];

          return {
            data: wanted
              .filter((id) => known.includes(id))
              .map((id) => ({ id })),
            error: null,
          };
        }

        if (table === 'tasks') return { data: task, error: null };

        if (table === 'task_comments') return { data: comments, error: null };

        return { data: null, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (key: string, value: unknown) => {
          state.filters[key] = value;
          return chain;
        },
        filter: (key: string, _operator: string, value: unknown) => {
          state.filters[key] = value;
          return chain;
        },
        in: (key: string, values: unknown[]) => {
          state.filters[`${key}:in`] = values;
          return chain;
        },
        not: (key: string, operator: string, value: unknown) => {
          state.filters[key] = `not.${operator}.${String(value)}`;
          return chain;
        },
        gt: (key: string, value: unknown) => {
          state.filters[`${key}:gt`] = value;
          return chain;
        },
        limit: (count: number) => {
          state.filters[':limit'] = count;
          return chain;
        },
        order: () => chain,
        range: () => Promise.resolve(result()),
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };

      return chain;
    },
  };
  const stage = new JiraAttachmentRelinkStage({ getClient: () => db } as any);
  const ctx = {
    orgId: 'org-1',
    dryRun: false,
    run: {
      id: 'run-1',
      config_snapshot: opts.repairOfRunId
        ? { repair_of_run_id: opts.repairOfRunId }
        : {},
    },
    job: { id: 'job-1', connection_id: 'conn-1', source_ref: 'ITPFM' },
    log: async (
      level: string,
      message: string,
      context?: Record<string, unknown>,
    ) => void logs.push({ level, message, context }),
  } as unknown as StageContext;
  const item = {
    payload: { issueSourceId: '10001', issueKey: 'ITPFM-15', taskId },
  } as any;

  return { stage, ctx, item, updates, logs, selectFilters, rpc };
}

describe('JiraAttachmentRelinkStage', () => {
  it('sends long task and comment content through the RPC body with exact scope and expected text', async () => {
    const original = `<table><tr><td>${'long content & ü '.repeat(5000)}</td></tr></table><a href="${sourceUrl}">report</a>`;
    const h = harness({ taskDescription: original, commentContent: original });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'updated',
    });
    expect(h.rpc).toHaveBeenCalledTimes(2);
    for (const commentId of [null, 'comment-1']) {
      expect(h.rpc).toHaveBeenCalledWith(
        'migration_compare_and_update_content',
        {
          p_organization_id: 'org-1',
          p_task_id: taskId,
          p_comment_id: commentId,
          p_expected: original,
          p_replacement: original.replace(
            sourceUrl,
            `/api/v1/attachments/${ATTACHMENT_ID}/download`,
          ),
        },
      );
    }
  });

  it('preserves both rows and warns when the RPC finds no matching ownership scope', async () => {
    const h = harness({ wrongScope: true });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(h.updates).toEqual([]);
    expect(h.logs).toHaveLength(2);
    expect(
      h.logs.every(
        (entry) =>
          entry.level === 'warn' && entry.message.includes('left unchanged'),
      ),
    ).toBe(true);
  });

  it('never sends a replacement emptied by sanitization to the RPC', async () => {
    const sanitizeMock = sanitizeRichText as jest.Mock;
    sanitizeMock.mockReturnValueOnce('  ').mockReturnValueOnce('');
    const h = harness();

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(2);
    expect(
      h.logs.every((entry) =>
        entry.message.includes('emptied by sanitization'),
      ),
    ).toBe(true);
  });

  it('propagates RPC failures so relinking can be retried', async () => {
    const h = harness({ rpcError: 'database temporarily unavailable' });

    await expect(h.stage.processItem(h.ctx, h.item)).rejects.toThrow(
      'database temporarily unavailable',
    );
    expect(h.updates).toEqual([]);
  });

  it('seeds every issue this run touched, whichever run first mapped it, and has no dry-run write pass', async () => {
    const h = harness();

    await expect(
      h.stage.produce(h.ctx, { checkpoint: null } as any),
    ).resolves.toMatchObject({
      items: [
        {
          entityType: 'jira_attachment_relink',
          sourceRef: '10001',
          payload: { issueKey: 'ITPFM-15', taskId },
        },
      ],
      nextCheckpoint: null,
      done: true,
    });
    // Enumerated from this run's own issue items, resolved connection-wide: no run/job stamp.
    expect(h.selectFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'migration_run_items',
          run_id: 'run-1',
          entity_type: 'issue',
          item_kind: 'entity',
        }),
        expect.objectContaining({
          entity_type: 'issue',
          source_connection_id: 'conn-1',
          'source_id:in': ['10001'],
        }),
      ]),
    );
    for (const filters of h.selectFilters.filter((f) => !f.table)) {
      expect(filters.job_id).toBeUndefined();
      expect(filters.run_id).toBeUndefined();
    }

    (h.ctx as any).dryRun = true;
    await expect(
      h.stage.produce(h.ctx, { checkpoint: null } as any),
    ).resolves.toEqual({ items: [], nextCheckpoint: null, done: true });
  });

  it('uses attachment crosswalk ids to rewrite an issue description and every comment', async () => {
    const h = harness();

    const out = await h.stage.processItem(h.ctx, h.item);

    expect(out).toEqual({
      kind: 'updated',
      targetId: taskId,
      targetTable: 'tasks',
    });
    expect(h.updates).toEqual([
      {
        table: 'tasks',
        id: taskId,
        value: {
          description: `<a href="/api/v1/attachments/${ATTACHMENT_ID}/download">report</a>`,
        },
      },
      {
        table: 'task_comments',
        id: 'comment-1',
        value: {
          content: `<img src="/api/v1/attachments/${ATTACHMENT_ID}/download">`,
        },
      },
    ]);
  });

  it('re-sanitizes the rewritten rows with tables ALLOWED', async () => {
    // This stage rewrites rows TasksService already wrote under `allowTables`. Sanitizing them
    // again under the default policy would strip the grid out of content that imported correctly —
    // and the exact-content compare-and-swap means only rows that happen to carry
    // an attachment would lose their table, which is about as hard to debug as data loss gets.
    const sanitizeMock = sanitizeRichText as unknown as jest.Mock;

    sanitizeMock.mockClear();

    const h = harness();

    await h.stage.processItem(h.ctx, h.item);

    const options = (sanitizeMock.mock.calls as unknown[][]).map(
      (call) => call[1],
    );

    expect(options.length).toBeGreaterThan(0);
    expect(
      options.every((o) => JSON.stringify(o) === '{"allowTables":true}'),
    ).toBe(true);
  });

  it('relinks repeated inline images in both the description and comment', async () => {
    const h = harness({
      taskDescription:
        `<p><img src="https://jira.example.test/secure/attachment/79837/report.png"></p>` +
        `<a href="${sourceUrl}">download</a>`,
      commentContent:
        '<p><img src="https://jira.example.test/secure/thumbnail/79837/_thumb_79837.png">' +
        '<img src="https://jira.example.test/secure/attachment/79837/report.png"></p>',
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'updated',
      targetId: taskId,
    });

    const rewritten = `/api/v1/attachments/${ATTACHMENT_ID}/download`;

    expect(h.updates).toEqual([
      {
        table: 'tasks',
        id: taskId,
        value: {
          description: `<p><img src="${rewritten}"></p><a href="${rewritten}">download</a>`,
        },
      },
      {
        table: 'task_comments',
        id: 'comment-1',
        value: {
          content: `<p><img src="${rewritten}"><img src="${rewritten}"></p>`,
        },
      },
    ]);
  });

  it('relinks a document attached to a different issue than the one linking it', async () => {
    const h = harness({
      crossIssueRow: true,
      taskDescription: `<p>Siehe <a href="${crossIssueUrl}">Prüfprotokoll</a></p>`,
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'updated',
    });

    expect(h.updates).toEqual(
      expect.arrayContaining([
        {
          table: 'tasks',
          id: taskId,
          value: {
            description: `<p>Siehe <a href="/api/v1/attachments/${OTHER_ATTACHMENT_ID}/download">Prüfprotokoll</a></p>`,
          },
        },
      ]),
    );
  });

  it('resolves candidates against the connection crosswalk, whichever run or job imported the file', async () => {
    const h = harness();

    await h.stage.processItem(h.ctx, h.item);

    const attachmentQueries = h.selectFilters.filter(
      (filters) => filters.entity_type === 'attachment',
    );

    expect(attachmentQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organization_id: 'org-1',
          source_connection_id: 'conn-1',
        }),
      ]),
    );
    // A retry, re-run, repair or deleted run must not hide a migrated file (XE-T668), and the
    // per-issue filter that hid cross-issue documents stays gone.
    for (const filters of attachmentQueries) {
      expect(filters.job_id).toBeUndefined();
      expect(filters.run_id).toBeUndefined();
      expect(filters['metadata->>issue']).toBeUndefined();
    }
  });

  it('lets a repair run enumerate its own replayed issue items', async () => {
    const h = harness({ repairOfRunId: 'source-run-1' });

    await expect(
      h.stage.produce(h.ctx, { checkpoint: null } as any),
    ).resolves.toMatchObject({ items: [{ sourceRef: '10001' }] });
    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'updated',
    });
    expect(h.selectFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'migration_run_items',
          run_id: 'run-1',
        }),
      ]),
    );
  });

  it('pages issue items by keyset and restarts a legacy offset checkpoint', async () => {
    const refs = Array.from({ length: 51 }, (_, i) => String(10001 + i));
    const h = harness({ issueRefs: refs });

    const first = await h.stage.produce(h.ctx, { checkpoint: null } as any);

    expect(first).toMatchObject({
      nextCheckpoint: { afterSourceRef: '10050' },
      done: false,
    });

    const second = await h.stage.produce(h.ctx, {
      checkpoint: { afterSourceRef: '10050' },
    } as any);

    expect(second).toMatchObject({ nextCheckpoint: null, done: true });
    expect(h.selectFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'migration_run_items',
          'source_ref:gt': '10050',
        }),
      ]),
    );

    h.selectFilters.length = 0;
    await h.stage.produce(h.ctx, { checkpoint: { offset: 50 } } as any);
    expect(
      h.selectFilters.find((f) => f.table === 'migration_run_items'),
    ).not.toHaveProperty('source_ref:gt');
  });

  it("relinks Jira Server's `{id}_{filename}` inline image path from a comment (XE-T668)", async () => {
    const h = harness({
      taskDescription: '<p>Ohne Anhang.</p>',
      commentContent:
        '<p>Rot markiert: abgebrochene Anrufe</p><img src="https://jira.example.test/secure/attachment/79837/79837_image-2026-09-03-14-12-20-599.png" alt="image.png">',
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'updated',
    });
    expect(h.updates).toEqual([
      {
        table: 'task_comments',
        id: 'comment-1',
        value: {
          content: `<p>Rot markiert: abgebrochene Anrufe</p><img src="/api/v1/attachments/${ATTACHMENT_ID}/download" alt="image.png">`,
        },
      },
    ]);
  });

  it('relinks advertised-host links when the connection uses an internal URL', async () => {
    const h = harness({
      baseUrl: 'http://10.0.0.5:8080',
      taskDescription: '<p>Ohne Anhang.</p>',
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toMatchObject({
      kind: 'updated',
    });
    expect(h.updates[0].value.content).toBe(
      `<img src="/api/v1/attachments/${ATTACHMENT_ID}/download">`,
    );
  });

  it('relinks a task directly for the boot-time heal, outside any run', async () => {
    const h = harness();
    const logs: string[] = [];

    await expect(
      h.stage.relinkTask(
        {
          orgId: 'org-1',
          connectionId: 'conn-1',
          passId: 'heal:1',
          log: async (_level, message) => void logs.push(message),
        },
        taskId,
        'ITPFM-15',
      ),
    ).resolves.toEqual({
      kind: 'updated',
      targetId: taskId,
      targetTable: 'tasks',
    });
    expect(h.updates).toHaveLength(2);
    expect(logs).toEqual([]);
  });

  it('never resolves a file from another connection with the same attachment id', async () => {
    const h = harness();

    await expect(
      h.stage.relinkTask(
        {
          orgId: 'org-1',
          connectionId: 'conn-2',
          passId: 'heal:1',
          log: async () => undefined,
        },
        taskId,
        'ITPFM-15',
      ),
    ).resolves.toMatchObject({ kind: 'skipped' });
    expect(h.updates).toEqual([]);
  });

  it('leaves and reports a source link whose attachment was never migrated', async () => {
    const h = harness({ attachmentRows: false });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toEqual({
      kind: 'skipped',
      reason: '1 linked document has no migrated file',
    });
    expect(h.updates).toEqual([]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0].level).toBe('warn');
    expect(h.logs[0].message).toContain('ITPFM-15');
    expect(h.logs[0].message).toContain('report.pdf');
    expect(h.logs[0].context).toMatchObject({
      issueKey: 'ITPFM-15',
      unresolvedLinks: [
        {
          sourceId: '79837',
          url: sourceUrl,
          filename: 'report.pdf',
          reason: 'not migrated from this connection',
        },
      ],
    });
  });

  it('reports a link whose attachment was deliberately not migrated', async () => {
    const h = harness({
      skippedRow: true,
      taskDescription:
        '<a href="https://jira.example.test/secure/attachment/9002/toolarge.zip">zip</a>',
      commentContent: '<p>Ohne Anhang.</p>',
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toEqual({
      kind: 'skipped',
      reason: '1 linked document has no migrated file',
    });
    expect(h.updates).toEqual([]);
    expect(h.logs[0].context).toMatchObject({
      unresolvedLinks: [
        { sourceId: '9002', reason: 'attachment was not migrated (skipped)' },
      ],
    });
  });

  it('reports a link whose migrated file no longer exists instead of rewriting it', async () => {
    const h = harness({
      targetFileMissing: true,
      commentContent: '<p>Text.</p>',
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toEqual({
      kind: 'skipped',
      reason: '1 linked document has no migrated file',
    });
    expect(h.updates).toEqual([]);
    expect(h.logs[0].context).toMatchObject({
      unresolvedLinks: [
        { sourceId: '79837', reason: 'migrated file no longer exists' },
      ],
    });
  });

  it('rewrites resolvable links and reports the rest in one warning', async () => {
    const h = harness({
      taskDescription:
        `<a href="${sourceUrl}">report</a>` +
        '<a href="https://jira.example.test/secure/attachment/9003/architektur.png">plan</a>',
      commentContent: '<p>Siehe Anhang.</p>',
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toEqual({
      kind: 'updated',
      targetId: taskId,
      targetTable: 'tasks',
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].value.description).toContain(
      `/api/v1/attachments/${ATTACHMENT_ID}/download`,
    );
    expect(h.updates[0].value.description).toContain('secure/attachment/9003');
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0].level).toBe('warn');
    expect(h.logs[0].message).toContain(
      '1 linked document has no migrated file',
    );
    expect(h.logs[0].context).toMatchObject({
      unresolvedLinks: [{ sourceId: '9003', filename: 'architektur.png' }],
    });
  });

  it('is a no-op on already-relinked content without touching the crosswalk', async () => {
    const h = harness({
      taskDescription: `<a href="/api/v1/attachments/${ATTACHMENT_ID}/download">report</a>`,
      commentContent: '<p>Ok.</p>',
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no Jira attachment URLs needed relinking',
    });
    expect(h.updates).toEqual([]);
    expect(h.logs).toEqual([]);
    expect(
      h.selectFilters.some((filters) => filters.entity_type === 'attachment'),
    ).toBe(false);
  });

  it('leaves third-party links untouched and unreported', async () => {
    const h = harness({
      taskDescription:
        '<a href="https://www.atlassian.com/secure/attachment/79837/lookalike.pdf">external</a>' +
        '<a href="https://example.test/doc.pdf">plain</a>',
      commentContent: '<p>Plain.</p>',
    });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no Jira attachment URLs needed relinking',
    });
    expect(h.updates).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('does not overwrite a concurrently edited description or comment', async () => {
    const h = harness({ concurrent: true });

    await expect(h.stage.processItem(h.ctx, h.item)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no Jira attachment URLs needed relinking',
    });
    expect(h.logs).toHaveLength(2);
    expect(
      h.logs.every((entry) => entry.message.includes('concurrently')),
    ).toBe(true);
  });
});
