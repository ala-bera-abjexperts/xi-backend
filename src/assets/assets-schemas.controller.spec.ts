import { AssetsSchemasController } from './assets-schemas.controller';

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
};

function responseMock() {
  return {
    set: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

describe('AssetsSchemasController', () => {
  let service: Record<string, jest.Mock>;
  let controller: AssetsSchemasController;

  beforeEach(() => {
    service = {
      getAll: jest.fn().mockResolvedValue([{ id: 'schema-1' }]),
      create: jest.fn().mockResolvedValue({ id: 'schema-1' }),
      getByKey: jest.fn().mockResolvedValue({ id: 'schema-1' }),
      getById: jest
        .fn()
        .mockResolvedValue({ id: 'schema-1', name: 'Risk & Controls!' }),
      update: jest.fn().mockResolvedValue({ id: 'schema-1', name: 'Updated' }),
      exportCsv: jest.fn().mockResolvedValue('id,name\n1,Risk'),
      addColumn: jest.fn().mockResolvedValue({ id: 'column-1' }),
      reorderColumns: jest.fn().mockResolvedValue({ success: true }),
      renameColumn: jest.fn().mockResolvedValue({ id: 'column-1' }),
      removeColumn: jest.fn().mockResolvedValue({ success: true }),
      softDelete: jest.fn().mockResolvedValue({ success: true }),
    };
    controller = new AssetsSchemasController(service as any);
  });

  it('delegates schema listing with space and organization scope', async () => {
    await expect(controller.getAll(user as any, 'space-1')).resolves.toEqual([
      { id: 'schema-1' },
    ]);

    expect(service.getAll).toHaveBeenCalledWith('space-1', 'org-1');
  });

  it('creates schemas with organization and actor context', async () => {
    const dto = { name: 'Risks' };

    await controller.create(user as any, 'space-1', dto as any);

    expect(service.create).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('gets schemas by key with key, space, and organization scope', async () => {
    await controller.getByKey(user as any, 'space-1', 'RISKS');

    expect(service.getByKey).toHaveBeenCalledWith('RISKS', 'space-1', 'org-1');
  });

  it('gets schemas by id with schema, space, and organization scope', async () => {
    await controller.getById(user as any, 'space-1', 'schema-1');

    expect(service.getById).toHaveBeenCalledWith(
      'schema-1',
      'space-1',
      'org-1',
    );
  });

  it('updates schemas with organization and actor context', async () => {
    const dto = { name: 'Updated risks' };

    await controller.update(user as any, 'space-1', 'schema-1', dto as any);

    expect(service.update).toHaveBeenCalledWith(
      'schema-1',
      'space-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('soft deletes schemas with organization and actor context', async () => {
    await controller.remove(user as any, 'space-1', 'schema-1');

    expect(service.softDelete).toHaveBeenCalledWith(
      'schema-1',
      'space-1',
      'org-1',
      'user-1',
    );
  });

  it('exports CSV with sanitized filename headers and sends the payload', async () => {
    const res = responseMock();

    await controller.exportCsv(user as any, 'space-1', 'schema-1', res as any);

    expect(service.getById).toHaveBeenCalledWith(
      'schema-1',
      'space-1',
      'org-1',
    );
    expect(service.exportCsv).toHaveBeenCalledWith(
      'schema-1',
      'space-1',
      'org-1',
    );
    const setArg = (res.set.mock.calls as unknown[][])[0]?.[0] as {
      'Content-Type': string;
      'Content-Disposition': string;
    };
    expect(setArg['Content-Type']).toBe('text/csv; charset=utf-8');
    // RFC 5987 dual form keeps the ORIGINAL schema name (incl. "&" and "!") in filename*=.
    expect(setArg['Content-Disposition']).toMatch(
      /^attachment; filename="Risk & Controls!_export_\d{4}-\d{2}-\d{2}\.csv"; filename\*=UTF-8''Risk%20%26%20Controls!/,
    );
    expect(res.send).toHaveBeenCalledWith('id,name\n1,Risk');
  });

  it('propagates export failures before writing the response', async () => {
    const expected = new Error('export failed');
    service.exportCsv.mockRejectedValueOnce(expected);
    const res = responseMock();

    await expect(
      controller.exportCsv(user as any, 'space-1', 'schema-1', res as any),
    ).rejects.toBe(expected);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('adds columns with schema, space, organization, and actor context', async () => {
    const dto = { name: 'Owner' };

    await controller.addColumn(user as any, 'space-1', 'schema-1', dto as any);

    expect(service.addColumn).toHaveBeenCalledWith(
      'schema-1',
      'space-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('reorders columns with schema, space, organization, and actor context', async () => {
    const dto = { columns: [{ id: 'column-1', order: 0 }] };

    await controller.reorderColumns(
      user as any,
      'space-1',
      'schema-1',
      dto as any,
    );

    expect(service.reorderColumns).toHaveBeenCalledWith(
      'schema-1',
      'space-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('renames columns with schema, column, space, organization, and actor context', async () => {
    const dto = { name: 'Owner' };

    await controller.renameColumn(
      user as any,
      'space-1',
      'schema-1',
      'column-1',
      dto as any,
    );

    expect(service.renameColumn).toHaveBeenCalledWith(
      'schema-1',
      'column-1',
      'space-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('removes columns with schema, column, space, organization, and actor context', async () => {
    await controller.removeColumn(
      user as any,
      'space-1',
      'schema-1',
      'column-1',
    );

    expect(service.removeColumn).toHaveBeenCalledWith(
      'schema-1',
      'column-1',
      'space-1',
      'org-1',
      'user-1',
    );
  });
});
