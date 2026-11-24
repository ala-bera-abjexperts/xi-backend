import type { PdfRenderService } from '../../document-designer/rendering/pdf-render.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  MigrationReportService,
  projectAuditRow,
  type MigrationReportExport,
} from './migration-report.service';

const rawItem = {
  id: 'item-1',
  stage: 'issues',
  stage_order: 10,
  entity_type: 'task',
  item_kind: 'entity' as const,
  source_ref: '=HYPERLINK("https://evil.example")',
  parent_source_ref: 'PARENT-1',
  payload: {
    title: '<script>alert(1)</script>',
    description: 'private body',
    comment: 'personal comment',
    credentials: { password: 'secret' },
    url: 'https://private.example/path',
  },
  status: 'failed',
  retry_count: 2,
  target_id: 'XI-22',
  error_class: 'permanent',
  error_message:
    'Fetch https://private.example for person@example.com failed with token=super-secret',
  started_at: '2026-09-01T10:00:00.000Z',
  finished_at: '2026-09-01T10:00:01.250Z',
  duration_ms: 1250,
  created_at: '2026-09-01T10:00:00.000Z',
};

const mapping = {
  entity_type: 'task',
  source_id: rawItem.source_ref,
  target_table: 'tasks',
  target_id: 'XI-22',
  match_method: 'source_key',
};

describe('migration report audit projection', () => {
  it.each(['info', 'warn'])(
    'exports page_history %s skip reasons as audit diagnostics',
    async (level) => {
      const db = databaseHarness({
        items: [
          scopedItem({
            stage: 'page_history',
            entity_type: 'page_history',
            source_ref: 'page-1',
            status: 'skipped',
            target_id: null,
          }),
        ],
        targets: {
          migration_logs: [
            {
              organization_id: 'org-1',
              run_id: 'run-1',
              stage: 'page_history',
              level,
              source_ref: 'page-1',
              message: 'history unavailable',
              context: {
                reason: 'No historical versions available',
                secret: 'private',
              },
              created_at: 'same-time',
            },
          ],
        },
      });
      const service = serviceWith(db);
      const bundle = await service.getExport('org-1', 'run-1');
      expect(bundle.items[0].skipReason).toBe(
        'No historical versions available',
      );
      expect(bundle.report.lossy).toHaveLength(level === 'warn' ? 1 : 0);
      expect(service.toCsv(bundle)).toContain(
        'No historical versions available',
      );
      expect(service.toHtml(bundle)).toContain(
        'No historical versions available',
      );
      expect(JSON.stringify(bundle)).not.toContain('private');
    },
  );
  it('projects only the audit allowlist and redacts URLs and credential values', () => {
    const row = projectAuditRow(rawItem, mapping);

    expect(row).toEqual({
      stage: 'issues',
      entityType: 'task',
      itemKind: 'entity',
      sourceRef: '=HYPERLINK("[url]")',
      titleOrFilename: '<script>alert(1)</script>',
      parentSourceRef: 'PARENT-1',
      outcome: 'failed',
      matchMethod: 'source_key',
      targetTable: 'tasks',
      targetIdOrKey: 'XI-22',
      attempts: 3,
      startedAt: '2026-09-01T10:00:00.000Z',
      finishedAt: '2026-09-01T10:00:01.250Z',
      durationMs: 1250,
      errorClass: 'permanent',
      errorMessage: 'Fetch [url] for [email] failed with token=[redacted]',
    });
    expect(JSON.stringify(row)).not.toMatch(
      /private body|personal comment|super-secret|credentials|password/,
    );
  });

  it('uses a filename only when no title is present and keeps collection rows visible', () => {
    const row = projectAuditRow({
      ...rawItem,
      item_kind: 'collection',
      payload: { filename: 'evidence.pdf', pageSize: 100 },
      source_ref: null,
      started_at: null,
      retry_count: 0,
    });

    expect(row.itemKind).toBe('collection');
    expect(row.titleOrFilename).toBe('evidence.pdf');
    expect(row.attempts).toBe(0);
  });

  it('allowlists Jira summaries and nested attachment filenames only', () => {
    expect(
      projectAuditRow({
        ...rawItem,
        payload: { summary: 'Issue summary', description: 'private' },
      }).titleOrFilename,
    ).toBe('Issue summary');
    const attachment = projectAuditRow({
      ...rawItem,
      payload: {
        attachment: {
          filename: 'invoice.pdf',
          url: 'https://private.example',
          comment: 'personal',
        },
      },
    });
    expect(attachment.titleOrFilename).toBe('invoice.pdf');
    expect(JSON.stringify(attachment)).not.toMatch(/private\.example|personal/);
    expect(
      projectAuditRow({
        ...rawItem,
        entity_type: 'user',
        payload: { summary: 'Personal display name' },
      }).titleOrFilename,
    ).toBeNull();
  });
});

describe('MigrationReportService audit exports', () => {
  const pdf = Buffer.from('%PDF-report');
  const pdfRenderer = {
    renderPdf: jest.fn().mockResolvedValue(pdf),
  } as unknown as jest.Mocked<PdfRenderService>;

  beforeEach(() => jest.clearAllMocks());

  it('neutralizes formulas, emits UTF-8 CSV, and includes every audit row once', () => {
    const service = new MigrationReportService(
      {} as SupabaseAdminService,
      pdfRenderer,
    );
    const bundle = exportBundle([
      projectAuditRow(rawItem, mapping),
      projectAuditRow({
        ...rawItem,
        id: 'item-2',
        source_ref: 'SAFE-2',
        payload: { title: 'Second' },
      }),
    ]);
    bundle.report.unimplementedStages = ['missing_stage'];
    bundle.report.entities = [
      {
        entityType: 'task',
        created: 1,
        skipped: 0,
        failed: 1,
        blocked: 0,
        planned: 0,
        mapped: 1,
      },
    ];
    bundle.report.reconciliation = [
      {
        entityType: 'task',
        sourceCount: null,
        targetCount: 1,
        shortfall: null,
      },
    ];
    bundle.report.failures = [
      {
        entityType: 'task',
        errorClass: 'permanent',
        cause: 'Fetch https://private.example failed',
        count: 2,
        samples: [{ sourceRef: 'TASK-1', title: 'One' }],
      },
    ];
    bundle.report.lossy = [
      {
        stage: 'issues',
        at: '2026-09-01T10:00:00.000Z',
        message: 'person@example.com was omitted',
      },
    ];

    const csv = service.toCsv(bundle);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""[url]"")"');
    expect(csv.match(/<script>alert\(1\)<\/script>/g)).toHaveLength(1);
    expect(csv.match(/SAFE-2/g)).toHaveLength(1);
    expect(csv).not.toContain('private body');
    expect(csv).not.toMatch(/private\.example|person@example\.com/);
    expect(csv).toContain('INCONCLUSIVE');
  });

  it('builds self-contained escaped HTML with repeated headers and page numbers', () => {
    const service = new MigrationReportService(
      {} as SupabaseAdminService,
      pdfRenderer,
    );
    const bundle = exportBundle([
      projectAuditRow(rawItem, mapping),
      projectAuditRow({ ...rawItem, status: 'blocked', source_ref: 'BLOCKED' }),
      projectAuditRow({ ...rawItem, status: 'dead', source_ref: 'DEAD' }),
    ]);
    bundle.report.unimplementedStages = ['unsupported_stage'];
    bundle.report.failures = [
      {
        entityType: 'task',
        errorClass: 'permanent',
        cause: '<bad cause>',
        count: 3,
        samples: [{ sourceRef: 'TASK-1', title: 'One' }],
      },
    ];
    const html = service.toHtml(bundle);

    expect(html).toContain('thead { display: table-header-group; }');
    expect(html).toContain('counter(page)');
    expect(html).toContain('counter(pages)');
    expect(html).not.toContain('class="footer"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('Not attempted');
    expect(html).toContain('unsupported_stage');
    expect(html).toContain('Grouped failure causes');
    expect(html).toContain('&lt;bad cause&gt;');
    expect(html).toContain('class="outcome-failed"');
    expect(html).toContain('class="outcome-blocked"');
    expect(html).toContain('class="outcome-dead"');
  });

  it('renders all rows through the existing PDF renderer', async () => {
    const service = new MigrationReportService(
      {} as SupabaseAdminService,
      pdfRenderer,
    );
    const rows = Array.from({ length: 1201 }, (_, index) =>
      projectAuditRow({
        ...rawItem,
        id: `item-${index}`,
        source_ref: `SOURCE-${index}`,
        payload: { title: `Title ${index}` },
      }),
    );

    await expect(service.toPdf(exportBundle(rows))).resolves.toBe(pdf);
    const html = pdfRenderer.renderPdf.mock.calls[0][0];
    for (const row of rows) {
      expect(html.match(new RegExp(`>${row.sourceRef}<`, 'g'))).toHaveLength(1);
    }
    expect(pdfRenderer.renderPdf.mock.calls[0]).toEqual([
      expect.any(String),
      { widthPx: 1123, heightPx: 794 },
    ]);
  });

  it('renders an explicit empty state', () => {
    const service = new MigrationReportService(
      {} as SupabaseAdminService,
      pdfRenderer,
    );

    expect(service.toHtml(exportBundle([]))).toContain(
      'No audit items were recorded for this run.',
    );
  });
});

describe('MigrationReportService tenant and run scoping', () => {
  it('counts only business entity items and mappings written by this run', async () => {
    const db = databaseHarness({
      items: [
        scopedItem({ source_ref: 'TASK-1', target_id: '00000000-0000-4000-8000-000000000009' }),
        scopedItem({
          id: 'skipped',
          source_ref: 'TASK-2',
          status: 'skipped',
          target_id: '00000000-0000-4000-8000-000000000009',
        }),
        scopedItem({
          id: 'failed',
          source_ref: 'TASK-3',
          status: 'failed',
          payload: { title: 'person@example.com' },
          error_message:
            'Fetch https://private.example failed token=super-secret',
        }),
        scopedItem({ id: 'blocked', source_ref: 'TASK-4', status: 'blocked' }),
        scopedItem({
          id: 'collection',
          item_kind: 'collection',
          entity_type: 'issues',
          source_ref: null,
          status: 'failed',
          error_message: 'Producer failed',
        }),
        scopedItem({
          id: 'verify',
          stage: 'verify',
          entity_type: 'verification',
          source_ref: 'verify:SPACE',
        }),
        scopedItem({
          id: 'probe',
          stage: 'probe',
          entity_type: 'probe',
          source_ref: 'probe-1',
        }),
        scopedItem({
          id: 'other-org',
          organization_id: 'org-2',
          source_ref: 'TASK-OTHER',
        }),
      ],
      mappings: [
        // A later upsert moved TASK-1's mutable crosswalk provenance to run-2. The immutable run
        // items must keep run-1's mapped_in_target stable.
        scopedMapping({ run_id: 'run-2', source_id: 'TASK-1' }),
        scopedMapping({
          entity_type: 'verification',
          source_id: 'verify:SPACE',
        }),
        scopedMapping({ entity_type: 'probe', source_id: 'probe-1' }),
      ],
      targets: { tasks: [{ id: '00000000-0000-4000-8000-000000000009', organization_id: 'org-1' }] },
    });
    const service = serviceWith(db);

    const bundle = await service.getExport('org-1', 'run-1');
    const report = bundle.report;

    expect(report.entities).toEqual([
      expect.objectContaining({
        entityType: 'task',
        created: 1,
        skipped: 1,
        failed: 1,
        blocked: 1,
        mapped: 2,
      }),
    ]);
    expect(report.totals).toEqual({
      created: 1,
      skipped: 1,
      failed: 1,
      blocked: 1,
    });
    expect(JSON.stringify(report.failures)).not.toMatch(
      /private\.example|person@example\.com|super-secret/,
    );
    expect(report.failures[0]).toEqual(
      expect.objectContaining({
        cause: 'Fetch [url] failed token=[redacted]',
        samples: [{ sourceRef: 'TASK-3', title: '[email]' }],
      }),
    );
    expect(bundle.items.find((item) => item.sourceRef === 'TASK-1')).toEqual(
      expect.objectContaining({
        targetIdOrKey: '00000000-0000-4000-8000-000000000009',
        targetTable: null,
        matchMethod: null,
      }),
    );
    expect(report.failures).toContainEqual(
      expect.objectContaining({
        entityType: 'issues',
        cause: 'Producer failed',
        count: 1,
      }),
    );
    expect(
      db
        .callsFor('migration_entity_map')
        .some(
          (call) =>
            call.filters.organization_id === 'org-1' &&
            call.filters.run_id === 'run-1',
        ),
    ).toBe(true);
  });

  it('returns a filtered page of projected rows with an exact total', async () => {
    const db = databaseHarness({
      items: [
        scopedItem({ status: 'failed', payload: rawItem.payload }),
        scopedItem({ id: 'item-2', stage: 'pages', entity_type: 'wiki_page' }),
      ],
      mappings: [scopedMapping()],
    });
    const service = serviceWith(db);

    const page = await service.listItems('org-1', 'run-1', {
      stage: 'issues',
      status: 'failed',
      entity_type: 'task',
      item_kind: 'entity',
      limit: 25,
      offset: 0,
    });

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('payload');
    expect(JSON.stringify(page.items[0])).not.toContain('private body');
    expect(
      db
        .callsFor('migration_run_items')
        .some(
          (call) =>
            call.filters.organization_id === 'org-1' &&
            call.filters.run_id === 'run-1' &&
            call.filters.stage === 'issues' &&
            call.filters.status === 'failed' &&
            call.filters.entity_type === 'task' &&
            call.filters.item_kind === 'entity',
        ),
    ).toBe(true);
  });

  it('never reports dry-run plans as mapped in the target', async () => {
    const db = databaseHarness({
      run: { mode: 'dry_run' },
      items: [scopedItem({ target_id: 'planned:TASK-1' })],
    });

    const report = await serviceWith(db).getReport('org-1', 'run-1');

    expect(report.entities[0].mapped).toBe(0);
  });

  it('does not report deleted physical targets as mapped', async () => {
    const db = databaseHarness({
      items: [
        scopedItem({ source_ref: 'TASK-1', target_id: '00000000-0000-4000-8000-000000000001' }),
        scopedItem({
          id: 'item-2',
          source_ref: 'TASK-2',
          target_id: '00000000-0000-4000-8000-000000000002',
        }),
      ],
      mappings: [
        scopedMapping({ source_id: 'TASK-1', target_id: '00000000-0000-4000-8000-000000000001' }),
        scopedMapping({ source_id: 'TASK-2', target_id: '00000000-0000-4000-8000-000000000002' }),
      ],
      targets: { tasks: [{ id: '00000000-0000-4000-8000-000000000001', organization_id: 'org-1' }] },
    });

    const report = await serviceWith(db).getReport('org-1', 'run-1');

    expect(report.entities[0].mapped).toBe(1);
  });

  it('counts Confluence children only when their owning page is live in the organization', async () => {
    const db = databaseHarness({
      items: [
        scopedItem({
          id: 'page-live-item',
          entity_type: 'page',
          source_ref: 'PAGE-1',
          target_id: '00000000-0000-4000-8000-000000000003',
        }),
        scopedItem({
          id: 'page-archived-item',
          entity_type: 'page',
          source_ref: 'PAGE-2',
          target_id: '00000000-0000-4000-8000-000000000004',
        }),
        scopedItem({
          id: 'attachment-live-item',
          entity_type: 'page_attachment',
          source_ref: 'PAGE-1:file.pdf',
          target_id: '00000000-0000-4000-8000-000000000005',
        }),
        scopedItem({
          id: 'attachment-archived-item',
          entity_type: 'page_attachment',
          source_ref: 'PAGE-2:file.pdf',
          target_id: '00000000-0000-4000-8000-000000000006',
        }),
        scopedItem({
          id: 'comment-live-item',
          entity_type: 'page_comment',
          source_ref: 'COMMENT-1',
          target_id: '00000000-0000-4000-8000-000000000007',
        }),
        scopedItem({
          id: 'comment-archived-item',
          entity_type: 'page_comment',
          source_ref: 'COMMENT-2',
          target_id: '00000000-0000-4000-8000-000000000008',
        }),
      ],
      targets: {
        wiki_pages: [
          {
            id: '00000000-0000-4000-8000-000000000003',
            organization_id: 'org-1',
            is_archived: false,
          },
          {
            id: '00000000-0000-4000-8000-000000000004',
            organization_id: 'org-1',
            is_archived: true,
          },
        ],
        wiki_page_attachments: [
          { id: '00000000-0000-4000-8000-000000000005', wiki_page_id: '00000000-0000-4000-8000-000000000003' },
          { id: '00000000-0000-4000-8000-000000000006', wiki_page_id: '00000000-0000-4000-8000-000000000004' },
        ],
        wiki_page_comments: [
          { id: '00000000-0000-4000-8000-000000000007', wiki_page_id: '00000000-0000-4000-8000-000000000003' },
          { id: '00000000-0000-4000-8000-000000000008', wiki_page_id: '00000000-0000-4000-8000-000000000004' },
        ],
      },
    });

    const report = await serviceWith(db).getReport('org-1', 'run-1');
    const mapped = new Map(
      report.entities.map((entity) => [entity.entityType, entity.mapped]),
    );

    expect(mapped.get('page')).toBe(1);
    expect(mapped.get('page_attachment')).toBe(1);
    expect(mapped.get('page_comment')).toBe(1);
  });
});

function exportBundle(
  items: MigrationReportExport['items'],
): MigrationReportExport {
  return {
    report: {
      runId: 'run-1',
      jobId: 'job-1',
      mode: 'live',
      status: 'partially_completed',
      startedAt: '2026-09-01T10:00:00.000Z',
      finishedAt: '2026-09-01T10:01:00.000Z',
      durationMs: 60_000,
      unimplementedStages: [],
      entities: [],
      reconciliation: [],
      lossy: [],
      failures: [],
      totals: { created: 0, skipped: 0, failed: 1, blocked: 0 },
    },
    items,
  };
}

function scopedItem(overrides: Record<string, unknown> = {}) {
  return {
    ...rawItem,
    organization_id: 'org-1',
    run_id: 'run-1',
    status: 'succeeded',
    retry_count: 0,
    error_class: null,
    error_message: null,
    ...overrides,
  };
}

function scopedMapping(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    run_id: 'run-1',
    status: 'mapped',
    ...mapping,
    ...overrides,
  };
}

function serviceWith(db: ReturnType<typeof databaseHarness>) {
  const admin = {
    getClient: () => ({ from: (table: string) => db.query(table) }),
  } as unknown as SupabaseAdminService;
  return new MigrationReportService(admin, {} as PdfRenderService);
}

function databaseHarness(seed: {
  items?: Array<Record<string, unknown>>;
  mappings?: Array<Record<string, unknown>>;
  run?: Record<string, unknown>;
  targets?: Record<string, Array<Record<string, unknown>>>;
}) {
  const calls: Array<{
    table: string;
    filters: Record<string, unknown>;
    range?: [number, number];
    count?: boolean;
  }> = [];
  const run = {
    id: 'run-1',
    organization_id: 'org-1',
    job_id: 'job-1',
    connection_id: 'connection-1',
    mode: 'live',
    status: 'succeeded',
    current_stage: null,
    stage_index: 1,
    config_snapshot: {},
    totals: {},
    correlation_id: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    error_message: null,
    created_by: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...seed.run,
  };

  class Query implements PromiseLike<unknown> {
    private readonly filters: Record<string, unknown> = {};
    private selectedCount = false;
    private selectedRange?: [number, number];

    constructor(private readonly table: string) {}

    select(_columns: string, options?: { count?: string }) {
      this.selectedCount = options?.count === 'exact';
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    }

    in(column: string, value: unknown[]) {
      this.filters[column] = value;
      return this;
    }

    order() {
      return this;
    }

    limit() {
      return this;
    }

    range(from: number, to: number) {
      this.selectedRange = [from, to];
      return this;
    }

    maybeSingle() {
      this.record();
      const found =
        this.filters.organization_id === run.organization_id &&
        this.filters.id === run.id;
      return Promise.resolve({ data: found ? run : null, error: null });
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?:
        | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): PromiseLike<TResult1 | TResult2> {
      this.record();
      const source =
        this.table === 'migration_run_items'
          ? (seed.items ?? [])
          : this.table === 'migration_entity_map'
            ? (seed.mappings ?? [])
            : (seed.targets?.[this.table] ?? []);
      const filtered = source.filter((row) =>
        Object.entries(this.filters).every(([key, value]) =>
          Array.isArray(value) ? value.includes(row[key]) : row[key] === value,
        ),
      );
      const data = this.selectedRange
        ? filtered.slice(this.selectedRange[0], this.selectedRange[1] + 1)
        : filtered;
      return Promise.resolve({
        data,
        error: null,
        count: this.selectedCount ? filtered.length : null,
      }).then(onfulfilled, onrejected);
    }

    private record() {
      calls.push({
        table: this.table,
        filters: { ...this.filters },
        range: this.selectedRange,
        count: this.selectedCount,
      });
    }
  }

  return {
    query: (table: string) => new Query(table),
    callsFor: (table: string) => calls.filter((call) => call.table === table),
  };
}
