import { SavedFiltersController } from './saved-filters.controller';

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

describe('SavedFiltersController', () => {
  let service: Record<string, jest.Mock>;
  let controller: SavedFiltersController;

  beforeEach(() => {
    service = {
      getDefaults: jest.fn().mockResolvedValue({ data: [] }),
      getFilterableFields: jest.fn().mockResolvedValue({ data: [] }),
      getParentOptions: jest.fn().mockResolvedValue({ data: [] }),
      executeAdHoc: jest.fn().mockResolvedValue({ data: [] }),
      getAll: jest.fn().mockResolvedValue({ data: [] }),
      create: jest.fn().mockResolvedValue({ id: 'filter-1' }),
      executeFilter: jest.fn().mockResolvedValue({ data: [] }),
      update: jest.fn().mockResolvedValue({ id: 'filter-1' }),
      toggleFavorite: jest.fn().mockResolvedValue({ favorite: true }),
      exportToCSV: jest.fn().mockResolvedValue('id,name\n1,Open'),
      getById: jest.fn().mockResolvedValue({
        data: { id: 'filter-1', name: 'Open Risks!' },
      }),
      getPermissions: jest.fn().mockResolvedValue([]),
      setPermissions: jest.fn().mockResolvedValue({ success: true }),
      getSubscriptions: jest.fn().mockResolvedValue([]),
      createSubscription: jest.fn().mockResolvedValue({ id: 'sub-1' }),
      deleteSubscription: jest.fn().mockResolvedValue({ success: true }),
      delete: jest.fn().mockResolvedValue({ success: true }),
    };
    controller = new SavedFiltersController(service as any);
  });

  it('delegates listing with organization and user context', async () => {
    await controller.list(user as any, 'risk', 'private', 'false');

    expect(service.getAll).toHaveBeenCalledWith('org-1', 'user-1', {
      search: 'risk',
      visibility: 'private',
      is_favorite: undefined,
    });
  });

  it('gets defaults and field definitions with parsed entity and space arrays', async () => {
    await controller.getDefaults(user as any);
    await controller.getFields(
      user as any,
      'tasks,processes',
      'space-1,space-2',
    );
    await controller.getFields(user as any);

    expect(service.getDefaults).toHaveBeenCalledWith('org-1');
    expect(service.getFilterableFields).toHaveBeenNthCalledWith(
      1,
      'org-1',
      'user-1',
      ['tasks', 'processes'],
      ['space-1', 'space-2'],
    );
    expect(service.getFilterableFields).toHaveBeenNthCalledWith(
      2,
      'org-1',
      'user-1',
      ['processes', 'tasks', 'lists'],
      undefined,
    );
  });

  it('rejects invalid parent option queries and parses valid query values', async () => {
    await expect(
      controller.getParentOptions(user as any, '   '),
    ).rejects.toThrow('Invalid query parameters');
    await expect(
      controller.getParentOptions(user as any, 'parent', 'tasks,assets'),
    ).rejects.toThrow('Invalid query parameters');
    await expect(
      controller.getParentOptions(user as any, 'parent', 'tasks', 'space-1'),
    ).rejects.toThrow('Invalid query parameters');
    await expect(
      controller.getParentOptions(
        user as any,
        'parent',
        'tasks',
        undefined,
        '75',
      ),
    ).rejects.toThrow('Invalid query parameters');

    await controller.getParentOptions(
      user as any,
      ' parent ',
      'tasks,processes',
      '53f4d965-0eff-43c1-9f4e-0cd28acbd189',
      '50',
    );

    expect(service.getParentOptions).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'parent',
      ['tasks', 'processes'],
      ['53f4d965-0eff-43c1-9f4e-0cd28acbd189'],
      50,
    );
  });

  it('executes ad hoc filters and creates saved filters with current user context', async () => {
    const executeDto = { entity_type: 'tasks' };
    const createDto = { name: 'Open tasks' };

    await controller.executeAdHoc(user as any, executeDto as any);
    await controller.create(user as any, createDto as any);

    expect(service.executeAdHoc).toHaveBeenCalledWith(
      executeDto,
      'org-1',
      'user-1',
    );
    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', createDto);
  });

  it('gets, updates, removes, and favorites saved filters with scoped ids', async () => {
    const dto = { name: 'Updated filter' };

    await controller.getById(user as any, 'filter-1');
    await controller.update(user as any, 'filter-1', dto as any);
    await controller.remove(user as any, 'filter-1');
    await controller.toggleFavorite(user as any, 'filter-1');

    expect(service.getById).toHaveBeenCalledWith('filter-1', 'org-1', 'user-1');
    expect(service.update).toHaveBeenCalledWith(
      'filter-1',
      'org-1',
      'user-1',
      dto,
    );
    expect(service.delete).toHaveBeenCalledWith('filter-1', 'org-1', 'user-1');
    expect(service.toggleFavorite).toHaveBeenCalledWith(
      'filter-1',
      'org-1',
      'user-1',
    );
  });

  it('executes saved filters with default pagination', async () => {
    await controller.executeSaved(user as any, 'filter-1', {} as any);

    expect(service.executeFilter).toHaveBeenCalledWith(
      'filter-1',
      'org-1',
      'user-1',
      { page: 1, pageSize: 50, sort: undefined },
    );
  });

  it('exports CSV with attachment headers and sends the payload', async () => {
    const res = responseMock();

    await controller.exportCsv(user as any, 'filter-1', res as any);

    expect(service.exportToCSV).toHaveBeenCalledWith(
      'filter-1',
      'org-1',
      'user-1',
    );
    expect(service.getById).toHaveBeenCalledWith('filter-1', 'org-1', 'user-1');
    const dispositionMatcher: unknown = expect.stringMatching(
      // RFC 5987 dual form keeps the ORIGINAL name (incl. "!") in filename*=.
      /^attachment; filename="Open Risks!-\d{4}-\d{2}-\d{2}\.csv"; filename\*=UTF-8''Open%20Risks!/,
    );
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': dispositionMatcher,
    });
    expect(res.send).toHaveBeenCalledWith('id,name\n1,Open');
  });

  it('propagates CSV export failures', async () => {
    const expected = new Error('csv failed');
    service.exportToCSV.mockRejectedValueOnce(expected);

    await expect(
      controller.exportCsv(user as any, 'filter-1', responseMock() as any),
    ).rejects.toBe(expected);
  });

  it('manages permissions with filter, organization, user, and dto context', async () => {
    const dto = { permissions: [{ user_id: 'user-2' }] };

    await controller.getPermissions(user as any, 'filter-1');
    await controller.setPermissions(user as any, 'filter-1', dto as any);

    expect(service.getPermissions).toHaveBeenCalledWith(
      'filter-1',
      'org-1',
      'user-1',
    );
    expect(service.setPermissions).toHaveBeenCalledWith(
      'filter-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('manages subscriptions with filter, organization, user, and subscription ids', async () => {
    const dto = { frequency: 'daily' };

    await controller.getSubscriptions(user as any, 'filter-1');
    await controller.createSubscription(user as any, 'filter-1', dto as any);
    await controller.deleteSubscription(user as any, 'filter-1', 'sub-1');

    expect(service.getSubscriptions).toHaveBeenCalledWith(
      'filter-1',
      'org-1',
      'user-1',
    );
    expect(service.createSubscription).toHaveBeenCalledWith(
      'filter-1',
      'org-1',
      'user-1',
      dto,
    );
    expect(service.deleteSubscription).toHaveBeenCalledWith(
      'filter-1',
      'sub-1',
      'org-1',
      'user-1',
    );
  });
});
