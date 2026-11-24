import { PagesController } from './pages.controller';

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('PagesController', () => {
  let service: Record<string, jest.Mock>;
  let controller: PagesController;

  beforeEach(() => {
    service = {
      getPages: jest.fn().mockResolvedValue([{ id: 'page-1' }]),
      reorderPages: jest.fn().mockResolvedValue(undefined),
      getPageById: jest.fn().mockResolvedValue({ id: 'page-1' }),
      createPage: jest.fn().mockResolvedValue({ id: 'page-1' }),
      updatePage: jest.fn().mockResolvedValue({ id: 'page-1', name: 'Home' }),
      deletePage: jest.fn().mockResolvedValue(undefined),
      duplicatePage: jest.fn().mockResolvedValue({ id: 'page-2' }),
      movePage: jest.fn().mockResolvedValue({ id: 'page-1', path_name: 'new' }),
      saveContent: jest.fn().mockResolvedValue({ id: 'page-1', content: [] }),
    };
    controller = new PagesController(service as any);
  });

  it('wraps page lists in a data envelope', async () => {
    await expect(controller.getPages(user as any, 'funnel-1')).resolves.toEqual(
      {
        data: [{ id: 'page-1' }],
      },
    );
    expect(service.getPages).toHaveBeenCalledWith('funnel-1', 'org-1');
  });

  it('returns undefined for no-content reorder after delegating', async () => {
    const dto = { pageIds: ['page-2', 'page-1'] };

    await expect(
      controller.reorderPages(user as any, 'funnel-1', dto as any),
    ).resolves.toBeUndefined();
    expect(service.reorderPages).toHaveBeenCalledWith(
      'funnel-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('creates pages with funnel, organization, actor, and dto context', async () => {
    const dto = { name: 'Landing' };

    await expect(
      controller.createPage(user as any, 'funnel-1', dto as any),
    ).resolves.toEqual({ data: { id: 'page-1' } });
    expect(service.createPage).toHaveBeenCalledWith(
      'funnel-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('gets a single page by id and wraps it in a data envelope', async () => {
    await expect(
      controller.getPageById(user as any, 'funnel-1', 'page-1'),
    ).resolves.toEqual({ data: { id: 'page-1' } });

    expect(service.getPageById).toHaveBeenCalledWith(
      'funnel-1',
      'page-1',
      'org-1',
    );
  });

  it('updates pages with page, organization, actor, and dto context', async () => {
    const dto = { name: 'Home' };

    await expect(
      controller.updatePage(user as any, 'funnel-1', 'page-1', dto as any),
    ).resolves.toEqual({ data: { id: 'page-1', name: 'Home' } });

    expect(service.updatePage).toHaveBeenCalledWith(
      'funnel-1',
      'page-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('returns undefined for no-content delete after delegating', async () => {
    await expect(
      controller.deletePage(user as any, 'funnel-1', 'page-1'),
    ).resolves.toBeUndefined();
    expect(service.deletePage).toHaveBeenCalledWith(
      'funnel-1',
      'page-1',
      'org-1',
      'user-1',
    );
  });

  it('duplicates pages with page, organization, and actor context', async () => {
    await expect(
      controller.duplicatePage(user as any, 'funnel-1', 'page-1'),
    ).resolves.toEqual({ data: { id: 'page-2' } });

    expect(service.duplicatePage).toHaveBeenCalledWith(
      'funnel-1',
      'page-1',
      'org-1',
      'user-1',
    );
  });

  it('moves pages with page, organization, actor, and dto context', async () => {
    const dto = { path_name: 'new' };

    await expect(
      controller.movePage(user as any, 'funnel-1', 'page-1', dto as any),
    ).resolves.toEqual({ data: { id: 'page-1', path_name: 'new' } });

    expect(service.movePage).toHaveBeenCalledWith(
      'funnel-1',
      'page-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('saves content with page, organization, and actor context', async () => {
    const dto = { content: [{ id: 'node-1' }] };

    await expect(
      controller.saveContent(user as any, 'funnel-1', 'page-1', dto as any),
    ).resolves.toEqual({ data: { id: 'page-1', content: [] } });
    expect(service.saveContent).toHaveBeenCalledWith(
      'funnel-1',
      'page-1',
      'org-1',
      'user-1',
      dto,
    );
  });
});
