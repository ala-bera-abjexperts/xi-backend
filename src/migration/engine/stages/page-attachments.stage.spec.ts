jest.mock('../../transformers/content-transform.service', () => ({
  ContentTransformService: class ContentTransformService {},
}));

import {
  canonicalSourceAttachmentDate,
  PageAttachmentsStage,
} from './page-attachments.stage';
import type { StageContext } from './stage.interface';
import type { WikiService } from '../../../wiki/wiki.service';
import type { ContentTransformService } from '../../transformers/content-transform.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';

const ORG = 'org-1';
const CONNECTION = 'connection-1';
const SPACE = 'space-1';
const PAGE = 'page-1';
const SOURCE_DATE = '2024-02-29T00:00:00.000Z';

function item(
  created: string | undefined = '2024-02-29T23:45:00+11:00',
  file?: { filename: string; mimeType: string },
) {
  return {
    payload: {
      pageSourceId: 'source-page-1',
      attachment: {
        sourceId: 'source-attachment-1',
        filename: file?.filename ?? 'handbook.pdf',
        mimeType: file?.mimeType ?? 'application/pdf',
        downloadUrl: 'https://confluence.test/download/handbook.pdf',
        sizeBytes: 16,
        ...(created === undefined ? {} : { created }),
      },
    },
  } as unknown as Parameters<PageAttachmentsStage['processItem']>[1];
}

function harness(
  options: {
    existing?: Record<string, unknown> | null;
    physicalExisting?: Record<string, unknown> | null;
    pageExists?: boolean;
    repair?: boolean;
    createdAt?: string;
    mappingError?: Error;
  } = {},
) {
  const wiki = {
    createAttachment: jest.fn().mockResolvedValue({
      id: 'attachment-1',
      file_path: 'https://storage.test/handbook.pdf',
    }),
    getAttachmentCreatedAt: jest
      .fn()
      .mockResolvedValue(options.createdAt ?? '2026-01-01T10:00:00.000Z'),
    updateAttachmentCreatedAt: jest.fn().mockResolvedValue(undefined),
    repairAttachmentContentType: jest.fn().mockResolvedValue(true),
    deleteAttachment: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<
    Pick<
      WikiService,
      | 'createAttachment'
      | 'getAttachmentCreatedAt'
      | 'updateAttachmentCreatedAt'
      | 'repairAttachmentContentType'
      | 'deleteAttachment'
    >
  >;
  const entityMap = {
    getTarget: jest.fn(
      (_org: string, _connection: string, entityType: string) => {
        if (entityType === 'page_attachment') return options.existing ?? null;
        if (entityType === 'page') {
          return { status: 'mapped', target_id: PAGE, metadata: {} };
        }
        if (entityType === 'space') {
          return { status: 'mapped', target_id: SPACE, metadata: {} };
        }
        return null;
      },
    ),
    getExistingWikiPageTarget: jest.fn(
      (_org: string, _connection: string, sourceId: string, spaceId: string) =>
        Promise.resolve(
          options.pageExists !== false &&
            sourceId === 'source-page-1' &&
            spaceId === SPACE
            ? { status: 'mapped', target_id: PAGE, metadata: {} }
            : null,
        ),
    ),
    getExistingWikiChildTarget: jest.fn(
      (
        _org: string,
        _connection: string,
        entityType: string,
        _sourceId: string,
        _table: string,
        pageId: string,
      ) =>
        Promise.resolve(
          entityType === 'page_attachment' && pageId === PAGE
            ? Object.prototype.hasOwnProperty.call(options, 'physicalExisting')
              ? (options.physicalExisting ?? null)
              : (options.existing ?? null)
            : null,
        ),
    ),
    deleteExactStaleMapping: jest.fn().mockResolvedValue(undefined),
    recordMapping: options.mappingError
      ? jest.fn().mockRejectedValue(options.mappingError)
      : jest.fn().mockResolvedValue(undefined),
  };
  const ctx = {
    orgId: ORG,
    dryRun: false,
    run: {
      id: 'run-1',
      config_snapshot: options.repair ? { repair_of_run_id: 'source-run' } : {},
      created_by: 'user-1',
    },
    job: {
      id: 'job-1',
      connection_id: CONNECTION,
      source_ref: 'DOCS',
      scope: { include_attachments: true },
    },
    entityMap,
    getAdapter: jest.fn().mockResolvedValue({
      product: 'confluence',
      getAttachmentBytes: jest.fn().mockResolvedValue({
        data: Buffer.from('attachment bytes'),
        contentType: 'application/pdf',
        size: 16,
      }),
      getPageBody: jest.fn().mockResolvedValue({ value: '<p />' }),
    }),
    getSourceBaseUrl: jest
      .fn()
      .mockResolvedValue('https://wiki.test/confluence'),
    log: jest.fn().mockResolvedValue(undefined),
  } as unknown as StageContext;
  const legacyWordPreview = {
    convert: jest.fn().mockResolvedValue(Buffer.from('PK\x03\x04preview')),
  };
  const content = {
    renderBodyAsTipTap: jest.fn().mockResolvedValue({
      content: JSON.stringify({ type: 'doc', content: [] }),
      unresolvedAttachmentRefs: [],
    }),
    renderExcerptAsTipTap: jest.fn().mockResolvedValue(null),
  };
  const stage = new PageAttachmentsStage(
    wiki as unknown as WikiService,
    content as unknown as ContentTransformService,
    {
      getClient: jest.fn(() => ({
        from: jest.fn(() => ({
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    content: JSON.stringify({ type: 'doc', content: [] }),
                  },
                }),
              })),
            })),
          })),
        })),
      })),
    } as unknown as SupabaseAdminService,
    legacyWordPreview as never,
  );

  return { ctx, entityMap, stage, wiki, legacyWordPreview, content };
}

describe('canonicalSourceAttachmentDate', () => {
  it('retains the source calendar day at UTC midnight', () => {
    expect(canonicalSourceAttachmentDate('2024-02-29T23:45:00+11:00')).toBe(
      SOURCE_DATE,
    );
  });

  it.each([undefined, 'not-a-date', '2024-02-30T10:00:00Z'])(
    'rejects unusable source timestamps',
    (value) => {
      expect(canonicalSourceAttachmentDate(value)).toBeNull();
    },
  );
});

describe('PageAttachmentsStage source dates', () => {
  it('passes the canonical source date on a new attachment and records it in the mapping', async () => {
    const h = harness();

    await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
      kind: 'created',
      targetId: 'attachment-1',
    });

    expect(h.wiki.createAttachment).toHaveBeenCalledWith(
      PAGE,
      SPACE,
      expect.any(Object),
      'user-1',
      SOURCE_DATE,
    );
    expect(h.entityMap.recordMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'attachment-1',
        metadata: expect.objectContaining({
          source_created_date: SOURCE_DATE,
        }),
      }),
    );
  });

  it('uses the database default when the source timestamp is unusable', async () => {
    const h = harness();

    await h.stage.processItem(h.ctx, item('not-a-date'));

    expect(h.wiki.createAttachment).toHaveBeenCalledWith(
      PAGE,
      SPACE,
      expect.any(Object),
      'user-1',
      undefined,
    );
    expect(h.entityMap.recordMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          source_created_date: expect.anything(),
        }),
      }),
    );
  });

  it('backfills a mapped attachment during repair without uploading it again', async () => {
    const h = harness({
      repair: true,
      existing: {
        status: 'mapped',
        target_id: 'attachment-1',
        metadata: { filename: 'handbook.pdf' },
      },
    });

    await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
      kind: 'updated',
      targetId: 'attachment-1',
    });

    expect(h.wiki.createAttachment).not.toHaveBeenCalled();
    expect(h.wiki.getAttachmentCreatedAt).toHaveBeenCalledWith(
      PAGE,
      SPACE,
      'attachment-1',
    );
    expect(h.wiki.updateAttachmentCreatedAt).toHaveBeenCalledWith(
      PAGE,
      SPACE,
      'attachment-1',
      SOURCE_DATE,
    );
  });

  it('does not replace a date already recorded as the source date', async () => {
    const h = harness({
      repair: true,
      existing: {
        status: 'mapped',
        target_id: 'attachment-1',
        // Both facts already recorded: a repair has nothing left to backfill here.
        metadata: {
          source_created_date: SOURCE_DATE,
          source_attachment_id: 'att-1',
        },
      },
    });

    await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
      kind: 'skipped',
    });

    expect(h.wiki.getAttachmentCreatedAt).not.toHaveBeenCalled();
    expect(h.wiki.updateAttachmentCreatedAt).not.toHaveBeenCalled();
    expect(h.entityMap.recordMapping).not.toHaveBeenCalled();
  });

  it('reclassifies a wrong Office MIME during repair without re-uploading the file', async () => {
    const h = harness({
      repair: true,
      existing: {
        status: 'mapped',
        target_id: 'attachment-1',
        // Date already recorded: the only remaining repair work is the MIME.
        metadata: {
          source_created_date: SOURCE_DATE,
          source_attachment_id: 'att-1',
        },
      },
    });

    await expect(
      h.stage.processItem(
        h.ctx,
        item(undefined, {
          filename: 'handbook.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'updated',
      targetId: 'attachment-1',
    });

    expect(h.wiki.repairAttachmentContentType).toHaveBeenCalledWith(
      PAGE,
      SPACE,
      'attachment-1',
      'handbook.docx',
    );
    expect(h.wiki.createAttachment).not.toHaveBeenCalled();
    expect(h.entityMap.recordMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ mime_reconciled: true }),
      }),
    );
  });

  it('does not repeat a MIME reconciliation already recorded as done', async () => {
    const h = harness({
      repair: true,
      existing: {
        status: 'mapped',
        target_id: 'attachment-1',
        metadata: {
          source_created_date: SOURCE_DATE,
          source_attachment_id: 'att-1',
          mime_reconciled: true,
        },
      },
    });

    await expect(
      h.stage.processItem(
        h.ctx,
        item(undefined, {
          filename: 'handbook.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
        }),
      ),
    ).resolves.toMatchObject({ kind: 'skipped' });

    expect(h.wiki.repairAttachmentContentType).not.toHaveBeenCalled();
  });

  it('preserves an already-correct target date while backfilling mapping metadata', async () => {
    const h = harness({
      repair: true,
      createdAt: '2024-02-29T18:45:00.000Z',
      existing: {
        status: 'mapped',
        target_id: 'attachment-1',
        metadata: {},
      },
    });

    await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
      kind: 'updated',
    });

    expect(h.wiki.updateAttachmentCreatedAt).not.toHaveBeenCalled();
    expect(h.entityMap.recordMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source_created_date: SOURCE_DATE,
        }),
      }),
    );
  });

  it('creates a DOCX preview derivative for a legacy DOC and records its browser-safe URL', async () => {
    const h = harness();
    const docItem = item() as { payload: { attachment: { filename: string } } };
    docItem.payload.attachment.filename = 'legacy.doc';
    (h.wiki.createAttachment as jest.Mock).mockResolvedValue({
      id: 'attachment-1',
      file_path: 'https://storage.test/legacy.doc',
      preview_file_path: 'https://storage.test/legacy.docx',
    });

    await h.stage.processItem(h.ctx, docItem as never);

    expect(h.legacyWordPreview.convert).toHaveBeenCalledWith(
      Buffer.from('attachment bytes'),
    );
    expect(h.wiki.createAttachment).toHaveBeenCalledWith(
      PAGE,
      SPACE,
      expect.any(Object),
      'user-1',
      SOURCE_DATE,
      expect.objectContaining({ filename: 'legacy.docx' }),
    );
    expect(h.entityMap.recordMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          preview_url: 'https://storage.test/legacy.docx',
        }),
      }),
    );
  });

  it('rerenders an already mapped attachment on a normal retry', async () => {
    const h = harness({
      existing: { status: 'mapped', target_id: 'attachment-1', metadata: {} },
    });

    await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
      kind: 'skipped',
      reason: 'attachment already migrated and page relinked',
    });
    expect(h.wiki.createAttachment).not.toHaveBeenCalled();
    for (const render of [
      h.content.renderBodyAsTipTap,
      h.content.renderExcerptAsTipTap,
    ])
      expect(render).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sourcePageUrl:
            'https://wiki.test/confluence/pages/viewpage.action?pageId=source-page-1',
        }),
      );
  });

  it('compensates only its newly created attachment when crosswalk recording fails', async () => {
    const h = harness({ mappingError: new Error('crosswalk unavailable') });

    await expect(h.stage.processItem(h.ctx, item())).rejects.toThrow(
      'crosswalk unavailable',
    );
    expect(h.wiki.deleteAttachment).toHaveBeenCalledWith('attachment-1', PAGE);
  });

  it('blocks on a missing owning page without downloading attachment bytes', async () => {
    const h = harness({ pageExists: false });

    await expect(h.stage.processItem(h.ctx, item())).resolves.toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'page', sourceId: 'source-page-1' },
    });
    const adapter = await h.ctx.getAdapter();
    expect(adapter.getAttachmentBytes).not.toHaveBeenCalled();
    expect(h.wiki.createAttachment).not.toHaveBeenCalled();
  });

  it('removes a stale attachment mapping before recreating its missing target', async () => {
    const stale = {
      status: 'mapped',
      target_id: 'attachment-deleted',
      metadata: {},
    };
    const h = harness({ existing: stale, physicalExisting: null });

    await expect(h.stage.processItem(h.ctx, item())).resolves.toMatchObject({
      kind: 'created',
      targetId: 'attachment-1',
    });
    expect(h.entityMap.deleteExactStaleMapping).toHaveBeenCalledWith(
      ORG,
      CONNECTION,
      'page_attachment',
      'source-page-1:handbook.pdf',
      'attachment-deleted',
    );
    expect(h.wiki.createAttachment).toHaveBeenCalledTimes(1);
  });

  it('fails retry visibly when the typed render result still reports the attachment unresolved', async () => {
    const h = harness();
    h.content.renderBodyAsTipTap.mockResolvedValue({
      content: JSON.stringify({ type: 'doc', content: [] }),
      unresolvedAttachmentRefs: ['handbook.pdf'],
    });

    await expect(h.stage.processItem(h.ctx, item())).rejects.toThrow(
      'remains unresolved',
    );
  });

  it('keeps a converter timeout retryable and creates no attachment', async () => {
    const h = harness();
    const docItem = item() as { payload: { attachment: { filename: string } } };
    docItem.payload.attachment.filename = 'legacy.doc';
    h.legacyWordPreview.convert.mockRejectedValueOnce(
      new Error('Legacy Word conversion failed: timed out'),
    );

    await expect(
      h.stage.processItem(h.ctx, docItem as never),
    ).rejects.toMatchObject({
      errorClass: 'transient',
    });
    expect(h.wiki.createAttachment).not.toHaveBeenCalled();
  });

  it.each([
    'Legacy Word file has an invalid DOC signature',
    'Legacy Word preview converter is unavailable',
    'Legacy Word conversion produced no DOCX preview',
    'Legacy Word conversion produced an invalid DOCX preview',
    'Legacy Word file exceeds the preview conversion limit',
  ])(
    'fails non-recoverable DOC conversion errors permanently: %s',
    async (message) => {
      const h = harness();
      const docItem = item() as {
        payload: { attachment: { filename: string } };
      };
      docItem.payload.attachment.filename = 'legacy.doc';
      h.legacyWordPreview.convert.mockRejectedValueOnce(new Error(message));

      await expect(
        h.stage.processItem(h.ctx, docItem as never),
      ).rejects.toMatchObject({
        errorClass: 'permanent',
      });
      expect(h.wiki.createAttachment).not.toHaveBeenCalled();
    },
  );

  it('propagates a repair lookup failure without replacing the mapping', async () => {
    const h = harness({
      repair: true,
      existing: {
        status: 'mapped',
        target_id: 'attachment-1',
        metadata: {},
      },
    });
    h.wiki.getAttachmentCreatedAt.mockRejectedValueOnce(
      new Error('attachment lookup failed'),
    );

    await expect(h.stage.processItem(h.ctx, item())).rejects.toThrow(
      'attachment lookup failed',
    );

    expect(h.wiki.updateAttachmentCreatedAt).not.toHaveBeenCalled();
    expect(h.entityMap.recordMapping).not.toHaveBeenCalled();
  });

  it('propagates a repair update failure without replacing the mapping', async () => {
    const h = harness({
      repair: true,
      existing: {
        status: 'mapped',
        target_id: 'attachment-1',
        metadata: {},
      },
    });
    h.wiki.updateAttachmentCreatedAt.mockRejectedValueOnce(
      new Error('attachment update failed'),
    );

    await expect(h.stage.processItem(h.ctx, item())).rejects.toThrow(
      'attachment update failed',
    );

    expect(h.entityMap.recordMapping).not.toHaveBeenCalled();
  });
});

it('classifies an invalid Content-Type header as permanent', async () => {
  const h = harness();
  h.wiki.createAttachment.mockRejectedValue(
    new Error('Invalid Content-Type header'),
  );
  await expect(h.stage.processItem(h.ctx, item())).rejects.toMatchObject({
    errorClass: 'permanent',
  });
});
