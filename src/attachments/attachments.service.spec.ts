import { AttachmentsService } from './attachments.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UPLOAD_LIMITS } from '../common/upload-limits';

describe('AttachmentsService', () => {
  let service: AttachmentsService;
  let mockFrom: jest.Mock;
  let storageFrom: jest.Mock;
  let storageRemove: jest.Mock;
  let createSignedUrl: jest.Mock;
  let permissions: { getUserSpacePermissions: jest.Mock };
  let auditLogs: { logAction: jest.Mock };

  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@example.com',
    memberships: [],
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    // `listForEntity` filters out attachments whose upload failed
    // (`current_version_id is null`), so the double needs this link or the
    // chain breaks on a method it does not have.
    chain.not = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    permissions = {
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: true,
        spaceRole: 'admin',
        globalRole: 'admin',
        permissions: { view_tasks: true, delete_attachments_tasks: true },
      }),
    };
    auditLogs = { logAction: jest.fn().mockResolvedValue(undefined) };

    storageRemove = jest.fn().mockResolvedValue({ error: null });
    createSignedUrl = jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed.example/file.pdf' },
      error: null,
    });
    storageFrom = jest.fn().mockReturnValue({
      remove: storageRemove,
      createSignedUrl,
    });
    const supabase = {
      getClient: () => ({
        from: mockFrom,
        storage: { from: storageFrom },
      }),
    } as unknown as SupabaseAdminService;

    service = new AttachmentsService(
      supabase,
      permissions as unknown as PermissionsService,
      auditLogs as unknown as AuditLogsService,
    );
  });

  function queueDownload(mimeType: string, versionNumber = 1) {
    const attachment = {
      id: 'attachment-1',
      organization_id: 'org-1',
      space_id: 'space-1',
      entity_type: 'task',
      entity_id: 'task-1',
      file_name: 'Prüfbericht Übersicht.png',
      current_version_id: 'version-1',
      checked_out_by: null,
      checked_out_at: null,
      checkout_note: null,
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const version = {
      id: `version-${versionNumber}`,
      attachment_id: 'attachment-1',
      version_number: versionNumber,
      file_path: `org-1/task/task-1/attachment-1/v${versionNumber}/image.png`,
      file_size: 123,
      mime_type: mimeType,
      uploaded_by: 'user-1',
      uploaded_at: '2026-01-01T00:00:00Z',
      comment: null,
    };
    const tableQueues: Record<string, ReturnType<typeof buildChain>[]> = {
      file_attachments: [buildChain({ data: attachment, error: null })],
      tasks: [
        buildChain({
          data: { organization_id: 'org-1', space_id: 'space-1' },
          error: null,
        }),
      ],
      file_versions: [buildChain({ data: version, error: null })],
    };

    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());
  }

  it('creates an inline image URL without forcing a download and preserves the requested version', async () => {
    queueDownload(' IMAGE/PNG; charset=binary ', 2);

    await expect(
      service.getDownloadInfo({
        attachmentId: 'attachment-1',
        versionNumber: 2,
        inline: true,
        user,
      }),
    ).resolves.toEqual({
      signedUrl: 'https://signed.example/file.pdf',
      fileName: 'Prüfbericht Übersicht.png',
      mimeType: ' IMAGE/PNG; charset=binary ',
      versionNumber: 2,
    });

    expect(createSignedUrl).toHaveBeenCalledWith(
      'org-1/task/task-1/attachment-1/v2/image.png',
      60,
    );
  });

  it('keeps local signed images on the browser storage proxy without losing the signature', async () => {
    const previous = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    try {
      queueDownload('image/jpeg');
      createSignedUrl.mockResolvedValue({ data: { signedUrl: 'http://127.0.0.1:54321/storage/v1/object/sign/attachments/photo.jpg?token=test-signature&download=photo.jpg' }, error: null });
      const result = await service.getDownloadInfo({ attachmentId: 'attachment-1', inline: true, user });
      expect(result.signedUrl).toBe('/storage/v1/object/sign/attachments/photo.jpg?token=test-signature&download=photo.jpg');
    } finally {
      if (previous === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previous;
    }
  });

  it.each([
    'application/pdf',
    'image/svg+xml',
    ' IMAGE/SVG+XML ; charset=utf-8',
  ])(
    'rejects %s as inline content after checking attachment permission',
    async (mimeType) => {
      queueDownload(mimeType);

      await expect(
        service.getDownloadInfo({
          attachmentId: 'attachment-1',
          inline: true,
          user,
        }),
      ).rejects.toThrow('Attachment cannot be rendered inline');

      expect(permissions.getUserSpacePermissions).toHaveBeenCalled();
      expect(createSignedUrl).not.toHaveBeenCalled();
    },
  );

  it('does not generate an inline URL when the user cannot view the attachment', async () => {
    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: false,
      spaceRole: null,
      globalRole: null,
      permissions: { view_tasks: false },
    });
    queueDownload('image/png');

    await expect(
      service.getDownloadInfo({
        attachmentId: 'attachment-1',
        inline: true,
        user,
      }),
    ).rejects.toThrow('You do not have permission to view attachments');

    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('writes task history when deleting a centralized task attachment', async () => {
    const attachment = {
      id: 'attachment-1',
      organization_id: 'org-1',
      space_id: 'space-1',
      entity_type: 'task',
      entity_id: 'task-1',
      file_name: 'evidence.pdf',
      current_version_id: 'version-1',
      checked_out_by: null,
      checked_out_at: null,
      checkout_note: null,
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const historyChain = buildChain({ data: null, error: null });
    const tableQueues: Record<string, ReturnType<typeof buildChain>[]> = {
      file_attachments: [
        buildChain({ data: attachment, error: null }),
        buildChain({ data: null, error: null }),
      ],
      tasks: [
        buildChain({
          data: { organization_id: 'org-1', space_id: 'space-1' },
          error: null,
        }),
      ],
      file_versions: [
        buildChain({
          data: [
            {
              id: 'version-1',
              file_path: 'org-1/task/task-1/attachment-1/v1/evidence.pdf',
              file_size: 123,
              mime_type: 'application/pdf',
            },
          ],
          error: null,
        }),
      ],
      task_history: [historyChain],
    };

    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());

    await expect(
      service.delete({
        attachmentId: 'attachment-1',
        user: {
          authUserId: 'auth-user-1',
          userId: 'user-1',
          organizationId: 'org-1',
          email: 'user@example.com',
          memberships: [],
        },
      }),
    ).resolves.toEqual({ success: true });

    expect(historyChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-1',
        organization_id: 'org-1',
        action: 'attachment_deleted',
        changed_by: 'user-1',
      }),
    );
  });

  it('downloads backfilled legacy task attachments from the legacy bucket', async () => {
    const attachment = {
      id: 'attachment-1',
      organization_id: 'org-1',
      space_id: 'space-1',
      entity_type: 'task',
      entity_id: 'task-1',
      file_name: 'evidence.pdf',
      current_version_id: 'version-1',
      checked_out_by: null,
      checked_out_at: null,
      checkout_note: null,
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const version = {
      id: 'version-1',
      attachment_id: 'attachment-1',
      version_number: 1,
      file_path: 'org-1/tasks/task-1/1777446365488-file.pdf',
      file_size: 123,
      mime_type: 'application/pdf',
      uploaded_by: 'user-1',
      uploaded_at: '2026-01-01T00:00:00Z',
      comment: null,
    };
    const tableQueues: Record<string, ReturnType<typeof buildChain>[]> = {
      file_attachments: [buildChain({ data: attachment, error: null })],
      tasks: [
        buildChain({
          data: { organization_id: 'org-1', space_id: 'space-1' },
          error: null,
        }),
      ],
      file_versions: [buildChain({ data: version, error: null })],
    };

    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());

    await expect(
      service.getDownloadInfo({
        attachmentId: 'attachment-1',
        user: {
          authUserId: 'auth-user-1',
          userId: 'user-1',
          organizationId: 'org-1',
          email: 'user@example.com',
          memberships: [],
        },
      }),
    ).resolves.toEqual({
      signedUrl: 'https://signed.example/file.pdf',
      fileName: 'evidence.pdf',
      mimeType: 'application/pdf',
      versionNumber: 1,
    });

    expect(storageFrom).toHaveBeenCalledWith('task-attachments');
    // `download` carries the ORIGINAL (possibly non-ASCII) name into Content-Disposition — without
    // it the user saves the sanitized storage-key name.
    expect(createSignedUrl).toHaveBeenCalledWith(
      'org-1/tasks/task-1/1777446365488-file.pdf',
      60,
      { download: 'evidence.pdf' },
    );
  });

  it('lists support request attachments for the ticket owner without a space membership lookup', async () => {
    const attachment = {
      id: 'attachment-1',
      organization_id: 'org-1',
      space_id: null,
      entity_type: 'support_request',
      entity_id: 'support-request-1',
      file_name: 'screen.png',
      current_version_id: 'version-1',
      checked_out_by: null,
      checked_out_at: null,
      checkout_note: null,
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const tableQueues: Record<string, ReturnType<typeof buildChain>[]> = {
      support_requests: [
        buildChain({
          data: {
            organization_id: 'org-1',
            space_id: null,
            created_by: 'user-1',
          },
          error: null,
        }),
      ],
      file_attachments: [buildChain({ data: [attachment], error: null })],
    };

    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());

    await expect(
      service.listForEntity({
        entityType: 'support_request',
        entityId: 'support-request-1',
        user: {
          authUserId: 'auth-user-1',
          userId: 'user-1',
          organizationId: 'org-1',
          email: 'user@example.com',
          memberships: [],
        },
      }),
    ).resolves.toEqual([attachment]);

    expect(permissions.getUserSpacePermissions).not.toHaveBeenCalled();
  });

  describe('importVersion — historical binaries respect existing upload rules', () => {
    // `importVersion` validates BEFORE any DB or storage call (see attachments.service.ts), so
    // these assert on the rejection alone — no chain mocking needed.
    it.each(['image/svg+xml', ' IMAGE/SVG+XML; charset=utf-8 '])(
      'rejects %s for an entity type that blocks SVG on normal uploads',
      async (mimeType) => {
        // wiki_page -> ENTITY_UPLOAD_LIMITS.wiki_page = { allowSvg: false }. A historical SVG
        // attachment version must be refused for the same reason a fresh upload would be — this is
        // the exact rule an earlier version of importVersion silently skipped by duplicating only
        // the size check instead of reusing validateFile.
        await expect(
          service.importVersion({
            organizationId: 'org-1',
            spaceId: 'space-1',
            entityType: 'wiki_page',
            entityId: 'page-1',
            fileName: 'diagram.bin',
            versionNumber: 1,
            data: Buffer.from('<svg></svg>'),
            mimeType,
            uploadedBy: 'user-1',
            createdBy: 'user-1',
          }),
        ).rejects.toThrow(/SVG files are not allowed/);
      },
    );

    it('rejects a binary over the entity size limit', async () => {
      // Derived from the live cap, not a hardcoded byte count: this fixture used to be a literal
      // 300 MB, which stopped exceeding the limit the moment the cloud attachment cap was raised
      // to 1 GB, so the test silently fell through to the unmocked DB path. `validateFile` only
      // reads `byteLength`, so a stand-in avoids materialising a multi-gigabyte buffer here.
      const oversized = {
        byteLength: UPLOAD_LIMITS.ATTACHMENT + 1,
      } as unknown as Buffer;

      await expect(
        service.importVersion({
          organizationId: 'org-1',
          spaceId: 'space-1',
          entityType: 'wiki_page',
          entityId: 'page-1',
          fileName: 'huge.bin',
          versionNumber: 1,
          data: oversized,
          mimeType: 'application/octet-stream',
          uploadedBy: 'user-1',
          createdBy: 'user-1',
        }),
      ).rejects.toThrow(/exceeds/);
    });

    it('rejects an empty filename before touching the database', async () => {
      await expect(
        service.importVersion({
          organizationId: 'org-1',
          spaceId: 'space-1',
          entityType: 'wiki_page',
          entityId: 'page-1',
          fileName: '   ',
          versionNumber: 1,
          data: Buffer.from('x'),
          mimeType: 'application/pdf',
          uploadedBy: 'user-1',
          createdBy: 'user-1',
        }),
      ).rejects.toThrow(/File name is required/);

      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('rejects an invalid version number', async () => {
      await expect(
        service.importVersion({
          organizationId: 'org-1',
          spaceId: 'space-1',
          entityType: 'wiki_page',
          entityId: 'page-1',
          fileName: 'file.pdf',
          versionNumber: 0,
          data: Buffer.from('x'),
          mimeType: 'application/pdf',
          uploadedBy: 'user-1',
          createdBy: 'user-1',
        }),
      ).rejects.toThrow(/Invalid version number/);
    });
  });
  it.each([
    [
      'report.xls',
      'Application/Vnd.Ms-Excel; charset=utf-8',
      'application/vnd.ms-excel',
    ],
    [
      'report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['report.xls', 'invalid content type', 'application/octet-stream'],
    ['page.html', ' TEXT/HTML; charset=utf-8 ', 'text/html'],
  ])(
    'normalizes historical %s on signed storage without changing bytes',
    async (fileName, mimeType, expected) => {
      const upload = jest.fn().mockResolvedValue({ error: null });
      storageFrom.mockReturnValue({ upload });
      // Isolate storage behavior; version numbering and adoption have separate tests.
      const methods = service as unknown as {
        findAttachmentByEntityAndName: () => Promise<unknown>;
        findVersionByAttachmentAndNumber: () => Promise<unknown>;
        createVersion: () => Promise<unknown>;
        getMaxVersionNumber: () => Promise<number>;
      };
      jest
        .spyOn(methods, 'findAttachmentByEntityAndName')
        .mockResolvedValue({ id: 'att-1' });
      jest
        .spyOn(methods, 'findVersionByAttachmentAndNumber')
        .mockResolvedValue(null);
      const createVersion = jest
        .spyOn(methods, 'createVersion')
        .mockResolvedValue({ id: 'v1' });
      jest.spyOn(methods, 'getMaxVersionNumber').mockResolvedValue(2);
      const data = Buffer.from([0, 255, 17, 128]);
      await service.importVersion({
        organizationId: 'org-1',
        spaceId: 'space-1',
        entityType: 'wiki_page',
        entityId: 'page-1',
        fileName,
        versionNumber: 1,
        data,
        mimeType,
        uploadedBy: 'user-1',
        createdBy: 'user-1',
      });
      expect(upload).toHaveBeenCalledWith(
        expect.stringContaining('/v1/'),
        data,
        { contentType: expected, upsert: false },
      );
      expect(upload.mock.calls[0][1]).toBe(data);
      expect(createVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          mime_type: expected,
          file_size: data.length,
        }),
      );
    },
  );
});
