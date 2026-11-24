import { buildNotificationPath, tenantBaseUrl } from './notification-link.util';

describe('buildNotificationPath', () => {
  it('builds a task link from space_key + task_key/entity_key', () => {
    expect(
      buildNotificationPath('task', 'id', {
        space_key: 'ENG',
        entity_key: 'ENG-1',
      }),
    ).toBe('/spaces/ENG/tasks/view/ENG-1');
    expect(
      buildNotificationPath('task', 'id', {
        space_key: 'ENG',
        task_key: 'ENG-2',
      }),
    ).toBe('/spaces/ENG/tasks/view/ENG-2');
  });

  it('builds a task_comment link from entity_key', () => {
    expect(
      buildNotificationPath('task_comment', 'c1', {
        space_key: 'ENG',
        entity_key: 'ENG-9',
      }),
    ).toBe('/spaces/ENG/tasks/view/ENG-9');
  });

  it('builds wiki links (page + comment), falling back to referenceId', () => {
    expect(
      buildNotificationPath('wiki_page', 'p1', {
        space_key: 'ENG',
        entity_id: 'PAGE',
      }),
    ).toBe('/spaces/ENG/wiki/PAGE');
    // wiki_comment has no frontend branch; ours uses entity_id or referenceId.
    expect(
      buildNotificationPath('wiki_comment', 'p1', { space_key: 'ENG' }),
    ).toBe('/spaces/ENG/wiki/p1');
  });

  it('builds wiki review links like wiki page links', () => {
    expect(
      buildNotificationPath('wiki_review_requested', 'p1', {
        space_key: 'ENG',
        entity_id: 'PAGE',
      }),
    ).toBe('/spaces/ENG/wiki/PAGE');
    expect(
      buildNotificationPath('wiki_review_decided', 'p1', { space_key: 'ENG' }),
    ).toBe('/spaces/ENG/wiki/p1');
  });

  it('uses the process KEY (not the uuid) for process links', () => {
    expect(
      buildNotificationPath('process', 'the-uuid', {
        space_key: 'ENG',
        entity_key: 'PROC-1',
      }),
    ).toBe('/spaces/ENG/processes/view/PROC-1');
    expect(
      buildNotificationPath('process_comment', 'the-uuid', {
        space_key: 'ENG',
        entity_key: 'PROC-1',
      }),
    ).toBe('/spaces/ENG/processes/view/PROC-1');
  });

  it('builds a portfolio letter link from portfolio_key + referenceId', () => {
    expect(
      buildNotificationPath('portfolio_management_letter', 'letter-1', {
        portfolio_key: 'PF',
      }),
    ).toBe('/portfolios/PF/letters/letter-1');
  });

  it('routes file_attachment links by entity_type', () => {
    expect(
      buildNotificationPath('file_attachment', 'a', {
        space_key: 'ENG',
        entity_type: 'task',
        entity_id: 'x',
        task_key: 'ENG-5',
      }),
    ).toBe('/spaces/ENG/tasks/view/ENG-5');
    expect(
      buildNotificationPath('file_attachment', 'a', {
        space_key: 'ENG',
        entity_type: 'wiki_page',
        entity_id: 'W1',
      }),
    ).toBe('/spaces/ENG/wiki/W1');
    expect(
      buildNotificationPath('file_attachment', 'a', {
        space_key: 'ENG',
        entity_type: 'asset_item',
        entity_id: 'I1',
        schema_key: 'S1',
      }),
    ).toBe('/spaces/ENG/lists/S1/I1');
  });

  it('honours an explicit metadata.link short-circuit', () => {
    expect(buildNotificationPath('task', 'id', { link: '/custom/path' })).toBe(
      '/custom/path',
    );
  });

  it('returns null when required keys are missing or type is unknown', () => {
    expect(
      buildNotificationPath('task', 'id', { space_key: 'ENG' }),
    ).toBeNull();
    expect(buildNotificationPath('task', 'id', {})).toBeNull();
    expect(buildNotificationPath('task', 'id', null)).toBeNull();
    expect(
      buildNotificationPath('unknown_type', 'id', { space_key: 'ENG' }),
    ).toBeNull();
    expect(buildNotificationPath(null, 'id', {})).toBeNull();
  });
});

describe('tenantBaseUrl (XE-T728)', () => {
  it('swaps the app. label for the org slug and keeps scheme and port', () => {
    expect(tenantBaseUrl('https://app.xisuite.cloud', 'acme')).toBe(
      'https://acme.xisuite.cloud',
    );
    expect(tenantBaseUrl('https://app.lvh.me:3000', 'acme')).toBe(
      'https://acme.lvh.me:3000',
    );
  });

  it('keeps a host without the app. label (on-prem / localhost)', () => {
    expect(tenantBaseUrl('https://xisuite.customer.local', 'acme')).toBe(
      'https://xisuite.customer.local',
    );
    expect(tenantBaseUrl('http://localhost:3000', 'acme')).toBe(
      'http://localhost:3000',
    );
  });

  it('keeps the app URL when there is no slug or the URL is unreadable', () => {
    expect(tenantBaseUrl('https://app.xisuite.cloud', null)).toBe(
      'https://app.xisuite.cloud',
    );
    expect(tenantBaseUrl('not a url', 'acme')).toBe('not a url');
  });
});
