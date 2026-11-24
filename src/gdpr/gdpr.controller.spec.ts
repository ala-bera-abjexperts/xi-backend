jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { GdprController } from './gdpr.controller';

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
};

function responseMock() {
  return {
    setHeader: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

describe('GdprController', () => {
  let service: Record<string, jest.Mock>;
  let controller: GdprController;

  beforeEach(() => {
    service = {
      getOrCreateSpreadsheet: jest.fn().mockResolvedValue({ columns: [] }),
      getSpreadsheetWithRecords: jest.fn().mockResolvedValue({ records: [] }),
      updateSpreadsheet: jest.fn().mockResolvedValue({ id: 'sheet-1' }),
      addColumn: jest.fn().mockResolvedValue({ id: 'column-1' }),
      reorderColumns: jest.fn().mockResolvedValue({ success: true }),
      renameColumn: jest.fn().mockResolvedValue({ id: 'column-1' }),
      removeColumn: jest.fn().mockResolvedValue({ success: true }),
      exportToCsv: jest.fn().mockResolvedValue({
        csvContent: 'id,name\n1,Record',
        filename: 'gdpr-export.csv',
      }),
      listRecords: jest.fn().mockResolvedValue({ data: [] }),
      createRecord: jest.fn().mockResolvedValue({ id: 'record-1' }),
      bulkUpdateCells: jest.fn().mockResolvedValue({ updated: 2 }),
      reorderRecords: jest.fn().mockResolvedValue({ success: true }),
      getRecord: jest.fn().mockResolvedValue({ id: 'record-1' }),
      updateRecord: jest.fn().mockResolvedValue({ id: 'record-1' }),
      deleteRecord: jest.fn().mockResolvedValue({ success: true }),
      toggleArchive: jest.fn().mockResolvedValue({ id: 'record-1' }),
      getComments: jest.fn().mockResolvedValue([{ id: 'comment-1' }]),
      getCommentCount: jest.fn().mockResolvedValue({ count: 1 }),
      createComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
      updateComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
      deleteComment: jest.fn().mockResolvedValue({ success: true }),
      getAttachments: jest.fn().mockResolvedValue([{ id: 'attachment-1' }]),
      uploadAttachment: jest.fn().mockResolvedValue({ id: 'attachment-1' }),
      getAttachmentSignedUrl: jest
        .fn()
        .mockResolvedValue({ url: 'https://example.test/file' }),
      deleteAttachment: jest.fn().mockResolvedValue({ success: true }),
      getHistory: jest.fn().mockResolvedValue([{ id: 'history-1' }]),
    };
    controller = new GdprController(service as any);
  });

  it('delegates spreadsheet reads with organization scope', async () => {
    await controller.getSpreadsheet(user as any);

    expect(service.getOrCreateSpreadsheet).toHaveBeenCalledWith(
      'org-1',
      'user-1',
    );
  });

  it('updates spreadsheet metadata with organization and actor context', async () => {
    const dto = { name: 'GDPR register' };

    await controller.updateSpreadsheet(user as any, dto as any);

    expect(service.updateSpreadsheet).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      dto,
    );
  });

  it('delegates spreadsheet column mutations with column ids and actor context', async () => {
    const addDto = { name: 'Owner' };
    const reorderDto = { columns: [{ id: 'column-1', order: 0 }] };
    const renameDto = { name: 'Process owner' };

    await controller.addColumn(user as any, addDto as any);
    await controller.reorderColumns(user as any, reorderDto as any);
    await controller.renameColumn(user as any, 'column-1', renameDto as any);
    await controller.removeColumn(user as any, 'column-1');

    expect(service.addColumn).toHaveBeenCalledWith('org-1', 'user-1', addDto);
    expect(service.reorderColumns).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      reorderDto,
    );
    expect(service.renameColumn).toHaveBeenCalledWith(
      'org-1',
      'column-1',
      'user-1',
      renameDto,
    );
    expect(service.removeColumn).toHaveBeenCalledWith(
      'org-1',
      'column-1',
      'user-1',
    );
  });

  it('exports records as CSV with response headers', async () => {
    const res = responseMock();

    await controller.exportToCsv(user as any, res as any);

    expect(service.exportToCsv).toHaveBeenCalledWith('org-1', 'user-1');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="gdpr-export.csv"',
    );
    expect(res.send).toHaveBeenCalledWith('id,name\n1,Record');
  });

  it('lists records with organization scope and query intact', async () => {
    const query = { page: 1, pageSize: 20 };

    await controller.listRecords(user as any, query as any);

    expect(service.listRecords).toHaveBeenCalledWith('org-1', query);
  });

  it('delegates record create, bulk update, reorder, get, update, and archive operations', async () => {
    const createDto = { title: 'Record' };
    const bulkDto = { records: [{ id: 'record-1' }] };
    const reorderDto = { records: [{ id: 'record-1', sort_order: 0 }] };
    const updateDto = { values: { owner: 'Jane' } };
    const archiveDto = { archived: true };

    await controller.createRecord(user as any, createDto as any);
    await controller.bulkUpdateCells(user as any, bulkDto as any);
    await controller.reorderRecords(user as any, reorderDto as any);
    await controller.getRecord(user as any, 'record-1');
    await controller.updateRecord(user as any, 'record-1', updateDto as any);
    await controller.toggleArchive(user as any, 'record-1', archiveDto as any);

    expect(service.createRecord).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      createDto,
    );
    expect(service.bulkUpdateCells).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      bulkDto,
    );
    expect(service.reorderRecords).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      reorderDto,
    );
    expect(service.getRecord).toHaveBeenCalledWith('record-1', 'org-1');
    expect(service.updateRecord).toHaveBeenCalledWith(
      'record-1',
      'org-1',
      'user-1',
      updateDto,
    );
    expect(service.toggleArchive).toHaveBeenCalledWith(
      'record-1',
      'org-1',
      'user-1',
      archiveDto,
    );
  });

  it('delegates comment reads and writes with record, organization, and actor context', async () => {
    const createDto = { content: 'hello' };
    const updateDto = { content: 'updated' };

    await controller.getComments(user as any, 'record-1');
    await controller.createComment(user as any, 'record-1', createDto as any);
    await controller.updateComment(
      user as any,
      'record-1',
      'comment-1',
      updateDto as any,
    );

    expect(service.getComments).toHaveBeenCalledWith('record-1', 'org-1');
    expect(service.createComment).toHaveBeenCalledWith(
      'record-1',
      'org-1',
      'user-1',
      createDto,
    );
    expect(service.updateComment).toHaveBeenCalledWith(
      'record-1',
      'comment-1',
      'org-1',
      'user-1',
      updateDto,
    );
  });

  it('delegates attachment reads, uploads, signed URL lookup, and history reads', async () => {
    const file = {
      originalname: 'evidence.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('file'),
    } as Express.Multer.File;

    await controller.getAttachments(user as any, 'record-1');
    await controller.uploadAttachment(user as any, 'record-1', file);
    await controller.getAttachmentSignedUrl(
      user as any,
      'record-1',
      'attachment-1',
    );
    await controller.getHistory(user as any, 'record-1');

    expect(service.getAttachments).toHaveBeenCalledWith('record-1', 'org-1');
    expect(service.uploadAttachment).toHaveBeenCalledWith(
      'record-1',
      'org-1',
      'user-1',
      file,
    );
    expect(service.getAttachmentSignedUrl).toHaveBeenCalledWith(
      'record-1',
      'attachment-1',
      'org-1',
    );
    expect(service.getHistory).toHaveBeenCalledWith('record-1', 'org-1');
  });

  it('delegates no-content delete endpoints and returns service result', async () => {
    await expect(
      controller.deleteRecord(user as any, 'record-1'),
    ).resolves.toEqual({
      success: true,
      message: 'Record deleted',
    });
    await expect(
      controller.deleteComment(user as any, 'record-1', 'comment-1'),
    ).resolves.toEqual({ success: true, message: 'Comment deleted' });
    await expect(
      controller.deleteAttachment(user as any, 'record-1', 'attachment-1'),
    ).resolves.toEqual({ success: true, message: 'Attachment deleted' });

    expect(service.deleteRecord).toHaveBeenCalledWith(
      'record-1',
      'org-1',
      'user-1',
    );
    expect(service.deleteComment).toHaveBeenCalledWith(
      'record-1',
      'comment-1',
      'org-1',
      'user-1',
    );
    expect(service.deleteAttachment).toHaveBeenCalledWith(
      'record-1',
      'attachment-1',
      'org-1',
      'user-1',
    );
  });
});
