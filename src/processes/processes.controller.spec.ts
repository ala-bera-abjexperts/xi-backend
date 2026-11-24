import { BadRequestException } from '@nestjs/common';
import { ProcessesController } from './processes.controller';

const user = { userId: 'user-1', organizationId: 'org-1' };

function createController() {
  const service = {
    getByKey: jest.fn().mockResolvedValue({ id: 'process-1' }),
    getAll: jest.fn().mockResolvedValue({ data: [] }),
    create: jest.fn().mockResolvedValue({ id: 'process-1' }),
    getById: jest.fn().mockResolvedValue({ id: 'process-1' }),
    reorder: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ id: 'process-1' }),
    delete: jest.fn().mockResolvedValue(undefined),
    getHistory: jest.fn().mockResolvedValue([{ id: 'history-1' }]),
    getRelationships: jest.fn().mockResolvedValue([{ id: 'rel-1' }]),
    createRelationship: jest.fn().mockResolvedValue({ id: 'rel-1' }),
    deleteRelationship: jest.fn().mockResolvedValue(undefined),
    getDiagram: jest.fn().mockResolvedValue({ xml: '<mxfile />' }),
    upsertDiagram: jest.fn().mockResolvedValue({ id: 'diagram-1' }),
    getComments: jest.fn().mockResolvedValue([{ id: 'comment-1' }]),
    createComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
    updateComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
    deleteComment: jest.fn().mockResolvedValue(undefined),
  };
  const attachmentsService = {
    getAttachments: jest.fn().mockResolvedValue([{ id: 'attachment-1' }]),
    uploadAttachment: jest.fn().mockResolvedValue({ id: 'attachment-1' }),
    getDownloadUrl: jest.fn().mockResolvedValue({ data: { url: 'url' } }),
    deleteAttachment: jest.fn().mockResolvedValue({ success: true }),
  };

  return {
    controller: new ProcessesController(
      service as never,
      attachmentsService as never,
    ),
    service,
    attachmentsService,
  };
}

describe('ProcessesController', () => {
  it('gets processes by key with organization scope', async () => {
    const { controller, service } = createController();

    await controller.getByKey(user as never, 'PROC-1');

    expect(service.getByKey).toHaveBeenCalledWith('PROC-1', 'org-1');
  });

  it('maps list query strings to service filters and numeric pagination', async () => {
    const { controller, service } = createController();

    await controller.list(
      user as never,
      'space-1',
      'active',
      'request',
      'search',
      '2',
      '50',
    );

    expect(service.getAll).toHaveBeenCalledWith('org-1', 'space-1', {
      status: 'active',
      request_type: 'request',
      search: 'search',
      page: 2,
      pageSize: 50,
    });
  });

  it('creates, gets, updates, and deletes processes with scoped context', async () => {
    const { controller, service } = createController();
    const createDto = { name: 'Process' };
    const updateDto = { name: 'Updated process' };

    await controller.create(user as never, createDto as never);
    await controller.getById(user as never, 'process-1');
    await controller.update(user as never, 'process-1', updateDto as never);
    await expect(
      controller.remove(user as never, 'process-1'),
    ).resolves.toEqual({ success: true, message: 'Process deleted' });

    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', createDto);
    expect(service.getById).toHaveBeenCalledWith('process-1', 'org-1');
    expect(service.update).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'user-1',
      updateDto,
    );
    expect(service.delete).toHaveBeenCalledWith('process-1', 'org-1', 'user-1');
  });

  it('dispatches reorder and partial update actions', async () => {
    const { controller, service } = createController();
    const items = [{ id: 'process-1', sort_order: 1 }];

    await expect(
      controller.patch(user as never, 'process-1', {
        action: 'reorder',
        items,
      } as never),
    ).resolves.toEqual({ success: true });
    await controller.patch(user as never, 'process-1', {
      action: 'partial_update',
      name: 'Renamed',
      items: [{ id: 'ignored' }],
    } as never);

    expect(service.reorder).toHaveBeenCalledWith(items, 'org-1');
    expect(service.update).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'user-1',
      { name: 'Renamed' },
    );
  });

  it('rejects invalid patch action bodies', async () => {
    const { controller } = createController();

    await expect(
      controller.patch(user as never, 'process-1', {
        action: 'reorder',
        items: [],
      } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.patch(user as never, 'process-1', {
        action: 'unknown',
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('requires an uploaded file before delegating attachment upload', async () => {
    const { controller, attachmentsService } = createController();
    const file = {
      originalname: 'evidence.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('file'),
    } as Express.Multer.File;

    await controller.uploadAttachment(user as never, 'process-1', file);

    expect(attachmentsService.uploadAttachment).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'user-1',
      file,
    );
    await expect(
      controller.uploadAttachment(
        user as never,
        'process-1',
        undefined as never,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('delegates history and relationship endpoints with controller success payloads', async () => {
    const { controller, service } = createController();
    const dto = { parent_process_id: 'parent-1' };

    await controller.getHistory(user as never, 'process-1');
    await controller.listRelationships(user as never, 'process-1');
    await controller.createRelationship(
      user as never,
      'process-1',
      dto as never,
    );
    await expect(
      controller.deleteRelationship(
        user as never,
        'process-1',
        'relationship-1',
      ),
    ).resolves.toEqual({ success: true, message: 'Relationship deleted' });

    expect(service.getHistory).toHaveBeenCalledWith('process-1', 'org-1');
    expect(service.getRelationships).toHaveBeenCalledWith('process-1', 'org-1');
    expect(service.createRelationship).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      dto,
    );
    expect(service.deleteRelationship).toHaveBeenCalledWith(
      'process-1',
      'relationship-1',
      'org-1',
    );
  });

  it('delegates diagram read and upsert operations with preview payloads', async () => {
    const { controller, service } = createController();
    const dto = { xml: '<mxfile />', previewSvg: '<svg />' };

    await controller.getDiagram(user as never, 'process-1');
    await controller.upsertDiagram(user as never, 'process-1', dto as never);

    expect(service.getDiagram).toHaveBeenCalledWith('process-1', 'org-1');
    expect(service.upsertDiagram).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'user-1',
      '<mxfile />',
      '<svg />',
    );
  });

  it('delegates attachment list, download URL, and delete endpoints', async () => {
    const { controller, attachmentsService } = createController();

    await controller.listAttachments(user as never, 'process-1');
    await controller.getAttachmentDownloadUrl(user as never, 'attachment-1');
    await controller.deleteAttachment(user as never, 'attachment-1');

    expect(attachmentsService.getAttachments).toHaveBeenCalledWith(
      'process-1',
      'org-1',
    );
    expect(attachmentsService.getDownloadUrl).toHaveBeenCalledWith(
      'attachment-1',
      'org-1',
    );
    expect(attachmentsService.deleteAttachment).toHaveBeenCalledWith(
      'attachment-1',
      'org-1',
      'user-1',
    );
  });

  it('delegates comment endpoints with content and controller success messages', async () => {
    const { controller, service } = createController();

    await controller.listComments(user as never, 'process-1');
    await controller.createComment(user as never, 'process-1', {
      content: 'hello',
    } as never);
    await controller.updateComment(user as never, 'process-1', 'comment-1', {
      content: 'updated',
    } as never);
    await expect(
      controller.deleteComment(user as never, 'process-1', 'comment-1'),
    ).resolves.toEqual({ success: true, message: 'Comment deleted' });

    expect(service.getComments).toHaveBeenCalledWith('process-1', 'org-1');
    expect(service.createComment).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'user-1',
      'hello',
    );
    expect(service.updateComment).toHaveBeenCalledWith(
      'process-1',
      'comment-1',
      'org-1',
      'user-1',
      'updated',
    );
    expect(service.deleteComment).toHaveBeenCalledWith(
      'process-1',
      'comment-1',
      'org-1',
      'user-1',
    );
  });
});
