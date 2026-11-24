/**
 * @fileoverview Unit tests for FileExplorerRepository.listNodes() — the subtree
 * (`folder_id`) and label (`label_ids`) filters, and the LIST_CAP truncation flag.
 *
 * These assert the SHAPE of the PostgREST calls, because that is where the bugs
 * live: `folder_id` must use array containment (not `parent_id`), it must not be
 * pinned to the root, and multiple labels must OR (union) rather than intersect.
 * @module src/file-explorer/file-explorer.repository.spec
 */

import { FileExplorerRepository } from './file-explorer.repository';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { ListNodesQueryDto } from './dto/list-nodes-query.dto';

type RecordedCall = [string, unknown[]];

interface FakeChain {
  calls: RecordedCall[];
  args(method: string): unknown[][];
  [key: string]: unknown;
}

const CHAIN_METHODS = [
  'select',
  'eq',
  'is',
  'in',
  'filter',
  'ilike',
  'order',
  'limit',
];

/**
 * A PostgREST query-builder double. Every builder method records its arguments
 * and returns the chain; the chain itself is awaitable, which covers both the
 * terminal `await q` and the label lookup's `await …in(…)`.
 */
function fakeChain(result: unknown, error: unknown = null): FakeChain {
  const calls: RecordedCall[] = [];
  const chain = {
    calls,
    args: (method: string) =>
      calls.filter(([name]) => name === method).map(([, args]) => args),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: result, error }).then(resolve),
  } as unknown as FakeChain;

  for (const method of CHAIN_METHODS) {
    chain[method] = jest.fn((...args: unknown[]) => {
      calls.push([method, args]);

      return chain;
    });
  }

  return chain;
}

describe('FileExplorerRepository.listNodes filters', () => {
  const SPACE = 'space-1';
  const ORG = 'org-1';
  const FOLDER = '11111111-1111-4111-8111-111111111111';
  const LABEL_A = '22222222-2222-4222-8222-222222222222';
  const LABEL_B = '33333333-3333-4333-8333-333333333333';

  let nodeChain: FakeChain;
  let labelChain: FakeChain;
  let repo: FileExplorerRepository;

  /** Wire the two tables listNodes can touch. */
  const setup = (nodeRows: unknown[], labelRows: unknown[] = []) => {
    nodeChain = fakeChain(nodeRows);
    labelChain = fakeChain(labelRows);

    const from = jest.fn((table: string) =>
      table === 'fe_node_labels' ? labelChain : nodeChain,
    );

    repo = new FileExplorerRepository({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);
  };

  const list = (query: ListNodesQueryDto, meta?: { truncated: boolean }) =>
    repo.listNodes(SPACE, ORG, 'all', query, meta);

  // ── Subtree ───────────────────────────────────────────────────────────────

  it('filters a whole subtree by ancestor containment, not by parent_id', async () => {
    setup([{ id: 'node-1' }]);

    await list({ folder_id: FOLDER });

    expect(nodeChain.args('filter')).toEqual([
      ['ancestor_ids', 'cs', `{${FOLDER}}`],
    ]);
    expect(nodeChain.args('eq')).not.toContainEqual(['parent_id', FOLDER]);
  });

  it('does not pin a subtree listing to the root', async () => {
    setup([]);

    await list({ folder_id: FOLDER });

    expect(nodeChain.args('is')).toEqual([]);
  });

  it('still defaults to the root when no cross-tree filter is given', async () => {
    setup([]);

    await list({});

    expect(nodeChain.args('is')).toEqual([['parent_id', null]]);
  });

  it('keeps parent_id as direct-children-only', async () => {
    setup([]);

    await list({ parent_id: FOLDER });

    expect(nodeChain.args('eq')).toContainEqual(['parent_id', FOLDER]);
    expect(nodeChain.args('filter')).toEqual([]);
  });

  // ── Labels ────────────────────────────────────────────────────────────────

  it('resolves a single label into an id IN (…) constraint', async () => {
    setup([{ id: 'node-1' }], [{ node_id: 'node-1' }]);

    await list({ label_ids: [LABEL_A] });

    expect(labelChain.args('in')).toEqual([['label_id', [LABEL_A]]]);
    expect(nodeChain.args('in')).toEqual([['id', ['node-1']]]);
    expect(nodeChain.args('is')).toEqual([]);
  });

  it('ORs multiple labels — any-of, deduplicated, never an intersection', async () => {
    setup(
      [{ id: 'node-1' }, { id: 'node-2' }],
      [
        { node_id: 'node-1' },
        { node_id: 'node-2' },
        { node_id: 'node-1' }, // same node carries both labels
      ],
    );

    await list({ label_ids: [LABEL_A, LABEL_B] });

    expect(labelChain.args('in')).toEqual([['label_id', [LABEL_A, LABEL_B]]]);
    expect(nodeChain.args('in')).toEqual([['id', ['node-1', 'node-2']]]);
  });

  it('returns nothing when no node carries any of the labels', async () => {
    setup([{ id: 'node-1' }], []);

    await expect(list({ label_ids: [LABEL_A] })).resolves.toEqual([]);
    expect(nodeChain.args('in')).toEqual([]);
  });

  // ── Subtree AND labels ────────────────────────────────────────────────────

  it('ANDs folder_id and label_ids on the same query', async () => {
    setup([{ id: 'node-1' }], [{ node_id: 'node-1' }]);

    await list({ folder_id: FOLDER, label_ids: [LABEL_A] });

    expect(nodeChain.args('filter')).toEqual([
      ['ancestor_ids', 'cs', `{${FOLDER}}`],
    ]);
    expect(nodeChain.args('in')).toEqual([['id', ['node-1']]]);
    expect(nodeChain.args('is')).toEqual([]);
  });

  // ── Truncation ────────────────────────────────────────────────────────────

  it('reports truncation to the caller when the row cap is hit', async () => {
    setup(Array.from({ length: 1000 }, (_, i) => ({ id: `node-${i}` })));

    const meta = { truncated: false };

    await list({}, meta);

    expect(meta.truncated).toBe(true);
  });

  it('leaves truncated false for a short result', async () => {
    setup([{ id: 'node-1' }]);

    const meta = { truncated: false };

    await list({}, meta);

    expect(meta.truncated).toBe(false);
  });
});
