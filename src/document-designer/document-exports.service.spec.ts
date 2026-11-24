/* eslint-disable @typescript-eslint/unbound-method */
// (jest mock assertions on class methods are a known unbound-method false
// positive — same disable used by users/workflow-engine controller specs)

// jsdom's ESM dependency chain is not transformable under jest — mock the
// sanitizer with a faithful double (repo precedent: sanitize-rich-text mocks).
jest.mock('./rendering/html-sanitizer', () => ({
  sanitizeHtml: (html: string) => html,
  stripHtmlToText: (html: string) => html.replace(/<[^>]*>/g, '').trim(),
}));

// puppeteer 25 is ESM-only — mock it module-level so importing the pdf render
// service (a constructor dependency here) never loads the real package.
jest.mock('puppeteer', () => ({
  __esModule: true,
  default: { launch: jest.fn() },
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { DocumentExportRepository } from './document-export.repository';
import type { DocumentTemplateRepository } from './document-template.repository';
import type { DocumentDataResolverService } from './rendering/document-data-resolver.service';
import { DocumentImageResolverService } from './rendering/document-image-resolver.service';
import type { DocumentRenderService } from './rendering/document-render.service';
import type { DocxRenderService } from './rendering/docx-render.service';
import type { PdfRenderService } from './rendering/pdf-render.service';
import {
  DocumentExportsService,
  sanitizeFileName,
  type IDocumentExportParams,
} from './document-exports.service';

const ORG = 'org-1';
const USER = 'user-1';
const TEMPLATE_ID = '4ac500fd-a2b1-4eba-aa35-37e221d8a211';
const EXPORT_ID = 'export-1';

const validDefinition = {
  schemaVersion: 1,
  mode: 'repeat_per_item',
  sourceEntity: 'tasks',
  page: {
    size: 'A4',
    orientation: 'portrait',
    margins: { top: 48, right: 48, bottom: 48, left: 48 },
    pageBreakMargin: 24,
  },
  elements: [],
};

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    organization_id: ORG,
    name: 'Status Report',
    source_entity: 'tasks',
    mode: 'repeat_per_item',
    definition: validDefinition,
    is_archived: false,
    ...overrides,
  };
}

function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    organization_id: ORG,
    template_id: TEMPLATE_ID,
    template_name: 'Status Report',
    format: 'html',
    status: 'pending',
    file_path: null,
    ...overrides,
  };
}

function dataCtx(itemCount = 2) {
  return {
    items: Array.from({ length: itemCount }, (_, i) => ({
      id: `task-${i}`,
      entityType: 'task' as const,
      raw: { id: `task-${i}` },
    })),
    subtasksByItemId: {},
    linkedByItemId: {},
    dynamicQueryByRegionId: {},
    lookups: {
      usersById: {},
      statusesById: {},
      prioritiesById: {},
      spacesById: {},
      assetsById: {},
      tasksById: {},
      wikiPagesById: {},
      organizationName: 'Acme',
    },
    fieldDefsBySpace: {},
    orgFieldDefs: {},
    warnings: [],
  };
}

function params(
  overrides: Partial<IDocumentExportParams> = {},
): IDocumentExportParams {
  return {
    organizationId: ORG,
    userId: USER,
    templateId: TEMPLATE_ID,
    format: 'html',
    scope: { savedFilterId: 'filter-1' },
    source: 'manual',
    ...overrides,
  };
}

function imageElement(id: string, src: Record<string, unknown>) {
  return {
    id,
    type: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    positionMode: 'absolute',
    zIndex: 0,
    style: {},
    objectFit: 'contain',
    src,
  };
}

describe('DocumentExportsService', () => {
  let templateRepo: jest.Mocked<DocumentTemplateRepository>;
  let exportRepo: jest.Mocked<DocumentExportRepository>;
  let dataResolver: jest.Mocked<DocumentDataResolverService>;
  let renderService: jest.Mocked<DocumentRenderService>;
  let pdfService: jest.Mocked<PdfRenderService>;
  let docxService: jest.Mocked<DocxRenderService>;
  let storageBucket: {
    upload: jest.Mock;
    remove: jest.Mock;
    createSignedUrl: jest.Mock;
  };
  let service: DocumentExportsService;

  beforeEach(() => {
    templateRepo = {
      findById: jest.fn().mockResolvedValue(template()),
    } as unknown as jest.Mocked<DocumentTemplateRepository>;

    exportRepo = {
      insert: jest.fn().mockResolvedValue(exportRow()),
      update: jest
        .fn()
        .mockImplementation((_org: string, id: string, patch: object) =>
          Promise.resolve(exportRow({ id, ...patch })),
        ),
      findById: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    } as unknown as jest.Mocked<DocumentExportRepository>;

    dataResolver = {
      resolve: jest.fn().mockResolvedValue(dataCtx()),
    } as unknown as jest.Mocked<DocumentDataResolverService>;

    renderService = {
      render: jest
        .fn()
        .mockReturnValue({ html: '<html>doc</html>', warnings: [] }),
    } as unknown as jest.Mocked<DocumentRenderService>;

    pdfService = {
      renderPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7')),
    } as unknown as jest.Mocked<PdfRenderService>;

    docxService = {
      renderDocx: jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('PKdocx'), warnings: [] }),
    } as unknown as jest.Mocked<DocxRenderService>;

    storageBucket = {
      upload: jest.fn().mockResolvedValue({ data: {}, error: null }),
      remove: jest.fn().mockResolvedValue({ data: null, error: null }),
      createSignedUrl: jest.fn().mockResolvedValue({
        data: { signedUrl: 'https://signed.example/file' },
        error: null,
      }),
    };

    const supabaseAdmin = {
      getClient: jest.fn().mockReturnValue({
        storage: { from: jest.fn().mockReturnValue(storageBucket) },
      }),
    } as unknown as SupabaseAdminService;

    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    const imageResolver = new DocumentImageResolverService(
      supabaseAdmin,
      configService,
    );

    service = new DocumentExportsService(
      templateRepo,
      exportRepo,
      dataResolver,
      renderService,
      pdfService,
      docxService,
      supabaseAdmin,
      imageResolver,
    );
  });

  it('runs the row lifecycle pending → running → completed and uploads under org/exportId/', async () => {
    const result = await service.export(params());

    expect(exportRepo.insert).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ status: 'pending', requested_by: USER }),
    );
    expect(exportRepo.update).toHaveBeenNthCalledWith(
      1,
      ORG,
      EXPORT_ID,
      expect.objectContaining({ status: 'running' }),
    );
    expect(exportRepo.update).toHaveBeenNthCalledWith(
      2,
      ORG,
      EXPORT_ID,
      expect.objectContaining({ status: 'completed', item_count: 2 }),
    );
    const completedPatch = exportRepo.update.mock.calls[1][2];
    expect(typeof completedPatch['file_size_bytes']).toBe('number');

    const uploadCalls = storageBucket.upload.mock.calls as Array<
      [string, Buffer, { contentType: string }]
    >;
    const uploadPath = uploadCalls[0][0];
    expect(uploadPath.startsWith(`${ORG}/${EXPORT_ID}/`)).toBe(true);
    expect(uploadPath.endsWith('.html')).toBe(true);

    expect(result.mimeType).toBe('text/html');
    expect(result.buffer.toString()).toContain('doc');
  });

  it('routes pdf exports through the pdf renderer with the page dimensions', async () => {
    await service.export(params({ format: 'pdf' }));

    expect(pdfService.renderPdf).toHaveBeenCalledWith(
      '<html>doc</html>',
      { widthPx: 794, heightPx: 1123 },
      [],
    );
    const uploadCalls = storageBucket.upload.mock.calls as Array<
      [string, Buffer, { contentType: string }]
    >;
    expect(uploadCalls[0][2].contentType).toBe('application/pdf');
  });

  it('routes docx exports through the docx renderer', async () => {
    await service.export(params({ format: 'docx' }));

    expect(docxService.renderDocx).toHaveBeenCalled();
    expect(pdfService.renderPdf).not.toHaveBeenCalled();
    expect(renderService.render).not.toHaveBeenCalled();
  });

  it('marks the row failed (truncated error) and rethrows on resolver failure', async () => {
    const boom = new Error('x'.repeat(3000));
    dataResolver.resolve.mockRejectedValue(boom);

    await expect(service.export(params())).rejects.toBe(boom);

    const failCall = exportRepo.update.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === 'failed',
    );
    expect(failCall).toBeDefined();
    const patch = failCall![2] as { error: string };
    expect(patch.error).toHaveLength(2000);
  });

  it('rejects the third concurrent export for the same org with 429', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    dataResolver.resolve
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(dataCtx());
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = () => resolve(dataCtx());
          }),
      );

    const first = service.export(params());
    const second = service.export(params());
    await new Promise((resolve) => setImmediate(resolve));

    await expect(service.export(params())).rejects.toMatchObject({
      status: 429,
    });

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);

    // Slots released — a follow-up export succeeds again.
    await expect(service.export(params())).resolves.toBeDefined();
  });

  it('fails the export when the rendered HTML exceeds 10 MB', async () => {
    renderService.render.mockReturnValue({
      html: 'a'.repeat(10 * 1024 * 1024 + 1),
      warnings: [],
    });

    await expect(service.export(params())).rejects.toMatchObject({
      status: 500,
    });

    const failCall = exportRepo.update.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === 'failed',
    );
    expect(failCall).toBeDefined();
  });

  it('rejects a scope that does not provide exactly one selector', async () => {
    await expect(service.export(params({ scope: {} }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.export(
        params({
          scope: {
            savedFilterId: 'filter-1',
            ids: ['4ac500fd-a2b1-4eba-aa35-37e221d8a211'],
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(exportRepo.insert).not.toHaveBeenCalled();
  });

  it('rejects archived and missing templates without writing history', async () => {
    templateRepo.findById.mockResolvedValueOnce(
      template({ is_archived: true }) as never,
    );
    await expect(service.export(params())).rejects.toBeInstanceOf(
      BadRequestException,
    );

    templateRepo.findById.mockResolvedValueOnce(null);
    await expect(service.export(params())).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(exportRepo.insert).not.toHaveBeenCalled();
  });

  it('stays org-scoped: repos and resolver receive the caller organization id', async () => {
    await service.export(params());

    expect(templateRepo.findById).toHaveBeenCalledWith(ORG, TEMPLATE_ID);
    expect(exportRepo.insert).toHaveBeenCalledWith(ORG, expect.any(Object));
    expect(dataResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, userId: USER }),
    );
  });

  it('returns a 60s signed URL for stored exports via getDownloadInfo', async () => {
    exportRepo.findById.mockResolvedValue(
      exportRow({
        status: 'completed',
        format: 'pdf',
        file_path: `${ORG}/${EXPORT_ID}/report.pdf`,
      }) as never,
    );

    const info = await service.getDownloadInfo(ORG, EXPORT_ID);

    expect(storageBucket.createSignedUrl).toHaveBeenCalledWith(
      `${ORG}/${EXPORT_ID}/report.pdf`,
      60,
    );
    expect(info).toEqual({
      signedUrl: 'https://signed.example/file',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('404s downloads whose file was purged or never produced', async () => {
    exportRepo.findById.mockResolvedValue(
      exportRow({ status: 'failed', file_path: null }) as never,
    );

    await expect(
      service.getDownloadInfo(ORG, EXPORT_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps repository totals to { data, count } for the history list', async () => {
    exportRepo.list.mockResolvedValue({
      data: [exportRow() as never],
      totalCount: 7,
    });

    const result = await service.list(ORG, { page: 1 });

    expect(exportRepo.list).toHaveBeenCalledWith(ORG, { page: 1 });
    expect(result.count).toBe(7);
    expect(result.data).toHaveLength(1);
  });

  it('never signs storage images outside the bucket allowlist / org folder — blanks them with a warning', async () => {
    templateRepo.findById.mockResolvedValue(
      template({
        definition: {
          ...validDefinition,
          elements: [
            imageElement('img-foreign-path', {
              kind: 'storage',
              bucket: 'attachments',
              path: 'org-2/confidential.png',
            }),
            imageElement('img-foreign-bucket', {
              kind: 'storage',
              bucket: 'site-studio-assets',
              path: `${ORG}/logo.png`,
            }),
            imageElement('img-ok', {
              kind: 'storage',
              bucket: 'attachments',
              path: `${ORG}/logo.png`,
            }),
          ],
        },
      }) as never,
    );

    const result = await service.export(params());

    // Only the conforming source reaches the service-role signer.
    expect(storageBucket.createSignedUrl).toHaveBeenCalledTimes(1);
    expect(storageBucket.createSignedUrl).toHaveBeenCalledWith(
      `${ORG}/logo.png`,
      300,
    );

    const renderOptions = renderService.render.mock.calls[0][2] as {
      resolveImageSrc: (src: unknown) => string;
    };
    expect(
      renderOptions.resolveImageSrc({
        kind: 'storage',
        bucket: 'attachments',
        path: 'org-2/confidential.png',
      }),
    ).toBe('');
    expect(
      renderOptions.resolveImageSrc({
        kind: 'storage',
        bucket: 'site-studio-assets',
        path: `${ORG}/logo.png`,
      }),
    ).toBe('');
    expect(
      renderOptions.resolveImageSrc({
        kind: 'storage',
        bucket: 'attachments',
        path: `${ORG}/logo.png`,
      }),
    ).toBe('https://signed.example/file');

    expect(result.warnings.some((w) => w.includes('img-foreign-path'))).toBe(
      true,
    );
    expect(result.warnings.some((w) => w.includes('img-foreign-bucket'))).toBe(
      true,
    );
    expect(result.warnings.some((w) => w.includes('img-ok'))).toBe(false);
  });

  it('strips a client-supplied extension so stored file names never double up', async () => {
    await service.export(
      params({ format: 'pdf', fileName: 'Quarterly Report.pdf' }),
    );

    const uploadCalls = storageBucket.upload.mock.calls as Array<[string]>;
    const uploadPath = uploadCalls[0][0];
    expect(uploadPath.endsWith('/Quarterly-Report.pdf')).toBe(true);
    expect(uploadPath.includes('.pdf.pdf')).toBe(false);
  });

  it('removes the uploaded file when the post-upload row update fails', async () => {
    const dbErr = new Error('transient db failure');
    exportRepo.update.mockImplementation(
      (_org: string, id: string, patch: object) => {
        if ((patch as { status?: string }).status === 'completed') {
          return Promise.reject(dbErr);
        }

        return Promise.resolve(exportRow({ id, ...patch }) as never);
      },
    );

    await expect(service.export(params())).rejects.toBe(dbErr);

    const uploadCalls = storageBucket.upload.mock.calls as Array<[string]>;
    const uploadPath = uploadCalls[0][0];
    expect(storageBucket.remove).toHaveBeenCalledWith([uploadPath]);

    const failCall = exportRepo.update.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === 'failed',
    );
    expect(failCall).toBeDefined();
  });

  it('threads the requester restriction down to the repository for history reads', async () => {
    exportRepo.findById.mockResolvedValue(
      exportRow({
        status: 'completed',
        format: 'pdf',
        file_path: `${ORG}/${EXPORT_ID}/report.pdf`,
      }) as never,
    );

    await service.getById(ORG, EXPORT_ID, USER);
    expect(exportRepo.findById).toHaveBeenCalledWith(ORG, EXPORT_ID, USER);

    await service.getDownloadInfo(ORG, EXPORT_ID, USER);
    expect(exportRepo.findById).toHaveBeenLastCalledWith(ORG, EXPORT_ID, USER);
  });

  it("404s another user's export when the requester restriction filters it out", async () => {
    exportRepo.findById.mockResolvedValue(null);

    await expect(
      service.getById(ORG, EXPORT_ID, 'someone-else'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('sanitizeFileName', () => {
    it('strips reserved characters and collapses whitespace', () => {
      expect(sanitizeFileName('My: Report / "v2" <final>?', 'fallback')).toBe(
        'My-Report-v2-final',
      );
    });

    it('caps at 120 characters and falls back when empty', () => {
      expect(sanitizeFileName('x'.repeat(200), 'fallback')).toHaveLength(120);
      expect(sanitizeFileName('///', 'Fall Back')).toBe('Fall-Back');
      expect(sanitizeFileName(undefined, '???')).toBe('document-export');
    });
  });
});
