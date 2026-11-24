import { BadRequestException, ConflictException } from '@nestjs/common';
import { PagesService } from './pages.service';

type TerminalResult = {
  data?: unknown;
  error?: unknown;
  count?: number | null;
};

function createQuery(result: TerminalResult, updates: unknown[] = []) {
  const query: Record<string, jest.Mock> = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    neq: jest.fn(() => query),
    like: jest.fn(() => query),
    in: jest.fn(() => query),
    order: jest.fn(() => query),
    limit: jest.fn(() => query),
    insert: jest.fn(() => query),
    update: jest.fn((payload: unknown) => {
      updates.push(payload);
      return query;
    }),
    delete: jest.fn(() => query),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    single: jest.fn(() => Promise.resolve(result)),
    then: jest.fn((resolve: (value: TerminalResult) => unknown) =>
      Promise.resolve(result).then(resolve),
    ),
  };

  return query;
}

function createService(
  queries: Record<string, jest.Mock>[],
  rpcResult: TerminalResult = { data: {}, error: null },
) {
  const rpc = jest.fn(() => Promise.resolve(rpcResult));
  const client = {
    from: jest.fn(() => {
      const query = queries.shift();

      if (!query) throw new Error('Unexpected Supabase query');

      return query;
    }),
    rpc,
  };
  const auditLogsService = {
    logAction: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new PagesService(
      { getClient: () => client } as any,
      auditLogsService as any,
    ),
    client,
    rpc,
    auditLogsService,
  };
}

describe('PagesService parity', () => {
  it('creates pages with the parent funnel published state', async () => {
    const inserted: unknown[] = [];
    const funnelQuery = createQuery({
      data: { id: 'funnel-1', published: true },
    });
    const sortQuery = createQuery({ data: { sort_order: 0 } });
    const insertQuery = createQuery({
      data: {
        id: 'page-1',
        name: 'Child',
        path_name: 'child',
        published: true,
      },
    });
    insertQuery.insert.mockImplementation((payload: unknown) => {
      inserted.push(payload);
      return insertQuery;
    });
    const { service } = createService([funnelQuery, sortQuery, insertQuery]);

    await service.createPage('funnel-1', 'org-1', 'user-1', {
      name: 'Child',
      path_name: 'child',
    });

    expect(inserted[0]).toMatchObject({ published: true });
  });

  // `movePage` no longer rewrites path_name itself. The `site_studio_require_page_command`
  // trigger rejects a direct UPDATE of any identity column, so the whole rename/move (including
  // the descendant cascade, collision checks and route aliasing) is delegated to
  // `site_studio_apply_page_command_v2`. These tests pin the call contract and the error mapping.
  it('routes a move through the page-command RPC instead of writing path_name directly', async () => {
    const updates: unknown[] = [];
    const identityQuery = createQuery({
      data: {
        id: 'page-1',
        funnel_id: 'funnel-1',
        organization_id: 'org-1',
        name: 'Docs',
        path_name: 'docs',
        slug: 'docs',
        parent_page_id: null,
        is_landing: false,
        version: 4,
      },
    });
    const reloadQuery = createQuery(
      { data: { id: 'page-1', path_name: 'knowledge' } },
      updates,
    );

    const { service, rpc } = createService([identityQuery, reloadQuery]);

    await service.movePage('funnel-1', 'page-1', 'org-1', 'user-1', {
      newPath: 'knowledge',
    });

    expect(rpc).toHaveBeenCalledWith(
      'site_studio_apply_page_command_v2',
      expect.objectContaining({
        p_organization_id: 'org-1',
        p_funnel_id: 'funnel-1',
        p_page_id: 'page-1',
        p_command: 'rename_move',
        p_expected_version: 4,
        p_slug: 'knowledge',
        p_parent_page_id: null,
        p_actor_id: 'user-1',
      }),
    );

    // The service must not attempt the write itself; the trigger would reject it.
    expect(updates).toEqual([]);
  });

  it('maps an RPC route collision to a BadRequest', async () => {
    const identityQuery = createQuery({
      data: {
        id: 'page-1',
        funnel_id: 'funnel-1',
        organization_id: 'org-1',
        name: 'Docs',
        path_name: 'docs',
        slug: 'docs',
        parent_page_id: null,
        is_landing: false,
        version: 1,
      },
    });

    const { service } = createService([identityQuery], {
      data: null,
      error: { message: 'SITE_STUDIO_ROUTE_COLLISION' },
    });

    await expect(
      service.movePage('funnel-1', 'page-1', 'org-1', 'user-1', {
        newPath: 'knowledge',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps an RPC version conflict to a 409 so the client can reload', async () => {
    const identityQuery = createQuery({
      data: {
        id: 'page-1',
        funnel_id: 'funnel-1',
        organization_id: 'org-1',
        name: 'Docs',
        path_name: 'docs',
        slug: 'docs',
        parent_page_id: null,
        is_landing: false,
        version: 1,
      },
    });

    const { service } = createService([identityQuery], {
      data: null,
      error: { message: 'SITE_STUDIO_VERSION_CONFLICT' },
    });

    await expect(
      service.movePage('funnel-1', 'page-1', 'org-1', 'user-1', {
        newPath: 'knowledge',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects page content without one __body root before saving', async () => {
    const { service } = createService([
      createQuery({ data: { id: 'page-1', path_name: 'docs' } }),
      createQuery({ data: { id: 'page-1' } }),
    ]);

    await expect(
      service.saveContent('funnel-1', 'page-1', 'org-1', 'user-1', {
        content: [
          {
            id: 'text-1',
            type: 'text',
            name: 'Text',
            styles: {},
            content: { innerText: 'No body' },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
