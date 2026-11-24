import { MigrationConnectionsService } from './migration-connections.service';
import type { SourceAdapterFactory } from '../adapters/source-adapter.factory';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

function query<T>(result: T) {
  const done = Promise.resolve({ data: result, error: null });
  const then: typeof done.then = (onfulfilled, onrejected) =>
    done.then(onfulfilled, onrejected);
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    then,
  };

  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);

  return chain;
}

function singleQuery<T>(result: T) {
  const chain = query(result);
  (chain as typeof chain & { maybeSingle: jest.Mock }).maybeSingle = jest.fn(
    () => Promise.resolve({ data: result, error: null }),
  );

  return chain;
}

describe('MigrationConnectionsService.findActiveJiraConnectionsByOrigin', () => {
  it('matches active Jira connections by normalized origin, retaining their configured base URL', async () => {
    const rows = query([
      { id: 'jira-1', base_url: 'https://JIRA.example.test:443/jira' },
    ]);
    const from = jest.fn(() => rows);
    const service = new MigrationConnectionsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {} as SourceAdapterFactory,
    );

    await expect(
      service.findActiveJiraConnectionsByOrigin(
        'org-1',
        'https://jira.example.test/secure/attachment/42',
      ),
    ).resolves.toEqual([
      {
        id: 'jira-1',
        baseUrl: 'https://JIRA.example.test:443/jira',
        origin: 'https://jira.example.test',
      },
    ]);
    expect(rows.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(rows.eq).toHaveBeenCalledWith('product', 'jira');
    expect(rows.eq).toHaveBeenCalledWith('is_revoked', false);
  });

  it('does not query connections for an invalid origin', async () => {
    const from = jest.fn();
    const service = new MigrationConnectionsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {} as SourceAdapterFactory,
    );

    await expect(
      service.findActiveJiraConnectionsByOrigin('org-1', 'not a URL'),
    ).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it('returns the configured base URL unchanged for migration render context', async () => {
    const row = singleQuery({ base_url: 'https://jira.example.test/jira' });
    const from = jest.fn(() => row);
    const service = new MigrationConnectionsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {} as SourceAdapterFactory,
    );

    await expect(service.getBaseUrl('org-1', 'jira-1')).resolves.toBe(
      'https://jira.example.test/jira',
    );
    expect(row.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(row.eq).toHaveBeenCalledWith('id', 'jira-1');
  });
});

describe('MigrationConnectionsService.buildAdapter', () => {
  it('passes the persisted deployment so a tested connection is not probed again', async () => {
    const adapter = { deployment: 'server' };
    const factory = {
      create: jest.fn().mockResolvedValue(adapter),
    };
    const service = new MigrationConnectionsService(
      { getClient: jest.fn() } as unknown as SupabaseAdminService,
      factory as unknown as SourceAdapterFactory,
    );

    jest.spyOn(service as any, 'getRow').mockResolvedValue({
      id: 'jira-1',
      organization_id: 'org-1',
      product: 'jira',
      deployment: 'server',
      base_url: 'https://jira.example.test',
      auth_type: 'basic',
      auth_username: 'migration-user',
      metadata: {},
      is_revoked: false,
    });
    jest.spyOn(service as any, 'decryptRow').mockReturnValue('secret');

    await expect(service.buildAdapter('org-1', 'jira-1')).resolves.toBe(
      adapter,
    );
    expect(factory.create).toHaveBeenCalledWith(
      expect.objectContaining({ deployment: 'server' }),
    );
  });
});
