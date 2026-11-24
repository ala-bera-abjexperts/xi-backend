import { MigrationEntityMapService } from './migration-entity-map.service';

const USER = '267b6a1d-6a5e-4d63-b544-d869f85ee906';
const OTHER = '11111111-2222-4333-8444-555555555555';
function fixture(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    spaces: [{ id: 'space', organization_id: 'org' }],
    users: [{ id: USER, is_active: true }],
    organization_members: [{ user_id: USER, organization_id: 'org' }],
    space_members: [{ id: 'member', user_id: USER, space_id: 'space', is_active: true }],
    migration_entity_map: [{ id: 'map', organization_id: 'org', source_connection_id: 'conn', entity_type: 'user', source_id: 'server-key', source_key: 'username', target_id: USER, target_table: 'users', status: 'mapped', is_placeholder: false, metadata: { display_name: 'Source Person' } }],
    ...extra,
  };
  const from = jest.fn((table: string) => {
    let rows = tables[table] ?? [];
    const q: any = {
      select: () => q,
      eq: (key: string, value: unknown) => { rows = rows.filter(r => r[key] === value); return q; },
      in: (key: string, values: unknown[]) => { rows = rows.filter(r => values.includes(r[key])); return q; },
      order: () => q,
      range: (start: number, end: number) => { rows = rows.slice(start, end + 1); return q; },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return q;
  });
  return { service: new MigrationEntityMapService({ getClient: () => ({ from }) } as any), tables, from };
}

describe('profile macro crosswalk', () => {
  it('resolves Server keys, username aliases and Cloud account IDs through the scoped crosswalk', async () => {
    const f = fixture();
    f.tables.migration_entity_map.push({ ...f.tables.migration_entity_map[0], id: 'cloud', source_id: 'abc:account-id', source_key: null });
    const result = await f.service.resolveProfileTargets('org', 'conn', 'space', ['server-key', 'username', 'abc:account-id', USER]);
    for (const ref of ['server-key', 'username', 'abc:account-id']) expect(result.get(ref)).toEqual({ userId: USER, displayName: 'Source Person' });
    expect(result.get(USER)?.userId).toBeUndefined();
  });
  it.each(['space_members', 'organization_members', 'users'])('rejects missing/deleted membership in %s', async table => {
    const f = fixture({ [table]: [] });
    expect((await f.service.resolveProfileTargets('org', 'conn', 'space', ['server-key'])).get('server-key')).toEqual({ displayName: 'Source Person' });
  });
  it('does not disambiguate by choosing whichever candidate is in the space', async () => {
    const f = fixture();
    f.tables.migration_entity_map.push({ ...f.tables.migration_entity_map[0], id: 'second', source_id: 'other-key', target_id: OTHER });
    expect((await f.service.resolveProfileTargets('org', 'conn', 'space', ['username'])).get('username')?.userId).toBeUndefined();
  });
  it('checks later mapping pages before accepting an alias', async () => {
    const f = fixture();
    const row = f.tables.migration_entity_map[0];
    f.tables.migration_entity_map = Array.from({ length: 1001 }, (_, index) => ({ ...row, id: String(index), source_id: `key-${index}`, target_id: index === 1000 ? OTHER : USER }));
    expect((await f.service.resolveProfileTargets('org', 'conn', 'space', ['username'])).get('username')?.userId).toBeUndefined();
  });
  it('excludes placeholders, other connections and other organizations', async () => {
    const f = fixture();
    f.tables.migration_entity_map[0].is_placeholder = true;
    f.tables.migration_entity_map.push({ ...f.tables.migration_entity_map[0], id: 'foreign', is_placeholder: false, source_connection_id: 'other' });
    expect((await f.service.resolveProfileTargets('org', 'conn', 'space', ['server-key'])).get('server-key')?.userId).toBeUndefined();
    expect(await f.service.resolveProfileTargets('other-org', 'conn', 'space', ['server-key'])).toEqual(new Map());
    expect(await f.service.resolveProfileTargets('org', 'conn', 'space', [])).toEqual(new Map());
  });
});
