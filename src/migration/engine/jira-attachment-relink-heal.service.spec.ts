import {
  JIRA_ATTACHMENT_RELINK_HEAL_MARKER,
  JiraAttachmentRelinkHealService,
} from './jira-attachment-relink-heal.service';
import { MigrationItemError } from './stages/stage.interface';

const TASK_A = 'a0b2d7e7-6877-4d38-aa15-b6a418064302';
const TASK_B = 'b1c3e8f8-7988-4e49-bb26-c7b529175413';

function harness(
  opts: {
    marker?: boolean;
    commentRows?: { task_id: string }[];
    insertError?: { message: string; code?: string };
    relink?: jest.Mock;
  } = {},
) {
  const reads: { table: string; filters: Record<string, unknown> }[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];

  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const result = () => {
        reads.push({ table, filters });

        if (table === 'cron_run_state') {
          return {
            data: opts.marker
              ? { job_name: JIRA_ATTACHMENT_RELINK_HEAL_MARKER }
              : null,
            error: null,
          };
        }

        if (table === 'migration_connections') {
          return {
            data: [{ id: 'conn-1', organization_id: 'org-1' }],
            error: null,
          };
        }

        if (table === 'migration_entity_map') {
          // One page: two migrated tasks plus a planned placeholder that must never be read.
          return {
            data: filters['source_id:gt']
              ? []
              : [
                  {
                    source_id: '10001',
                    source_key: 'ITPFM-1',
                    target_id: TASK_A,
                  },
                  {
                    source_id: '10002',
                    source_key: 'ITPFM-2',
                    target_id: TASK_B,
                  },
                  {
                    source_id: '10003',
                    source_key: 'ITPFM-3',
                    target_id: 'planned:10003',
                  },
                ],
            error: null,
          };
        }

        if (table === 'tasks') return { data: [{ id: TASK_A }], error: null };

        if (table === 'task_comments') {
          return {
            data: opts.commentRows ?? [{ task_id: TASK_B }],
            error: null,
          };
        }

        return { data: null, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return chain;
        },
        in: (key: string, values: unknown[]) => {
          filters[`${key}:in`] = values;
          return chain;
        },
        gt: (key: string, value: unknown) => {
          filters[`${key}:gt`] = value;
          return chain;
        },
        or: (value: string) => {
          filters[':or'] = value;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result()),
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return Promise.resolve({ error: opts.insertError ?? null });
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };

      return chain;
    },
  };
  const relink =
    opts.relink ??
    jest.fn(async (_scope: unknown, taskId: string) =>
      taskId === TASK_A
        ? { kind: 'updated', targetId: taskId, targetTable: 'tasks' }
        : { kind: 'skipped', reason: '1 linked document has no migrated file' },
    );
  const service = new JiraAttachmentRelinkHealService(
    { getClient: () => db } as any,
    { relinkTask: relink } as any,
  );
  const logger = (service as any).logger;

  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  return { service, relink, reads, inserts, logger };
}

describe('JiraAttachmentRelinkHealService', () => {
  afterEach(() => {
    delete process.env.MIGRATION_ENGINE_DISABLED;
    jest.restoreAllMocks();
  });

  it('does nothing once the database carries the heal marker', async () => {
    const h = harness({ marker: true });

    await h.service.run();

    expect(h.relink).not.toHaveBeenCalled();
    expect(h.reads.map((read) => read.table)).toEqual(['cron_run_state']);
    expect(h.inserts).toEqual([]);
  });

  it('relinks only imported tasks with Jira links, scoped to their connection, then marks the database', async () => {
    const h = harness();

    await h.service.run();

    expect(h.relink).toHaveBeenCalledTimes(2);
    expect(h.relink).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', connectionId: 'conn-1' }),
      TASK_A,
      'ITPFM-1',
    );
    expect(h.relink).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', connectionId: 'conn-1' }),
      TASK_B,
      'ITPFM-2',
    );

    const taskScan = h.reads.find((read) => read.table === 'tasks')!;

    // Placeholder targets are never read; both columns filter on every Jira URL shape.
    expect(taskScan.filters['id:in']).toEqual([TASK_A, TASK_B]);
    expect(taskScan.filters[':or']).toBe(
      'description.ilike.*secure/attachment/*,description.ilike.*secure/thumbnail/*,' +
        'description.ilike.*attachment/content/*,description.ilike.*attachment/thumbnail/*',
    );
    expect(
      h.reads.find((read) => read.table === 'task_comments')!.filters[':or'],
    ).toContain('content.ilike.*secure/attachment/*');
    expect(
      h.reads.find((read) => read.table === 'migration_entity_map')!.filters,
    ).toMatchObject({
      organization_id: 'org-1',
      source_connection_id: 'conn-1',
      entity_type: 'issue',
      status: 'mapped',
    });
    expect(h.inserts).toEqual([
      {
        table: 'cron_run_state',
        row: expect.objectContaining({
          job_name: JIRA_ATTACHMENT_RELINK_HEAL_MARKER,
        }),
      },
    ]);
  });

  it('leaves no marker when a task fails transiently, so the next boot retries', async () => {
    const h = harness({
      relink: jest.fn(async () => {
        throw new MigrationItemError('transient', 'db unavailable');
      }),
    });

    await expect(h.service.run()).resolves.toBeUndefined();

    expect(h.inserts).toEqual([]);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('retrying on next boot'),
    );
  });

  it('still marks the database when a task was deleted mid-pass', async () => {
    const h = harness({
      relink: jest.fn(async () => {
        throw new MigrationItemError(
          'conflict',
          'Mapped task no longer exists',
        );
      }),
    });

    await h.service.run();

    expect(h.inserts).toHaveLength(1);
  });

  it('treats a marker written by another replica as success', async () => {
    const h = harness({
      insertError: { message: 'duplicate key', code: '23505' },
    });

    await h.service.run();

    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('1 of 2 task(s)'),
    );
  });

  it('relinks the whole page when the comment scan hits the row cap', async () => {
    const h = harness({
      commentRows: Array.from({ length: 1000 }, () => ({ task_id: TASK_B })),
    });

    await h.service.run();

    expect(h.relink.mock.calls.map((call) => call[1])).toEqual([
      TASK_A,
      TASK_B,
    ]);
  });

  it('is not scheduled on a replica with the migration engine disabled', () => {
    process.env.MIGRATION_ENGINE_DISABLED = 'true';
    const h = harness();
    const timer = jest.spyOn(global, 'setTimeout');

    h.service.onApplicationBootstrap();

    expect(timer).not.toHaveBeenCalled();
  });
});
