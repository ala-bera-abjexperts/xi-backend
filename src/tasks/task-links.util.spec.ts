/**
 * @fileoverview Unit tests for the task→task link lookups shared by the three
 * "Linked to" filter engines (XE-T532): both directions unioned, self-links
 * dropped, 100-id chunking, and a failed chunk degrading to a partial result.
 *
 * @module src/tasks/task-links.util.spec
 * @author Prince Jadiya
 */

import {
  createLinkViewCheck,
  fetchLinkedTaskIds,
  fetchTaskKeys,
} from './task-links.util';

interface Call {
  table: string;
  eqs: Record<string, unknown>;
  inCol: string;
  inVals: string[];
}

type Respond = (call: Call) => { data: unknown; error: unknown };

function fakeClient(respond: Respond) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => {
      const call: Call = { table, eqs: {}, inCol: '', inVals: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          call.eqs[col] = val;
          return chain;
        },
        in: (col: string, vals: string[]) => {
          call.inCol = col;
          call.inVals = vals;
          return chain;
        },
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve(respond(call)).then(ok),
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

const links = (rows: { source_id: string; target_id: string }[]) => {
  return (call: Call) => ({
    data: rows.filter((r) =>
      call.inVals.includes(
        call.inCol === 'source_id' ? r.source_id : r.target_id,
      ),
    ),
    error: null,
  });
};

describe('fetchLinkedTaskIds', () => {
  it('unions both directions, org-scoped and task→task only', async () => {
    const { client, calls } = fakeClient(
      links([
        { source_id: 't11', target_id: 't12' },
        { source_id: 't10', target_id: 't11' },
      ]),
    );

    const result = await fetchLinkedTaskIds(client, 'org-1', ['t11']);

    expect([...(result.get('t11') ?? [])].sort()).toEqual(['t10', 't12']);
    expect(calls.map((c) => c.inCol).sort()).toEqual([
      'source_id',
      'target_id',
    ]);
    for (const call of calls) {
      expect(call.table).toBe('task_relationships');
      expect(call.eqs).toMatchObject({
        organization_id: 'org-1',
        source_type: 'task',
        target_type: 'task',
      });
    }
  });

  it('drops self-links and dedupes reverse/duplicate links', async () => {
    const { client } = fakeClient(
      links([
        { source_id: 'a', target_id: 'a' },
        { source_id: 'a', target_id: 'b' },
        { source_id: 'b', target_id: 'a' },
      ]),
    );

    const result = await fetchLinkedTaskIds(client, 'org-1', ['a', 'b']);

    expect([...(result.get('a') ?? [])]).toEqual(['b']);
    expect([...(result.get('b') ?? [])]).toEqual(['a']);
  });

  it('splits 150 ids into 2 chunks per direction', async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }));
    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);

    await fetchLinkedTaskIds(client, 'org-1', ids);

    const outgoing = calls.filter((c) => c.inCol === 'source_id');
    expect(outgoing.map((c) => c.inVals.length)).toEqual([100, 50]);
    expect(calls.filter((c) => c.inCol === 'target_id')).toHaveLength(2);
  });

  it('warns and keeps the other results when a chunk query fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeClient((call) =>
      call.inCol === 'source_id'
        ? { data: null, error: { message: 'boom' } }
        : { data: [{ source_id: 'x', target_id: 'a' }], error: null },
    );

    const result = await fetchLinkedTaskIds(client, 'org-1', ['a']);

    expect([...(result.get('a') ?? [])]).toEqual(['x']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('makes no query for an empty id list', async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }));

    expect((await fetchLinkedTaskIds(client, 'org-1', [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('fetchTaskKeys', () => {
  it('maps ids to keys, org-scoped', async () => {
    const { client, calls } = fakeClient(() => ({
      data: [{ id: 't13', key: 'XSD-T13', space_id: 'space-1' }],
      error: null,
    }));

    const result = await fetchTaskKeys(client, 'org-1', ['t13']);

    expect(result.get('t13')).toBe('XSD-T13');
    expect(calls[0]).toMatchObject({
      table: 'tasks',
      inCol: 'id',
      inVals: ['t13'],
      eqs: { organization_id: 'org-1' },
    });
  });

  it('keeps only rows whose space passes the optional filter', async () => {
    const { client } = fakeClient(() => ({
      data: [
        { id: 't13', key: 'XSD-T13', space_id: 'space-1' },
        { id: 't14', key: 'XSD-T14', space_id: 'space-2' },
        { id: 't15', key: 'XSD-T15', space_id: null },
      ],
      error: null,
    }));
    const include = jest.fn((spaceId: string | null) =>
      Promise.resolve(spaceId !== 'space-2'),
    );

    const result = await fetchTaskKeys(
      client,
      'org-1',
      ['t13', 't14', 't15'],
      include,
    );

    expect([...result.keys()]).toEqual(['t13', 't15']);
    expect(include).toHaveBeenCalledWith(null);
  });

  it('makes no query for an empty id list', async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }));

    expect((await fetchTaskKeys(client, 'org-1', [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('createLinkViewCheck', () => {
  // A failed lookup must still answer "cannot see" (fail closed), but never
  // silently: each failure is logged.
  it('fails closed, and logs, when a permission lookup fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const permissions = {
      getUserSpacePermissions: jest.fn().mockRejectedValue(new Error('boom')),
      getUserEffectivePermissions: jest
        .fn()
        .mockRejectedValue(new Error('boom')),
    };
    const canView = createLinkViewCheck(
      permissions as never,
      'org-1',
      'user-1',
    );

    await expect(canView('space-1', 'view_tasks')).resolves.toBe(false);
    await expect(canView(null, 'view_tasks')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
