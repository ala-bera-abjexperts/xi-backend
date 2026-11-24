import { BadRequestException } from '@nestjs/common';
import { ListsSpacesCompatController } from './lists-spaces-compat.controller';

const user = { userId: 'user-1', organizationId: 'org-1' };

function createController() {
  const service = {
    getSchemas: jest.fn().mockResolvedValue([{ id: 'schema-1' }]),
    createSchema: jest.fn().mockResolvedValue({ id: 'schema-1' }),
    getSchemaById: jest.fn().mockResolvedValue({ id: 'schema-1' }),
    getSchemaByKey: jest.fn().mockResolvedValue({ id: 'schema-1' }),
    updateSchema: jest.fn().mockResolvedValue({ id: 'schema-1' }),
    deleteSchema: jest.fn().mockResolvedValue(undefined),
    restoreSchema: jest
      .fn()
      .mockResolvedValue({ id: 'schema-1', is_active: true }),
    exportToCSV: jest.fn().mockResolvedValue('Title\nItem'),
    importItemsFromFile: jest.fn().mockResolvedValue({ created: 1 }),
    importSchemaFromFile: jest.fn().mockResolvedValue({
      schema: { id: 'schema-1', key: 'IMPORTED' },
      importResult: { created: 1 },
    }),
    addColumn: jest.fn().mockResolvedValue({ id: 'schema-1' }),
    reorderColumns: jest.fn().mockResolvedValue({ id: 'schema-1' }),
    renameColumn: jest.fn().mockResolvedValue({ id: 'schema-1' }),
    removeColumn: jest.fn().mockResolvedValue({ id: 'schema-1' }),
    getItems: jest
      .fn()
      .mockResolvedValue({ data: [{ id: 'item-1' }], total: 1 }),
    createItem: jest.fn().mockResolvedValue({ id: 'item-1' }),
    getItemById: jest.fn().mockResolvedValue({
      id: 'item-1',
      custom_field_values: { risk: 'high' },
      version: 4,
    }),
    updateItem: jest.fn().mockResolvedValue({ id: 'item-1' }),
    deleteItem: jest.fn().mockResolvedValue(undefined),
    bulkUpdateCells: jest.fn().mockResolvedValue([{ id: 'item-1' }]),
    bulkDeleteItems: jest.fn().mockResolvedValue(undefined),
    bulkArchiveItems: jest.fn().mockResolvedValue(undefined),
    reorderRows: jest.fn().mockResolvedValue(undefined),
    getItemHistory: jest.fn().mockResolvedValue([{ id: 'history-1' }]),
    getItemCustomFieldValues: jest
      .fn()
      .mockResolvedValue({ data: { risk: 'high' }, version: 4 }),
    updateItemCustomFieldValues: jest.fn().mockResolvedValue({ id: 'item-1' }),
    getComments: jest.fn().mockResolvedValue([{ id: 'comment-1' }]),
    createComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
    updateComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
    deleteComment: jest.fn().mockResolvedValue(undefined),
    getAttachments: jest.fn().mockResolvedValue([{ id: 'attachment-1' }]),
    uploadAttachment: jest.fn().mockResolvedValue({ id: 'attachment-1' }),
    getAttachmentDownloadUrl: jest.fn().mockResolvedValue('signed-url'),
    deleteAttachment: jest.fn().mockResolvedValue(undefined),
    getLinks: jest.fn().mockResolvedValue([{ id: 'link-1' }]),
    createLink: jest.fn().mockResolvedValue({ id: 'link-1' }),
    deleteLink: jest.fn().mockResolvedValue(undefined),
    getCustomFields: jest.fn().mockResolvedValue([{ id: 'field-1' }]),
    assignCustomField: jest.fn().mockResolvedValue({ id: 'assignment-1' }),
    updateCustomFieldAssignment: jest
      .fn()
      .mockResolvedValue({ id: 'assignment-1' }),
    removeCustomField: jest.fn().mockResolvedValue(undefined),
    reorderCustomFields: jest.fn().mockResolvedValue(undefined),
    syncCustomFields: jest.fn().mockResolvedValue([{ id: 'assignment-1' }]),
  };

  return {
    controller: new ListsSpacesCompatController(service as never),
    service,
  };
}

describe('ListsSpacesCompatController', () => {
  it('normalizes legacy schema and item query aliases under a space path', async () => {
    const { controller, service } = createController();

    await expect(
      controller.listSchemas(user as never, 'space-1', 'true', 'search'),
    ).resolves.toEqual({ data: [{ id: 'schema-1' }], count: 1 });
    await expect(
      controller.listItems(
        user as never,
        'space-1',
        'schema-1',
        '2',
        '75',
        'needle',
        'true',
        'title',
        'desc',
      ),
    ).resolves.toEqual({
      data: [{ id: 'item-1' }],
      total: 1,
      page: 2,
      page_size: 75,
    });

    expect(service.getSchemas).toHaveBeenCalledWith('org-1', 'space-1', {
      is_archived: 'true',
      search: 'search',
    });
    expect(service.getItems).toHaveBeenCalledWith('org-1', 'schema-1', {
      page: 2,
      page_size: 75,
      search: 'needle',
      is_archived: 'true',
      sort_column: 'title',
      sort_direction: 'desc',
    });
  });

  it('forces route space and auth organization while ignoring legacy ids in bodies', async () => {
    const { controller, service } = createController();

    await expect(
      controller.createSchema(user as never, 'space-1', {
        name: 'Assets',
        space_id: 'wrong-space',
        organizationId: 'wrong-org',
      } as never),
    ).resolves.toEqual({ data: { id: 'schema-1' }, success: true });
    await expect(
      controller.createItem(user as never, 'space-1', {
        schema_id: 'schema-1',
        space_id: 'wrong-space',
        organizationId: 'wrong-org',
      } as never),
    ).resolves.toEqual({ data: { id: 'item-1' }, success: true });

    expect(service.createSchema).toHaveBeenCalledWith('org-1', 'user-1', {
      name: 'Assets',
      space_id: 'space-1',
    });
    expect(service.createItem).toHaveBeenCalledWith('org-1', 'user-1', {
      schema_id: 'schema-1',
      space_id: 'space-1',
    });
  });

  it('imports rows through the route space and authenticated user', async () => {
    const { controller, service } = createController();
    const file = { originalname: 'rows.csv' } as Express.Multer.File;

    await expect(
      controller.importItems(user as never, 'space-1', 'schema-1', file),
    ).resolves.toEqual({ data: { created: 1 }, success: true });

    expect(service.importItemsFromFile).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'schema-1',
      file,
      { spaceId: 'space-1' },
    );
  });

  it('creates imported schemas under the route space', async () => {
    const { controller, service } = createController();
    const file = { originalname: 'lists.csv' } as Express.Multer.File;

    await expect(
      controller.importSchema(
        user as never,
        'space-1',
        { name: 'Imported' },
        file,
      ),
    ).resolves.toEqual({
      data: {
        schema: { id: 'schema-1', key: 'IMPORTED' },
        importResult: { created: 1 },
      },
      success: true,
    });

    expect(service.importSchemaFromFile).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'space-1',
      file,
      { name: 'Imported' },
    );
  });

  it('rejects missing import files before delegating', async () => {
    const { controller, service } = createController();

    await expect(
      controller.importItems(
        user as never,
        'space-1',
        'schema-1',
        undefined as never,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.importSchema(
        user as never,
        'space-1',
        { name: 'Imported' },
        undefined as never,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(service.importItemsFromFile).not.toHaveBeenCalled();
    expect(service.importSchemaFromFile).not.toHaveBeenCalled();
  });

  it('restores archived schemas through the space-scoped compatibility route', async () => {
    const { controller, service } = createController();

    await expect(
      controller.restoreSchema(user as never, 'space-1', 'schema-1'),
    ).resolves.toEqual({
      data: { id: 'schema-1', is_active: true },
      success: true,
    });

    expect(service.restoreSchema).toHaveBeenCalledWith(
      'schema-1',
      'org-1',
      'user-1',
    );
  });

  it('passes parsed column filters to space-scoped item queries', async () => {
    const { controller, service } = createController();

    await controller.listItems(
      user as never,
      'space-1',
      'schema-1',
      '1',
      '10',
      undefined,
      'false',
      undefined,
      undefined,
      '{"serverlocation":"USA"}',
    );

    expect(service.getItems).toHaveBeenCalledWith(
      'org-1',
      'schema-1',
      expect.objectContaining({
        column_filters: { serverlocation: 'USA' },
      }),
    );
  });

  it('maps legacy bulk, reorder, custom field, attachment, link, and raw detail shapes', async () => {
    const { controller, service } = createController();
    const file = { originalname: 'a.txt' } as Express.Multer.File;

    await expect(
      controller.getSchemaById(user as never, 'space-1', 'schema-1'),
    ).resolves.toEqual({ id: 'schema-1' });
    await expect(
      controller.getItemById(user as never, 'space-1', 'item-1'),
    ).resolves.toEqual({
      id: 'item-1',
      custom_field_values: { risk: 'high' },
      version: 4,
    });
    await expect(
      controller.bulkUpdateItems(user as never, 'space-1', {
        updates: [
          { item_id: 'item-1', column_id: 'c1', value: 'v', version: 1 },
        ],
      }),
    ).resolves.toEqual({ data: [{ id: 'item-1' }], success: true });
    await expect(
      controller.bulkDeleteItems(user as never, 'space-1', { ids: ['item-1'] }),
    ).resolves.toEqual({ success: true, message: '1 items deleted' });
    await expect(
      controller.bulkArchiveItems(user as never, 'space-1', {
        ids: ['item-1'],
      }),
    ).resolves.toEqual({ success: true, message: '1 items archived' });
    await expect(
      controller.reorderItems(user as never, 'space-1', {
        schemaId: 'schema-1',
        orders: [{ item_id: 'item-1', row_order: 3 }],
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      controller.getItemCustomFieldValues(user as never, 'space-1', 'item-1'),
    ).resolves.toEqual({
      data: { risk: 'high' },
      version: 4,
      success: true,
    });
    await expect(
      controller.uploadAttachment(user as never, 'space-1', 'item-1', file, {
        schemaId: 'schema-1',
      }),
    ).resolves.toEqual({ data: { id: 'attachment-1' }, success: true });
    await expect(
      controller.getAttachmentDownloadUrl(
        user as never,
        'space-1',
        'attachment-1',
      ),
    ).resolves.toEqual({ data: { url: 'signed-url' } });
    await expect(
      controller.createLink(user as never, 'space-1', 'item-1', {
        target_type: 'wiki',
        target_id: 'page-1',
        organizationId: 'wrong-org',
      }),
    ).resolves.toEqual({ data: { id: 'link-1' }, success: true });

    expect(service.reorderRows).toHaveBeenCalledWith(
      'schema-1',
      'org-1',
      'user-1',
      [{ item_id: 'item-1', row_order: 3 }],
    );
    expect(service.uploadAttachment).toHaveBeenCalledWith(
      'item-1',
      'org-1',
      'schema-1',
      file,
      'user-1',
    );
    expect(service.createLink).toHaveBeenCalledWith(
      'item-1',
      'org-1',
      'user-1',
      { target_type: 'wiki', target_id: 'page-1' },
    );
  });

  it('rejects missing legacy required payloads before delegating', async () => {
    const { controller } = createController();

    await expect(
      controller.listItems(user as never, 'space-1', undefined as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.reorderItems(user as never, 'space-1', {
        schemaId: 'schema-1',
        orders: [],
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.uploadAttachment(
        user as never,
        'space-1',
        'item-1',
        undefined as never,
        { schemaId: 'schema-1' },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
