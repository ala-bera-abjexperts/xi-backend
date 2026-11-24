/**
 * @fileoverview Unit tests for GdprService — spreadsheet auto-create, column
 * add/remove with ordering rules, record CRUD with optimistic-lock, bulk
 * cell updates, archive toggling, comment ownership rules, attachment
 * upload validation, and CSV export with dynamic header discovery.
 * @module src/gdpr/gdpr.service.spec
 * @author Prince Jadiya
 */

import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) =>
    value
      ?.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<img\b[^>]*>/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '')
      .replace(/\son\w+='[^']*'/gi, '')
      .replace(/\son\w+=\S+/gi, '') ?? null,
}));

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GdprService } from './gdpr.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { UpdateRecordDto } from './dto/update-record.dto';

describe('GdprService', () => {
  let service: GdprService;
  let mockFrom: jest.Mock;
  let mockStorageFrom: jest.Mock;
  let mockUpload: jest.Mock;
  let mockRemove: jest.Mock;
  let mockCreateSignedUrl: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';

  const mockSpreadsheet = {
    id: 'sheet-1',
    organization_id: ORG,
    title: 'GDPR Register',
    column_config: [
      { columnId: 'name', label: 'Name', order: 0 },
      { columnId: 'email', label: 'Email', order: 1 },
    ],
    created_by: USER,
  };

  const mockRecord = {
    id: 'rec-1',
    spreadsheet_id: 'sheet-1',
    organization_id: ORG,
    cell_data: { name: 'Alice', email: 'alice@example.com' },
    row_order: 0,
    assignee_id: null,
    is_archived: false,
    version: 1,
    created_by: USER,
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
    chain.ilike = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockUpload = jest.fn().mockResolvedValue({ error: null });
    mockRemove = jest.fn().mockResolvedValue({ error: null });
    mockCreateSignedUrl = jest
      .fn()
      .mockResolvedValue({ data: { signedUrl: 'https://signed.test/url' } });
    mockStorageFrom = jest.fn().mockReturnValue({
      upload: mockUpload,
      remove: mockRemove,
      createSignedUrl: mockCreateSignedUrl,
    });

    const supa = {
      getClient: () => ({
        from: mockFrom,
        storage: { from: mockStorageFrom },
      }),
    } as unknown as SupabaseAdminService;
    service = new GdprService(supa);
  });

  describe('UpdateRecordDto compatibility', () => {
    it('accepts the legacy id field sent by the frontend update service', async () => {
      const dto = plainToInstance(UpdateRecordDto, {
        id: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
        cell_data: { name: 'Bob' },
        version: 1,
      });

      await expect(
        validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
      ).resolves.toHaveLength(0);
    });
  });

  // ── Spreadsheet ────────────────────────────────────────────────────────

  describe('getOrCreateSpreadsheet', () => {
    it('returns the existing spreadsheet when one exists', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSpreadsheet, error: null }),
      );
      const r = (await service.getOrCreateSpreadsheet(ORG, USER)) as Record<
        string,
        unknown
      >;
      expect(r['id']).toBe('sheet-1');
    });

    it('auto-creates a default spreadsheet when none exists', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // existing check
        .mockReturnValueOnce(
          buildChain({ data: mockSpreadsheet, error: null }),
        ); // insert
      const r = (await service.getOrCreateSpreadsheet(ORG, USER)) as Record<
        string,
        unknown
      >;
      expect(r['id']).toBe('sheet-1');
    });

    it('throws BadRequest on lookup error', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(service.getOrCreateSpreadsheet(ORG, USER)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('updateSpreadsheet', () => {
    it('updates the spreadsheet when found', async () => {
      const updated = { ...mockSpreadsheet, title: 'Renamed' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSpreadsheet, error: null })) // getSpreadsheetOrThrow
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = (await service.updateSpreadsheet(ORG, USER, {
        title: 'Renamed',
      } as never)) as Record<string, unknown>;
      expect(r['title']).toBe('Renamed');
    });

    it('throws NotFound when spreadsheet does not exist', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: null,
          error: { message: 'No rows', code: 'PGRST116' },
        }),
      );
      await expect(
        service.updateSpreadsheet(ORG, USER, {} as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Columns ────────────────────────────────────────────────────────────

  describe('addColumn', () => {
    it('appends a new column at the configured position', async () => {
      const updatedSheet = {
        ...mockSpreadsheet,
        column_config: [
          ...mockSpreadsheet.column_config,
          { columnId: 'phone', label: 'Phone', order: 2 },
        ],
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSpreadsheet, error: null })) // getSpreadsheetOrThrow
        .mockReturnValueOnce(buildChain({ data: updatedSheet, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange
      const r = (await service.addColumn(ORG, USER, {
        columnId: 'phone',
        label: 'Phone',
        order: 2,
      } as never)) as Record<string, unknown>;
      expect((r['column_config'] as unknown[]).length).toBe(3);
    });

    it('rejects duplicate columnId', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSpreadsheet, error: null }),
      );
      await expect(
        service.addColumn(ORG, USER, {
          columnId: 'name',
          label: 'Name dup',
          order: 5,
        } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('removeColumn', () => {
    it('removes the column from column_config', async () => {
      const updatedSheet = {
        ...mockSpreadsheet,
        column_config: [{ columnId: 'email', label: 'Email', order: 1 }],
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSpreadsheet, error: null })) // getSpreadsheetOrThrow
        .mockReturnValueOnce(buildChain({ data: updatedSheet, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange
      const r = (await service.removeColumn(ORG, 'name', USER)) as Record<
        string,
        unknown
      >;
      expect((r['column_config'] as unknown[]).length).toBe(1);
    });

    it('throws NotFound when columnId does not exist', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSpreadsheet, error: null }),
      );
      await expect(service.removeColumn(ORG, 'phantom', USER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── Records ────────────────────────────────────────────────────────────

  describe('listRecords', () => {
    it('returns paginated records', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mockRecord], error: null, count: 1 }),
      );
      const r = await service.listRecords(ORG, {});
      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
      expect(r.pageSize).toBe(50);
    });

    it('clamps pageSize to 200', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);
      const r = await service.listRecords(ORG, { pageSize: '999' });
      expect(r.pageSize).toBe(200);
    });

    it('throws BadRequest when DB errors', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { message: 'down' },
          count: 0,
        }),
      );
      await expect(service.listRecords(ORG, {})).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('createRecord', () => {
    it('auto-increments row_order from the max existing row', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSpreadsheet, error: null })) // getOrCreateSpreadsheet (existing)
        .mockReturnValueOnce(
          buildChain({ data: { row_order: 4 }, error: null }),
        ) // max row_order lookup
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // insert
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange

      const r = (await service.createRecord(ORG, USER, {
        cell_data: { name: 'Alice' },
      } as never)) as Record<string, unknown>;
      expect(r['id']).toBe('rec-1');
    });

    it('uses 0 as row_order when no records exist yet', async () => {
      const insertChain = buildChain({ data: mockRecord, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSpreadsheet, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // no max row
        .mockReturnValueOnce(insertChain) // insert
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange

      await service.createRecord(ORG, USER, {} as never);
      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { row_order: number };
      expect(inserted.row_order).toBe(0);
    });

    it('sanitizes rich text cell_data before inserting a record', async () => {
      const insertChain = buildChain({ data: mockRecord, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSpreadsheet, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      await service.createRecord(ORG, USER, {
        cell_data: {
          description: '<p onclick="bad()">Safe</p><script>alert(1)</script>',
        },
      } as never);

      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { cell_data: unknown };
      expect(inserted.cell_data).toEqual({
        description: '<p>Safe</p>',
      });
    });
  });

  describe('updateRecord', () => {
    it('rejects on version mismatch (ConflictException)', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockRecord, version: 5 }, error: null }),
      );
      await expect(
        service.updateRecord('rec-1', ORG, USER, {
          version: 1,
          cell_data: {},
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('updates and bumps version on matching version', async () => {
      const updated = { ...mockRecord, version: 2 };
      const updateChain = buildChain({ data: updated, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(updateChain) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange

      const r = (await service.updateRecord('rec-1', ORG, USER, {
        id: 'rec-1',
        version: 1,
        cell_data: { name: 'Bob' },
      } as never)) as Record<string, unknown>;
      expect(r['version']).toBe(2);
      expect(updateChain.eq).toHaveBeenCalledWith('version', 1);
    });

    it('sanitizes cell_data before updating a record', async () => {
      const updated = { ...mockRecord, version: 2 };
      const updateChain = buildChain({ data: updated, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(updateChain)
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      await service.updateRecord('rec-1', ORG, USER, {
        id: 'rec-1',
        version: 1,
        cell_data: {
          description: '<div onmouseover="bad()">Hello<img src=x></div>',
        },
      } as never);

      const updatedPayload = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { cell_data: unknown };
      expect(updatedPayload.cell_data).toEqual({
        description: '<div>Hello</div>',
      });
    });

    it('rejects if the row version changes between fetch and update', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: null,
            error: { code: 'PGRST116', message: 'No rows returned' },
          }),
        );

      await expect(
        service.updateRecord('rec-1', ORG, USER, {
          id: 'rec-1',
          version: 1,
          cell_data: { name: 'Bob' },
        } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteRecord', () => {
    it('deletes the record before cleaning up attachment storage', async () => {
      const deleteChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(
          buildChain({
            data: [{ file_path: 'org/rec/x.png' }],
            error: null,
          }),
        ) // attachments
        .mockReturnValueOnce(deleteChain); // delete record

      await expect(
        service.deleteRecord('rec-1', ORG, USER),
      ).resolves.toBeUndefined();
      expect(mockRemove).toHaveBeenCalledWith(['org/rec/x.png']);
      expect(deleteChain.delete).toHaveBeenCalled();
    });

    it('proceeds with delete when there are no attachments', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.deleteRecord('rec-1', ORG, USER),
      ).resolves.toBeUndefined();
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('does not remove storage when record deletion fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: [{ file_path: 'org/rec/x.png' }], error: null }),
        )
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'delete failed' } }),
        );

      await expect(service.deleteRecord('rec-1', ORG, USER)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRemove).not.toHaveBeenCalled();
    });
  });

  describe('toggleArchive', () => {
    it('archives the record', async () => {
      const archived = { ...mockRecord, is_archived: true };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(buildChain({ data: archived, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange

      const r = (await service.toggleArchive('rec-1', ORG, USER, {
        is_archived: true,
      } as never)) as Record<string, unknown>;
      expect(r['is_archived']).toBe(true);
    });

    it('throws Conflict when no row was updated after the version predicate', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.toggleArchive('rec-1', ORG, USER, {
          is_archived: true,
        } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('bulkUpdateCells', () => {
    it('rejects payloads exceeding the 100-item ceiling', async () => {
      const updates = Array.from({ length: 101 }, (_, i) => ({
        record_id: `rec-${i}`,
        column_id: 'name',
        value: 'X',
        version: 1,
      }));
      await expect(
        service.bulkUpdateCells(ORG, USER, { updates } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('flags failures for records whose version no longer matches', async () => {
      // 1 mock for the bulk fetch — returns a record with version 5
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [{ id: 'rec-1', version: 5, cell_data: {} }],
          error: null,
        }),
      );

      await expect(
        service.bulkUpdateCells(ORG, USER, {
          updates: [
            {
              record_id: 'rec-1',
              column_id: 'name',
              value: 'Alice',
              version: 1,
            },
          ],
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects mixed versions for updates targeting the same record', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [{ id: 'rec-1', version: 1, cell_data: { name: 'old' } }],
          error: null,
        }),
      );

      await expect(
        service.bulkUpdateCells(ORG, USER, {
          updates: [
            {
              record_id: 'rec-1',
              column_id: 'name',
              value: 'Alice',
              version: 1,
            },
            {
              record_id: 'rec-1',
              column_id: 'email',
              value: 'a@example.com',
              version: 0,
            },
          ],
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('updates records when versions agree', async () => {
      const updated = {
        ...mockRecord,
        cell_data: { name: 'Alice' },
        version: 2,
      };
      const updateChain = buildChain({ data: updated, error: null });
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'rec-1', version: 1, cell_data: { name: 'old' } }],
            error: null,
          }),
        ) // fetch
        .mockReturnValueOnce(updateChain) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange

      const r = await service.bulkUpdateCells(ORG, USER, {
        updates: [
          { record_id: 'rec-1', column_id: 'name', value: 'Alice', version: 1 },
        ],
      } as never);

      expect(r).toHaveLength(1);
      expect((r[0] as Record<string, unknown>)['version']).toBe(2);
      expect(updateChain.eq).toHaveBeenCalledWith('version', 1);
    });

    it('sanitizes cell values before bulk merging cell_data', async () => {
      const updated = {
        ...mockRecord,
        cell_data: { description: '<p>Safe</p>' },
        version: 2,
      };
      const updateChain = buildChain({ data: updated, error: null });
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'rec-1', version: 1, cell_data: {} }],
            error: null,
          }),
        )
        .mockReturnValueOnce(updateChain)
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      await service.bulkUpdateCells(ORG, USER, {
        updates: [
          {
            record_id: 'rec-1',
            column_id: 'description',
            value: '<p onclick="bad()">Safe</p><script>alert(1)</script>',
            version: 1,
          },
        ],
      } as never);

      const updatedPayload = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { cell_data: unknown };
      expect(updatedPayload.cell_data).toEqual({ description: '<p>Safe</p>' });
    });

    it('rejects when a matching snapshot loses the update race', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'rec-1', version: 1, cell_data: { name: 'old' } }],
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: null,
            error: { code: 'PGRST116', message: 'No rows returned' },
          }),
        );

      await expect(
        service.bulkUpdateCells(ORG, USER, {
          updates: [
            {
              record_id: 'rec-1',
              column_id: 'name',
              value: 'Alice',
              version: 1,
            },
          ],
        } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('reorderRecords', () => {
    it('issues parallel updates and counts successes', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.reorderRecords(ORG, USER, {
        spreadsheet_id: 'sheet-1',
        updates: [
          { record_id: 'rec-1', row_order: 0 },
          { record_id: 'rec-2', row_order: 1 },
        ],
      } as never);
      expect(r.updated).toBe(2);
      expect(mockFrom).toHaveBeenCalledWith('gdpr_record_changes');
    });

    it('throws BadRequest when any update fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fk' } }),
        );
      await expect(
        service.reorderRecords(ORG, USER, {
          updates: [
            { record_id: 'rec-1', row_order: 0 },
            { record_id: 'rec-2', row_order: 1 },
          ],
        } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Comments ───────────────────────────────────────────────────────────

  describe('getComments', () => {
    it('returns ordered comments', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'c-1', content: 'hi', created_by: USER }],
            error: null,
          }),
        );
      const r = await service.getComments('rec-1', ORG);
      expect(r).toHaveLength(1);
    });
  });

  describe('createComment', () => {
    it('inserts a new comment for the record', async () => {
      const insertChain = buildChain({
        data: { id: 'c-1', content: '<p>hi</p>', created_by: USER },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange
      const r = (await service.createComment('rec-1', ORG, USER, {
        content:
          '<p>hi</p><img src=x onerror=alert(1)><script>alert(1)</script>',
      } as never)) as Record<string, unknown>;
      expect(r['id']).toBe('c-1');
      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { content: string };
      expect(inserted.content).toBe('<p>hi</p>');
      expect(inserted.content).not.toContain('onerror');
      expect(inserted.content).not.toContain('script');
    });
  });

  describe('updateComment', () => {
    it('rejects when caller is not the author (ForbiddenException)', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', created_by: 'someone-else' },
            error: null,
          }),
        );
      await expect(
        service.updateComment('rec-1', 'c-1', ORG, USER, {
          content: 'edit',
        } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it('updates when author matches', async () => {
      const updated = { id: 'c-1', content: '<p>edited</p>', created_by: USER };
      const updateChain = buildChain({ data: updated, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', created_by: USER, content: 'old' },
            error: null,
          }),
        ) // existing fetch
        .mockReturnValueOnce(updateChain) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange
      const r = (await service.updateComment('rec-1', 'c-1', ORG, USER, {
        content:
          '<p>edited</p><img src=x onerror=alert(1)><script>alert(1)</script>',
      } as never)) as Record<string, unknown>;
      expect(r['content']).toBe('<p>edited</p>');
      const updatePayload = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { content: string };
      expect(updatePayload.content).toBe('<p>edited</p>');
      expect(updatePayload.content).not.toContain('onerror');
      expect(updatePayload.content).not.toContain('script');
    });

    it('throws NotFound when the comment does not exist', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.updateComment('rec-1', 'missing', ORG, USER, {
          content: 'x',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteComment', () => {
    it('rejects when caller is not the author', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', created_by: 'someone-else' },
            error: null,
          }),
        );
      await expect(
        service.deleteComment('rec-1', 'c-1', ORG, USER),
      ).rejects.toThrow(ForbiddenException);
    });

    it('removes the comment when author matches', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', created_by: USER, content: 'old' },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.deleteComment('rec-1', 'c-1', ORG, USER),
      ).resolves.toBeUndefined();
    });
  });

  // ── Attachments ────────────────────────────────────────────────────────

  describe('uploadAttachment', () => {
    const validFile = {
      buffer: Buffer.from('data'),
      originalname: 'doc.pdf',
      mimetype: 'application/pdf',
      size: 1024,
    } as unknown as Express.Multer.File;

    it('rejects when no file is provided', async () => {
      await expect(
        service.uploadAttachment(
          'rec-1',
          ORG,
          USER,
          undefined as unknown as Express.Multer.File,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects files exceeding the attachment limit', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockRecord, error: null }),
      );
      const big = {
        ...validFile,
        size: UPLOAD_LIMITS.ATTACHMENT + 1,
      } as unknown as Express.Multer.File;
      await expect(
        service.uploadAttachment('rec-1', ORG, USER, big),
      ).rejects.toThrow(/maximum allowed size of/);
    });

    // Attachments intentionally accept EVERY mime type — the size cap is the only control. This
    // asserts the absence of a type gate so a future allow-list cannot be reintroduced silently.
    it('accepts an arbitrary mime type', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(buildChain({ data: { id: 'att-1' }, error: null })) // insert
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logChange
      const unusual = {
        ...validFile,
        mimetype: 'application/x-7z-compressed',
      } as unknown as Express.Multer.File;
      await expect(
        service.uploadAttachment('rec-1', ORG, USER, unusual),
      ).resolves.toBeDefined();
    });

    it('uploads, inserts an attachment row, and returns the new row', async () => {
      const created = {
        id: 'att-1',
        file_name: 'doc.pdf',
        file_path: 'path',
      };
      const historyChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(buildChain({ data: created, error: null })) // insert
        .mockReturnValueOnce(historyChain); // logChange

      const r = (await service.uploadAttachment(
        'rec-1',
        ORG,
        USER,
        validFile,
      )) as Record<string, unknown>;
      expect(r['id']).toBe('att-1');
      expect(mockUpload).toHaveBeenCalled();
      expect(historyChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ file_name: 'doc.pdf' }) as Record<
            string,
            unknown
          >,
        }) as Record<string, unknown>,
      );
    });

    it('rolls back the storage upload when the DB insert fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null })) // getRecordOrThrow
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fk fail' } }),
        ); // insert fails

      await expect(
        service.uploadAttachment('rec-1', ORG, USER, validFile),
      ).rejects.toThrow(BadRequestException);
      expect(mockRemove).toHaveBeenCalled();
    });
  });

  describe('getAttachmentSignedUrl', () => {
    it('returns the signed url + expiry', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { file_path: 'p/file.pdf' }, error: null }),
        );
      const r = await service.getAttachmentSignedUrl('rec-1', 'att-1', ORG);
      expect(r.url).toBe('https://signed.test/url');
      expect(r.expiresIn).toBe(3600);
    });

    it('throws NotFound when attachment is missing', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.getAttachmentSignedUrl('rec-1', 'missing', ORG),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteAttachment', () => {
    it('deletes the attachment row before cleaning up storage', async () => {
      const deleteChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { file_path: 'p/file.pdf' }, error: null }),
        )
        .mockReturnValueOnce(deleteChain);
      await expect(
        service.deleteAttachment('rec-1', 'att-1', ORG),
      ).resolves.toBeUndefined();
      expect(deleteChain.delete).toHaveBeenCalled();
      expect(mockRemove).toHaveBeenCalledWith(['p/file.pdf']);
    });

    it('includes file name in delete activity metadata', async () => {
      const historyChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: {
              file_path: 'p/file.pdf',
              file_name: 'file.pdf',
              file_size: 100,
              mime_type: 'application/pdf',
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(historyChain);

      await service.deleteAttachment('rec-1', 'att-1', ORG, USER);

      expect(historyChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            file_name: 'file.pdf',
          }) as Record<string, unknown>,
        }) as Record<string, unknown>,
      );
    });
  });

  // ── History ────────────────────────────────────────────────────────────

  describe('getHistory', () => {
    it('returns history rows for a record', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRecord, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'h-1', change_type: 'cell_update' }],
            error: null,
          }),
        );
      const r = await service.getHistory('rec-1', ORG);
      expect(r).toHaveLength(1);
    });
  });

  // ── Export ─────────────────────────────────────────────────────────────

  describe('exportToCsv', () => {
    it('uses configured columns when present', async () => {
      // exportToCsv reads `column_id` (snake_case) from configured columns
      // — different from the `columnId` field used by addColumn — so the
      // export-specific spreadsheet fixture mirrors that schema.
      const exportSheet = {
        ...mockSpreadsheet,
        column_config: [
          { column_id: 'name', label: 'Name', order: 0 },
          { column_id: 'email', label: 'Email', order: 1 },
        ],
      };
      const records = [
        {
          id: 'rec-1',
          cell_data: { name: 'Alice', email: 'a@x.com' },
        },
        {
          id: 'rec-2',
          cell_data: { name: 'Bob, with comma', email: 'b@x.com' },
        },
      ];
      mockFrom
        .mockReturnValueOnce(buildChain({ data: exportSheet, error: null })) // getOrCreateSpreadsheet
        .mockReturnValueOnce(buildChain({ data: records, error: null })); // export query

      const r = await service.exportToCsv(ORG, USER);
      expect(r.filename).toMatch(/^gdpr-export-/);
      expect(r.csvContent.split('\n')[0]).toBe('Name,Email');
      // CSV escaping for the comma value
      expect(r.csvContent).toContain('"Bob, with comma"');
    });

    it('discovers columns dynamically when column_config is empty', async () => {
      const emptySheet = { ...mockSpreadsheet, column_config: [] };
      const records = [
        { id: 'rec-1', cell_data: { foo: 'a', bar: 'b' } },
        { id: 'rec-2', cell_data: { foo: 'c', baz: 'd' } },
      ];
      mockFrom
        .mockReturnValueOnce(buildChain({ data: emptySheet, error: null }))
        .mockReturnValueOnce(buildChain({ data: records, error: null }));

      const r = await service.exportToCsv(ORG, USER);
      const header = r.csvContent.split('\n')[0];
      // Header keys are sorted ascending
      expect(header).toBe('bar,baz,foo');
    });
  });
});
