/**
 * @fileoverview Unit tests for ListsService — schema CRUD, item CRUD,
 * item reorder, key generation, cascade on schema delete.
 * @module src/lists/lists.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ListsService } from './lists.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('ListsService', () => {
  let service: ListsService;
  let mockFrom: jest.Mock;
  let mockStorageFrom: jest.Mock;
  let mockUpload: jest.Mock;
  let mockCreateSignedUrl: jest.Mock;
  let mockRemove: jest.Mock;

  const ORG = 'org-1';
  const SPACE = 'space-1';

  const mockSchema = {
    id: 'list-1',
    organization_id: ORG,
    space_id: SPACE,
    name: 'Asset Register',
    description: null,
    key: 'S1-L1',
    type: 'table',
    icon: 'bx-list-ul',
    fields_definition: [],
    column_config: [
      {
        columnId: 'serial_number',
        label: 'Serial Number',
        cellType: 'text',
        order: 0,
        required: false,
      },
      {
        columnId: 'in_use',
        label: 'In Use',
        cellType: 'checkbox',
        order: 1,
        required: false,
      },
      {
        columnId: 'price',
        label: 'Price',
        cellType: 'number',
        order: 2,
        required: false,
      },
    ],
    settings: {},
    permissions: {},
    field_group_ids: [],
    status: 'active',
    version: 1,
    is_active: true,
    sort_order: 0,
    is_archived: false,
    created_by: null,
    updated_by: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };

  const mockItem = {
    id: 'item-1',
    organization_id: ORG,
    space_id: SPACE,
    schema_id: 'list-1',
    list_id: 'list-1',
    title: 'Laptop #42',
    description: null,
    fields_data: {},
    custom_field_values: {},
    row_order: 0,
    version: 1,
    columnid: null,
    duedate: null,
    assignee: null,
    position: 0,
    customvalues: {},
    is_archived: false,
    created_by: null,
    updated_by: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  function makeCsvFile(
    content: string,
    originalname = 'import.csv',
  ): Express.Multer.File {
    const buffer = Buffer.from(content, 'utf8');

    return {
      buffer,
      originalname,
      mimetype: 'text/csv',
      size: buffer.length,
    } as Express.Multer.File;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockUpload = jest.fn().mockResolvedValue({ error: null });
    mockCreateSignedUrl = jest
      .fn()
      .mockResolvedValue({ data: { signedUrl: 'signed-url' }, error: null });
    mockRemove = jest.fn().mockResolvedValue({ error: null });
    mockStorageFrom = jest.fn().mockReturnValue({
      upload: mockUpload,
      createSignedUrl: mockCreateSignedUrl,
      remove: mockRemove,
    });

    const supa = {
      getClient: () => ({ from: mockFrom, storage: { from: mockStorageFrom } }),
    } as unknown as SupabaseAdminService;
    service = new ListsService(supa);
  });

  // ---- Schemas ----------------------------------------------------------

  describe('getSchemas', () => {
    it('returns list schemas filtered by space', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockSchema], error: null }),
      );
      const r = await service.getSchemas(ORG, SPACE);
      expect(r).toHaveLength(1);
    });
  });

  describe('getSchemaById', () => {
    it('returns a schema', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      );
      const r = await service.getSchemaById('list-1', ORG);
      expect(r.name).toBe('Asset Register');
    });

    it('throws 404 on missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getSchemaById('nope', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getSchemaByKey', () => {
    it('returns a schema by key', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      );
      const r = await service.getSchemaByKey('S1-L1', ORG);
      expect(r.id).toBe('list-1');
    });

    it('throws 404 on unknown key', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getSchemaByKey('X-L999', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createSchema', () => {
    it('creates a schema with auto-generated key', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      ); // insert
      const r = await service.createSchema(ORG, 'user-1', {
        space_id: SPACE,
        name: 'Asset Register',
        type: 'table',
      } as never);
      expect(r.id).toBe('list-1');
    });
  });

  describe('updateSchema', () => {
    it('partial updates a schema', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockSchema, name: 'Updated' },
            error: null,
          }),
        ); // update
      const r = await service.updateSchema('list-1', ORG, 'user-1', {
        name: 'Updated',
      });
      expect(r.name).toBe('Updated');
    });
  });

  describe('deleteSchema', () => {
    it('cascade-deletes schema + items', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete items
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete schema
      await expect(
        service.deleteSchema('list-1', ORG),
      ).resolves.toBeUndefined();
    });
  });

  // ---- Items ------------------------------------------------------------

  describe('getItems', () => {
    it('returns paginated items', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getSchemaById
        .mockReturnValueOnce(
          buildChain({ data: [mockItem], error: null, count: 1 }),
        );
      const r = await service.getItems(ORG, 'list-1', {});
      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
    });
  });

  describe('getItemById', () => {
    it('returns an item', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockItem, error: null }));
      const r = await service.getItemById('item-1', ORG);
      expect(r.title).toBe('Laptop #42');
    });

    it('throws 404 on missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getItemById('nope', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createItem', () => {
    it('creates an item', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getSchemaById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // max row_order lookup
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null })) // insert
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange (fire-and-forget)
      const r = await service.createItem(ORG, 'user-1', {
        schema_id: 'list-1',
        title: 'Laptop #42',
      } as never);
      expect(r.id).toBe('item-1');
    });
  });

  describe('importItemsFromFile', () => {
    it('imports CSV rows into an existing list schema', async () => {
      const importedItem = {
        ...mockItem,
        id: 'item-imported',
        title: 'Laptop 99',
        fields_data: {
          serial_number: 'A-99',
          in_use: true,
          price: 1234.5,
        },
      };
      const insertChain = buildChain({ data: importedItem, error: null });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // import schema lookup
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // createItem schema lookup
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // max row_order lookup
        .mockReturnValueOnce(insertChain); // insert item

      const result = await service.importItemsFromFile(
        ORG,
        'user-1',
        'list-1',
        makeCsvFile(
          'Title,Serial Number,In Use,Price\nLaptop 99,A-99,true,1234.50\n',
        ),
      );

      expect(result.created).toBe(1);
      expect(result.items[0].title).toBe('Laptop 99');
      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          schema_id: 'list-1',
          title: 'Laptop 99',
          fields_data: {
            serial_number: 'A-99',
            in_use: true,
            price: 1234.5,
          },
        }),
      );
    });

    it('rejects existing-list imports without a title column', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      );

      await expect(
        service.importItemsFromFile(
          ORG,
          'user-1',
          'list-1',
          makeCsvFile('Serial Number,Price\nA-99,12\n'),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('importSchemaFromFile', () => {
    it('creates a list schema from headers and imports rows', async () => {
      const schemaInsertChain = buildChain({
        data: {
          ...mockSchema,
          id: 'imported-schema',
          name: 'Servers',
          key: 'SERVERS',
          column_config: [
            {
              columnId: 'location',
              label: 'Location',
              cellType: 'text',
              order: 0,
              required: false,
            },
          ],
        },
        error: null,
      });
      const itemInsertChain = buildChain({
        data: {
          ...mockItem,
          id: 'server-1',
          schema_id: 'imported-schema',
          title: 'Server 1',
          fields_data: { location: 'Room A' },
        },
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(schemaInsertChain) // createSchema
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockSchema,
              id: 'imported-schema',
              name: 'Servers',
              key: 'SERVERS',
              column_config: [
                {
                  columnId: 'location',
                  label: 'Location',
                  cellType: 'text',
                  order: 0,
                  required: false,
                },
              ],
            },
            error: null,
          }),
        ) // createItem schema lookup
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // max row_order lookup
        .mockReturnValueOnce(itemInsertChain); // insert item

      const result = await service.importSchemaFromFile(
        ORG,
        'user-1',
        SPACE,
        makeCsvFile('Name,Location\nServer 1,Room A\n', 'servers.csv'),
        { name: 'Servers' },
      );

      expect(result.schema.name).toBe('Servers');
      expect(result.importResult.created).toBe(1);
      expect(schemaInsertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Servers',
          space_id: SPACE,
          column_config: [
            expect.objectContaining({
              columnId: 'location',
              label: 'Location',
            }),
          ],
        }),
      );
      expect(itemInsertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          schema_id: 'imported-schema',
          title: 'Server 1',
          fields_data: { location: 'Room A' },
        }),
      );
    });
  });

  describe('updateItem', () => {
    it('partial updates an item', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null })) // getItemById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockItem, title: 'Updated' },
            error: null,
          }),
        ); // update
      const r = await service.updateItem('item-1', ORG, 'user-1', {
        title: 'Updated',
      });
      expect(r.title).toBe('Updated');
    });
  });

  describe('deleteItem', () => {
    it('deletes an item', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null })) // getItemById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      await expect(
        service.deleteItem('item-1', ORG, 'user-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('reorderItems', () => {
    it('updates position for each item', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getSchemaById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // update item 1
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // update item 2
      await expect(
        service.reorderItems(ORG, {
          list_id: 'list-1',
          item_ids: ['item-1', 'item-2'],
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('uploadAttachment', () => {
    const file = {
      buffer: Buffer.from('pdf'),
      originalname: 'doc.pdf',
      mimetype: 'application/pdf',
      size: 1024,
    } as unknown as Express.Multer.File;

    it('uploads list item attachments to the configured list attachments bucket', async () => {
      const insertChain = buildChain({
        data: { id: 'attachment-1', file_name: 'doc.pdf' },
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(
          buildChain({ data: { schema_id: 'schema-1' }, error: null }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      await service.uploadAttachment('item-1', ORG, 'schema-1', file, 'user-1');

      expect(mockStorageFrom).toHaveBeenCalledWith('list-attachments');
      expect(mockUpload).toHaveBeenCalled();
      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          item_id: 'item-1',
          organization_id: ORG,
          uploaded_by: 'user-1',
        }),
      );
      expect(insertChain.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          created_by: expect.anything() as unknown,
        }),
      );
      expect(insertChain.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          schema_id: expect.anything() as unknown,
        }),
      );
    });
  });

  describe('getRelations', () => {
    it('returns enriched relation rows with item, schema, type, and user details', async () => {
      const chain = buildChain({
        data: [
          {
            id: 'relation-1',
            source_item_id: 'item-1',
            target_item_id: 'item-2',
            relation_type: { id: 'type-1', name: 'Relates to' },
            source_item: {
              id: 'item-1',
              title: 'Laptop #42',
              schema: { id: 'list-1', name: 'Asset Register', key: 'assets' },
            },
            target_item: {
              id: 'item-2',
              title: 'Server #7',
              schema: { id: 'list-2', name: 'Servers', key: 'servers' },
            },
            created_by_user: {
              id: 'user-1',
              first_name: 'Prince',
              last_name: 'Jadiya',
            },
          },
        ],
        error: null,
      });
      mockFrom.mockReturnValueOnce(chain);

      const r = await service.getRelations('item-1', ORG);

      expect(r).toHaveLength(1);
      expect(chain.select).toHaveBeenCalledWith(
        expect.stringContaining('target_item:asset_items'),
      );
      expect(chain.select).toHaveBeenCalledWith(
        expect.stringContaining('source_item:asset_items'),
      );
      expect(chain.select).toHaveBeenCalledWith(
        expect.stringContaining('relation_type:relation_types'),
      );
      const r0 = r[0] as Record<string, Record<string, unknown>>;
      expect(r0['target_item']['title']).toBe('Server #7');
      expect(
        (r0['target_item']['schema'] as Record<string, unknown>)['name'],
      ).toBe('Servers');
      expect(r0['relation_type']['name']).toBe('Relates to');
    });
  });
});
