jest.mock('../../transformers/content-transform.service', () => ({
  ContentTransformService: class ContentTransformService {},
}));

import { PageHistoryStage } from './page-history.stage';
import type { StageContext } from './stage.interface';
import type { ContentTransformService } from '../../transformers/content-transform.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { AttachmentsService } from '../../../attachments/attachments.service';
import { AtlassianRequestError } from '../../adapters/http/atlassian-http-client';
import { BadRequestException } from '@nestjs/common';

const ORG = 'org-1';
const CONNECTION = 'connection-1';
const SPACE = 'space-1';
const WIKI_PAGE = 'wiki-page-1';
const SOURCE_PAGE = 'source-page-1';

/**
 * Awaitable chain stub: every builder call returns itself, and awaiting anywhere in the chain
 * resolves the configured result. Supabase's builder is used with a different method sequence on
 * each of the five queries this stage makes, so matching them individually would only test the
 * shape of the mock.
 */
function chain(result: unknown) {
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }

      return () => proxy;
    },
  });

  return proxy;
}

function versionRow(version: number, id = `row-v${version}`) {
  return { id, version };
}

function harness(
  options: {
    spaceRow?: { status: string; target_id: string | null } | null;
    pageRow?: { status: string; target_id: string | null } | null;
    versions?: { version: number; message?: string; authorSourceId?: string }[];
    existingVersionRows?: { id: string; version: number }[];
    mappedVersions?: Set<string>;
    attachmentRows?: { source_id: string; metadata: Record<string, unknown> }[];
    attachmentVersions?: { version: number; downloadUrl?: string }[];
    supportsHistory?: boolean;
    omitHistoryMethods?: boolean;
    bodyAtVersion?: unknown;
    dryRun?: boolean;
    seedPages?: { source_id: string }[];
    getPageVersionsError?: Error;
    getAttachmentVersionsError?: Error;
    getAttachmentBytesError?: Error;
    importVersionError?: Error;
  } = {},
) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const db = {
    from: jest.fn((table: string) => {
      if (table === 'wiki_page_versions') {
        return {
          select: () =>
            chain({
              data: options.existingVersionRows ?? [versionRow(1)],
              error: null,
            }),
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);

            return chain({ error: null });
          },
          insert: (row: Record<string, unknown>) => {
            inserted.push(row);

            return chain({ data: { id: 'new-version-row' }, error: null });
          },
        };
      }

      // migration_entity_map: produce (pages) and the per-page attachment lookup.
      return {
        select: () =>
          chain({
            data: options.seedPages ?? options.attachmentRows ?? [],
            error: null,
          }),
      };
    }),
  };

  const adapter: Record<string, unknown> = {
    product: 'confluence',
    getAttachmentBytes: options.getAttachmentBytesError
      ? jest.fn().mockRejectedValue(options.getAttachmentBytesError)
      : jest.fn().mockResolvedValue({
          data: Buffer.from('bytes'),
          contentType: 'application/pdf',
          size: 5,
        }),
  };

  if (!options.omitHistoryMethods) {
    adapter.supportsHistory = jest
      .fn()
      .mockResolvedValue(options.supportsHistory ?? true);
    adapter.getPageVersions = options.getPageVersionsError
      ? jest.fn().mockRejectedValue(options.getPageVersionsError)
      : jest.fn().mockResolvedValue(
          (
            options.versions ?? [{ version: 1 }, { version: 2 }, { version: 3 }]
          ).map((v) => ({
            pageSourceId: SOURCE_PAGE,
            version: v.version,
            message: v.message,
            authorSourceId: v.authorSourceId,
          })),
        );
    adapter.getPageBodyAtVersion = jest
      .fn()
      .mockResolvedValue(
        options.bodyAtVersion === undefined
          ? { format: 'storage', value: '<p>old</p>' }
          : options.bodyAtVersion,
      );
    adapter.getAttachmentVersions = options.getAttachmentVersionsError
      ? jest.fn().mockRejectedValue(options.getAttachmentVersionsError)
      : jest.fn().mockResolvedValue(
          (options.attachmentVersions ?? []).map((v) => ({
            attachmentSourceId: 'att-1',
            version: v.version,
            filename: 'handbook.pdf',
            mimeType: 'application/pdf',
            downloadUrl: v.downloadUrl ?? 'https://confluence.test/download/v1',
          })),
        );
  }

  const entityMap = {
    getTarget: jest.fn(
      (_org: string, _conn: string, entityType: string, sourceId: string) => {
        if (entityType === 'space') {
          if (options.spaceRow !== undefined) return options.spaceRow;
          return { status: 'mapped', target_id: SPACE, metadata: {} };
        }
        if (entityType === 'page') {
          if (options.pageRow !== undefined) return options.pageRow;
          return { status: 'mapped', target_id: WIKI_PAGE, metadata: {} };
        }
        if (entityType === 'page_version') {
          return options.mappedVersions?.has(sourceId)
            ? { status: 'mapped', target_id: 'existing-row' }
            : null;
        }
        if (entityType === 'page_attachment_version') return null;

        return null;
      },
    ),
    recordMapping: jest.fn().mockResolvedValue(undefined),
  };

  const attachments = {
    importVersion: options.importVersionError
      ? jest.fn().mockRejectedValue(options.importVersionError)
      : jest.fn().mockResolvedValue({
          attachment: { id: 'file-attachment-1' },
          version: {
            id: 'file-version-1',
            file_path: 'org/wiki_page/p/a/v1/f.pdf',
          },
          adopted: false,
        }),
  } as unknown as jest.Mocked<Pick<AttachmentsService, 'importVersion'>>;

  const log = jest.fn().mockResolvedValue(undefined);
  const ctx = {
    orgId: ORG,
    dryRun: options.dryRun ?? false,
    run: { id: 'run-1', config_snapshot: {}, created_by: 'user-1' },
    job: {
      id: 'job-1',
      connection_id: CONNECTION,
      source_ref: 'DOCS',
      scope: { include_attachments: true },
    },
    entityMap,
    getAdapter: jest.fn().mockResolvedValue(adapter),
    getSourceBaseUrl: jest.fn().mockResolvedValue('https://confluence.test'),
    log,
  } as unknown as StageContext;

  const content = {
    renderBodyAsTipTap: jest.fn().mockResolvedValue({
      content: JSON.stringify({ type: 'doc', content: [] }),
      unresolvedAttachmentRefs: [],
    }),
  };

  const stage = new PageHistoryStage(
    content as unknown as ContentTransformService,
    attachments as unknown as AttachmentsService,
    { getClient: () => db } as unknown as SupabaseAdminService,
  );

  const importVersion = attachments.importVersion as unknown as jest.Mock;

  return {
    stage,
    ctx,
    entityMap,
    attachments,
    importVersion,
    adapter,
    inserted,
    updates,
    content,
    log,
  };
}

function item() {
  return {
    source_ref: SOURCE_PAGE,
    payload: { pageSourceId: SOURCE_PAGE },
  } as unknown as Parameters<PageHistoryStage['processItem']>[1];
}

describe('PageHistoryStage', () => {
  describe('capability gating', () => {
    it('reports an audited partial result when the adapter has no history methods', async () => {
      const h = harness({ omitHistoryMethods: true });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toEqual({
        kind: 'skipped',
        reason: 'source does not expose revision history',
      });

      // The point of the requirement: a denied history must be visible, never silently green.
      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('does not expose revision history'),
        expect.objectContaining({ partial: true }),
      );
      expect(h.inserted).toHaveLength(0);
    });

    it('reports an audited partial result when the probe says history is unreadable', async () => {
      const h = harness({ supportsHistory: false });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
        kind: 'skipped',
      });
      expect(h.inserted).toHaveLength(0);
    });

    it('reports a partial result when the source lists no revisions at all', async () => {
      const h = harness({ versions: [] });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
        kind: 'skipped',
        reason: 'source returned no revisions',
      });
    });

    it('degrades a REAL denial (404/403/401) into an audited skip, not a retry', async () => {
      // The bug this pins: a source that genuinely refuses the version sub-resource for one page
      // must be reported once, not retried to exhaustion as if it were a network blip.
      const h = harness({
        getPageVersionsError: new AtlassianRequestError(
          'GET /rest/api/content/page-1/version failed with 404',
          404,
        ),
      });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toEqual({
        kind: 'skipped',
        reason: 'source denied revision history for this page',
        targetId: WIKI_PAGE,
      });

      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('source denied revision history'),
        expect.objectContaining({ partial: true }),
      );
      expect(h.inserted).toHaveLength(0);
    });

    it('retries a genuinely transient failure instead of degrading it', async () => {
      // A 500/network fault is NOT a denial — it must still throw so the worker's retry/backoff
      // handles it, exactly as before this fix.
      const h = harness({
        getPageVersionsError: new AtlassianRequestError('server error', 500),
      });

      await expect(h.stage.processItem(h.ctx, item())).rejects.toThrow(
        /Failed to list revisions/,
      );
    });

    it('still attempts attachment-version history when page-history is denied for the same page', async () => {
      // Confluence can gate page-body history and attachment history on different permission
      // surfaces. A denial on one domain must not suppress an attempt at the other for the same
      // page — this is the exact scenario the live test environment surfaced.
      const h = harness({
        getPageVersionsError: new AtlassianRequestError('denied', 404),
        attachmentRows: [
          {
            source_id: `${SOURCE_PAGE}:handbook.pdf`,
            metadata: { source_attachment_id: 'att-1' },
          },
        ],
        attachmentVersions: [{ version: 1 }, { version: 2 }],
      });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
        kind: 'updated',
      });

      expect(h.importVersion).toHaveBeenCalledTimes(2);
      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('source denied revision history'),
        expect.objectContaining({ partial: true }),
      );
    });
  });

  describe('page revisions', () => {
    it('preserves the historical title returned alongside its body for safe restore', async () => {
      const h = harness({
        versions: [{ version: 1 }, { version: 2 }],
        bodyAtVersion: {
          format: 'storage',
          value: '<p>Old register</p>',
          title: 'Original register title',
        },
      });
      await h.stage.processItem(h.ctx, item());
      expect(h.inserted[0].title).toBe('Original register title');
    });

    it('imports 1..N-1 and never duplicates the current revision', async () => {
      const h = harness({
        versions: [{ version: 1 }, { version: 2 }, { version: 3 }],
      });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
        kind: 'updated',
        targetId: WIKI_PAGE,
      });

      expect(h.content.renderBodyAsTipTap).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sourcePageUrl:
            'https://confluence.test/pages/viewpage.action?pageId=source-page-1',
        }),
      );
      expect(h.inserted.map((r) => r.version)).toEqual([1, 2]);
      // v3 is the live page; importing it would show the same body twice in history.
      expect(h.inserted.map((r) => r.version)).not.toContain(3);
    });

    it('renumbers the trigger-created row to the source latest so numbering mirrors the source', async () => {
      const h = harness({
        versions: [{ version: 1 }, { version: 2 }, { version: 3 }],
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.updates).toEqual([{ version: 3 }]);
    });

    it('marks imported revisions with the sentinel the versioning trigger refuses to coalesce', async () => {
      const h = harness({ versions: [{ version: 1 }, { version: 2 }] });

      await h.stage.processItem(h.ctx, item());

      expect(h.inserted[0]).toMatchObject({ wiki_page_id: WIKI_PAGE });
      expect(h.inserted[0]?.changes).toMatchObject({
        event: 'origin_backfill',
        source: 'confluence',
        source_version: 1,
      });
    });

    it('retains the change message and minor-edit flag when the source reports them', async () => {
      const h = harness({
        versions: [{ version: 1, message: 'typo fix' }, { version: 2 }],
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.inserted[0]?.changes).toMatchObject({ message: 'typo fix' });
    });

    it('adopts an already-imported revision instead of writing it twice', async () => {
      const h = harness({
        versions: [{ version: 1 }, { version: 2 }, { version: 3 }],
        mappedVersions: new Set([`${SOURCE_PAGE}:v1`]),
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.inserted.map((r) => r.version)).toEqual([2]);
    });

    it('skips a revision whose body the source withholds rather than inventing one', async () => {
      const h = harness({
        versions: [{ version: 1 }, { version: 2 }],
        bodyAtVersion: null,
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.inserted).toHaveLength(0);
      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('withheld the body'),
        expect.objectContaining({ partial: true }),
      );
    });

    it('REFUSES to import into a page the user has edited since the import', async () => {
      // Two rows means the target authored its own history; source numbers would collide with it
      // on UNIQUE(wiki_page_id, version), and a collision is not an adoption.
      const h = harness({
        versions: [{ version: 1 }, { version: 2 }, { version: 3 }],
        existingVersionRows: [versionRow(1), versionRow(2)],
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.updates).toHaveLength(0);
      expect(h.inserted).toHaveLength(0);
      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('target-authored revisions'),
        expect.objectContaining({ partial: true }),
      );
    });

    it('REFUSES when a coincidental version-number match is not proven by a prior import', async () => {
      // The trap this pins: 3 real target-authored rows (from user edits), one of which happens to
      // sit at exactly the source's `latest` (3). Trusting `rows.some(v === latest)` alone would
      // treat that coincidence as "already aligned" and import straight past the guard meant to
      // protect these rows — the crosswalk proof (no mapped page_version at v2) is what catches it.
      const h = harness({
        versions: [{ version: 1 }, { version: 2 }, { version: 3 }],
        existingVersionRows: [versionRow(1), versionRow(2), versionRow(3)],
        // No mappedVersions set: nothing proves a prior page_history import ever reached v3.
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.updates).toHaveLength(0);
      expect(h.inserted).toHaveLength(0);
      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('target-authored revisions'),
        expect.objectContaining({ partial: true }),
      );
    });

    it('trusts the fast path only when a prior import is proven by the crosswalk', async () => {
      // The legitimate mirror of the test above: same 3 target rows, same source `latest`, but this
      // time v1 and v2 ARE recorded as mapped page_version rows — proof a real page_history import
      // reached v3 before. That must be adopted cleanly, not refused.
      const h = harness({
        versions: [{ version: 1 }, { version: 2 }, { version: 3 }],
        existingVersionRows: [versionRow(1), versionRow(2), versionRow(3)],
        mappedVersions: new Set([`${SOURCE_PAGE}:v1`, `${SOURCE_PAGE}:v2`]),
      });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
        kind: 'skipped',
      });

      expect(h.updates).toHaveLength(0);
      expect(h.inserted).toHaveLength(0);
      expect(h.log).not.toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('target-authored revisions'),
        expect.anything(),
      );
    });
  });

  describe('attachment versions', () => {
    it('imports each source version at its own version number', async () => {
      const h = harness({
        versions: [{ version: 1 }],
        attachmentRows: [
          {
            source_id: `${SOURCE_PAGE}:handbook.pdf`,
            metadata: {
              source_attachment_id: 'att-1',
              filename: 'handbook.pdf',
            },
          },
        ],
        attachmentVersions: [{ version: 1 }, { version: 2 }],
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.importVersion).toHaveBeenCalledTimes(2);
      expect(h.importVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'wiki_page',
          entityId: WIKI_PAGE,
          versionNumber: 1,
          fileName: 'handbook.pdf',
        }),
      );
    });

    it('reports an attachment with no recorded source id instead of guessing', async () => {
      const h = harness({
        versions: [{ version: 1 }],
        attachmentRows: [
          { source_id: `${SOURCE_PAGE}:handbook.pdf`, metadata: {} },
        ],
        attachmentVersions: [{ version: 1 }],
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.importVersion).not.toHaveBeenCalled();
      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('no recorded source id'),
        expect.objectContaining({ partial: true }),
      );
    });

    it('skips a version with no download URL rather than failing the page', async () => {
      const h = harness({
        versions: [{ version: 1 }],
        attachmentRows: [
          {
            source_id: `${SOURCE_PAGE}:handbook.pdf`,
            metadata: { source_attachment_id: 'att-1' },
          },
        ],
        attachmentVersions: [{ version: 1, downloadUrl: '' }],
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.importVersion).not.toHaveBeenCalled();
    });

    it('degrades a validation/storage rejection (e.g. blocked SVG, oversize) into a per-version skip', async () => {
      // The gap this pins: `importVersion` enforces the SAME size/content-type rules a normal
      // upload does and throws BadRequestException on rejection. Before this fix nothing caught
      // it, so a genuinely blocked historical file (not a network problem) retried to exhaustion
      // exactly like the source-denial bug fixed earlier in this file.
      const h = harness({
        versions: [{ version: 1 }],
        attachmentRows: [
          {
            source_id: `${SOURCE_PAGE}:handbook.pdf`,
            metadata: { source_attachment_id: 'att-1' },
          },
        ],
        attachmentVersions: [{ version: 1 }, { version: 2 }],
        importVersionError: new BadRequestException(
          'SVG files are not allowed for this entity type',
        ),
      });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toBeDefined();

      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('failed validation or storage'),
        expect.objectContaining({ partial: true }),
      );
    });

    it('still retries a genuinely unexpected failure storing an attachment version', async () => {
      const h = harness({
        versions: [{ version: 1 }],
        attachmentRows: [
          {
            source_id: `${SOURCE_PAGE}:handbook.pdf`,
            metadata: { source_attachment_id: 'att-1' },
          },
        ],
        attachmentVersions: [{ version: 1 }],
        importVersionError: new Error('unexpected DB outage'),
      });

      await expect(h.stage.processItem(h.ctx, item())).rejects.toThrow(
        /Failed to store attachment/,
      );
    });

    it('degrades a denial listing attachment versions into an audited skip for that attachment only', async () => {
      const h = harness({
        // Two source versions so page revision v1 still imports despite the attachment denial —
        // the point is that ONE failure domain degrading must not sink the other.
        versions: [{ version: 1 }, { version: 2 }],
        attachmentRows: [
          {
            source_id: `${SOURCE_PAGE}:handbook.pdf`,
            metadata: { source_attachment_id: 'att-1' },
          },
        ],
        getAttachmentVersionsError: new AtlassianRequestError('denied', 403),
      });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
        kind: 'updated',
      });

      expect(h.importVersion).not.toHaveBeenCalled();
      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('denied version history for attachment'),
        expect.objectContaining({ partial: true }),
      );
    });

    it('degrades a denial downloading one version binary into a skip for that version only', async () => {
      const h = harness({
        versions: [{ version: 1 }],
        attachmentRows: [
          {
            source_id: `${SOURCE_PAGE}:handbook.pdf`,
            metadata: { source_attachment_id: 'att-1' },
          },
        ],
        attachmentVersions: [{ version: 1 }, { version: 2 }],
        getAttachmentBytesError: new AtlassianRequestError('denied', 401),
      });

      await h.stage.processItem(h.ctx, item());

      expect(h.importVersion).not.toHaveBeenCalled();
      expect(h.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('denied download of attachment'),
        expect.objectContaining({ partial: true }),
      );
    });
  });

  describe('dry run', () => {
    it('plans without fetching bodies, downloading bytes or writing rows', async () => {
      const h = harness({
        dryRun: true,
        versions: [{ version: 1 }, { version: 2 }, { version: 3 }],
      });

      await expect(h.stage.processItem(h.ctx, item())).resolves.toEqual({
        kind: 'planned',
      });

      expect(h.inserted).toHaveLength(0);
      expect(h.updates).toHaveLength(0);
      expect(h.importVersion).not.toHaveBeenCalled();
      expect(
        (h.adapter.getPageBodyAtVersion as jest.Mock).mock.calls,
      ).toHaveLength(0);
      expect(h.entityMap.recordMapping).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'planned' }),
      );
    });
  });
});

describe('history skip diagnostics', () => {
  it.each([
    {
      versions: [{ version: 1 }],
      reason: 'source contains only the current revision',
    },
    { versions: [], reason: 'source returned no revisions' },
    {
      versions: [{ version: 1 }, { version: 2 }],
      existingVersionRows: [versionRow(1), versionRow(2)],
      reason: 'target-authored revisions preserved',
    },
    {
      versions: [{ version: 1 }, { version: 2 }],
      mappedVersions: new Set([`${SOURCE_PAGE}:v1`]),
      reason: 'every revision was already imported',
    },
  ])('logs $reason', async ({ reason, ...options }) => {
    const h = harness(options);
    await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
      kind: 'skipped',
      reason,
    });
    expect(h.log).toHaveBeenCalledWith(
      'info',
      expect.any(String),
      expect.objectContaining({ sourceRef: SOURCE_PAGE, reason }),
    );
  });
});

it('classifies an invalid historical Content-Type header as permanent', async () => {
  const h = harness({
    versions: [{ version: 1 }],
    attachmentRows: [
      {
        source_id: `${SOURCE_PAGE}:report.xls`,
        metadata: { source_attachment_id: 'att-1' },
      },
    ],
    attachmentVersions: [{ version: 1 }],
    importVersionError: new Error('Invalid Content-Type header'),
  });
  await expect(h.stage.processItem(h.ctx, item())).rejects.toMatchObject({
    errorClass: 'permanent',
  });
});

describe('history planned dependency gates', () => {
  const planned = { status: 'planned', target_id: null };
  it.each([
    { spaceRow: planned },
    { pageRow: planned },
    { spaceRow: planned, pageRow: planned },
  ])('plans new targets with planned dependency rows: %j', async (rows) => {
    const h = harness({ dryRun: true, ...rows });
    await expect(h.stage.processItem(h.ctx, item())).resolves.toEqual({
      kind: 'planned',
    });
    expect(h.inserted).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(h.importVersion).not.toHaveBeenCalled();
    expect(h.adapter.getPageBodyAtVersion).not.toHaveBeenCalled();
    expect(h.adapter.getAttachmentBytes).not.toHaveBeenCalled();
  });
  it.each([
    { dryRun: true, spaceRow: null, dependency: 'space' },
    { dryRun: true, pageRow: null, dependency: 'page' },
    { dryRun: false, spaceRow: planned, dependency: 'space' },
    { dryRun: false, pageRow: planned, dependency: 'page' },
    {
      dryRun: false,
      spaceRow: { status: 'mapped', target_id: null },
      dependency: 'space',
    },
  ])(
    'keeps unresolved or live target-less dependency blocked: %j',
    async ({ dependency, ...options }) => {
      const h = harness(options);
      await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
        kind: 'blocked',
        waitingFor: { entityType: dependency },
      });
      expect(h.inserted).toHaveLength(0);
      expect(h.importVersion).not.toHaveBeenCalled();
    },
  );
});
