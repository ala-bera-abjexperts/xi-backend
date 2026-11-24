import { BadRequestException } from '@nestjs/common';
import { ProcessesSpacesCompatController } from './processes-spaces-compat.controller';

const user = { userId: 'user-1', organizationId: 'org-1' };

function createController() {
  const service = {
    getAll: jest
      .fn()
      .mockResolvedValue({ data: [{ id: 'process-1' }], total: 1 }),
    getAllWithParents: jest.fn().mockResolvedValue([{ id: 'process-1' }]),
    create: jest.fn().mockResolvedValue({ id: 'process-1' }),
    getById: jest.fn().mockResolvedValue({ id: 'process-1' }),
    getByIdWithParents: jest.fn().mockResolvedValue({
      id: 'process-1',
      parent_ids: ['parent-1'],
    }),
    getByKey: jest.fn().mockResolvedValue({ id: 'process-1' }),
    getByKeyWithParents: jest.fn().mockResolvedValue({
      id: 'process-1',
      parent_ids: ['parent-1'],
    }),
    update: jest.fn().mockResolvedValue({ id: 'process-1' }),
    delete: jest.fn().mockResolvedValue(undefined),
    reorder: jest.fn().mockResolvedValue(undefined),
    getDiagram: jest.fn().mockResolvedValue({ data: null }),
    upsertDiagram: jest
      .fn()
      .mockResolvedValue({ data: { id: 'diagram-1' }, success: true }),
  };
  const attachmentsService = {
    getAttachments: jest
      .fn()
      .mockResolvedValue({ data: [{ id: 'attachment-1' }], count: 1 }),
    uploadAttachment: jest
      .fn()
      .mockResolvedValue({ data: { id: 'attachment-1' }, success: true }),
    getDownloadUrl: jest.fn().mockResolvedValue({ data: { url: 'url' } }),
    deleteAttachment: jest
      .fn()
      .mockResolvedValue({ success: true, message: 'Attachment deleted' }),
  };

  return {
    controller: new ProcessesSpacesCompatController(
      service as never,
      attachmentsService as never,
    ),
    service,
    attachmentsService,
  };
}

describe('ProcessesSpacesCompatController', () => {
  it('normalizes list aliases and returns legacy non-paginated shape', async () => {
    const { controller, service } = createController();

    await expect(
      controller.list(
        user as never,
        'space-1',
        'active',
        'Risiko',
        undefined,
        'needle',
        undefined,
        undefined,
        'true',
      ),
    ).resolves.toEqual({ data: [{ id: 'process-1' }], count: 1 });

    expect(service.getAllWithParents).toHaveBeenCalledWith('org-1', 'space-1', {
      status: 'active',
      request_type: 'Risiko',
      search: 'needle',
    });
  });

  it('returns paginated legacy shape when pagination aliases are present', async () => {
    const { controller, service } = createController();

    await expect(
      controller.list(
        user as never,
        'space-1',
        undefined,
        undefined,
        'Assetbewertung',
        undefined,
        '3',
        '25',
        undefined,
      ),
    ).resolves.toEqual({
      data: [{ id: 'process-1' }],
      total: 1,
      page: 3,
      pageSize: 25,
    });

    expect(service.getAll).toHaveBeenCalledWith('org-1', 'space-1', {
      request_type: 'Assetbewertung',
      page: 3,
      pageSize: 25,
    });
  });

  it('forces route space and auth organization for create and wraps mutations', async () => {
    const { controller, service } = createController();

    await expect(
      controller.create(user as never, 'space-1', {
        title: 'Process',
        space_id: 'wrong-space',
        organizationId: 'wrong-org',
      } as never),
    ).resolves.toEqual({ data: { id: 'process-1' }, success: true });
    await expect(
      controller.update(user as never, 'space-1', 'process-1', {
        title: 'Updated',
        organizationId: 'wrong-org',
      } as never),
    ).resolves.toEqual({ data: { id: 'process-1' }, success: true });
    await expect(
      controller.remove(user as never, 'space-1', 'process-1'),
    ).resolves.toEqual({ success: true });

    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', {
      title: 'Process',
      space_id: 'space-1',
    });
    expect(service.update).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'user-1',
      { title: 'Updated' },
    );
    expect(service.delete).toHaveBeenCalledWith('process-1', 'org-1', 'user-1');
  });

  it('supports withParents aliases, by-key lookup, diagram, attachments, and reorder', async () => {
    const { controller, service, attachmentsService } = createController();
    const file = { originalname: 'diagram.pdf' } as Express.Multer.File;

    await expect(
      controller.getById(user as never, 'space-1', 'process-1', 'true'),
    ).resolves.toEqual({
      data: { id: 'process-1', parent_ids: ['parent-1'] },
    });
    await expect(
      controller.getByKey(user as never, 'space-1', 'PROC-1', 'true'),
    ).resolves.toEqual({
      data: { id: 'process-1', parent_ids: ['parent-1'] },
    });
    await expect(
      controller.upsertDiagram(user as never, 'space-1', 'process-1', {
        xml: '<mxfile />',
        organizationId: 'wrong-org',
      } as never),
    ).resolves.toEqual({ data: { id: 'diagram-1' }, success: true });
    await expect(
      controller.listAttachments(user as never, 'space-1', 'process-1'),
    ).resolves.toEqual({ data: [{ id: 'attachment-1' }], count: 1 });
    await expect(
      controller.uploadAttachment(user as never, 'space-1', 'process-1', file),
    ).resolves.toEqual({ data: { id: 'attachment-1' }, success: true });
    await expect(
      controller.reorder(user as never, 'space-1', {
        updates: [{ id: 'process-1', sort_order: 2 }],
      }),
    ).resolves.toEqual({ success: true, updated: 1 });

    expect(service.getByIdWithParents).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'space-1',
    );
    expect(service.getByKeyWithParents).toHaveBeenCalledWith(
      'PROC-1',
      'org-1',
      'space-1',
    );
    expect(service.upsertDiagram).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'user-1',
      '<mxfile />',
      undefined,
    );
    expect(attachmentsService.uploadAttachment).toHaveBeenCalledWith(
      'process-1',
      'org-1',
      'user-1',
      file,
    );
    expect(service.reorder).toHaveBeenCalledWith(
      [{ id: 'process-1', sort_order: 2 }],
      'org-1',
    );
  });

  it('rejects missing legacy payloads before delegating', async () => {
    const { controller } = createController();

    await expect(
      controller.upsertDiagram(user as never, 'space-1', 'process-1', {}),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.uploadAttachment(
        user as never,
        'space-1',
        'process-1',
        undefined as never,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.reorder(user as never, 'space-1', { updates: [] }),
    ).rejects.toThrow(BadRequestException);
  });
});
