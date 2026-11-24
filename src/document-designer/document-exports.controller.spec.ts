/* eslint-disable @typescript-eslint/unbound-method */
// (jest mock assertions on class methods are a known unbound-method false
// positive — same disable used by users/workflow-engine controller specs)

// jsdom's ESM dependency chain is not transformable under jest — mock the
// sanitizer with a faithful double (repo precedent: sanitize-rich-text mocks).
jest.mock('./rendering/html-sanitizer', () => ({
  sanitizeHtml: (html: string) => html,
  stripHtmlToText: (html: string) => html.replace(/<[^>]*>/g, '').trim(),
}));

// puppeteer 25 is ESM-only — mock it module-level so the service import chain
// (controller → exports service → pdf render service) never loads it.
jest.mock('puppeteer', () => ({
  __esModule: true,
  default: { launch: jest.fn() },
}));

import 'reflect-metadata';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { REQUIRE_FEATURE_KEY } from '../auth/decorators/require-feature.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/require-permissions.decorator';
import { DocumentExportsController } from './document-exports.controller';
import type { DocumentExportsService } from './document-exports.service';
import type { DocumentWikiPushService } from './document-wiki-push.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { Response } from 'express';

runControllerContractSuite({
  controller: DocumentExportsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('DocumentExportsController manual behavior', () => {
  let controller: DocumentExportsController;
  let service: jest.Mocked<DocumentExportsService>;
  let permissionsService: jest.Mocked<PermissionsService>;
  let wikiPushService: jest.Mocked<DocumentWikiPushService>;

  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@example.com',
  } as RequestUser;

  const templateId = '4ac500fd-a2b1-4eba-aa35-37e221d8a211';

  function mockResponse() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    } as unknown as Response;
  }

  beforeEach(() => {
    service = {
      export: jest.fn(),
      list: jest.fn(),
      getById: jest.fn(),
      getDownloadInfo: jest.fn(),
    } as unknown as jest.Mocked<DocumentExportsService>;
    permissionsService = {
      // Default: NOT a manager — history access restricted to own exports.
      hasAllPermissions: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<PermissionsService>;
    wikiPushService = {
      pushToWiki: jest.fn(),
      updateWikiPush: jest.fn(),
      listWikiPushes: jest.fn(),
    } as unknown as jest.Mocked<DocumentWikiPushService>;
    controller = new DocumentExportsController(
      service,
      permissionsService,
      wikiPushService,
    );
  });

  it('requires the document designer feature at class level', () => {
    expect(
      Reflect.getMetadata(REQUIRE_FEATURE_KEY, DocumentExportsController),
    ).toEqual(['module_document_designer']);
  });

  it('applies export/view permissions per route', () => {
    const proto = DocumentExportsController.prototype;
    const permissionsOf = (handler: unknown) =>
      Reflect.getMetadata(PERMISSIONS_KEY, handler as object) as {
        permissions: string[];
      };

    expect(permissionsOf(proto.exportTemplate).permissions).toEqual([
      'can_export_documents',
    ]);
    expect(permissionsOf(proto.download).permissions).toEqual([
      'can_export_documents',
    ]);
    expect(permissionsOf(proto.list).permissions).toEqual([
      'can_view_document_templates',
    ]);
    expect(permissionsOf(proto.getById).permissions).toEqual([
      'can_view_document_templates',
    ]);
  });

  it('streams downloads with Content-Disposition and the file buffer', async () => {
    const buffer = Buffer.from('%PDF-1.7');
    service.export.mockResolvedValue({
      record: { id: 'export-1' },
      buffer,
      fileName: 'Status-Report-2026-07-19.pdf',
      mimeType: 'application/pdf',
      warnings: [],
    } as never);
    const res = mockResponse();

    await controller.exportTemplate(
      user,
      templateId,
      { format: 'pdf', scope: { savedFilterId: 'filter-1' } },
      res,
    );

    expect(service.export).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      templateId,
      format: 'pdf',
      scope: { savedFilterId: 'filter-1' },
      delivery: undefined,
      fileName: undefined,
      source: 'manual',
    });
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          'attachment; filename="Status-Report-2026-07-19.pdf"; filename*=UTF-8\'\'Status-Report-2026-07-19.pdf',
      }),
    );
    expect(res.send).toHaveBeenCalledWith(buffer);
    expect(service.getDownloadInfo).not.toHaveBeenCalled();
  });

  it('strips double quotes from the download file name header', async () => {
    service.export.mockResolvedValue({
      record: { id: 'export-1' },
      buffer: Buffer.from('x'),
      fileName: 'evil".pdf',
      mimeType: 'application/pdf',
      warnings: [],
    } as never);
    const res = mockResponse();

    await controller.exportTemplate(
      user,
      templateId,
      { format: 'pdf', scope: { savedFilterId: 'filter-1' } },
      res,
    );

    const setCalls = (res.set as jest.Mock).mock.calls as Array<
      [Record<string, string>]
    >;
    const headers = setCalls[0][0];
    // The ASCII fallback neutralises the quote to '_'; the encoded form carries it safely.
    expect(headers['Content-Disposition']).toBe(
      'attachment; filename="evil_.pdf"; filename*=UTF-8\'\'evil%22.pdf',
    );
  });

  it("returns { record, download } JSON in the envelope shape for delivery 'store'", async () => {
    service.export.mockResolvedValue({
      record: { id: 'export-1' },
      buffer: Buffer.from('x'),
      fileName: 'report.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      warnings: ['w1'],
    } as never);
    service.getDownloadInfo.mockResolvedValue({
      signedUrl: 'https://signed.example/file',
      fileName: 'report.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const res = mockResponse();

    await controller.exportTemplate(
      user,
      templateId,
      {
        format: 'docx',
        scope: { savedFilterId: 'filter-1' },
        delivery: 'store',
      },
      res,
    );

    expect(service.getDownloadInfo).toHaveBeenCalledWith(
      'org-1',
      'export-1',
      'user-1',
    );
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 200,
      hasError: false,
      data: {
        record: { id: 'export-1' },
        download: {
          signedUrl: 'https://signed.example/file',
          fileName: 'report.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        warnings: ['w1'],
      },
      message: 'success',
    });
    expect(res.send).not.toHaveBeenCalled();
  });

  it('restricts history list/detail/download to the caller for non-managers', async () => {
    service.list.mockResolvedValue({ data: [], count: 0 });

    await controller.list(user, templateId, 'completed', 'manual', 2, 50);
    await controller.getById(user, 'export-1');
    await controller.download(user, 'export-1');

    expect(permissionsService.hasAllPermissions).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      ['can_manage_document_templates'],
    );
    expect(service.list).toHaveBeenCalledWith('org-1', {
      template_id: templateId,
      status: 'completed',
      source: 'manual',
      requested_by: 'user-1',
      page: 2,
      pageSize: 50,
    });
    expect(service.getById).toHaveBeenCalledWith('org-1', 'export-1', 'user-1');
    expect(service.getDownloadInfo).toHaveBeenCalledWith(
      'org-1',
      'export-1',
      'user-1',
    );
  });

  it('lifts the requester restriction for can_manage_document_templates holders', async () => {
    permissionsService.hasAllPermissions.mockResolvedValue(true);
    service.list.mockResolvedValue({ data: [], count: 0 });

    await controller.list(
      user,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    await controller.getById(user, 'export-1');
    await controller.download(user, 'export-1');

    expect(service.list).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ requested_by: undefined }),
    );
    expect(service.getById).toHaveBeenCalledWith(
      'org-1',
      'export-1',
      undefined,
    );
    expect(service.getDownloadInfo).toHaveBeenCalledWith(
      'org-1',
      'export-1',
      undefined,
    );
  });
});
